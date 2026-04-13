use crate::ai;
use crate::mcp::McpPool;
use crate::notify;
use crate::voice;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

pub struct McpState(pub Arc<Mutex<McpPool>>);

#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    state: tauri::State<'_, McpState>,
    history: Vec<Value>,
    _speak_reply: Option<bool>,
) -> Result<(), String> {
    let pool = state.0.clone();
    let app_done = app.clone();

    tauri::async_runtime::spawn(async move {
        let guard = pool.lock().await;
        let messages = ai::build_messages(history, &*guard);
        let result = ai::run_chat_turn(&app_done, &*guard, messages, true).await;
        drop(guard);

        match result {
            Ok(msgs) => {
                if let Some(win) = app_done.get_webview_window("main") {
                    if let Ok(focused) = win.is_focused() {
                        if !focused {
                            notify::show(
                                &app_done,
                                "OpenJarvis",
                                "Assistant finished responding.",
                            );
                        }
                    }
                }
                let assistant_plain = ai::last_assistant_plain_text(&msgs).unwrap_or_default();
                let _ = app_done.emit(
                    "done",
                    serde_json::json!({ "assistantPlain": assistant_plain }),
                );
            }
            Err(e) => {
                let _ = app_done.emit("error", e.to_string());
                notify::show(&app_done, "OpenJarvis", &format!("Error: {e}"));
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn start_voice(app: AppHandle) {
    notify::show(
        &app,
        "OpenJarvis",
        voice::start_voice_notification_body(),
    );
}

/// Decode browser-recorded audio (base64) and transcribe via ElevenLabs STT.
#[tauri::command]
pub async fn elevenlabs_transcribe_audio(
    audio_base64: String,
    filename: String,
) -> Result<String, String> {
    if !crate::elevenlabs::has_api_key() {
        return Err(
            "Set ELEVENLABS_API_KEY in .env. Voice input uses ElevenLabs.".into(),
        );
    }
    let bytes = STANDARD
        .decode(audio_base64.trim())
        .map_err(|e| format!("invalid base64: {e}"))?;
    if bytes.is_empty() {
        return Err("No audio data.".into());
    }
    let name = filename.trim();
    let fname = if name.is_empty() { "rec.webm" } else { name };
    let client = reqwest::Client::new();
    crate::elevenlabs::transcribe_audio_bytes(&client, bytes, fname)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_voice() {}

#[tauri::command]
pub async fn speak(text: String) -> Result<(), String> {
    if !voice::voice_tts_enabled() {
        return Ok(());
    }
    crate::tts::speak(&text).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notify_user(app: AppHandle, title: String, body: String) {
    notify::show(&app, &title, &body);
}

#[tauri::command]
pub async fn get_mcp_servers(state: tauri::State<'_, McpState>) -> Result<Vec<Value>, String> {
    let g = state.0.lock().await;
    Ok(g.status_values())
}

#[tauri::command]
pub async fn reload_mcp_config(
    app: AppHandle,
    state: tauri::State<'_, McpState>,
) -> Result<(), String> {
    let app_mcp = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("mcp-servers.json");
    let pool = crate::mcp::McpPool::connect_startup_paths(Some(app_mcp))
        .await
        .map_err(|e| e.to_string())?;
    *state.0.lock().await = pool;
    Ok(())
}

#[tauri::command]
pub fn wake_assistant(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found.".to_string())?;
    win.unminimize().map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_always_on_top(true).map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}
