//! Clipboard history (opt-in, sensitive-content aware) and screenshots.

use crate::winutil::*;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use windows::core::PCWSTR;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::Memory::*;
use windows::Win32::UI::WindowsAndMessaging::*;

#[derive(Serialize, Clone)]
pub struct Clip {
    pub id: u64,
    pub ts: i64,
    pub text: String,
    pub pinned: bool,
}

pub struct Clipboard {
    pub enabled: AtomicBool,
    pub items: Mutex<VecDeque<Clip>>,
}

impl Clipboard {
    pub fn new() -> Arc<Self> { Arc::new(Self { enabled: AtomicBool::new(false), items: Mutex::new(VecDeque::new()) }) }
}

/// Heuristic: looks like a password/secret -> never stored (FILES-03).
fn looks_secret(s: &str) -> bool {
    let t = s.trim();
    if t.len() < 8 || t.len() > 128 || t.contains(char::is_whitespace) { return false; }
    let classes = [t.chars().any(|c| c.is_ascii_lowercase()), t.chars().any(|c| c.is_ascii_uppercase()), t.chars().any(|c| c.is_ascii_digit()), t.chars().any(|c| !c.is_alphanumeric())];
    let prefixes = ["sk-", "ghp_", "gho_", "xox", "AKIA", "eyJ", "-----BEGIN"];
    classes.iter().filter(|x| **x).count() >= 3 || prefixes.iter().any(|p| t.starts_with(p))
}

unsafe fn format_present(name: &str) -> bool {
    let w = wide(name);
    let f = RegisterClipboardFormatW(PCWSTR(w.as_ptr()));
    f != 0 && IsClipboardFormatAvailable(f).is_ok()
}

unsafe fn read_text() -> Option<String> {
    // Honour the Windows conventions password managers use to opt out of history.
    if format_present("ExcludeClipboardContentFromMonitorProcessing") { return None; }
    if format_present("CanIncludeInClipboardHistory") {
        let w = wide("CanIncludeInClipboardHistory");
        let f = RegisterClipboardFormatW(PCWSTR(w.as_ptr()));
        if let Ok(h) = GetClipboardData(f) {
            let p = GlobalLock(HGLOBAL(h.0)) as *const u32;
            let allowed = !p.is_null() && *p != 0;
            let _ = GlobalUnlock(HGLOBAL(h.0));
            if !allowed { return None; }
        }
    }
    let h = GetClipboardData(13 /* CF_UNICODETEXT */).ok()?;
    let p = GlobalLock(HGLOBAL(h.0)) as *const u16;
    if p.is_null() { return None; }
    let mut len = 0;
    while *p.add(len) != 0 && len < 200_000 { len += 1; }
    let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
    let _ = GlobalUnlock(HGLOBAL(h.0));
    Some(s)
}

pub fn spawn_watcher(c: Arc<Clipboard>) {
    std::thread::spawn(move || {
        let mut last_seq = 0u32;
        let mut id = 0u64;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(800));
            if !c.enabled.load(Ordering::Relaxed) { continue; }
            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq == last_seq { continue; }
            last_seq = seq;
            let text = unsafe {
                if OpenClipboard(None).is_err() { continue; }
                let t = read_text();
                let _ = CloseClipboard();
                t
            };
            let Some(text) = text else { continue };
            if text.trim().is_empty() || looks_secret(&text) { continue; }
            let mut items = c.items.lock();
            items.retain(|i| i.text != text || i.pinned);
            id += 1;
            items.push_front(Clip { id, ts: crate::db::now(), text: text.chars().take(20_000).collect(), pinned: false });
            while items.len() > 60 {
                if let Some(pos) = items.iter().rposition(|i| !i.pinned) { items.remove(pos); } else { break; }
            }
        }
    });
}

/// Capture the virtual screen, one monitor or the foreground window to a PNG file.
/// Returns (path, width, height).
pub fn screenshot(target: &str, monitor: Option<usize>) -> Result<(String, u32, u32), String> {
    let (x, y, w, h) = unsafe {
        match target {
            "window" => {
                let hw = GetForegroundWindow();
                let mut r = RECT::default();
                let _ = windows::Win32::Graphics::Dwm::DwmGetWindowAttribute(hw, windows::Win32::Graphics::Dwm::DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut _ as _, 16);
                (r.left, r.top, r.right - r.left, r.bottom - r.top)
            }
            "monitor" => {
                let mons = crate::wm::monitors();
                let m = mons.get(monitor.unwrap_or(0)).ok_or("No such monitor")?;
                (m.bounds.x, m.bounds.y, m.bounds.w, m.bounds.h)
            }
            _ => (
                GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN),
            ),
        }
    };
    if w <= 0 || h <= 0 { return Err("Nothing to capture".into()); }
    let mut pixels = vec![0u8; (w * h * 4) as usize];
    unsafe {
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        let _ = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT);
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() },
            ..Default::default()
        };
        GetDIBits(mem, bmp, 0, h as u32, Some(pixels.as_mut_ptr() as _), &mut bi, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
    }
    for px in pixels.chunks_exact_mut(4) { px.swap(0, 2); px[3] = 255; }
    let dir = std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into())).join("Pictures").join("Screenshots");
    std::fs::create_dir_all(&dir).ok();
    let path = dir.join(format!("GlassCore-{}.png", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    let f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(f), w as u32, h as u32);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut wr = enc.write_header().map_err(|e| e.to_string())?;
    wr.write_image_data(&pixels).map_err(|e| e.to_string())?;
    Ok((path.to_string_lossy().to_string(), w as u32, h as u32))
}
