// Utilitários do WASAPI: lista de dispositivos, nomes e formatos.

use serde::Serialize;
use windows::core::{HRESULT, PCWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{
    eCapture, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_E_DEVICE_INVALIDATED,
    AUDCLNT_E_DEVICE_IN_USE, AUDCLNT_E_RESOURCES_INVALIDATED, AUDCLNT_E_SERVICE_NOT_RUNNING, DEVICE_STATE_ACTIVE,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::Foundation::E_ACCESSDENIED;
use windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE;
use windows::Win32::Media::Multimedia::{KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL, STGM_READ};

// GetDevice com um id que não existe mais: HRESULT_FROM_WIN32(ERROR_NOT_FOUND).
const E_NOTFOUND: HRESULT = HRESULT(0x8007_0490_u32 as i32);

#[derive(Clone, Serialize)]
pub struct Device {
    pub id: String,
    pub label: String,
}

/// Erro no formato que o renderer já entende: { name, message }, como um DOMException.
#[derive(Clone, Debug, Serialize)]
pub struct AudioError {
    pub name: String,
    pub message: String,
}

impl AudioError {
    pub fn new(name: &str, message: impl Into<String>) -> Self {
        AudioError { name: name.into(), message: message.into() }
    }
}

impl From<windows::core::Error> for AudioError {
    fn from(error: windows::core::Error) -> Self {
        let code = error.code();
        let name = match code {
            c if c == AUDCLNT_E_DEVICE_INVALIDATED || c == E_NOTFOUND => "NotFoundError",
            c if c == AUDCLNT_E_DEVICE_IN_USE => "NotReadableError",
            // Privacidade do Windows: apps da área de trabalho sem acesso ao microfone.
            c if c == E_ACCESSDENIED => "NotAllowedError",
            _ => "AbortError",
        };
        AudioError::new(name, format!("0x{:08X} {}", code.0 as u32, error.message()))
    }
}

/// Erros que significam "o dispositivo saiu ou o serviço de áudio reiniciou".
pub fn is_device_gone(code: HRESULT) -> bool {
    code == AUDCLNT_E_DEVICE_INVALIDATED
        || code == AUDCLNT_E_RESOURCES_INVALIDATED
        || code == AUDCLNT_E_SERVICE_NOT_RUNNING
}

pub fn enumerator() -> windows::core::Result<IMMDeviceEnumerator> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

pub fn device_id(device: &IMMDevice) -> String {
    unsafe {
        match device.GetId() {
            Ok(id) => {
                let text = id.to_string().unwrap_or_default();
                CoTaskMemFree(Some(id.0 as *const _));
                text
            }
            Err(_) => String::new(),
        }
    }
}

pub fn friendly_name(device: &IMMDevice) -> String {
    unsafe {
        device
            .OpenPropertyStore(STGM_READ)
            .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName))
            .map(|value| value.to_string())
            .unwrap_or_default()
    }
}

pub fn list_capture(enumerator: &IMMDeviceEnumerator) -> windows::core::Result<Vec<Device>> {
    let mut list = Vec::new();
    unsafe {
        let devices = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)?;
        for i in 0..devices.GetCount()? {
            let device = devices.Item(i)?;
            list.push(Device { id: device_id(&device), label: friendly_name(&device) });
        }
    }
    Ok(list)
}

pub fn get_device(enumerator: &IMMDeviceEnumerator, id: &str) -> windows::core::Result<IMMDevice> {
    let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { enumerator.GetDevice(PCWSTR(wide.as_ptr())) }
}

/// O formato de mixagem do Windows é float de 32 bits desde o Windows 7, mas confere.
pub fn is_float(format: &WAVEFORMATEX) -> bool {
    let tag = format.wFormatTag as u32;
    if tag == WAVE_FORMAT_IEEE_FLOAT {
        return true;
    }
    if tag == WAVE_FORMAT_EXTENSIBLE {
        let ext = unsafe { &*(format as *const WAVEFORMATEX as *const WAVEFORMATEXTENSIBLE) };
        let sub = ext.SubFormat;
        return sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    }
    false
}

/// Formato alocado pelo WASAPI (GetMixFormat), liberado ao sair de escopo.
pub struct MixFormat(pub *mut WAVEFORMATEX);

impl MixFormat {
    pub fn get(&self) -> &WAVEFORMATEX {
        unsafe { &*self.0 }
    }
}

impl Drop for MixFormat {
    fn drop(&mut self) {
        unsafe { CoTaskMemFree(Some(self.0 as *const _)) };
    }
}
