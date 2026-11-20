// Modo navegador: servidor local que entrega a página do player e leva a oferta e
// a resposta WebRTC entre o app e a guia. O Meet só compartilha som de guias e da
// tela inteira, nunca de uma janela.
//
// HTTP mínimo feito à mão (std::net): são quatro arquivos, um fluxo SSE e um POST.
// Cada conexão fecha depois da resposta, menos o SSE.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

// Porta fixa: se o app reiniciar, a guia que já estava aberta se reconecta sozinha.
// Se ela estiver ocupada, o sistema escolhe outra, e a guia precisa ser reaberta.
const PREFERRED_PORT: u16 = 47830;
const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const KEEPALIVE: Duration = Duration::from_secs(15);
const SECURITY_HEADERS: &str = "Content-Security-Policy: default-src 'self'\r\n\
X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\n";

const FILES: [(&str, &[u8], &str); 4] = [
    ("/", include_bytes!("../../src/player/index.html"), "text/html; charset=utf-8"),
    ("/player.js", include_bytes!("../../src/player/player.js"), "text/javascript; charset=utf-8"),
    ("/player.css", include_bytes!("../../src/player/player.css"), "text/css; charset=utf-8"),
    ("/icon.svg", include_bytes!("../../src/player/icon.svg"), "image/svg+xml"),
];

struct Viewer {
    id: String,
    stream: TcpStream,
}

#[derive(Default)]
struct Inner {
    // Uma guia por vez: codificar o vídeo para várias guias custaria CPU à toa.
    viewer: Option<Viewer>,
    last_status: Option<Value>,
}

pub struct Share {
    port: Option<u16>,
    inner: Arc<Mutex<Inner>>,
}

fn random_id() -> String {
    use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    let mut bytes = [0u8; 16];
    unsafe {
        let _ = BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn write_event(stream: &mut TcpStream, kind: &str, data: &Value) -> std::io::Result<()> {
    stream.write_all(format!("event: {kind}\ndata: {data}\n\n").as_bytes())
}

fn respond(stream: &mut TcpStream, status: &str, extra: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\n{SECURITY_HEADERS}{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }
}

fn read_request(stream: &TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_owned();
    let target = parts.next()?.to_owned();
    let mut headers = Vec::new();
    let mut total = line.len();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        total += header.len();
        if total > MAX_HEADER_BYTES {
            return None;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (key, value) = header.split_once(':')?;
        headers.push((key.trim().to_owned(), value.trim().to_owned()));
    }
    let path = target.split('?').next().unwrap_or("/").to_owned();
    let mut request = Request { method, path, headers, body: Vec::new() };
    let length: usize = request.header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if length > MAX_BODY_BYTES {
        request.body = vec![0; MAX_BODY_BYTES + 1];
        return Some(request);
    }
    request.body = vec![0; length];
    reader.read_exact(&mut request.body).ok()?;
    Some(request)
}

impl Share {
    pub fn start(app: &AppHandle) -> Share {
        let inner = Arc::new(Mutex::new(Inner::default()));
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, PREFERRED_PORT)).or_else(|error| {
            eprintln!("porta {PREFERRED_PORT} em uso ({error}): o modo navegador vai usar outra");
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        });
        let Ok(listener) = listener else {
            eprintln!("modo navegador: não foi possível abrir o servidor local");
            return Share { port: None, inner };
        };
        let port = listener.local_addr().map(|address| address.port()).ok();
        let (shared, app) = (inner.clone(), app.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (shared, app) = (shared.clone(), app.clone());
                std::thread::spawn(move || handle(stream, port.unwrap_or(0), &shared, &app));
            }
        });
        // Comentários periódicos mantêm o SSE vivo e revelam guias fechadas.
        let keepalive = inner.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(KEEPALIVE);
            let mut state = keepalive.lock().unwrap();
            if let Some(viewer) = state.viewer.as_mut() {
                if viewer.stream.write_all(b": ping\n\n").is_err() {
                    state.viewer = None;
                }
            }
        });
        Share { port, inner }
    }

    pub fn url(&self) -> Option<String> {
        self.port.map(|port| format!("http://127.0.0.1:{port}/"))
    }

    fn current_viewer(&self) -> Option<String> {
        self.inner.lock().unwrap().viewer.as_ref().map(|viewer| viewer.id.clone())
    }

    fn send_offer(&self, id: &str, description: Value) {
        let mut state = self.inner.lock().unwrap();
        if let Some(viewer) = state.viewer.as_mut().filter(|viewer| viewer.id == id) {
            let _ = write_event(&mut viewer.stream, "offer", &json!({ "description": description }));
        }
    }

    fn send_status(&self, status: Value) {
        let mut state = self.inner.lock().unwrap();
        if let Some(viewer) = state.viewer.as_mut() {
            let _ = write_event(&mut viewer.stream, "status", &status);
        }
        state.last_status = Some(status);
    }
}

