// Motor de áudio: leva o som da placa direto para a saída padrão pelo WASAPI.
//
// Por que não pelo Chromium: medido no notebook de teste, o caminho do Chromium
// leva ~120 ms da placa até a mixagem do Windows. Daqui, com o stream de saída em
// modo raw (que pula os efeitos do driver, como o Dolby), são ~65 ms.
//
// Uma thread só atende a placa e a saída, com prioridade de áudio (MMCSS). A
// fila entre as duas fica no mínimo que não falha: um pacote da placa mais um
// período da saída. O que passar disso (relógios diferentes, uma travada) é
// descartado, para o atraso nunca acumular.

use super::wasapi::{self, AudioError, MixFormat};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;
use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::Audio::{
    eConsole, eRender, AudioCategory_GameMedia, AudioClientProperties, IAudioCaptureClient, IAudioClient,
    IAudioClient3, IAudioRenderClient, IMMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    AUDCLNT_STREAMOPTIONS_NONE, AUDCLNT_STREAMOPTIONS_RAW,
};
use windows::Win32::System::Com::{CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{
    AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateEventW, SetEvent, WaitForMultipleObjects,
    INFINITE,
};

/// Estado que a UI muda a qualquer momento, lido pela thread de áudio.
pub struct Shared {
    volume: AtomicU32,
    muted: AtomicBool,
    local: AtomicBool,
    raw: AtomicBool,
}

impl Shared {
    fn gain(&self) -> f32 {
        if self.muted.load(Ordering::Relaxed) || !self.local.load(Ordering::Relaxed) {
            0.0
        } else {
            f32::from_bits(self.volume.load(Ordering::Relaxed))
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInfo {
    pub device: String,
    pub output: String,
    /// Se o driver aceitou o modo raw (sem os efeitos do Windows).
    pub raw: bool,
    pub sample_rate: u32,
    pub channels: u16,
    pub period_ms: f64,
}

pub enum Status {
    /// A placa saiu ou não reabriu depois de uma troca da saída.
    Lost { generation: u64, error: AudioError },
    /// A sessão foi refeita (outra saída padrão, ou o modo raw mudou).
    Reopened { generation: u64, info: OpenInfo },
}

enum Command {
    Open { id: String, generation: u64, reply: Sender<Result<OpenInfo, AudioError>> },
    Close { generation: u64 },
    Rebuild,
}

struct Wake(HANDLE);
// O evento do Windows pode ser sinalizado de qualquer thread.
unsafe impl Send for Wake {}
unsafe impl Sync for Wake {}

pub struct Engine {
    commands: Sender<Command>,
    wake: Arc<Wake>,
    shared: Arc<Shared>,
}

impl Engine {
    pub fn start(on_status: impl Fn(Status) + Send + 'static) -> Engine {
        let shared = Arc::new(Shared {
            volume: AtomicU32::new(1.0f32.to_bits()),
            muted: AtomicBool::new(false),
            local: AtomicBool::new(true),
            raw: AtomicBool::new(true),
        });
        let wake = Arc::new(Wake(unsafe { CreateEventW(None, false, false, None) }.expect("evento do motor de áudio")));
        let (commands, receiver) = mpsc::channel();
        let thread_shared = shared.clone();
        let thread_wake = wake.clone();
        std::thread::Builder::new()
            .name("audio-engine".into())
            .spawn(move || run(receiver, thread_wake, thread_shared, on_status))
            .expect("thread do motor de áudio");
        Engine { commands, wake, shared }
    }

    fn send(&self, command: Command) {
        if self.commands.send(command).is_ok() {
            unsafe {
                let _ = SetEvent(self.wake.0);
            }
        }
    }

    /// Bloqueia até a placa abrir ou falhar. Chamar fora da thread da UI.
    pub fn open(&self, id: String, generation: u64) -> Result<OpenInfo, AudioError> {
        let (reply, answer) = mpsc::channel();
        self.send(Command::Open { id, generation, reply });
        answer.recv().unwrap_or_else(|_| Err(AudioError::new("AbortError", "motor de áudio parado")))
    }

    pub fn close(&self, generation: u64) {
        self.send(Command::Close { generation });
    }

    pub fn rebuild(&self) {
        self.send(Command::Rebuild);
    }

    pub fn set_volume(&self, value: f32) {
        self.shared.volume.store(value.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    pub fn set_muted(&self, value: bool) {
        self.shared.muted.store(value, Ordering::Relaxed);
    }

    pub fn set_local(&self, enabled: bool) {
        self.shared.local.store(enabled, Ordering::Relaxed);
    }

    pub fn set_raw(&self, enabled: bool) {
        if self.shared.raw.swap(enabled, Ordering::Relaxed) != enabled {
            self.rebuild();
        }
    }
}

struct Current {
    id: String,
    generation: u64,
    session: Session,
}

fn run(receiver: Receiver<Command>, wake: Arc<Wake>, shared: Arc<Shared>, on_status: impl Fn(Status)) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let mut task_index = 0u32;
    let task = unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task_index) }.ok();
    let enumerator = wasapi::enumerator();
    let mut current: Option<Current> = None;

    loop {
        loop {
            match receiver.try_recv() {
                Ok(Command::Open { id, generation, reply }) => {
                    current = None;
                    let result = match &enumerator {
                        Ok(enumerator) => Session::open(enumerator, &id, shared.raw.load(Ordering::Relaxed)),
                        Err(error) => Err(error.clone().into()),
                    };
                    let _ = reply.send(result.as_ref().map(|session| session.info.clone()).map_err(Clone::clone));
                    if let Ok(session) = result {
                        current = Some(Current { id, generation, session });
                    }
                }
                Ok(Command::Close { generation }) => {
                    // Um fechamento atrasado não derruba uma abertura mais nova.
                    if current.as_ref().is_some_and(|c| c.generation == generation) {
                        current = None;
                    }
                }
                Ok(Command::Rebuild) => rebuild(&mut current, &enumerator, &shared, &on_status),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    if let Some(task) = task {
                        unsafe {
                            let _ = AvRevertMmThreadCharacteristics(task);
                        }
                    }
                    return;
                }
            }
        }

        let Some(active) = current.as_mut() else {
            unsafe { WaitForMultipleObjects(&[wake.0], false, INFINITE) };
            continue;
        };
        let handles = [wake.0, active.session.capture_event, active.session.render_event];
        unsafe { WaitForMultipleObjects(&handles, false, 100) };
        if let Err(error) = active.session.pump(&shared) {
            eprintln!("áudio: {error}");
            if wasapi::is_device_gone(error.code()) {
                // A saída pode ter mudado. Se a placa também saiu, a reabertura falha.
                rebuild(&mut current, &enumerator, &shared, &on_status);
            }
        }
    }
}

fn rebuild(
    current: &mut Option<Current>,
    enumerator: &windows::core::Result<IMMDeviceEnumerator>,
    shared: &Shared,
    on_status: &impl Fn(Status),
) {
    let Some(previous) = current.take() else { return };
    let Current { id, generation, session } = previous;
    drop(session);
    let Ok(enumerator) = enumerator else { return };
    match Session::open(enumerator, &id, shared.raw.load(Ordering::Relaxed)) {
        Ok(session) => {
            on_status(Status::Reopened { generation, info: session.info.clone() });
            *current = Some(Current { id, generation, session });
        }
        Err(error) => on_status(Status::Lost { generation, error }),
    }
}

struct Session {
    info: OpenInfo,
    input: IAudioClient,
    capture: IAudioCaptureClient,
    output: IAudioClient3,
    render: IAudioRenderClient,
    capture_event: HANDLE,
    render_event: HANDLE,
    channels: usize,
    period: usize,
    buffer_frames: u32,
    /// Maior pacote visto da placa, em quadros.
    packet: usize,
    ring: VecDeque<f32>,
    capacity: usize,
    primed: bool,
    gain: f32,
}

impl Session {
    fn open(enumerator: &IMMDeviceEnumerator, id: &str, raw: bool) -> Result<Session, AudioError> {
        match Self::try_open(enumerator, id, raw) {
            // Algum driver pode aceitar a propriedade e recusar o stream: tenta sem raw.
            Err(error) if raw && error.name == "AbortError" => Self::try_open(enumerator, id, false),
            other => other,
        }
    }

    fn try_open(enumerator: &IMMDeviceEnumerator, id: &str, raw: bool) -> Result<Session, AudioError> {
        unsafe {
            let card = wasapi::get_device(enumerator, id)?;
            let speakers = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;

            // Saída: formato de mixagem, menor período que o driver aceitar.
            let output: IAudioClient3 = speakers.Activate(CLSCTX_ALL, None)?;
            let format = MixFormat(output.GetMixFormat()?);
            if !wasapi::is_float(format.get()) {
                return Err(AudioError::new("NotSupportedError", "a saída não usa áudio em float"));
            }
            let properties = AudioClientProperties {
                cbSize: std::mem::size_of::<AudioClientProperties>() as u32,
                bIsOffload: false.into(),
                eCategory: AudioCategory_GameMedia,
                Options: if raw { AUDCLNT_STREAMOPTIONS_RAW } else { AUDCLNT_STREAMOPTIONS_NONE },
            };
            let raw_accepted = raw && output.SetClientProperties(&properties).is_ok();
            let (mut default_period, mut fundamental, mut min_period, mut max_period) = (0, 0, 0, 0);
            output.GetSharedModeEnginePeriod(
                format.0,
                &mut default_period,
                &mut fundamental,
                &mut min_period,
                &mut max_period,
            )?;
            let render_event = CreateEventW(None, false, false, None)?;
            output.InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, min_period, format.0, None)?;
            output.SetEventHandle(render_event)?;
            let buffer_frames = output.GetBufferSize()?;
            let render: IAudioRenderClient = output.GetService()?;

            // Placa: o Windows converte para o formato da saída (taxa e canais).
            let input: IAudioClient = card.Activate(CLSCTX_ALL, None)?;
            let capture_event = CreateEventW(None, false, false, None)?;
            input.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                0,
                0,
                format.0,
                None,
            )?;
            input.SetEventHandle(capture_event)?;
            let capture: IAudioCaptureClient = input.GetService()?;

            // A saída começa com um período de silêncio, como pede o WASAPI.
            render.GetBuffer(min_period)?;
            render.ReleaseBuffer(min_period, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)?;

            let rate = format.get().nSamplesPerSec;
            let channels = format.get().nChannels;
            let info = OpenInfo {
                device: wasapi::friendly_name(&card),
                output: wasapi::friendly_name(&speakers),
                raw: raw_accepted,
                sample_rate: rate,
                channels,
                period_ms: min_period as f64 * 1000.0 / rate as f64,
            };
            input.Start()?;
            output.Start()?;
            Ok(Session {
                info,
                input,
                capture,
                output,
                render,
                capture_event,
                render_event,
                channels: channels as usize,
                period: min_period as usize,
                buffer_frames,
                packet: 0,
                ring: VecDeque::with_capacity(rate as usize * channels as usize),
                // Folga de 1 s; o controle mantém a fila bem abaixo disso.
                capacity: rate as usize * channels as usize,
                primed: false,
                gain: 0.0,
            })
        }
    }

    fn pump(&mut self, shared: &Shared) -> windows::core::Result<()> {
        unsafe {
            // Lê tudo o que a placa tiver. O ganho muda em rampa, sem estalo.
            loop {
                let packet = self.capture.GetNextPacketSize()?;
                if packet == 0 {
                    break;
                }
                let mut data = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                let count = frames as usize;
                let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null();
                let target = shared.gain();
                let start = self.gain;
                let samples = if silent {
                    &[][..]
                } else {
                    std::slice::from_raw_parts(data as *const f32, count * self.channels)
                };
                for frame in 0..count {
                    let gain = start + (target - start) * (frame + 1) as f32 / count.max(1) as f32;
                    for channel in 0..self.channels {
                        let value = if silent { 0.0 } else { samples[frame * self.channels + channel] };
                        self.ring.push_back(value * gain);
                    }
                }
                self.gain = target;
                self.capture.ReleaseBuffer(frames)?;
                self.packet = self.packet.max(count);
                if self.ring.len() > self.capacity {
                    let extra = self.ring.len() - self.capacity;
                    self.ring.drain(..extra);
                }
            }

            // Escreve na saída o que couber, sem completar com silêncio: silêncio
            // escrito viraria atraso fixo.
            let padding = self.output.GetCurrentPadding()? as usize;
            let queued = self.ring.len() / self.channels;
            let target = self.packet + self.period;
            if !self.primed {
                if queued < target {
                    return Ok(());
                }
                self.primed = true;
            }
            let queued = if queued + padding > target + self.packet {
                let excess = (queued + padding - target).min(queued);
                self.ring.drain(..excess * self.channels);
                queued - excess
            } else {
                queued
            };
            let room = self.buffer_frames as usize - padding;
            let frames = room.min(queued);
            if frames > 0 {
                let buffer = self.render.GetBuffer(frames as u32)? as *mut f32;
                let out = std::slice::from_raw_parts_mut(buffer, frames * self.channels);
                for (slot, value) in out.iter_mut().zip(self.ring.drain(..frames * self.channels)) {
                    *slot = value;
                }
                self.render.ReleaseBuffer(frames as u32, 0)?;
            }
        }
        Ok(())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe {
            let _ = self.input.Stop();
            let _ = self.output.Stop();
            let _ = CloseHandle(self.capture_event);
            let _ = CloseHandle(self.render_event);
        }
    }
}
