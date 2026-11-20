// Janela principal: restaura posição e tamanho e salva ao fechar.
// O Tauri trabalha em pixels físicos, então a janela não cresce a cada abertura
// com escala fracionária, como acontecia no Electron.

use crate::settings::Settings;
use serde_json::{json, Map, Value};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow, Window, WindowEvent};

const MIN_VISIBLE_PX: i64 = 100;

// A posição salva só vale se uma parte razoável da janela cair numa tela atual.
fn is_on_some_display(window: &WebviewWindow, x: i64, y: i64, width: i64, height: i64) -> bool {
    let Ok(monitors) = window.available_monitors() else { return false };
    monitors.iter().any(|monitor| {
        let area = monitor.work_area();
        let (ax, ay) = (area.position.x as i64, area.position.y as i64);
        let (aw, ah) = (area.size.width as i64, area.size.height as i64);
        let visible_width = (x + width).min(ax + aw) - x.max(ax);
        let visible_height = (y + height).min(ay + ah) - y.max(ay);
        visible_width >= MIN_VISIBLE_PX && visible_height >= MIN_VISIBLE_PX
    })
}

pub fn restore(window: &WebviewWindow, settings: &Settings) {
    if let Value::Object(saved) = settings.get("window") {
        let read = |key: &str| saved.get(key).and_then(Value::as_i64);
        if let (Some(x), Some(y), Some(width), Some(height)) = (read("x"), read("y"), read("width"), read("height")) {
            let _ = window.set_size(PhysicalSize::new(width as u32, height as u32));
            // Se a tela de antes sumiu, a janela fica centralizada na principal.
            if is_on_some_display(window, x, y, width, height) {
                let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
            } else {
                let _ = window.center();
            }
        }
    }
    let _ = window.show();
}

pub fn save(window: &Window, settings: &Settings) {
    // Em tela cheia ou maximizada, guarda o tamanho normal de antes.
    if window.is_fullscreen().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else { return };
    let mut patch = Map::new();
    patch.insert(
        "window".into(),
        json!({ "x": position.x, "y": position.y, "width": size.width, "height": size.height }),
    );
    settings.save(patch);
}

pub fn on_main_event(window: &Window, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { .. } => save(window, &window.state::<Settings>()),
        // A coleção é auxiliar: fecha junto com a principal.
        WindowEvent::Destroyed => {
            if let Some(collection) = window.app_handle().get_webview_window("collection") {
                let _ = collection.close();
            }
        }
        _ => {}
    }
}

#[tauri::command]
pub fn window_toggle_fullscreen(window: Window) {
    let full = window.is_fullscreen().unwrap_or(false);
    let _ = window.set_fullscreen(!full);
}

#[tauri::command]
pub fn window_exit_fullscreen(window: Window) {
    let _ = window.set_fullscreen(false);
}
