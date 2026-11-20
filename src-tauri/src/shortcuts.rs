// Atalhos globais dos clipes: funcionam com qualquer janela em foco, como o
// Discord ou um jogo. Atalho ocupado por outro app vira aviso no overlay.

use serde_json::{json, Value};
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const CLIP_SHORTCUTS: [(&str, &str, u32); 2] = [
    ("CommandOrControl+Shift+F9", "Ctrl+Shift+F9", 30),
    ("CommandOrControl+Shift+F10", "Ctrl+Shift+F10", 60),
];

pub struct Shortcuts {
    failed: Vec<String>,
}

fn seconds_for(shortcut: &Shortcut) -> Option<u32> {
    CLIP_SHORTCUTS
        .iter()
        .find(|(accelerator, _, _)| accelerator.parse::<Shortcut>().is_ok_and(|parsed| &parsed == shortcut))
        .map(|(_, _, seconds)| *seconds)
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            if let Some(seconds) = seconds_for(shortcut) {
                let _ = app.emit_to("main", "clip:request", seconds);
            }
        })
        .build()
}

pub fn register<R: Runtime>(app: &AppHandle<R>) -> Shortcuts {
    let mut failed = Vec::new();
    for (accelerator, label, _) in CLIP_SHORTCUTS {
        let registered = accelerator
            .parse::<Shortcut>()
            .map_err(|error| error.to_string())
            .and_then(|shortcut| app.global_shortcut().register(shortcut).map_err(|error| error.to_string()));
        if let Err(error) = registered {
            eprintln!("atalho {label} em uso por outro aplicativo: {error}");
            failed.push(label.to_owned());
        }
    }
    Shortcuts { failed }
}

#[tauri::command]
pub fn clips_shortcuts(state: tauri::State<'_, Shortcuts>) -> Value {
    let shortcuts: Vec<Value> = CLIP_SHORTCUTS
        .iter()
        .map(|(_, label, seconds)| json!({ "label": label, "seconds": seconds }))
        .collect();
    json!({ "shortcuts": shortcuts, "failed": state.failed })
}
