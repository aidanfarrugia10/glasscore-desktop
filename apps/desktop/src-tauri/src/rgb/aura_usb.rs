//! ASUS Aura USB motherboard controller (e.g. 0B05:19AF "AURA LED Controller").
//!
//! Protocol notes (65-byte HID reports, first byte 0xEC; the query replies were
//! independently verified on a 0B05:19AF controller):
//!   EC 82            -> EC 02 "<firmware string>"
//!   EC B0            -> EC 30 00 <60-byte config table>; table[2] = addressable channels,
//!                       table[0x1B] = on-board LED count
//!   EC 35 ch 00 00 m -> set channel effect mode (0xFF = direct / software control)
//!   EC 40 ch|0x80? start count RGB*count  -> direct colours, ≤20 LEDs per report,
//!                       0x80 flag on the final report applies the frame
//! Only allow-listed product IDs are touched, and only after the firmware and config
//! table read back correctly. No flash/save commands are ever sent.

use super::*;
use crate::winutil::*;
use windows::core::PCWSTR;
use windows::Win32::Devices::DeviceAndDriverInstallation::*;
use windows::Win32::Devices::HumanInterfaceDevice::*;
use windows::Win32::Foundation::*;
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::Threading::*;
use windows::Win32::System::IO::*;

const PIDS: &[u16] = &[0x18F3, 0x1939, 0x19AF, 0x1AA6];
const MAX_PER_PACKET: usize = 20;
const MODE_DIRECT: u8 = 0xFF;

pub struct AuraUsb {
    h: HANDLE,
    pid: u16,
    firmware: String,
    channels: usize,
    onboard_leds: usize,
    sizes: Vec<usize>,
    direct_set: bool,
}

unsafe impl Send for AuraUsb {}

fn hid_paths() -> Vec<String> {
    let mut out = vec![];
    unsafe {
        let g = HidD_GetHidGuid();
        let Ok(set) = SetupDiGetClassDevsW(Some(&g), PCWSTR::null(), None, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE) else { return out };
        let mut i = 0;
        loop {
            let mut d = SP_DEVICE_INTERFACE_DATA { cbSize: std::mem::size_of::<SP_DEVICE_INTERFACE_DATA>() as u32, ..Default::default() };
            if SetupDiEnumDeviceInterfaces(set, None, &g, i, &mut d).is_err() { break; }
            i += 1;
            let mut need = 0u32;
            let _ = SetupDiGetDeviceInterfaceDetailW(set, &d, None, 0, Some(&mut need), None);
            if need == 0 { continue; }
            let mut buf = vec![0u8; need as usize];
            let det = buf.as_mut_ptr() as *mut SP_DEVICE_INTERFACE_DETAIL_DATA_W;
            (*det).cbSize = std::mem::size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32;
            if SetupDiGetDeviceInterfaceDetailW(set, &d, Some(det), need, None, None).is_ok() {
                let p = (*det).DevicePath.as_ptr();
                let len = (0..).take_while(|&k| *p.add(k) != 0).count();
                out.push(String::from_utf16_lossy(std::slice::from_raw_parts(p, len)));
            }
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
    }
    out
}

impl AuraUsb {
    pub fn open_all() -> Result<Vec<AuraUsb>, String> {
        let mut out = vec![];
        let mut last_err = String::from("No ASUS Aura USB controller found");
        for path in hid_paths() {
            let low = path.to_lowercase();
            if !low.contains("vid_0b05") { continue; }
            let Some(pid) = PIDS.iter().copied().find(|p| low.contains(&format!("pid_{:04x}", p))) else { continue };
            match Self::open(&path, pid) {
                Ok(c) => out.push(c),
                Err(e) => last_err = e,
            }
        }
        if out.is_empty() { Err(last_err) } else { Ok(out) }
    }

    fn open(path: &str, pid: u16) -> Result<Self, String> {
        unsafe {
            let w = wide(path);
            let h = CreateFileW(
                PCWSTR(w.as_ptr()),
                (GENERIC_READ | GENERIC_WRITE).0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                None,
            ).map_err(|e| e.message().to_string())?;
            // Only the vendor-defined Aura interface (usage page 0xFF72).
            let mut pp = PHIDP_PREPARSED_DATA::default();
            if !HidD_GetPreparsedData(h, &mut pp) { let _ = CloseHandle(h); return Err("no HID caps".into()); }
            let mut caps = HIDP_CAPS::default();
            let _ = HidP_GetCaps(pp, &mut caps);
            let _ = HidD_FreePreparsedData(pp);
            if caps.UsagePage != 0xFF72 || caps.OutputReportByteLength < 65 {
                let _ = CloseHandle(h);
                return Err("not the Aura interface".into());
            }
            let mut me = Self { h, pid, firmware: String::new(), channels: 0, onboard_leds: 0, sizes: vec![], direct_set: false };
            me.write(&[0xEC, 0x82])?;
            let fw = me.read(800).ok_or("Controller didn't answer the firmware query")?;
            if fw[0] != 0xEC || fw[1] != 0x02 { return Err("Unexpected firmware reply — not touching this controller".into()); }
            me.firmware = String::from_utf8_lossy(&fw[2..18]).trim_matches(char::from(0)).trim().to_string();
            me.write(&[0xEC, 0xB0])?;
            let cfg = me.read(800).ok_or("Controller didn't return its config table")?;
            if cfg[0] != 0xEC || cfg[1] != 0x30 { return Err("Unexpected config reply".into()); }
            let table = &cfg[4..64];
            me.channels = (table[2] as usize).min(8);
            me.onboard_leds = (table[0x1B] as usize).min(32);
            me.sizes = vec![60; me.channels];
            Ok(me)
        }
    }

    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let mut buf = [0u8; 65];
        buf[..bytes.len().min(65)].copy_from_slice(&bytes[..bytes.len().min(65)]);
        unsafe {
            let ev = CreateEventW(None, true, false, PCWSTR::null()).map_err(|e| e.message().to_string())?;
            let mut ov = OVERLAPPED { hEvent: ev, ..Default::default() };
            let _ = WriteFile(self.h, Some(&buf), None, Some(&mut ov));
            let mut done = 0u32;
            let r = GetOverlappedResultEx(self.h, &ov, &mut done, 500, false);
            if r.is_err() { let _ = CancelIoEx(self.h, Some(&ov)); }
            let _ = CloseHandle(ev);
            r.map_err(|_| "USB write failed or timed out — controller unplugged?".to_string())
        }
    }

    fn read(&self, timeout_ms: u32) -> Option<[u8; 65]> {
        let mut buf = [0u8; 65];
        unsafe {
            let ev = CreateEventW(None, true, false, PCWSTR::null()).ok()?;
            let mut ov = OVERLAPPED { hEvent: ev, ..Default::default() };
            let _ = ReadFile(self.h, Some(&mut buf), None, Some(&mut ov));
            let mut done = 0u32;
            let r = GetOverlappedResultEx(self.h, &ov, &mut done, timeout_ms, false);
            if r.is_err() { let _ = CancelIoEx(self.h, Some(&ov)); }
            let _ = CloseHandle(ev);
            r.ok()?;
        }
        Some(buf)
    }

    fn ensure_direct(&mut self) -> Result<(), String> {
        if self.direct_set { return Ok(()); }
        // Effect channel 0 = on-board / 12 V; 1..=n = addressable headers.
        for ch in 0..=self.channels as u8 {
            self.write(&[0xEC, 0x35, ch, 0x00, 0x00, MODE_DIRECT])?;
        }
        self.direct_set = true;
        Ok(())
    }

    fn direct(&self, channel: u8, colors: &[Rgb]) -> Result<(), String> {
        let chunks: Vec<&[Rgb]> = colors.chunks(MAX_PER_PACKET).collect();
        for (i, chunk) in chunks.iter().enumerate() {
            let last = i == chunks.len() - 1;
            let mut pkt = vec![0xEC, 0x40, if last { channel | 0x80 } else { channel }, (i * MAX_PER_PACKET) as u8, chunk.len() as u8];
            for c in chunk.iter() { pkt.extend_from_slice(c); }
            self.write(&pkt)?;
        }
        Ok(())
    }
}

