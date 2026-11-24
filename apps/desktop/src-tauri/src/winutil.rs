//! Small helpers shared by the Windows modules.

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::System::Registry::*;
use windows::Win32::System::Threading::*;
use windows::Win32::UI::Shell::IsUserAnAdmin;

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

pub unsafe fn pwstr(p: PWSTR) -> String {
    if p.is_null() { String::new() } else { p.to_string().unwrap_or_default() }
}

pub fn is_admin() -> bool {
    unsafe { IsUserAnAdmin().as_bool() }
}

/// Read a REG_SZ / REG_EXPAND_SZ / REG_DWORD value as a string.
pub fn reg_string(root: HKEY, path: &str, name: &str) -> Option<String> {
    unsafe {
        let p = wide(path);
        let n = wide(name);
        let mut ty = REG_VALUE_TYPE::default();
        let mut size = 0u32;
        if RegGetValueW(root, PCWSTR(p.as_ptr()), PCWSTR(n.as_ptr()), RRF_RT_ANY, Some(&mut ty), None, Some(&mut size)).is_err() {
            return None;
        }
        let mut buf = vec![0u8; size as usize + 2];
        if RegGetValueW(root, PCWSTR(p.as_ptr()), PCWSTR(n.as_ptr()), RRF_RT_ANY, Some(&mut ty), Some(buf.as_mut_ptr() as _), Some(&mut size)).is_err() {
            return None;
        }
        match ty {
            REG_DWORD => Some(u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]).to_string()),
            REG_QWORD => Some(u64::from_le_bytes(buf[0..8].try_into().ok()?).to_string()),
            _ => {
                let w: Vec<u16> = buf.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                Some(from_wide(&w))
            }
        }
    }
}

/// Enumerate sub-key names.
pub fn reg_subkeys(root: HKEY, path: &str) -> Vec<String> {
    let mut out = vec![];
    unsafe {
        let p = wide(path);
        let mut key = HKEY::default();
        if RegOpenKeyExW(root, PCWSTR(p.as_ptr()), Some(0), KEY_READ, &mut key).is_err() {
            return out;
        }
        let mut i = 0u32;
        loop {
            let mut name = [0u16; 256];
            let mut len = name.len() as u32;
            if RegEnumKeyExW(key, i, Some(PWSTR(name.as_mut_ptr())), &mut len, None, None, None, None).is_err() {
                break;
            }
            out.push(from_wide(&name));
            i += 1;
        }
        let _ = RegCloseKey(key);
    }
    out
}

/// Enumerate (name, value-as-string) pairs of a key.
pub fn reg_values(root: HKEY, path: &str) -> Vec<(String, String)> {
    let mut names = vec![];
    unsafe {
        let p = wide(path);
        let mut key = HKEY::default();
        if RegOpenKeyExW(root, PCWSTR(p.as_ptr()), Some(0), KEY_READ, &mut key).is_err() {
            return vec![];
        }
        let mut i = 0u32;
        loop {
            let mut name = [0u16; 512];
            let mut len = name.len() as u32;
            if RegEnumValueW(key, i, Some(PWSTR(name.as_mut_ptr())), &mut len, None, None, None, None).is_err() {
                break;
            }
            names.push(from_wide(&name));
            i += 1;
        }
        let _ = RegCloseKey(key);
    }
    names.into_iter().filter_map(|n| reg_string(root, path, &n).map(|v| (n, v))).collect()
}

/// Full image path of a process, if we may query it.
pub fn process_path(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(h);
        r.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// Process creation time as FILETIME ticks — used to defeat PID reuse.
pub fn process_creation(pid: u32) -> Option<u64> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        let r = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u);
        let _ = CloseHandle(h);
        r.ok()?;
        Some(((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64)
    }
}

/// Redact things that identify the user (PRIVACY-17).
pub fn redact(s: &str) -> String {
    let mut out = s.to_string();
    if let Ok(user) = std::env::var("USERNAME") {
        if !user.is_empty() {
            out = out.replace(&user, "<user>");
        }
    }
    if let Ok(host) = std::env::var("COMPUTERNAME") {
        if !host.is_empty() {
            out = out.replace(&host, "<host>");
        }
    }
    out
}
