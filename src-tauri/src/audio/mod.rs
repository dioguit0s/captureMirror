// Comandos de áudio para o renderer e avisos de troca de dispositivo.

mod engine;
mod loopback;
pub mod wasapi;

use engine::{Engine, OpenInfo, Status};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use wasapi::{AudioError, Device};
use windows::core::{implement, PCWSTR};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::{
    eConsole, eRender, EDataFlow, ERole, IMMNotificationClient, IMMNotificationClient_Impl, DEVICE_STATE,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

pub struct Audio {
    engine: std::sync::Arc<Engine>,
    loopback: loopback::Loopback,
}

impl Audio {
    pub fn start(app: &AppHandle) -> Audio {
        let emitter = app.clone();
        let engine = std::sync::Arc::new(Engine::start(move |status| {
            let payload = match status {
                Status::Lost { generation, error } => json!({ "generation": generation, "state": "lost", "error": error }),
                Status::Reopened { generation, info } => json!({ "generation": generation, "state": "open", "info": info }),
            };
            let _ = emitter.emit("audio:status", payload);
        }));
        watch_devices(app.clone(), engine.clone());
        Audio { engine, loopback: loopback::Loopback::default() }
    }
}

// Avisos do Windows: dispositivo novo, removido, ou outra saída padrão.
#[implement(IMMNotificationClient)]
struct Notifier {
    app: AppHandle,
    engine: std::sync::Arc<Engine>,
}

impl IMMNotificationClient_Impl for Notifier_Impl {
    fn OnDeviceStateChanged(&self, _id: &PCWSTR, _state: DEVICE_STATE) -> windows::core::Result<()> {
        let _ = self.app.emit("audio:devices", ());
        Ok(())
    }

    fn OnDeviceAdded(&self, _id: &PCWSTR) -> windows::core::Result<()> {
        let _ = self.app.emit("audio:devices", ());
        Ok(())
    }

    fn OnDeviceRemoved(&self, _id: &PCWSTR) -> windows::core::Result<()> {
        let _ = self.app.emit("audio:devices", ());
        Ok(())
    }

    fn OnDefaultDeviceChanged(&self, flow: EDataFlow, role: ERole, _id: &PCWSTR) -> windows::core::Result<()> {
        // Fone conectado ou outra saída escolhida no Windows: o som acompanha.
        if flow == eRender && role == eConsole {
            self.engine.rebuild();
        }
        Ok(())
    }

    fn OnPropertyValueChanged(&self, _id: &PCWSTR, _key: &PROPERTYKEY) -> windows::core::Result<()> {
        Ok(())
    }
}

// O registro precisa de um enumerador vivo. Uma thread própria o mantém.
fn watch_devices(app: AppHandle, engine: std::sync::Arc<Engine>) {
    std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(enumerator) = wasapi::enumerator() else { return };
        let client: IMMNotificationClient = Notifier { app, engine }.into();
        if enumerator.RegisterEndpointNotificationCallback(&client).is_err() {
            return;
        }
        loop {
            std::thread::park();
        }
    });
}

fn in_com<T>(work: impl FnOnce() -> T) -> T {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    work()
}

#[tauri::command]
pub async fn audio_list() -> Result<Vec<Device>, AudioError> {
    tauri::async_runtime::spawn_blocking(|| in_com(|| Ok(wasapi::list_capture(&wasapi::enumerator()?)?)))
        .await
        .map_err(|error| AudioError::new("AbortError", error.to_string()))?
}

#[tauri::command]
pub async fn audio_open(audio: State<'_, Audio>, id: String, generation: u64) -> Result<OpenInfo, AudioError> {
    let engine = audio.engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.open(id, generation))
        .await
        .map_err(|error| AudioError::new("AbortError", error.to_string()))?
}

#[tauri::command]
pub fn audio_close(audio: State<'_, Audio>, generation: u64) {
    audio.engine.close(generation);
}

#[tauri::command]
pub fn audio_set_volume(audio: State<'_, Audio>, value: f32) {
    audio.engine.set_volume(value);
}

#[tauri::command]
pub fn audio_set_muted(audio: State<'_, Audio>, value: bool) {
    audio.engine.set_muted(value);
}

#[tauri::command]
pub fn audio_set_local(audio: State<'_, Audio>, enabled: bool) {
    audio.engine.set_local(enabled);
}

#[tauri::command]
pub fn audio_set_low_latency(audio: State<'_, Audio>, enabled: bool) {
    audio.engine.set_raw(enabled);
}

/// Som do PC para os clipes, em blocos binários pelo canal.
#[tauri::command]
pub fn loopback_start(audio: State<'_, Audio>, channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>) {
    audio.loopback.start(channel);
}

#[tauri::command]
pub fn loopback_stop(audio: State<'_, Audio>) {
    audio.loopback.stop();
}
