mod ai;
mod audio_output;
mod commands;
mod context;
mod elevenlabs;
mod mcp;
mod notify;
mod tts;
mod voice;

use commands::McpState;
use mcp::McpPool;
use std::path::Path;
use std::sync::Arc;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tokio::sync::Mutex;

/// Load `.env` from the repo root and `src-tauri/` (and finally process cwd).
/// `dotenvy` does not overwrite variables already set in the real environment.
fn load_env_files() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for p in [
        manifest.join("../.env"),
        manifest.join(".env"),
    ] {
        if p.is_file() {
            let _ = dotenvy::from_path(p);
        }
    }
    let _ = dotenvy::dotenv();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    load_env_files();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(McpState(Arc::new(Mutex::new(McpPool::new()))))
        .invoke_handler(tauri::generate_handler![
            commands::send_message,
            commands::start_voice,
            commands::stop_voice,
            commands::speak,
            commands::notify_user,
            commands::get_mcp_servers,
            commands::reload_mcp_config,
            commands::elevenlabs_transcribe_audio,
            commands::wake_assistant,
        ])
        .setup(|app| {
            let show_item = MenuItemBuilder::new("Show OpenJarvis")
                .id("show")
                .build(app)?;
            let quit_item = MenuItemBuilder::new("Quit")
                .id("quit")
                .build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;
            let app_for_tray = app.handle().clone();
            TrayIconBuilder::new()
                .menu(&tray_menu)
                .on_menu_event(move |app: &tauri::AppHandle, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_always_on_top(true);
                            let _ = w.set_focus();
                            let _ = w.emit("activate_voice", ());
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(w) = app_for_tray.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_always_on_top(true);
                            let _ = w.set_focus();
                            let _ = w.emit("activate_voice", ());
                        }
                    }
                })
                .build(app)?;

            let state = app.state::<McpState>();
            let app_mcp = app
                .path()
                .app_config_dir()
                .ok()
                .map(|d| d.join("mcp-servers.json"));
            match tauri::async_runtime::block_on(McpPool::connect_startup_paths(app_mcp)) {
                Ok(pool) => {
                    *tauri::async_runtime::block_on(state.0.lock()) = pool;
                }
                Err(e) => {
                    eprintln!("OpenJarvis MCP: failed to load config: {e}");
                }
            }

            use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

            #[cfg(target_os = "macos")]
            let mods = Modifiers::SUPER | Modifiers::SHIFT;
            #[cfg(not(target_os = "macos"))]
            let mods = Modifiers::CONTROL | Modifiers::SHIFT;

            let shortcut = Shortcut::new(Some(mods), Code::Space);
            let handle = app.handle().clone();

            handle.global_shortcut().on_shortcut(shortcut, move |app, _shortcut, event| {
                use tauri_plugin_global_shortcut::ShortcutState;
                if event.state != ShortcutState::Pressed {
                    return;
                }
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                    // Target the webview so the React listener always receives the event.
                    let _ = w.emit("activate_voice", ());
                }
            })?;

            if let Some(w) = app.get_webview_window("main") {
                let app_for_close = app.handle().clone();
                w.on_window_event(move |e| {
                    if let WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        if let Some(win) = app_for_close.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OpenJarvis");
}
