//! Audio (AUDIO-01..03, 07) via Core Audio, and DDC/CI monitor brightness (AUDIO-04).

use crate::winutil::*;
use serde::Serialize;
use windows::core::{Interface, GUID, PCWSTR, HRESULT};
use windows::Win32::Devices::Display::*;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Media::Audio::Endpoints::*;
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;

#[derive(Serialize, Clone)]
pub struct Endpoint {
    pub id: String,
    pub name: String,
    pub flow: String,
    pub default: bool,
    pub volume: Option<f32>,
    pub muted: Option<bool>,
    pub peak: Option<f32>,
}

#[derive(Serialize, Clone)]
pub struct AppVolume {
    pub pid: u32,
    pub name: String,
    pub volume: f32,
    pub muted: bool,
    pub peak: f32,
}

fn com() {
    unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
}

fn enumerator() -> Result<IMMDeviceEnumerator, String> {
    com();
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.message().to_string()) }
}

unsafe fn device_name(d: &IMMDevice) -> String {
    let Ok(store) = d.OpenPropertyStore(STGM_READ) else { return String::new() };
    let Ok(v) = store.GetValue(&PKEY_Device_FriendlyName) else { return String::new() };
    let s = v.to_string();
    s
}

pub fn endpoints() -> Result<Vec<Endpoint>, String> {
    let e = enumerator()?;
    let mut out = vec![];
    unsafe {
        for (flow, label) in [(eRender, "output"), (eCapture, "input")] {
            let def_id = e.GetDefaultAudioEndpoint(flow, eConsole).ok().and_then(|d| d.GetId().ok()).map(|p| pwstr(p)).unwrap_or_default();
            let coll = e.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE).map_err(|e| e.message().to_string())?;
            for i in 0..coll.GetCount().unwrap_or(0) {
                let Ok(d) = coll.Item(i) else { continue };
                let id = d.GetId().map(|p| pwstr(p)).unwrap_or_default();
                let vol: Option<IAudioEndpointVolume> = d.Activate(CLSCTX_ALL, None).ok();
                let meter: Option<IAudioMeterInformation> = d.Activate(CLSCTX_ALL, None).ok();
                out.push(Endpoint {
                    name: device_name(&d),
                    flow: label.into(),
                    default: id == def_id,
                    volume: vol.as_ref().and_then(|v| v.GetMasterVolumeLevelScalar().ok()),
                    muted: vol.as_ref().and_then(|v| v.GetMute().ok()).map(|b| b.as_bool()),
                    peak: meter.as_ref().and_then(|m| m.GetPeakValue().ok()),
                    id,
                });
            }
        }
    }
    Ok(out)
}

fn device(id: &str) -> Result<IMMDevice, String> {
    let e = enumerator()?;
    let w = wide(id);
    unsafe { e.GetDevice(PCWSTR(w.as_ptr())).map_err(|e| e.message().to_string()) }
}

pub fn set_volume(id: &str, level: Option<f32>, mute: Option<bool>) -> Result<(), String> {
    let d = device(id)?;
    unsafe {
        let v: IAudioEndpointVolume = d.Activate(CLSCTX_ALL, None).map_err(|e| e.message().to_string())?;
        if let Some(l) = level { v.SetMasterVolumeLevelScalar(l.clamp(0.0, 1.0), std::ptr::null()).map_err(|e| e.message().to_string())?; }
        if let Some(m) = mute { v.SetMute(m, std::ptr::null()).map_err(|e| e.message().to_string())?; }
    }
    Ok(())
}

/// Default output volume â€” used by automation rules.
pub fn set_default_volume(level: Option<f32>, mute: Option<bool>) -> Result<(), String> {
    let e = enumerator()?;
    let id = unsafe { e.GetDefaultAudioEndpoint(eRender, eConsole).and_then(|d| d.GetId()).map(|p| pwstr(p)).map_err(|e| e.message().to_string())? };
    set_volume(&id, level, mute)
}

pub fn sessions(id: &str) -> Result<Vec<AppVolume>, String> {
    let d = device(id)?;
    let mut out = vec![];
    unsafe {
        let mgr: IAudioSessionManager2 = d.Activate(CLSCTX_ALL, None).map_err(|e| e.message().to_string())?;
        let en = mgr.GetSessionEnumerator().map_err(|e| e.message().to_string())?;
        for i in 0..en.GetCount().unwrap_or(0) {
            let Ok(c) = en.GetSession(i) else { continue };
            let Ok(c2) = c.cast::<IAudioSessionControl2>() else { continue };
            if c2.IsSystemSoundsSession() == S_OK { continue; }
            let pid = c2.GetProcessId().unwrap_or(0);
            if pid == 0 { continue; }
            let Ok(sv) = c.cast::<ISimpleAudioVolume>() else { continue };
            let peak = c.cast::<IAudioMeterInformation>().ok().and_then(|m| m.GetPeakValue().ok()).unwrap_or(0.0);
            let name = process_path(pid).and_then(|p| p.rsplit('\\').next().map(|s| s.to_string())).unwrap_or_else(|| format!("PID {}", pid));
            out.push(AppVolume { pid, name, volume: sv.GetMasterVolume().unwrap_or(1.0), muted: sv.GetMute().map(|b| b.as_bool()).unwrap_or(false), peak });
        }
    }
    Ok(out)
}

