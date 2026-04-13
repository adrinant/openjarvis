//! MCP client pool: stdio servers via `rmcp`, config from `mcp-servers.json`.
use anyhow::{anyhow, Context, Result};
use rmcp::model::{CallToolRequestParams, Tool};
use rmcp::serve_client;
use rmcp::service::RunningService;
use rmcp::transport::child_process::TokioChildProcess;
use rmcp::RoleClient;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::path::Path;
use tokio::process::Command as TokioCommand;

#[derive(Debug, Deserialize)]
struct McpConfigFile {
    servers: Vec<McpServerConfig>,
}

#[derive(Debug, Deserialize, Clone)]
struct McpServerConfig {
    name: String,
    transport: String,
    command: String,
    args: Vec<String>,
    #[serde(default)]
    env: Option<HashMap<String, String>>,
}

#[derive(Clone)]
struct ToolRoute {
    server_idx: usize,
    original_name: String,
}

struct ServerConn {
    running: RunningService<RoleClient, ()>,
}

/// One row for `get_mcp_servers`.
#[derive(Clone, serde::Serialize)]
pub struct McpServerStatus {
    pub name: String,
    pub connected: bool,
    pub tool_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct McpPool {
    servers: Vec<ServerConn>,
    openai_tool_defs: Vec<Value>,
    routes: HashMap<String, ToolRoute>,
    statuses: Vec<McpServerStatus>,
}

impl Default for McpPool {
    fn default() -> Self {
        Self {
            servers: Vec::new(),
            openai_tool_defs: Vec::new(),
            routes: HashMap::new(),
            statuses: Vec::new(),
        }
    }
}

impl McpPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Load `mcp-servers.json` from several locations and keep the config that yields the most tools.
    /// Order: cwd, repo root next to this crate (compile-time path), then app config dir.
    /// This avoids an empty tool list when the app data folder has no file but the project does.
    pub async fn connect_startup_paths(app_config_mcp: Option<std::path::PathBuf>) -> Result<Self> {
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("mcp-servers.json"));
        }
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../mcp-servers.json"));
        if let Some(p) = app_config_mcp {
            candidates.push(p);
        }

        let mut seen = HashSet::new();
        let mut best = Self::default();

        for p in candidates {
            let key = p.to_string_lossy().to_string();
            if !seen.insert(key) || !p.is_file() {
                continue;
            }
            match Self::connect_from_path(&p).await {
                Ok(pool) => {
                    let n = pool.openai_tool_defs.len();
                    eprintln!(
                        "OpenJarvis MCP: `{}` — {} tool(s) registered",
                        p.display(),
                        n
                    );
                    for st in &pool.statuses {
                        if let Some(ref err) = st.error {
                            eprintln!("  server `{}`: failed — {err}", st.name);
                        } else if st.connected {
                            eprintln!("  server `{}`: OK ({} tool(s))", st.name, st.tool_count);
                        }
                    }
                    if n > best.openai_tool_defs.len() {
                        best = pool;
                    }
                }
                Err(e) => eprintln!("OpenJarvis MCP: skipped `{}`: {e}", p.display()),
            }
        }

        if best.openai_tool_defs.is_empty() {
            eprintln!(
                "OpenJarvis MCP: no tools loaded. Copy mcp-servers.example.json to mcp-servers.json, start SearXNG if needed, and check logs above."
            );
        }

        Ok(best)
    }

    /// Sorted names as sent to the model (`server__tool`).
    pub fn namespaced_tool_names(&self) -> Vec<String> {
        let mut v: Vec<String> = self.routes.keys().cloned().collect();
        v.sort();
        v
    }

    pub async fn connect_from_path(path: &Path) -> Result<Self> {
        let raw = match tokio::fs::read_to_string(path).await {
            Ok(s) => s,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e.into()),
        };
        let file: McpConfigFile =
            serde_json::from_str(&raw).with_context(|| format!("parse {}", path.display()))?;
        Self::connect_servers(&file.servers).await
    }

    async fn connect_servers(configs: &[McpServerConfig]) -> Result<Self> {
        let mut servers = Vec::new();
        let mut openai_tool_defs = Vec::new();
        let mut routes = HashMap::new();
        let mut statuses = Vec::new();

        for cfg in configs {
            if cfg.transport != "stdio" {
                statuses.push(McpServerStatus {
                    name: cfg.name.clone(),
                    connected: false,
                    tool_count: 0,
                    error: Some(format!(
                        "unsupported transport {:?} (only \"stdio\")",
                        cfg.transport
                    )),
                });
                continue;
            }

            match connect_one_server(cfg).await {
                Ok((conn, tools)) => {
                    let slug = slugify(&cfg.name);
                    let idx = servers.len();
                    for t in &tools {
                        let namespaced = format!("{}__{}", slug, t.name);
                        routes.insert(
                            namespaced.clone(),
                            ToolRoute {
                                server_idx: idx,
                                original_name: t.name.to_string(),
                            },
                        );
                        openai_tool_defs.push(tool_to_openai(&namespaced, t));
                    }
                    servers.push(conn);
                    statuses.push(McpServerStatus {
                        name: cfg.name.clone(),
                        connected: true,
                        tool_count: tools.len(),
                        error: None,
                    });
                }
                Err(e) => {
                    statuses.push(McpServerStatus {
                        name: cfg.name.clone(),
                        connected: false,
                        tool_count: 0,
                        error: Some(e.to_string()),
                    });
                }
            }
        }

        Ok(Self {
            servers,
            openai_tool_defs,
            routes,
            statuses,
        })
    }

    pub fn openai_tools(&self) -> Vec<Value> {
        self.openai_tool_defs.clone()
    }

    pub fn status_values(&self) -> Vec<Value> {
        self.statuses
            .iter()
            .map(|s| serde_json::to_value(s).unwrap_or(Value::Null))
            .collect()
    }

    pub async fn call_tool(&self, namespaced_name: &str, arguments_json: &str) -> Result<String> {
        let route = self
            .routes
            .get(namespaced_name)
            .ok_or_else(|| anyhow!("unknown tool {namespaced_name:?}"))?;
        let server = self
            .servers
            .get(route.server_idx)
            .ok_or_else(|| anyhow!("stale MCP server index"))?;

        let args_map: Map<String, Value> = match arguments_json.trim() {
            "" | "{}" => Map::new(),
            s => serde_json::from_str(s).context("tool arguments JSON")?,
        };

        let params = CallToolRequestParams::new(std::borrow::Cow::Owned(route.original_name.clone()))
            .with_arguments(args_map);

        let result = server
            .running
            .call_tool(params)
            .await
            .map_err(|e| anyhow!(e.to_string()))?;

        serde_json::to_string(&result).map_err(|e| anyhow!(e))
    }
}

