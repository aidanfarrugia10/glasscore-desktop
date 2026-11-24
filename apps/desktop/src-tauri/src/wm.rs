//! Window manager (FR-01): monitors, top-level windows, zone layouts, snapping,
//! workspaces. Works in physical pixels (process is Per-Monitor-V2 DPI aware).

use crate::winutil::*;
use serde::{Deserialize, Serialize};
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Dwm::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::HiDpi::*;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::*;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default)]
pub struct Rect { pub x: i32, pub y: i32, pub w: i32, pub h: i32 }

#[derive(Serialize, Clone)]
pub struct Monitor {
    pub key: String,
    pub name: String,
    pub bounds: Rect,
    pub work: Rect,
    pub dpi: u32,
    pub scale: f32,
    pub primary: bool,
}

#[derive(Serialize, Clone)]
pub struct Win {
    pub hwnd: isize,
    pub title: String,
    pub pid: u32,
    pub exe: String,
    pub rect: Rect,
    pub monitor: String,
    pub minimized: bool,
    pub maximized: bool,
}

/// A zone in fractions (0..1) of a monitor's work area.
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct Zone { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Layout {
    pub id: String,
    pub name: String,
    pub zones: Vec<Zone>,
    #[serde(default = "gap_default")]
    pub gap: i32,
}
fn gap_default() -> i32 { 8 }

fn to_rect(r: RECT) -> Rect { Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } }

pub fn monitors() -> Vec<Monitor> {
    unsafe extern "system" fn cb(h: HMONITOR, _: HDC, _: *mut RECT, l: LPARAM) -> BOOL {
        let v = &mut *(l.0 as *mut Vec<Monitor>);
        let mut mi = MONITORINFOEXW::default();
        mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(h, &mut mi as *mut _ as *mut MONITORINFO).as_bool() {
            let (mut dx, mut dy) = (96u32, 96u32);
            let _ = GetDpiForMonitor(h, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
            let b = to_rect(mi.monitorInfo.rcMonitor);
            let name = from_wide(&mi.szDevice);
            v.push(Monitor {
                key: format!("{}@{}x{}", name.trim_start_matches(r"\\.\"), b.w, b.h),
                name,
                bounds: b,
                work: to_rect(mi.monitorInfo.rcWork),
                dpi: dx,
                scale: dx as f32 / 96.0,
                primary: mi.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            });
        }
        true.into()
    }
    let mut v: Vec<Monitor> = vec![];
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(cb), LPARAM(&mut v as *mut _ as isize));
    }
    v.sort_by_key(|m| (m.bounds.x, m.bounds.y));
    v
}

fn monitor_key_for(h: HWND, mons: &[Monitor]) -> String {
    unsafe {
        let hm = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFOEXW::default();
        mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hm, &mut mi as *mut _ as *mut MONITORINFO).as_bool() {
            let name = from_wide(&mi.szDevice);
            if let Some(m) = mons.iter().find(|m| m.name == name) { return m.key.clone(); }
        }
    }
    String::new()
}

fn is_app_window(h: HWND) -> bool {
    unsafe {
        if !IsWindowVisible(h).as_bool() { return false; }
        if !GetWindow(h, GW_OWNER).unwrap_or_default().is_invalid() { return false; }
        let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 { return false; }
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut _ as _, 4);
        if cloaked != 0 { return false; }
        GetWindowTextLengthW(h) > 0
    }
}

pub fn windows_list() -> Vec<Win> {
    unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> BOOL {
        let v = &mut *(l.0 as *mut Vec<HWND>);
        if is_app_window(h) { v.push(h); }
        true.into()
    }
    let mut hs: Vec<HWND> = vec![];
    unsafe { let _ = EnumWindows(Some(cb), LPARAM(&mut hs as *mut _ as isize)); }
    let mons = monitors();
    let me = std::process::id();
    hs.into_iter()
        .filter_map(|h| unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, Some(&mut pid));
            if pid == me { return None; }
            let mut b = [0u16; 512];
            let n = GetWindowTextW(h, &mut b);
            let mut r = RECT::default();
            let _ = GetWindowRect(h, &mut r);
            let exe = process_path(pid).unwrap_or_default();
            let mut wp = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
            let _ = GetWindowPlacement(h, &mut wp);
            Some(Win {
                hwnd: h.0 as isize,
                title: String::from_utf16_lossy(&b[..n as usize]),
                pid,
                exe,
                rect: to_rect(r),
                monitor: monitor_key_for(h, &mons),
                minimized: IsIconic(h).as_bool(),
                maximized: wp.showCmd == SW_SHOWMAXIMIZED.0 as u32,
            })
        })
        .collect()
}