pub fn set_session(id: &str, pid: u32, level: Option<f32>, mute: Option<bool>) -> Result<(), String> {
    let d = device(id)?;
    unsafe {
        let mgr: IAudioSessionManager2 = d.Activate(CLSCTX_ALL, None).map_err(|e| e.message().to_string())?;
        let en = mgr.GetSessionEnumerator().map_err(|e| e.message().to_string())?;
        for i in 0..en.GetCount().unwrap_or(0) {
            let Ok(c) = en.GetSession(i) else { continue };
            let Ok(c2) = c.cast::<IAudioSessionControl2>() else { continue };
            if c2.GetProcessId().unwrap_or(0) != pid { continue; }
            let sv: ISimpleAudioVolume = c.cast().map_err(|e| e.message().to_string())?;
            if let Some(l) = level { let _ = sv.SetMasterVolume(l.clamp(0.0, 1.0), std::ptr::null()); }
            if let Some(m) = mute { let _ = sv.SetMute(m, std::ptr::null()); }
        }
    }
    Ok(())
}

// --- Default device switching via the (undocumented but long-stable) IPolicyConfig.
#[windows::core::interface("f8679f50-850a-41cf-9c72-430f290290c8")]
unsafe trait IPolicyConfig: windows::core::IUnknown {
    fn GetMixFormat(&self, a: PCWSTR, b: *mut *mut core::ffi::c_void) -> HRESULT;
    fn GetDeviceFormat(&self, a: PCWSTR, b: i32, c: *mut *mut core::ffi::c_void) -> HRESULT;
    fn ResetDeviceFormat(&self, a: PCWSTR) -> HRESULT;
    fn SetDeviceFormat(&self, a: PCWSTR, b: *mut core::ffi::c_void, c: *mut core::ffi::c_void) -> HRESULT;
    fn GetProcessingPeriod(&self, a: PCWSTR, b: i32, c: *mut i64, d: *mut i64) -> HRESULT;
    fn SetProcessingPeriod(&self, a: PCWSTR, b: *mut i64) -> HRESULT;
    fn GetShareMode(&self, a: PCWSTR, b: *mut core::ffi::c_void) -> HRESULT;
    fn SetShareMode(&self, a: PCWSTR, b: *mut core::ffi::c_void) -> HRESULT;
    fn GetPropertyValue(&self, a: PCWSTR, b: *const core::ffi::c_void, c: *mut core::ffi::c_void) -> HRESULT;
    fn SetPropertyValue(&self, a: PCWSTR, b: *const core::ffi::c_void, c: *mut core::ffi::c_void) -> HRESULT;
    fn SetDefaultEndpoint(&self, id: PCWSTR, role: i32) -> HRESULT;
    fn SetEndpointVisibility(&self, a: PCWSTR, b: i32) -> HRESULT;
}

const CLSID_POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

pub fn set_default(id: &str) -> Result<(), String> {
    com();
    unsafe {
        let pc: IPolicyConfig = CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL).map_err(|e| e.message().to_string())?;
        let w = wide(id);
        for role in [0, 1, 2] {
            pc.SetDefaultEndpoint(PCWSTR(w.as_ptr()), role).ok().map_err(|e| e.message().to_string())?;
        }
    }
    Ok(())
}

// --- DDC/CI brightness ---

#[derive(Serialize, Clone)]
pub struct Brightness {
    pub monitor: usize,
    pub name: String,
    pub min: u32,
    pub current: u32,
    pub max: u32,
}

fn physical() -> Vec<(usize, PHYSICAL_MONITOR)> {
    unsafe extern "system" fn cb(h: HMONITOR, _: HDC, _: *mut RECT, l: LPARAM) -> windows::core::BOOL {
        (&mut *(l.0 as *mut Vec<HMONITOR>)).push(h);
        true.into()
    }
    let mut hs: Vec<HMONITOR> = vec![];
    unsafe { let _ = EnumDisplayMonitors(None, None, Some(cb), LPARAM(&mut hs as *mut _ as isize)); }
    let mut out = vec![];
    for (i, h) in hs.into_iter().enumerate() {
        unsafe {
            let mut n = 0u32;
            if GetNumberOfPhysicalMonitorsFromHMONITOR(h, &mut n).is_err() || n == 0 { continue; }
            let mut arr = vec![PHYSICAL_MONITOR::default(); n as usize];
            if GetPhysicalMonitorsFromHMONITOR(h, &mut arr).is_ok() {
                for m in arr { out.push((i, m)); }
            }
        }
    }
    out
}

pub fn brightness() -> Vec<Brightness> {
    let mut out = vec![];
    for (i, m) in physical() {
        unsafe {
            let (mut a, mut b, mut c) = (0u32, 0u32, 0u32);
            if GetMonitorBrightness(m.hPhysicalMonitor, &mut a, &mut b, &mut c) != 0 {
                let desc = m.szPhysicalMonitorDescription;
                out.push(Brightness { monitor: i, name: from_wide(&desc), min: a, current: b, max: c });
            }
            let _ = DestroyPhysicalMonitor(m.hPhysicalMonitor);
        }
    }
    out
}

pub fn set_brightness(monitor: usize, value: u32) -> Result<(), String> {
    let mut ok = false;
    for (i, m) in physical() {
        unsafe {
            if i == monitor && SetMonitorBrightness(m.hPhysicalMonitor, value) != 0 { ok = true; }
            let _ = DestroyPhysicalMonitor(m.hPhysicalMonitor);
        }
    }
    if ok { Ok(()) } else { Err("This display doesn't accept DDC/CI brightness commands".into()) }
}