async fn connect_one_server(cfg: &McpServerConfig) -> Result<(ServerConn, Vec<Tool>)> {
    let cmd = build_command(cfg)?;
    let transport = TokioChildProcess::new(cmd).map_err(|e| anyhow!(e))?;
    let running = serve_client((), transport)
        .await
        .map_err(|e| anyhow!(e.to_string()))?;
    let tools = running
        .list_all_tools()
        .await
        .map_err(|e| anyhow!(e.to_string()))?;
    Ok((ServerConn { running }, tools))
}

fn build_command(cfg: &McpServerConfig) -> std::io::Result<TokioCommand> {
    #[cfg(windows)]
    {
        if cfg.command.eq_ignore_ascii_case("npx") {
            let mut cmd = rmcp::transport::which_command("npx")?;
            cmd.args(&cfg.args);
            if let Some(env) = &cfg.env {
                for (k, v) in env {
                    cmd.env(k, v);
                }
            }
            return Ok(cmd);
        }
    }

    let mut cmd = TokioCommand::new(&cfg.command);
    cmd.args(&cfg.args);
    if let Some(env) = &cfg.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    Ok(cmd)
}

fn slugify(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn tool_to_openai(namespaced: &str, tool: &Tool) -> Value {
    let desc = tool.description.as_deref().unwrap_or("MCP tool");
    let parameters = Value::Object((tool.input_schema.as_ref()).clone());
    json!({
        "type": "function",
        "function": {
            "name": namespaced,
            "description": desc,
            "parameters": parameters,
        }
    })
}

pub fn tool_result_message(tool_call_id: impl Into<String>, content: impl Into<String>) -> Value {
    json!({
        "role": "tool",
        "tool_call_id": tool_call_id.into(),
        "content": content.into(),
    })
}