/// Exclusions: never touch these (G9-15).
pub fn excluded(exe: &str, extra: &[String]) -> bool {
    let n = exe.rsplit('\\').next().unwrap_or("").to_lowercase();
    let builtin = ["explorer.exe", "searchhost.exe", "startmenuexperiencehost.exe", "shellexperiencehost.exe", "lockapp.exe", "textinputhost.exe", "applicationframehost.exe"];
    builtin.contains(&n.as_str()) || extra.iter().any(|e| e.eq_ignore_ascii_case(&n))
}

/// Move a window so its *visible* frame lands exactly on `r` (compensates DWM shadow borders).
pub fn place(hwnd: isize, r: Rect) -> Result<(), String> {
    unsafe {
        let h = HWND(hwnd as _);
        if !IsWindow(Some(h)).as_bool() { return Err("Window no longer exists".into()); }
        if IsIconic(h).as_bool() || IsZoomed(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        let mut wr = RECT::default();
        let _ = GetWindowRect(h, &mut wr);
        let mut fr = RECT::default();
        let (mut l, mut t, mut rr, mut b) = (0, 0, 0, 0);
        if DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &mut fr as *mut _ as _, std::mem::size_of::<RECT>() as u32).is_ok() {
            l = fr.left - wr.left;
            t = fr.top - wr.top;
            rr = wr.right - fr.right;
            b = wr.bottom - fr.bottom;
        }
        SetWindowPos(h, None, r.x - l, r.y - t, r.w + l + rr, r.h + t + b, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
            .map_err(|e| e.message().to_string())?;
        // Partial-failure report: apps with a minimum size may refuse.
        let mut after = RECT::default();
        let _ = GetWindowRect(h, &mut after);
        let got = to_rect(after);
        if (got.w - (r.w + l + rr)).abs() > 4 || (got.h - (r.h + t + b)).abs() > 4 {
            return Err("App refused the requested size (minimum size constraint)".into());
        }
    }
    Ok(())
}

/// Zone rectangles in physical pixels for a monitor work area.
pub fn zone_rects(m: &Monitor, layout: &Layout) -> Vec<Rect> {
    let g = layout.gap;
    let wa = m.work;
    layout.zones.iter().map(|z| {
        let x0 = wa.x + (z.x * wa.w as f64).round() as i32;
        let y0 = wa.y + (z.y * wa.h as f64).round() as i32;
        let x1 = wa.x + ((z.x + z.w) * wa.w as f64).round() as i32;
        let y1 = wa.y + ((z.y + z.h) * wa.h as f64).round() as i32;
        let hl = if z.x <= 0.0001 { g } else { g / 2 };
        let ht = if z.y <= 0.0001 { g } else { g / 2 };
        let hr = if z.x + z.w >= 0.9999 { g } else { g / 2 };
        let hb = if z.y + z.h >= 0.9999 { g } else { g / 2 };
        Rect { x: x0 + hl, y: y0 + ht, w: (x1 - x0 - hl - hr).max(50), h: (y1 - y0 - ht - hb).max(50) }
    }).collect()
}

pub fn foreground() -> Option<isize> {
    unsafe {
        let h = GetForegroundWindow();
        if h.is_invalid() || !is_app_window(h) { None } else { Some(h.0 as isize) }
    }
}

pub fn monitor_of(hwnd: isize) -> Option<Monitor> {
    let mons = monitors();
    let key = monitor_key_for(HWND(hwnd as _), &mons);
    mons.into_iter().find(|m| m.key == key)
}

/// Snap a window into zone `idx` of `layout` on its current monitor.
pub fn snap(hwnd: isize, layout: &Layout, idx: usize) -> Result<(), String> {
    let m = monitor_of(hwnd).ok_or("No monitor")?;
    let rects = zone_rects(&m, layout);
    let r = *rects.get(idx).ok_or("No such zone")?;
    place(hwnd, r)
}

/// Which zone (index) best contains the window centre.
pub fn current_zone(hwnd: isize, layout: &Layout) -> Option<usize> {
    let m = monitor_of(hwnd)?;
    let mut r = RECT::default();
    unsafe { let _ = GetWindowRect(HWND(hwnd as _), &mut r); }
    let (cx, cy) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    zone_rects(&m, layout).iter().position(|z| cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h)
}

/// Span a window across zones a..=b (G9-10): union of their rectangles.
pub fn span(hwnd: isize, layout: &Layout, a: usize, b: usize) -> Result<(), String> {
    let m = monitor_of(hwnd).ok_or("No monitor")?;
    let rs = zone_rects(&m, layout);
    let (lo, hi) = (a.min(b), a.max(b));
    let sel: Vec<_> = rs.get(lo..=hi).ok_or("No such zones")?.to_vec();
    let x0 = sel.iter().map(|r| r.x).min().unwrap();
    let y0 = sel.iter().map(|r| r.y).min().unwrap();
    let x1 = sel.iter().map(|r| r.x + r.w).max().unwrap();
    let y1 = sel.iter().map(|r| r.y + r.h).max().unwrap();
    place(hwnd, Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
}

// ---------- Workspaces (WORKSPACE-01..03) ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WsEntry {
    pub exe: String,
    pub title_hint: String,
    pub monitor: String,
    /// Window frame as fractions of the monitor work area — resolution independent.
    pub frac: Zone,
    #[serde(default)]
    pub launch: bool,
    #[serde(default)]
    pub args: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub entries: Vec<WsEntry>,
    #[serde(default)]
    pub layout: Option<String>,
    #[serde(default)]
    pub lighting: Option<String>,
    #[serde(default)]
    pub cooling: Option<String>,
    #[serde(default)]
    pub monitoring: Option<String>,
}

pub fn capture(name: &str, exclusions: &[String]) -> Workspace {
    let mons = monitors();
    let entries = windows_list()
        .into_iter()
        .filter(|w| !w.minimized && !w.exe.is_empty() && !excluded(&w.exe, exclusions))
        .filter_map(|w| {
            let m = mons.iter().find(|m| m.key == w.monitor)?;
            let wa = m.work;
            Some(WsEntry {
                exe: w.exe,
                title_hint: w.title.chars().take(60).collect(),
                monitor: w.monitor,
                frac: Zone {
                    x: (w.rect.x - wa.x) as f64 / wa.w as f64,
                    y: (w.rect.y - wa.y) as f64 / wa.h as f64,
                    w: w.rect.w as f64 / wa.w as f64,
                    h: w.rect.h as f64 / wa.h as f64,
                },
                launch: false,
                args: String::new(),
            })
        })
        .collect();
    Workspace { id: format!("ws-{}", crate::db::now()), name: name.into(), entries, layout: None, lighting: None, cooling: None, monitoring: None }
}

#[derive(Serialize, Default)]
pub struct RestoreReport {
    pub moved: usize,
    pub launched: usize,
    pub failed: Vec<String>,
    pub undo: Vec<(isize, Rect)>,
}

pub fn restore(ws: &Workspace) -> RestoreReport {
    let mons = monitors();
    let mut rep = RestoreReport::default();
    let mut used: Vec<isize> = vec![];
    for e in &ws.entries {
        let m = mons.iter().find(|m| m.key == e.monitor).or_else(|| mons.iter().find(|m| m.primary)).or(mons.first());
        let Some(m) = m else { break };
        let wa = m.work;
        let target = Rect {
            x: wa.x + (e.frac.x * wa.w as f64).round() as i32,
            y: wa.y + (e.frac.y * wa.h as f64).round() as i32,
            w: (e.frac.w * wa.w as f64).round() as i32,
            h: (e.frac.h * wa.h as f64).round() as i32,
        };
        let find = |used: &Vec<isize>| windows_list().into_iter().find(|w| w.exe.eq_ignore_ascii_case(&e.exe) && !used.contains(&w.hwnd));
        let mut win = find(&used);
        if win.is_none() && e.launch {
            let f = wide(&e.exe);
            let a = wide(&e.args);
            unsafe { ShellExecuteW(None, PCWSTR(wide("open").as_ptr()), PCWSTR(f.as_ptr()), PCWSTR(a.as_ptr()), PCWSTR::null(), SW_SHOWNORMAL); }
            rep.launched += 1;
            for _ in 0..40 {
                std::thread::sleep(std::time::Duration::from_millis(250));
                win = find(&used);
                if win.is_some() { break; }
            }
        }
        match win {
            Some(w) => {
                rep.undo.push((w.hwnd, w.rect));
                used.push(w.hwnd);
                match place(w.hwnd, target) {
                    Ok(_) => rep.moved += 1,
                    Err(err) => rep.failed.push(format!("{}: {}", e.exe.rsplit('\\').next().unwrap_or(""), err)),
                }
            }
            None => if !e.launch { rep.failed.push(format!("{} isn't running", e.exe.rsplit('\\').next().unwrap_or(""))) },
        }
    }
    rep
}

pub fn undo(moves: &[(isize, Rect)]) -> usize {
    moves.iter().filter(|(h, r)| place(*h, *r).is_ok()).count()
}

pub fn focus(hwnd: isize) {
    unsafe {
        let h = HWND(hwnd as _);
        if IsIconic(h).as_bool() { let _ = ShowWindow(h, SW_RESTORE); }
        let _ = SetForegroundWindow(h);
    }
}

pub fn minimize(hwnd: isize) {
    unsafe { let _ = ShowWindow(HWND(hwnd as _), SW_MINIMIZE); }
}

pub fn builtin_layouts() -> Vec<Layout> {
    let cols = |id: &str, name: &str, ws: &[f64]| {
        let mut x = 0.0;
        let zones = ws.iter().map(|w| { let z = Zone { x, y: 0.0, w: *w, h: 1.0 }; x += w; z }).collect();
        Layout { id: id.into(), name: name.into(), zones, gap: 8 }
    };
    vec![
        cols("2-even", "2 columns", &[0.5, 0.5]),
        cols("3-even", "3 columns", &[1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0]),
        cols("4-even", "4 columns", &[0.25; 4]),
        cols("5-even", "5 columns", &[0.2; 5]),
        cols("25-50-25", "25 / 50 / 25", &[0.25, 0.5, 0.25]),
        cols("30-40-30", "30 / 40 / 30", &[0.3, 0.4, 0.3]),
        cols("20-60-20", "20 / 60 / 20", &[0.2, 0.6, 0.2]),
        cols("60-40", "60 / 40", &[0.6, 0.4]),
        Layout {
            id: "6-grid".into(), name: "6 grid".into(), gap: 8,
            zones: (0..6).map(|i| Zone { x: (i % 3) as f64 / 3.0, y: (i / 3) as f64 / 2.0, w: 1.0 / 3.0, h: 0.5 }).collect(),
        },
        Layout {
            id: "8-grid".into(), name: "8 grid".into(), gap: 8,
            zones: (0..8).map(|i| Zone { x: (i % 4) as f64 / 4.0, y: (i / 4) as f64 / 2.0, w: 0.25, h: 0.5 }).collect(),
        },
        Layout {
            id: "focus-stack".into(), name: "Centre + side stacks".into(), gap: 8,
            zones: vec![
                Zone { x: 0.0, y: 0.0, w: 0.25, h: 0.5 }, Zone { x: 0.0, y: 0.5, w: 0.25, h: 0.5 },
                Zone { x: 0.25, y: 0.0, w: 0.5, h: 1.0 },
                Zone { x: 0.75, y: 0.0, w: 0.25, h: 0.5 }, Zone { x: 0.75, y: 0.5, w: 0.25, h: 0.5 },
            ],
        },
    ]
}
