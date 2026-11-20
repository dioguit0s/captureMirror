// Clipes: pasta, lista, gravação, Lixeira, protocolo clip:// e arrastar.
//
// Arquivos em Vídeos\Capture Mirror. A miniatura (.jpg) e a duração (.json) de cada
// clipe ficam em .thumbs, com o mesmo nome-base do .mp4.

use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::ipc::InvokeBody;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

const THUMBS: &str = ".thumbs";
// O player pede pedaços do vídeo. Um pedido sem fim definido recebe no máximo isto.
const MAX_CHUNK: u64 = 4 * 1024 * 1024;

pub fn clips_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path().video_dir().unwrap_or_else(|_| PathBuf::from(".")).join("Capture Mirror")
}

fn thumbs_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    clips_dir(app).join(THUMBS)
}

fn base_name(name: &str) -> &str {
    name.strip_suffix(".mp4").or_else(|| name.strip_suffix(".MP4")).unwrap_or(name)
}

/// Os nomes vêm do renderer: só aceita um .mp4 direto na pasta de clipes.
pub fn clip_path<R: Runtime>(app: &AppHandle<R>, name: &str) -> Option<PathBuf> {
    let plain = Path::new(name).file_name()?.to_str()? == name;
    let mp4 = Path::new(name).extension()?.to_str()?.eq_ignore_ascii_case("mp4");
    (plain && mp4 && !name.contains(['/', '\\'])).then(|| clips_dir(app).join(name))
}

fn thumb_path<R: Runtime>(app: &AppHandle<R>, name: &str) -> PathBuf {
    thumbs_dir(app).join(format!("{}.jpg", base_name(name)))
}

fn info_path<R: Runtime>(app: &AppHandle<R>, name: &str) -> PathBuf {
    thumbs_dir(app).join(format!("{}.json", base_name(name)))
}

// "Clipe AAAA-MM-DD HH-MM-SS.mp4" no horário local, com (2), (3)... se repetir.
fn unique_name<R: Runtime>(app: &AppHandle<R>) -> String {
    let stamp = local_stamp();
    let mut n = 1;
    loop {
        let name = if n == 1 { format!("Clipe {stamp}.mp4") } else { format!("Clipe {stamp} ({n}).mp4") };
        if !clips_dir(app).join(&name).exists() {
            return name;
        }
        n += 1;
    }
}

fn local_stamp() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}-{:02}-{:02} {:02}-{:02}-{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    )
}

fn encode(name: &str) -> String {
    utf8_percent_encode(name, NON_ALPHANUMERIC).to_string()
}

#[derive(Serialize)]
pub struct Clip {
    name: String,
    size: u64,
    date: f64,
    duration: Option<f64>,
    url: String,
    thumb: Option<String>,
}

// O clipe chega em blocos, com a posição de cada um no arquivo: um clipe de 5 min
// passa de 300 MB, e mandá-lo de uma vez fazia o WebView2 copiar o pedido inteiro
// várias vezes (8 GB de pico, medido). Grava com outro nome e renomeia no fim: a
// coleção nunca lista um clipe pela metade.
struct Pending {
    file: fs::File,
    temp: PathBuf,
    name: String,
    thumb: Vec<u8>,
}

#[derive(Default)]
pub struct Writing(std::sync::Mutex<Option<Pending>>);

fn begin<R: Runtime>(app: &AppHandle<R>, thumb: Vec<u8>) -> std::io::Result<Pending> {
    fs::create_dir_all(thumbs_dir(app))?;
    let name = unique_name(app);
    let temp = thumbs_dir(app).join(format!("{}.part", base_name(&name)));
    let file = fs::OpenOptions::new().create(true).write(true).truncate(true).open(&temp)?;
    Ok(Pending { file, temp, name, thumb })
}

fn finish<R: Runtime>(app: &AppHandle<R>, pending: Pending, duration: f64) -> std::io::Result<String> {
    let Pending { file, temp, name, thumb } = pending;
    file.sync_all()?;
    drop(file);
    if !thumb.is_empty() {
        fs::write(thumb_path(app, &name), thumb)?;
    }
    fs::write(info_path(app, &name), serde_json::json!({ "duration": duration }).to_string())?;
    fs::rename(&temp, clips_dir(app).join(&name))?;
    Ok(name)
}

fn read_duration<R: Runtime>(app: &AppHandle<R>, name: &str) -> Option<f64> {
    let text = fs::read_to_string(info_path(app, name)).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok()?.get("duration")?.as_f64()
}

