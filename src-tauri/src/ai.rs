use crate::context;
use crate::mcp::McpPool;
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Map, Value};
use std::env;
use tauri::{AppHandle, Emitter};

const GATEWAY_BASE: &str = "https://ai-gateway.vercel.sh/v1";

fn gateway_model() -> String {
    env::var("OPENJARVIS_AI_MODEL")
        .unwrap_or_else(|_| "anthropic/claude-sonnet-4.6".to_string())
}

fn gateway_key() -> Result<String> {
    env::var("AI_GATEWAY_API_KEY").context("AI_GATEWAY_API_KEY is not set")
}

/// One chat turn: optional streaming to the UI, returns updated messages including assistant reply.
pub async fn run_chat_turn(
    app: &AppHandle,
    pool: &McpPool,
    mut messages: Vec<Value>,
    stream_tokens: bool,
) -> Result<Vec<Value>> {
    let key = gateway_key()?;
    let client = Client::new();
    let tools = pool.openai_tools();

    loop {
        let mut body = json!({
            "model": gateway_model(),
            "messages": messages,
            "stream": stream_tokens,
        });
        if !tools.is_empty() {
            let tool_choice = tool_choice_for_request(&messages, &tools);
            let o = body.as_object_mut().unwrap();
            o.insert("tools".into(), Value::Array(tools.clone()));
            o.insert("tool_choice".into(), tool_choice);
        }

        if stream_tokens && tools.is_empty() {
            let assistant = stream_chat_completion(&client, &key, &body, Some(app)).await?;
            messages.push(assistant);
            return Ok(messages);
        }

        // When MCP tools are registered, use a non-streaming completion. Several models and
        // gateways (including DeepSeek via AI Gateway) omit or fragment `tool_calls` in SSE
        // deltas, so the model looks like it "will search" without ever calling a tool.
        if stream_tokens && !tools.is_empty() {
            let mut sync_body = body.clone();
            sync_body
                .as_object_mut()
                .expect("body object")
                .insert("stream".into(), json!(false));
            let assistant = complete_chat_completion(&client, &key, &sync_body).await?;
            messages.push(assistant.clone());

            if let Some(c) = assistant_content_for_ui(&assistant) {
                if !c.is_empty() {
                    let _ = app.emit("token", c);
                }
            }

            let had_tools = assistant
                .get("tool_calls")
                .and_then(|a| a.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            if !had_tools {
                return Ok(messages);
            }
            let tool_calls = assistant
                .get("tool_calls")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            run_tool_loop(app, pool, &mut messages, tool_calls).await?;
            continue;
        }

        let assistant = complete_chat_completion(&client, &key, &body).await?;
        let had_tools = assistant
            .get("tool_calls")
            .and_then(|a| a.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        messages.push(assistant.clone());

        if !had_tools {
            return Ok(messages);
        }

        let tool_calls = assistant
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        run_tool_loop(app, pool, &mut messages, tool_calls).await?;
    }
}

async fn run_tool_loop(
    app: &AppHandle,
    pool: &McpPool,
    messages: &mut Vec<Value>,
    tool_calls: Vec<Value>,
) -> Result<()> {
    for call in &tool_calls {
        let id = call
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let func = call.get("function").cloned().unwrap_or(json!({}));
        let name = func
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let args = func
            .get("arguments")
            .and_then(|v| v.as_str())
            .unwrap_or("{}")
            .to_string();

        let _ = app.emit(
            "tool_use",
            json!({ "name": name.clone(), "arguments": args.clone() }),
        );

        let result = match pool.call_tool(&name, &args).await {
            Ok(s) => s,
            Err(e) => {
                let _ = app.emit(
                    "tool_error",
                    json!({ "name": name.clone(), "error": e.to_string() }),
                );
                format!(r#"{{"error": {:?}}}"#, e.to_string())
            }
        };

        let _ = app.emit(
            "tool_result",
            json!({ "name": name.clone(), "output": &result }),
        );

        messages.push(crate::mcp::tool_result_message(id, result));
    }
    Ok(())
}

async fn complete_chat_completion(client: &Client, key: &str, body: &Value) -> Result<Value> {
    let url = format!("{GATEWAY_BASE}/chat/completions");
    let resp = client
        .post(&url)
        .bearer_auth(key)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .context("gateway request")?;

    let status = resp.status();
    let txt = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("gateway HTTP {}: {}", status, txt);
    }

    let v: Value = serde_json::from_str(&txt).context("parse json")?;
    let choice = v
        .get("choices")
        .and_then(|c| c.get(0))
        .ok_or_else(|| anyhow!("no choices"))?;
    let msg = choice
        .get("message")
        .cloned()
        .ok_or_else(|| anyhow!("no message"))?;
    Ok(openai_message_to_history(&msg)?)
}

async fn stream_chat_completion(
    client: &Client,
    key: &str,
    body: &Value,
    app: Option<&AppHandle>,
) -> Result<Value> {
    let url = format!("{GATEWAY_BASE}/chat/completions");
    let resp = client
        .post(&url)
        .bearer_auth(key)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .context("gateway request")?;

    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        anyhow::bail!("gateway HTTP {}: {}", status, txt);
    }

    let mut stream = resp.bytes_stream();
    let mut sse_buf = String::new();
    let mut content = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("stream chunk")?;
        sse_buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = sse_buf.find("\n\n") {
            let raw_event = sse_buf[..pos].to_string();
            sse_buf.drain(..pos + 2);
            for line in raw_event.lines() {
                let line = line.trim();
                let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                    continue;
                };
                if data == "[DONE]" {
                    continue;
                }
                let Ok(ev) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                let choice = ev.get("choices").and_then(|c| c.get(0));
                let delta = choice.and_then(|c| c.get("delta"));
                if let Some(t) = delta.and_then(|d| d.get("content")).and_then(|x| x.as_str()) {
                    content.push_str(t);
                    if let Some(app) = app {
                        let _ = app.emit("token", t);
                    }
                }
            }
        }
    }

    let mut msg = Map::new();
    msg.insert("role".into(), json!("assistant"));
    if !content.is_empty() {
        msg.insert("content".into(), json!(content));
    } else {
        msg.insert("content".into(), Value::Null);
    }
    Ok(Value::Object(msg))
}

