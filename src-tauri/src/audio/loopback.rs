// Som do PC para os clipes: loopback WASAPI da saída padrão, entregue ao renderer
// em blocos de ~10 ms (float 32, 48 kHz, estéreo intercalado).
//
// No Electron isso vinha do getDisplayMedia. No WebView2 ele abriria o seletor de
// tela do Edge a cada abertura, então o loopback passou para cá.

use super::wasapi::{self, AudioError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    WAVEFORMATEX,
};
use windows::Win32::Media::Multimedia::WAVE_FORMAT_IEEE_FLOAT;
use windows::Win32::System::Com::{CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

const RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
const CHUNK_FRAMES: usize = 480;
// 200 ms de buffer no Windows: o thread lê a cada 5 ms, então sobra folga.
const BUFFER_HNS: i64 = 2_000_000;

#[derive(Default)]
pub struct Loopback {
    running: Mutex<Option<Arc<AtomicBool>>>,
}

impl Loopback {
    pub fn start(&self, channel: Channel<InvokeResponseBody>) {
        self.stop();
        let running = Arc::new(AtomicBool::new(true));
        *self.running.lock().unwrap() = Some(running.clone());
        std::thread::Builder::new()
            .name("loopback".into())
            .spawn(move || unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                while running.load(Ordering::Relaxed) {
                    // Saída padrão trocada ou serviço de áudio reiniciado: reabre.
                    if let Err(error) = capture(&running, &channel) {
                        eprintln!("loopback: {} {}", error.name, error.message);
                        std::thread::sleep(Duration::from_millis(500));
                    }
                }
            })
            .expect("thread do loopback");
    }

    pub fn stop(&self) {
        if let Some(running) = self.running.lock().unwrap().take() {
            running.store(false, Ordering::Relaxed);
        }
    }
}

unsafe fn capture(running: &AtomicBool, channel: &Channel<InvokeResponseBody>) -> Result<(), AudioError> {
    let enumerator = wasapi::enumerator()?;
    let speakers = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
    let client: IAudioClient = speakers.Activate(CLSCTX_ALL, None)?;
    let block = CHANNELS * 4;
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16,
        nChannels: CHANNELS,
        nSamplesPerSec: RATE,
        nAvgBytesPerSec: RATE * block as u32,
        nBlockAlign: block,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        BUFFER_HNS,
        0,
        &format,
        None,
    )?;
    let capture: IAudioCaptureClient = client.GetService()?;
    client.Start()?;
    let mut pending: Vec<u8> = Vec::with_capacity(CHUNK_FRAMES * block as usize * 2);
    let result = (|| -> Result<(), AudioError> {
        while running.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(5));
            loop {
                let packet = capture.GetNextPacketSize()?;
                if packet == 0 {
                    break;
                }
                let mut data = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                let bytes = frames as usize * block as usize;
                if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                    pending.resize(pending.len() + bytes, 0);
                } else {
                    pending.extend_from_slice(std::slice::from_raw_parts(data, bytes));
                }
                capture.ReleaseBuffer(frames)?;
            }
            let chunk = CHUNK_FRAMES * block as usize;
            while pending.len() >= chunk {
                let rest = pending.split_off(chunk);
                let body = std::mem::replace(&mut pending, rest);
                // A janela fechou ou recarregou: para de capturar.
                if channel.send(InvokeResponseBody::Raw(body)).is_err() {
                    running.store(false, Ordering::Relaxed);
                    break;
                }
            }
        }
        Ok(())
    })();
    let _ = client.Stop();
    result
}
