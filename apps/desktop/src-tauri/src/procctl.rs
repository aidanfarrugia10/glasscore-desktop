//! Process actions (FR-03): graceful close, end task, end tree, suspend/resume,
//! priority, affinity, signature, details. Identity is re-verified before every write.

use crate::winutil::*;
use serde::{Deserialize, Serialize};
use windows::core::{PCWSTR, PCSTR, BOOL};
use windows::Win32::Foundation::*;
use windows::Win32::Security::WinTrust::*;
use windows::Win32::System::Diagnostics::ToolHelp::*;
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::Threading::*;
use windows::Win32::UI::WindowsAndMessaging::*;

#[derive(Deserialize, Clone, Copy)]
pub struct Target {
    pub pid: u32,
    /// FILETIME creation ticks captured when the user chose the target.
    pub created: Option<u64>,
}

fn verify(t: &Target, name_check: bool) -> Result<String, String> {
    let path = process_path(t.pid).unwrap_or_default();
    let name = path.rsplit('\\').next().unwrap_or("").to_string();
    if name_check && crate::telemetry::is_protected(&name, t.pid) {
        return Err(format!("{} is a protected system process and can't be changed", if name.is_empty() { format!("PID {}", t.pid) } else { name }));
    }
    if let Some(c) = t.created {
        match process_creation(t.pid) {
            Some(now) if now == c => {}
            Some(_) => return Err("That PID now belongs to a different process — refresh and try again".into()),
            None => return Err("Process has exited or access is denied".into()),
        }
    }
    Ok(if path.is_empty() { format!("PID {}", t.pid) } else { path })
}

#[derive(Serialize)]
pub struct Identity {
    pub pid: u32,
    pub created: Option<u64>,
    pub path: Option<String>,
}

pub fn identity(pid: u32) -> Identity {
    Identity { pid, created: process_creation(pid), path: process_path(pid) }
}

/// Top-level visible windows belonging to a pid.
pub fn windows_of(pid: u32) -> Vec<HWND> {
    struct Ctx { pid: u32, out: Vec<HWND> }
    unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> BOOL {
        let ctx = &mut *(l.0 as *mut Ctx);
        let mut p = 0u32;
        GetWindowThreadProcessId(h, Some(&mut p));
        if p == ctx.pid && IsWindowVisible(h).as_bool() && GetWindow(h, GW_OWNER).unwrap_or_default().is_invalid() {
            ctx.out.push(h);
        }
        true.into()
    }
    let mut ctx = Ctx { pid, out: vec![] };
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut ctx as *mut _ as isize));
    }
    ctx.out
}

/// Ask windows to close (lets apps prompt to save). Returns windows signalled.
pub fn close_gracefully(t: Target) -> Result<usize, String> {
    verify(&t, true)?;
    let ws = windows_of(t.pid);
    for w in &ws {
        unsafe {
            let _ = PostMessageW(Some(*w), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
    if ws.is_empty() {
        Err("No windows to close — use End task instead".into())
    } else {
        Ok(ws.len())
    }
}

pub fn terminate(t: Target) -> Result<String, String> {
    let what = verify(&t, true)?;
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, t.pid)
            .map_err(|e| format!("Access denied ({}). Elevated processes need the hardware helper.", e.code().0))?;
        let r = TerminateProcess(h, 1);
        let _ = CloseHandle(h);
        r.map_err(|e| e.message().to_string())?;
    }
    Ok(what)
}

/// Child PIDs (recursive) — shown to the user before tree termination (PROCESS-09).
pub fn descendants(pid: u32) -> Vec<(u32, String)> {
    let mut all = vec![];
    unsafe {
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    all.push((e.th32ProcessID, e.th32ParentProcessID, from_wide(&e.szExeFile)));
                    if Process32NextW(snap, &mut e).is_err() { break; }
                }
            }
            let _ = CloseHandle(snap);
        }
    }
    let mut out = vec![];
    let mut stack = vec![pid];
    while let Some(p) = stack.pop() {
        for (c, parent, name) in &all {
            if *parent == p && *c != p && !out.iter().any(|(x, _)| x == c) {
                out.push((*c, name.clone()));
                stack.push(*c);
            }
        }
    }
    out
}

pub fn terminate_tree(t: Target) -> Result<usize, String> {
    verify(&t, true)?;
    let kids = descendants(t.pid);
    let mut n = 0;
    for (pid, name) in kids.iter().rev() {
        if crate::telemetry::is_protected(name, *pid) { continue; }
        if terminate(Target { pid: *pid, created: None }).is_ok() { n += 1; }
    }
    terminate(t)?;
    Ok(n + 1)
}

type NtFn = unsafe extern "system" fn(HANDLE) -> i32;

fn nt(name: &str) -> Option<NtFn> {
    unsafe {
        let m = GetModuleHandleW(PCWSTR(wide("ntdll.dll").as_ptr())).ok()?;
        let c = std::ffi::CString::new(name).ok()?;
        GetProcAddress(m, PCSTR(c.as_ptr() as _)).map(|f| std::mem::transmute::<_, NtFn>(f))
    }
}

pub fn suspend(t: Target, resume: bool) -> Result<String, String> {
    let what = verify(&t, true)?;
    let f = nt(if resume { "NtResumeProcess" } else { "NtSuspendProcess" }).ok_or("ntdll entry missing")?;
    unsafe {
        let h = OpenProcess(PROCESS_SUSPEND_RESUME, false, t.pid).map_err(|_| "Access denied".to_string())?;
        let s = f(h);
        let _ = CloseHandle(h);
        if s != 0 { return Err(format!("NTSTATUS 0x{:08X}", s)); }
    }
    Ok(what)
}

