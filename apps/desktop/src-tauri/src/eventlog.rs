//! Event Log reader (DIAGNOSTIC-03) via the Windows Event Log API (wevtapi).

use crate::winutil::*;
use serde::Serialize;
use windows::core::PCWSTR;
use windows::Win32::System::EventLog::*;

#[derive(Serialize, Clone)]
pub struct Event {
    pub channel: String,
    pub provider: String,
    pub id: u32,
    pub level: u8,
    pub time: String,
    pub message: String,
}

fn between<'a>(s: &'a str, a: &str, b: &str) -> Option<&'a str> {
    let i = s.find(a)? + a.len();
    let j = s[i..].find(b)? + i;
    Some(&s[i..j])
}

unsafe fn render_xml(h: EVT_HANDLE) -> String {
    let mut used = 0u32;
    let mut props = 0u32;
    let _ = EvtRender(None, h, EvtRenderEventXml.0 as u32, 0, None, &mut used, &mut props);
    if used == 0 { return String::new(); }
    let mut buf = vec![0u16; used as usize / 2 + 1];
    if EvtRender(None, h, EvtRenderEventXml.0 as u32, used, Some(buf.as_mut_ptr() as _), &mut used, &mut props).is_ok() {
        from_wide(&buf)
    } else {
        String::new()
    }
}

unsafe fn message(provider: &str, h: EVT_HANDLE) -> String {
    let p = wide(provider);
    let Ok(meta) = EvtOpenPublisherMetadata(None, PCWSTR(p.as_ptr()), PCWSTR::null(), 0, 0) else { return String::new() };
    let mut used = 0u32;
    let _ = EvtFormatMessage(Some(meta), Some(h), 0, None, EvtFormatMessageEvent.0 as u32, None, &mut used);
    let mut out = String::new();
    if used > 0 && used < 64_000 {
        let mut buf = vec![0u16; used as usize + 1];
        if EvtFormatMessage(Some(meta), Some(h), 0, None, EvtFormatMessageEvent.0 as u32, Some(&mut buf), &mut used).is_ok() {
            out = from_wide(&buf);
        }
    }
    let _ = EvtClose(meta);
    out
}

/// Newest events first. `max_level`: 1 critical, 2 error, 3 warning, 4 information.
pub fn query(channel: &str, max_level: u8, limit: usize) -> Result<Vec<Event>, String> {
    let allowed = ["System", "Application", "Setup", "Microsoft-Windows-Kernel-Power/Thermal-Operational"];
    if !allowed.contains(&channel) {
        return Err("Channel not in the allowlist".into());
    }
    let levels = (1..=max_level.clamp(1, 4)).map(|l| format!("Level={}", l)).collect::<Vec<_>>().join(" or ");
    let q = format!("*[System[({})]]", levels);
    let mut out = vec![];
    unsafe {
        let c = wide(channel);
        let qw = wide(&q);
        let rs = EvtQuery(None, PCWSTR(c.as_ptr()), PCWSTR(qw.as_ptr()), (EvtQueryChannelPath.0 | EvtQueryReverseDirection.0) as u32)
            .map_err(|e| e.message().to_string())?;
        let mut handles = [0isize; 32];
        'outer: loop {
            let mut got = 0u32;
            if EvtNext(rs, &mut handles, 1000, 0, &mut got).is_err() { break; }
            for &raw in &handles[..got as usize] {
                let h = EVT_HANDLE(raw);
                if out.len() < limit {
                    let xml = render_xml(h);
                    let provider = between(&xml, "Provider Name='", "'").unwrap_or("").to_string();
                    let id = between(&xml, "<EventID", "</EventID>").and_then(|s| s.rsplit('>').next()).and_then(|s| s.parse().ok()).unwrap_or(0);
                    let level = between(&xml, "<Level>", "</Level>").and_then(|s| s.parse().ok()).unwrap_or(0);
                    let time = between(&xml, "SystemTime='", "'").unwrap_or("").to_string();
                    let msg = message(&provider, h);
                    out.push(Event { channel: channel.into(), provider, id, level, time, message: redact(msg.trim()) });
                }
                let _ = EvtClose(h);
                if out.len() >= limit { break 'outer; }
            }
        }
        let _ = EvtClose(rs);
    }
    Ok(out)
}