pub fn list<R: Runtime>(app: &AppHandle<R>) -> Vec<Clip> {
    let Ok(entries) = fs::read_dir(clips_dir(app)) else { return Vec::new() };
    let mut clips: Vec<Clip> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_owned();
            clip_path(app, &name)?;
            // O arquivo pode sumir entre a leitura da pasta e o stat.
            let meta = entry.metadata().ok().filter(|meta| meta.is_file())?;
            let date = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as f64;
            Some(Clip {
                size: meta.len(),
                date,
                duration: read_duration(app, &name),
                url: format!("http://clip.localhost/media/{}", encode(&name)),
                thumb: thumb_path(app, &name)
                    .exists()
                    .then(|| format!("http://clip.localhost/thumb/{}", encode(&name))),
                name,
            })
        })
        .collect();
    clips.sort_by(|a, b| b.date.total_cmp(&a.date));
    clips
}

/// Vai para a Lixeira, de onde pode ser restaurado. A miniatura é só cache do app.
pub fn trash_clip<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<(), String> {
    let Some(file) = clip_path(app, name) else { return Ok(()) };
    trash::delete(&file).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(thumb_path(app, name));
    let _ = fs::remove_file(info_path(app, name));
    Ok(())
}

// clip://media/<nome.mp4> e clip://thumb/<nome.mp4>, que o WebView2 vê como
// http://clip.localhost/... Responde a Range (206): sem isso o player não avança.
pub fn serve<R: Runtime>(app: &AppHandle<R>, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let empty = |status: StatusCode| Response::builder().status(status).body(Vec::new()).unwrap();
    let path = request.uri().path();
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let (Some(kind), Some(encoded)) = (parts.next(), parts.next()) else { return empty(StatusCode::NOT_FOUND) };
    let name = percent_decode_str(encoded).decode_utf8_lossy().into_owned();
    let Some(clip) = clip_path(app, &name) else { return empty(StatusCode::NOT_FOUND) };
    let (file, mime) = match kind {
        "media" => (clip, "video/mp4"),
        "thumb" => (thumb_path(app, &name), "image/jpeg"),
        _ => return empty(StatusCode::NOT_FOUND),
    };
    let Ok(mut handle) = fs::File::open(&file) else { return empty(StatusCode::NOT_FOUND) };
    let Ok(size) = handle.metadata().map(|meta| meta.len()) else { return empty(StatusCode::NOT_FOUND) };

    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes="))
        .and_then(|value| value.split_once('-'));
    let builder = Response::builder().header(header::CONTENT_TYPE, mime).header(header::ACCEPT_RANGES, "bytes");

    let Some((from, to)) = range.filter(|(from, to)| !from.is_empty() || !to.is_empty()) else {
        let mut body = Vec::with_capacity(size as usize);
        if handle.read_to_end(&mut body).is_err() {
            return empty(StatusCode::INTERNAL_SERVER_ERROR);
        }
        return builder.status(StatusCode::OK).body(body).unwrap();
    };
    // "bytes=-N" pede os últimos N bytes.
    let (start, end) = match (from.parse::<u64>().ok(), to.parse::<u64>().ok()) {
        (Some(start), Some(end)) => (start, end.min(size.saturating_sub(1))),
        (Some(start), None) => (start, (start + MAX_CHUNK - 1).min(size.saturating_sub(1))),
        (None, Some(last)) => (size.saturating_sub(last), size.saturating_sub(1)),
        (None, None) => (0, size.saturating_sub(1)),
    };
    if size == 0 || start > end {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{size}"))
            .body(Vec::new())
            .unwrap();
    }
    let mut body = vec![0; (end - start + 1) as usize];
    if handle.seek(SeekFrom::Start(start)).is_err() || handle.read_exact(&mut body).is_err() {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    }
    builder
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
        .body(body)
        .unwrap()
}

// Janela separada de propósito: o Go Live compartilha só a janela principal, e
// quem assiste não vê a coleção.
pub fn open_collection<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("collection") {
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    // O WebView2 exige as mesmas flags em todas as janelas do app.
    let args = app
        .config()
        .app
        .windows
        .first()
        .and_then(|window| window.additional_browser_args.clone())
        .unwrap_or_default();
    let built = tauri::WebviewWindowBuilder::new(app, "collection", tauri::WebviewUrl::App("renderer/clips.html".into()))
        .title("Capture Mirror — Clipes")
        .inner_size(1000.0, 680.0)
        .min_inner_size(480.0, 360.0)
        .background_color(tauri::window::Color(0x14, 0x14, 0x14, 0xff))
        .disable_drag_drop_handler()
        .additional_browser_args(&args)
        .build();
    if let Err(error) = built {
        eprintln!("coleção: {error}");
    }
}

fn notify_changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit_to("collection", "clips:changed", ());
}