fn handle(mut stream: TcpStream, port: u16, shared: &Arc<Mutex<Inner>>, app: &AppHandle) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let Some(request) = read_request(&stream) else { return };
    let local = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    // Só aceita pedidos feitos para o próprio endereço local. Isso barra páginas de
    // outros sites que tentem falar com o servidor por DNS rebinding.
    if !request.header("host").is_some_and(|host| local.iter().any(|value| value == host)) {
        return respond(&mut stream, "403 Forbidden", "", b"");
    }
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/events") => open_events(stream, shared, app),
        ("POST", "/signal") => read_signal(&mut stream, &request, port, shared, app),
        ("GET", path) => match FILES.iter().find(|(name, _, _)| *name == path) {
            Some((_, body, mime)) => respond(&mut stream, "200 OK", &format!("Content-Type: {mime}\r\n"), body),
            None => respond(&mut stream, "404 Not Found", "", b""),
        },
        _ => respond(&mut stream, "405 Method Not Allowed", "", b""),
    }
}

fn open_events(mut stream: TcpStream, shared: &Arc<Mutex<Inner>>, app: &AppHandle) {
    let _ = stream.set_read_timeout(None);
    let head = format!(
        "HTTP/1.1 200 OK\r\n{SECURITY_HEADERS}Content-Type: text/event-stream; charset=utf-8\r\nConnection: keep-alive\r\n\r\nretry: 2000\n\n"
    );
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    let id = random_id();
    let Ok(watch) = stream.try_clone() else { return };
    {
        let mut state = shared.lock().unwrap();
        // Uma guia nova assume o lugar da anterior.
        if let Some(mut previous) = state.viewer.take() {
            let _ = write_event(&mut previous.stream, "replaced", &json!({}));
            let _ = previous.stream.shutdown(std::net::Shutdown::Both);
        }
        let _ = write_event(&mut stream, "hello", &json!({ "id": id }));
        if let Some(status) = state.last_status.clone() {
            let _ = write_event(&mut stream, "status", &status);
        }
        state.viewer = Some(Viewer { id: id.clone(), stream });
    }
    let _ = app.emit_to("main", "share:viewer", Some(id.clone()));

    // A guia nunca manda nada por aqui: a leitura só termina quando ela fecha.
    let mut watch = watch;
    let mut sink = [0u8; 256];
    while matches!(watch.read(&mut sink), Ok(n) if n > 0) {}
    let mut state = shared.lock().unwrap();
    if state.viewer.as_ref().is_some_and(|viewer| viewer.id == id) {
        state.viewer = None;
        drop(state);
        let _ = app.emit_to("main", "share:viewer", None::<String>);
    }
}

fn read_signal(stream: &mut TcpStream, request: &Request, port: u16, shared: &Arc<Mutex<Inner>>, app: &AppHandle) {
    let origins = [format!("http://127.0.0.1:{port}"), format!("http://localhost:{port}")];
    let same_origin = request.header("origin").is_some_and(|origin| origins.iter().any(|value| value == origin));
    let json_body = request.header("content-type").is_some_and(|value| value.starts_with("application/json"));
    if !same_origin || !json_body {
        return respond(stream, "403 Forbidden", "", b"");
    }
    if request.body.len() > MAX_BODY_BYTES {
        return respond(stream, "413 Payload Too Large", "", b"");
    }
    let Ok(message) = serde_json::from_slice::<Value>(&request.body) else {
        return respond(stream, "400 Bad Request", "", b"");
    };
    let id = message.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
    let description = message.get("description");
    let is_answer = description.and_then(|d| d.get("type")).and_then(Value::as_str) == Some("answer");
    // Resposta de uma guia que já foi substituída: ignora.
    let current = shared.lock().unwrap().viewer.as_ref().map(|viewer| viewer.id.clone());
    if current.as_deref() != Some(id.as_str()) || !is_answer {
        return respond(stream, "409 Conflict", "", b"");
    }
    let sdp = description.and_then(|d| d.get("sdp")).and_then(Value::as_str).unwrap_or_default();
    respond(stream, "204 No Content", "", b"");
    let _ = app.emit_to("main", "share:answer", json!({ "id": id, "description": { "type": "answer", "sdp": sdp } }));
}

#[tauri::command]
pub fn share_current(share: tauri::State<'_, Share>) -> Value {
    json!({ "url": share.url(), "viewer": share.current_viewer() })
}

#[tauri::command]
pub fn share_offer(share: tauri::State<'_, Share>, id: String, description: Value) {
    share.send_offer(&id, description);
}

#[tauri::command]
pub fn share_status(share: tauri::State<'_, Share>, status: Value) {
    share.send_status(status);
}

#[tauri::command]
pub fn share_open(app: AppHandle, share: tauri::State<'_, Share>) {
    if let Some(url) = share.url() {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}