pub fn set_priority(t: Target, class: &str) -> Result<String, String> {
    let what = verify(&t, true)?;
    let c = match class {
        "idle" => IDLE_PRIORITY_CLASS,
        "below" => BELOW_NORMAL_PRIORITY_CLASS,
        "normal" => NORMAL_PRIORITY_CLASS,
        "above" => ABOVE_NORMAL_PRIORITY_CLASS,
        "high" => HIGH_PRIORITY_CLASS,
        _ => return Err("Realtime priority is not allowed (it can freeze the system)".into()),
    };
    unsafe {
        let h = OpenProcess(PROCESS_SET_INFORMATION, false, t.pid).map_err(|_| "Access denied".to_string())?;
        let r = SetPriorityClass(h, c);
        let _ = CloseHandle(h);
        r.map_err(|e| e.message().to_string())?;
    }
    Ok(what)
}

pub fn get_priority_affinity(pid: u32) -> (Option<String>, Option<u64>, u64) {
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return (None, None, 0) };
        let pc = GetPriorityClass(h);
        let (mut pm, mut sm) = (0usize, 0usize);
        let aff = GetProcessAffinityMask(h, &mut pm, &mut sm).ok().map(|_| pm as u64);
        let _ = CloseHandle(h);
        let name = match PROCESS_CREATION_FLAGS(pc) {
            IDLE_PRIORITY_CLASS => "idle",
            BELOW_NORMAL_PRIORITY_CLASS => "below",
            NORMAL_PRIORITY_CLASS => "normal",
            ABOVE_NORMAL_PRIORITY_CLASS => "above",
            HIGH_PRIORITY_CLASS => "high",
            REALTIME_PRIORITY_CLASS => "realtime",
            _ => "unknown",
        };
        (Some(name.into()), aff, sm as u64)
    }
}

pub fn set_affinity(t: Target, mask: u64) -> Result<String, String> {
    let what = verify(&t, true)?;
    if mask == 0 { return Err("At least one CPU must stay selected".into()); }
    unsafe {
        let h = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, t.pid).map_err(|_| "Access denied".to_string())?;
        let r = SetProcessAffinityMask(h, mask as usize);
        let _ = CloseHandle(h);
        r.map_err(|e| e.message().to_string())?;
    }
    Ok(what)
}

/// Authenticode check of an executable (PROCESS-08). Never uploads anything.
pub fn signature(path: &str) -> String {
    unsafe {
        let w = wide(path);
        let mut file = WINTRUST_FILE_INFO {
            cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
            pcwszFilePath: PCWSTR(w.as_ptr()),
            ..Default::default()
        };
        let mut data = WINTRUST_DATA {
            cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            dwStateAction: WTD_STATEACTION_VERIFY,
            dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL,
            ..Default::default()
        };
        data.Anonymous.pFile = &mut file;
        let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let r = WinVerifyTrust(HWND(-1isize as _), &mut action, &mut data as *mut _ as _);
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        let _ = WinVerifyTrust(HWND(-1isize as _), &mut action, &mut data as *mut _ as _);
        match r as u32 {
            0 => "signed".into(),
            0x800B0100 => "unsigned".into(),
            0x80096010 | 0x80096019 => "invalid signature".into(),
            0x800B0109 => "untrusted root".into(),
            0x800B0101 => "expired certificate".into(),
            0x80092026 => "catalog-signed (system)".into(),
            x => format!("unverified (0x{:08X})", x),
        }
    }
}

#[derive(Serialize)]
pub struct Details {
    pub pid: u32,
    pub path: Option<String>,
    pub signature: Option<String>,
    pub priority: Option<String>,
    pub affinity: Option<u64>,
    pub system_mask: u64,
    pub windows: Vec<String>,
    pub children: Vec<(u32, String)>,
    pub created: Option<u64>,
    pub threads: Vec<u32>,
    pub modules: Vec<String>,
}

pub fn details(pid: u32) -> Details {
    let path = process_path(pid);
    let (priority, affinity, system_mask) = get_priority_affinity(pid);
    let windows = windows_of(pid)
        .into_iter()
        .map(|h| unsafe {
            let mut b = [0u16; 256];
            let n = GetWindowTextW(h, &mut b);
            String::from_utf16_lossy(&b[..n as usize])
        })
        .filter(|s| !s.is_empty())
        .collect();
    let mut threads = vec![];
    let mut modules = vec![];
    unsafe {
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) {
            let mut e = THREADENTRY32 { dwSize: std::mem::size_of::<THREADENTRY32>() as u32, ..Default::default() };
            if Thread32First(snap, &mut e).is_ok() {
                loop {
                    if e.th32OwnerProcessID == pid { threads.push(e.th32ThreadID); }
                    if Thread32Next(snap, &mut e).is_err() { break; }
                }
            }
            let _ = CloseHandle(snap);
        }
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid) {
            let mut e = MODULEENTRY32W { dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32, ..Default::default() };
            if Module32FirstW(snap, &mut e).is_ok() {
                loop {
                    modules.push(from_wide(&e.szExePath));
                    if modules.len() > 400 || Module32NextW(snap, &mut e).is_err() { break; }
                }
            }
            let _ = CloseHandle(snap);
        }
    }
    Details {
        pid,
        signature: path.as_deref().map(signature),
        path,
        priority,
        affinity,
        system_mask,
        windows,
        children: descendants(pid),
        created: process_creation(pid),
        threads,
        modules,
    }
}
