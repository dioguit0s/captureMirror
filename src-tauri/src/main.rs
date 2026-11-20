#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod clips;
mod settings;
mod share;
mod shortcuts;
mod window;

use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(shortcuts::plugin())
        // Câmera e microfone sem perguntar: a página é do próprio app.
        .on_permission_request(|webview, kind| {
            // Em dev, o Tauri serve as páginas por 127.0.0.1 em vez de tauri.localhost.
            let local = webview
                .url()
                .map(|url| match url.host_str() {
                    Some("tauri.localhost") => true,
                    Some("127.0.0.1") => cfg!(debug_assertions),
                    _ => false,
                })
                .unwrap_or(false);
            match kind {
                PermissionKind::Camera | PermissionKind::Microphone if local => PermissionResponse::Allow,
                _ => PermissionResponse::Default,
            }
        })
        // Vídeos e miniaturas da coleção. Lê o disco fora da thread da UI.
        .register_asynchronous_uri_scheme_protocol("clip", |context, request, responder| {
            let app = context.app_handle().clone();
            std::thread::spawn(move || responder.respond(clips::serve(&app, &request)));
        })
        .setup(|app| {
            let settings = settings::Settings::load(app.handle());
            let main = app.get_webview_window("main").expect("janela principal");
            window::restore(&main, &settings);
            app.manage(settings);
            app.manage(audio::Audio::start(app.handle()));
            app.manage(shortcuts::register(app.handle()));
            app.manage(share::Share::start(app.handle()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                window::on_main_event(window, event);
            }
        })
        .invoke_handler(tauri::generate_handler![
            settings::settings_load,
            settings::settings_save,
            window::window_toggle_fullscreen,
            window::window_exit_fullscreen,
            audio::audio_list,
            audio::audio_open,
            audio::audio_close,
            audio::audio_set_volume,
            audio::audio_set_muted,
            audio::audio_set_local,
            audio::audio_set_low_latency,
            audio::loopback_start,
            audio::loopback_stop,
            shortcuts::clips_shortcuts,
            clips::clips_save,
            clips::clips_list,
            clips::clips_trash,
            clips::clips_show,
            clips::clips_open_folder,
            clips::clips_drag,
            clips::collection_open,
            share::share_current,
            share::share_offer,
            share::share_status,
            share::share_open,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o app");
}