// Aviso do Windows "Clipe salvo". Clicar abre a coleção. Um aviso dentro da janela
// iria para o stream.
fn notify_saved<R: Runtime>(app: &AppHandle<R>, name: &str, duration: f64) {
    use tauri_winrt_notification::{Duration as ToastDuration, Toast};
    // Sem instalador, o Windows só mostra avisos de um app registrado: em dev usa
    // o do PowerShell, como o plugin oficial de notificações.
    let app_id = if cfg!(debug_assertions) { Toast::POWERSHELL_APP_ID.to_owned() } else { app.config().identifier.clone() };
    let handle = app.clone();
    let shown = Toast::new(&app_id)
        .title("Clipe salvo")
        .text1(&format!("{} s · {name}", duration.round() as i64))
        .duration(ToastDuration::Short)
        .sound(None)
        .on_activated(move |_| {
            open_collection(&handle);
            Ok(())
        })
        .show();
    if let Err(error) = shown {
        eprintln!("aviso de clipe salvo: {error}");
    }
}

fn header_number(request: &tauri::ipc::Request<'_>, name: &str) -> Option<f64> {
    request.headers().get(name)?.to_str().ok()?.parse().ok()
}

/// Começa um clipe. O corpo é a miniatura (pode vir vazio).
#[tauri::command]
pub fn clips_begin<R: Runtime>(
    app: AppHandle<R>,
    writing: tauri::State<'_, Writing>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let thumb = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        _ => Vec::new(),
    };
    let mut slot = writing.0.lock().unwrap();
    // Um clipe anterior que ficou pela metade: apaga.
    if let Some(old) = slot.take() {
        let _ = fs::remove_file(&old.temp);
    }
    *slot = Some(begin(&app, thumb).map_err(|error| error.to_string())?);
    Ok(())
}

/// Um bloco do MP4, na posição do header x-position.
#[tauri::command]
pub fn clips_write(writing: tauri::State<'_, Writing>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else { return Err("bloco do clipe ausente".into()) };
    let position = header_number(&request, "x-position").ok_or("posição do bloco ausente")? as u64;
    let mut slot = writing.0.lock().unwrap();
    let pending = slot.as_mut().ok_or("nenhum clipe em gravação")?;
    use std::io::Write;
    pending.file.seek(SeekFrom::Start(position)).map_err(|error| error.to_string())?;
    pending.file.write_all(data).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clips_finish<R: Runtime>(
    app: AppHandle<R>,
    writing: tauri::State<'_, Writing>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let duration = header_number(&request, "x-duration").unwrap_or(0.0);
    let pending = writing.0.lock().unwrap().take().ok_or("nenhum clipe em gravação")?;
    let temp = pending.temp.clone();
    let name = finish(&app, pending, duration).map_err(|error| {
        let _ = fs::remove_file(&temp);
        error.to_string()
    })?;
    notify_saved(&app, &name, duration);
    notify_changed(&app);
    Ok(name)
}

#[tauri::command]
pub fn clips_abort(writing: tauri::State<'_, Writing>) {
    if let Some(pending) = writing.0.lock().unwrap().take() {
        drop(pending.file);
        let _ = fs::remove_file(&pending.temp);
    }
}

#[tauri::command]
pub fn clips_list<R: Runtime>(app: AppHandle<R>) -> Vec<Clip> {
    list(&app)
}

#[tauri::command]
pub fn clips_trash<R: Runtime>(app: AppHandle<R>, name: String) -> Result<(), String> {
    trash_clip(&app, &name)?;
    notify_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn clips_show<R: Runtime>(app: AppHandle<R>, name: String) {
    if let Some(file) = clip_path(&app, &name) {
        let _ = app.opener().reveal_item_in_dir(file);
    }
}

#[tauri::command]
pub fn clips_open_folder<R: Runtime>(app: AppHandle<R>) {
    let dir = clips_dir(&app);
    let _ = fs::create_dir_all(&dir);
    let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
}

// Assíncrono de propósito: no Windows, criar janela num comando síncrono trava o
// WebView2 novo em about:blank.
#[tauri::command]
pub async fn collection_open<R: Runtime>(app: AppHandle<R>) {
    open_collection(&app);
}

// Arrastar o card leva o arquivo de verdade: dá para soltar no Discord ou no Explorer.
#[tauri::command]
pub fn clips_drag<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, name: String) {
    let Some(file) = clip_path(&app, &name) else { return };
    let thumb = thumb_path(&app, &name);
    let image = if thumb.exists() {
        drag::Image::File(thumb)
    } else {
        drag::Image::Raw(include_bytes!("../icons/128x128.png").to_vec())
    };
    let _ = app.run_on_main_thread(move || {
        let result = drag::start_drag(&window, drag::DragItem::Files(vec![file]), image, |_, _| {}, Default::default());
        if let Err(error) = result {
            eprintln!("arrastar clipe: {error}");
        }
    });
}
