//! Windows services (FR-08). Read with least privilege; control needs SERVICE_START /
//! SERVICE_STOP rights — when we lack them the request is routed to the elevated broker.

use crate::winutil::*;
use serde::Serialize;
use windows::core::PCWSTR;
use windows::Win32::Foundation::*;
use windows::Win32::System::Services::*;

#[derive(Serialize, Clone)]
pub struct Svc {
    pub name: String,
    pub display: String,
    pub state: String,
    pub pid: u32,
    pub start: String,
    pub delayed: bool,
    pub binary: String,
    pub account: String,
    pub kind: String,
    pub description: String,
}

fn state_name(s: SERVICE_STATUS_CURRENT_STATE) -> &'static str {
    match s {
        SERVICE_STOPPED => "Stopped",
        SERVICE_START_PENDING => "Starting",
        SERVICE_STOP_PENDING => "Stopping",
        SERVICE_RUNNING => "Running",
        SERVICE_CONTINUE_PENDING => "Resuming",
        SERVICE_PAUSE_PENDING => "Pausing",
        SERVICE_PAUSED => "Paused",
        _ => "Unknown",
    }
}

fn start_name(s: SERVICE_START_TYPE) -> &'static str {
    match s {
        SERVICE_AUTO_START => "Automatic",
        SERVICE_DEMAND_START => "Manual",
        SERVICE_DISABLED => "Disabled",
        SERVICE_BOOT_START => "Boot",
        SERVICE_SYSTEM_START => "System",
        _ => "Unknown",
    }
}

pub fn list() -> Result<Vec<Svc>, String> {
    let mut out = vec![];
    unsafe {
        let scm = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_ENUMERATE_SERVICE | SC_MANAGER_CONNECT).map_err(|e| e.message().to_string())?;
        let mut needed = 0u32;
        let mut count = 0u32;
        let mut resume = 0u32;
        let _ = EnumServicesStatusExW(scm, SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_STATE_ALL, None, &mut needed, &mut count, Some(&mut resume), PCWSTR::null());
        let mut buf = vec![0u8; needed as usize + 4096];
        resume = 0;
        EnumServicesStatusExW(scm, SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_STATE_ALL, Some(&mut buf), &mut needed, &mut count, Some(&mut resume), PCWSTR::null())
            .map_err(|e| e.message().to_string())?;
        let items = std::slice::from_raw_parts(buf.as_ptr() as *const ENUM_SERVICE_STATUS_PROCESSW, count as usize);
        for it in items {
            let name = pwstr(it.lpServiceName);
            let mut svc = Svc {
                display: pwstr(it.lpDisplayName),
                state: state_name(it.ServiceStatusProcess.dwCurrentState).into(),
                pid: it.ServiceStatusProcess.dwProcessId,
                start: String::new(),
                delayed: false,
                binary: String::new(),
                account: String::new(),
                kind: if it.ServiceStatusProcess.dwServiceType.0 & SERVICE_WIN32_SHARE_PROCESS.0 != 0 { "Shared".into() } else { "Own process".into() },
                description: String::new(),
                name: name.clone(),
            };
            let w = wide(&name);
            if let Ok(h) = OpenServiceW(scm, PCWSTR(w.as_ptr()), SERVICE_QUERY_CONFIG) {
                let mut need = 0u32;
                let _ = QueryServiceConfigW(h, None, 0, &mut need);
                let mut cb = vec![0u8; need as usize];
                if QueryServiceConfigW(h, Some(cb.as_mut_ptr() as *mut QUERY_SERVICE_CONFIGW), need, &mut need).is_ok() {
                    let c = &*(cb.as_ptr() as *const QUERY_SERVICE_CONFIGW);
                    svc.start = start_name(c.dwStartType).into();
                    svc.binary = pwstr(c.lpBinaryPathName);
                    svc.account = pwstr(c.lpServiceStartName);
                }
                let mut need = 0u32;
                let _ = QueryServiceConfig2W(h, SERVICE_CONFIG_DESCRIPTION, None, &mut need);
                if need > 0 {
                    let mut db = vec![0u8; need as usize];
                    if QueryServiceConfig2W(h, SERVICE_CONFIG_DESCRIPTION, Some(&mut db), &mut need).is_ok() {
                        let d = &*(db.as_ptr() as *const SERVICE_DESCRIPTIONW);
                        svc.description = pwstr(d.lpDescription);
                    }
                }
                let mut need = 0u32;
                let mut dl = [0u8; 16];
                if QueryServiceConfig2W(h, SERVICE_CONFIG_DELAYED_AUTO_START_INFO, Some(&mut dl), &mut need).is_ok() {
                    svc.delayed = dl[0] != 0;
                }
                let _ = CloseServiceHandle(h);
            }
            out.push(svc);
        }
        let _ = CloseServiceHandle(scm);
    }
    Ok(out)
}

/// Services that depend on `name` (SERVICES-04) — shown before stop/restart.
pub fn dependents(name: &str) -> Vec<String> {
    let mut out = vec![];
    unsafe {
        let Ok(scm) = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT) else { return out };
        let w = wide(name);
        if let Ok(h) = OpenServiceW(scm, PCWSTR(w.as_ptr()), SERVICE_ENUMERATE_DEPENDENTS) {
            let mut need = 0u32;
            let mut count = 0u32;
            let _ = EnumDependentServicesW(h, SERVICE_ACTIVE, None, 0, &mut need, &mut count);
            if need > 0 {
                let mut buf = vec![0u8; need as usize];
                if EnumDependentServicesW(h, SERVICE_ACTIVE, Some(buf.as_mut_ptr() as *mut ENUM_SERVICE_STATUSW), need, &mut need, &mut count).is_ok() {
                    let items = std::slice::from_raw_parts(buf.as_ptr() as *const ENUM_SERVICE_STATUSW, count as usize);
                    for it in items { out.push(pwstr(it.lpDisplayName)); }
                }
            }
            let _ = CloseServiceHandle(h);
        }
        let _ = CloseServiceHandle(scm);
    }
    out
}

/// Try to control a service directly. Err("ACCESS_DENIED") tells the caller to use the broker.
pub fn control(name: &str, action: &str) -> Result<(), String> {
    unsafe {
        let scm = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT).map_err(|e| e.message().to_string())?;
        let w = wide(name);
        let access = SERVICE_START | SERVICE_STOP | SERVICE_QUERY_STATUS;
        let h = match OpenServiceW(scm, PCWSTR(w.as_ptr()), access) {
            Ok(h) => h,
            Err(e) => {
                let _ = CloseServiceHandle(scm);
                return Err(if e.code() == ERROR_ACCESS_DENIED.to_hresult() { "ACCESS_DENIED".into() } else { e.message().to_string() });
            }
        };
        let r = match action {
            "start" => StartServiceW(h, None).map_err(|e| e.message().to_string()),
            "stop" => {
                let mut st = SERVICE_STATUS::default();
                ControlService(h, SERVICE_CONTROL_STOP, &mut st).map_err(|e| e.message().to_string())
            }
            "restart" => {
                let mut st = SERVICE_STATUS::default();
                let _ = ControlService(h, SERVICE_CONTROL_STOP, &mut st);
                for _ in 0..40 {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    let mut s = SERVICE_STATUS::default();
                    if QueryServiceStatus(h, &mut s).is_ok() && s.dwCurrentState == SERVICE_STOPPED { break; }
                }
                StartServiceW(h, None).map_err(|e| e.message().to_string())
            }
            _ => Err("unknown action".into()),
        };
        let _ = CloseServiceHandle(h);
        let _ = CloseServiceHandle(scm);
        r
    }
}