/// Extract plain string from `message.content` (OpenAI string/array, Anthropic-style nested `text`, etc.).
pub fn plain_text_from_message_content(content: &Value) -> Option<String> {
    match content {
        Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
        Value::Array(parts) => {
            let mut out = String::new();
            for p in parts {
                append_text_from_content_block(p, &mut out);
            }
            if out.trim().is_empty() {
                None
            } else {
                Some(out)
            }
        }
        _ => None,
    }
}

fn append_text_from_content_block(p: &Value, out: &mut String) {
    let Some(obj) = p.as_object() else {
        return;
    };
    if let Some(Value::String(t)) = obj.get("text") {
        out.push_str(t);
        return;
    }
    if let Some(Value::Object(tinner)) = obj.get("text") {
        if let Some(Value::String(v)) = tinner.get("value") {
            out.push_str(v);
            return;
        }
    }
    if let Some(Value::String(c)) = obj.get("content") {
        out.push_str(c);
    }
}

/// Walk from the end: last assistant message with extractable text (for TTS / UI fallback).
pub fn last_assistant_plain_text(messages: &[Value]) -> Option<String> {
    for m in messages.iter().rev() {
        if m.get("role").and_then(|r| r.as_str()) != Some("assistant") {
            continue;
        }
        let Some(c) = m.get("content") else {
            continue;
        };
        if let Some(t) = plain_text_from_message_content(c) {
            return Some(t);
        }
    }
    None
}

/// Plain text from an assistant message object we store in `messages` (string or multimodal array).
fn assistant_content_for_ui(assistant: &Value) -> Option<String> {
    let c = assistant.get("content")?;
    plain_text_from_message_content(c)
}

fn openai_message_to_history(msg: &Value) -> Result<Value> {
    let role = msg
        .get("role")
        .and_then(|r| r.as_str())
        .unwrap_or("assistant");
    let mut out = Map::new();
    out.insert("role".into(), json!(role));
    if let Some(c) = msg.get("content") {
        out.insert("content".into(), c.clone());
    } else {
        out.insert("content".into(), Value::Null);
    }
    if let Some(tc) = msg.get("tool_calls") {
        out.insert("tool_calls".into(), tc.clone());
    }
    if let Some(id) = msg.get("tool_call_id").and_then(|x| x.as_str()) {
        out.insert("tool_call_id".into(), json!(id));
    }
    Ok(Value::Object(out))
}

/// Build request messages: system prompt (reflects MCP state) + client history.
pub fn build_messages(history: Vec<Value>, pool: &McpPool) -> Vec<Value> {
    let names = pool.namespaced_tool_names();
    let has = !names.is_empty();
    let sys = context::system_prompt(has, &names);
    let mut out = vec![json!({
        "role": "system",
        "content": sys,
    })];
    out.extend(history);
    out
}

fn last_message_is_user(messages: &[Value]) -> bool {
    messages
        .last()
        .and_then(|m| m.get("role").and_then(|r| r.as_str()))
        == Some("user")
}

fn last_user_text(messages: &[Value]) -> Option<String> {
    messages.iter().rev().find_map(|m| {
        if m.get("role").and_then(|r| r.as_str()) != Some("user") {
            return None;
        }
        let c = m.get("content")?;
        message_content_as_str(c)
    })
}

fn message_content_as_str(c: &Value) -> Option<String> {
    plain_text_from_message_content(c)
}

/// Some models ignore `tool_choice: auto` for web search; force the search MCP tool when intent matches.
fn forced_tool_choice_for_web_search(user_msg: &str, tools: &[Value]) -> Option<Value> {
    let u = user_msg.to_lowercase();
    let wants_web = u.contains("search")
        || u.contains("look up")
        || u.contains("lookup ")
        || u.contains("google")
        || u.contains("on the web")
        || u.contains("online")
        || u.contains("find information")
        || u.contains(" wikipedia")
        || u.contains("wiki ");
    if !wants_web {
        return None;
    }
    for t in tools {
        let name = t
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(|x| x.as_str())?;
        let nl = name.to_lowercase();
        if nl.contains("search") || nl.contains("searx") || nl.contains("web") {
            return Some(json!({
                "type": "function",
                "function": {"name": name}
            }));
        }
    }
    None
}

fn tool_choice_for_request(messages: &[Value], tools: &[Value]) -> Value {
    if last_message_is_user(messages) {
        if let Some(text) = last_user_text(messages) {
            if let Some(forced) = forced_tool_choice_for_web_search(&text, tools) {
                return forced;
            }
        }
    }
    json!("auto")
}
