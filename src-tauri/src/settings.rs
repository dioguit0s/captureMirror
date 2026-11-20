// Configuração em JSON na pasta de dados do app. Gravação atômica: escreve em
// outro arquivo e renomeia, para uma queda no meio não corromper o arquivo.

use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

// O renderer só pode gravar estas chaves. "window" é gravada pelo próprio Rust.
const SAVABLE_KEYS: &[&str] = &["video", "audio", "volume", "clipMic", "resolution", "lowLatency"];

fn defaults() -> Map<String, Value> {
    match json!({
        "video": null,
        "audio": null,
        "volume": 1,
        "clipMic": null,
        "resolution": "720p",
        "lowLatency": true,
        "window": null,
    }) {
        Value::Object(map) => map,
        _ => unreachable!(),
    }
}

pub struct Settings {
    path: PathBuf,
    current: Mutex<Map<String, Value>>,
}

impl Settings {
    pub fn load(app: &AppHandle) -> Self {
        let dir = app.path().app_data_dir().expect("pasta de dados do app");
        let path = dir.join("settings.json");
        migrate_from_electron(app, &path);
        let mut current = defaults();
        if let Ok(text) = fs::read_to_string(&path) {
            // Arquivo corrompido: o app abre com os valores padrão.
            if let Ok(Value::Object(saved)) = serde_json::from_str::<Value>(&text) {
                current.extend(saved);
            }
        }
        Settings { path, current: Mutex::new(current) }
    }

    pub fn snapshot(&self) -> Map<String, Value> {
        self.current.lock().unwrap().clone()
    }

    pub fn get(&self, key: &str) -> Value {
        self.current.lock().unwrap().get(key).cloned().unwrap_or(Value::Null)
    }

    /// Grava só as chaves que o renderer pode mudar.
    pub fn save_from_renderer(&self, patch: Map<String, Value>) {
        let allowed = patch.into_iter().filter(|(key, _)| SAVABLE_KEYS.contains(&key.as_str())).collect();
        self.save(allowed);
    }

    pub fn save(&self, patch: Map<String, Value>) {
        let snapshot = {
            let mut current = self.current.lock().unwrap();
            current.extend(patch);
            current.clone()
        };
        if let Err(error) = self.write(&snapshot) {
            eprintln!("configuração: {error}");
        }
    }

    fn write(&self, value: &Map<String, Value>) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, serde_json::to_string_pretty(value).unwrap_or_default())?;
        fs::rename(&temp, &self.path)
    }
}

// Na primeira abertura depois da troca do Electron, aproveita os dispositivos, o
// volume e a resolução salvos. Os limites da janela não: estavam em outra unidade.
fn migrate_from_electron(app: &AppHandle, path: &PathBuf) {
    if path.exists() {
        return;
    }
    let Ok(roaming) = app.path().config_dir() else { return };
    let old = roaming.join("Capture Mirror").join("settings.json");
    let Ok(text) = fs::read_to_string(&old) else { return };
    let Ok(Value::Object(mut saved)) = serde_json::from_str::<Value>(&text) else { return };
    saved.remove("bounds");
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(path, serde_json::to_string_pretty(&saved).unwrap_or_default());
}

#[tauri::command]
pub fn settings_load(settings: tauri::State<Settings>) -> Map<String, Value> {
    settings.snapshot()
}

#[tauri::command]
pub fn settings_save(settings: tauri::State<Settings>, patch: Map<String, Value>) {
    settings.save_from_renderer(patch);
}