impl Controller for AuraUsb {
    fn info(&self) -> ControllerInfo {
        let mut zones = vec![];
        for i in 0..self.channels {
            zones.push(ZoneInfo { index: i, name: format!("ARGB header {}", i + 1), leds: self.sizes[i], max_leds: 120, kind: ZoneKind::Addressable, resizable: true });
        }
        if self.onboard_leds > 0 {
            zones.push(ZoneInfo { index: self.channels, name: "On-board & 12V RGB".into(), leds: self.onboard_leds, max_leds: self.onboard_leds, kind: ZoneKind::Group, resizable: false });
        }
        ControllerInfo {
            id: format!("aura-usb-{:04x}", self.pid),
            name: "ASUS Aura motherboard controller".into(),
            provider: "ASUS Aura USB (direct)".into(),
            firmware: self.firmware.clone(),
            zones,
            notes: vec![
                "ARGB LED counts can't be read back from this controller — set each header's count to match your fans (Map fans).".into(),
            ],
        }
    }

    fn set_zone(&mut self, zone: usize, colors: &[Rgb]) -> Result<(), String> {
        self.ensure_direct()?;
        if zone < self.channels {
            self.direct(zone as u8, colors)
        } else if zone == self.channels {
            self.direct(0x04, colors)
        } else {
            Err("No such zone".into())
        }
    }

    fn resize_zone(&mut self, zone: usize, leds: usize) -> Result<(), String> {
        if zone >= self.channels { return Err("Only ARGB headers can be resized".into()); }
        self.sizes[zone] = leds.clamp(1, 120);
        Ok(())
    }

    fn release(&mut self) {
        // Leave the last frame showing (direct mode holds it). Nothing is written to flash.
        unsafe { let _ = CloseHandle(self.h); }
        self.h = HANDLE::default();
    }
}

impl Drop for AuraUsb {
    fn drop(&mut self) {
        if !self.h.is_invalid() { unsafe { let _ = CloseHandle(self.h); } }
    }
}
