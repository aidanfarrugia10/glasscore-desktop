//! OpenRGB SDK client (RGB-04): localhost-only, protocol version negotiated (max 4).

use super::*;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};

const MAX_PROTO: u32 = 4;
const REQ_COUNT: u32 = 0;
const REQ_DATA: u32 = 1;
const REQ_PROTO: u32 = 40;
const SET_NAME: u32 = 50;
const UPDATE_ZONE_LEDS: u32 = 1051;
const SET_CUSTOM_MODE: u32 = 1100;

struct Zone { name: String, leds: usize, kind: i32 }

pub struct OpenRgb {
    stream: TcpStream,
    index: u32,
    name: String,
    version: String,
    zones: Vec<Zone>,
    proto: u32,
}

fn send(s: &mut TcpStream, dev: u32, id: u32, data: &[u8]) -> std::io::Result<()> {
    let mut b = Vec::with_capacity(16 + data.len());
    b.extend_from_slice(b"ORGB");
    b.extend_from_slice(&dev.to_le_bytes());
    b.extend_from_slice(&id.to_le_bytes());
    b.extend_from_slice(&(data.len() as u32).to_le_bytes());
    b.extend_from_slice(data);
    s.write_all(&b)
}

fn recv(s: &mut TcpStream) -> std::io::Result<(u32, Vec<u8>)> {
    let mut h = [0u8; 16];
    s.read_exact(&mut h)?;
    if &h[0..4] != b"ORGB" { return Err(std::io::Error::other("bad magic")); }
    let id = u32::from_le_bytes(h[8..12].try_into().unwrap());
    let size = u32::from_le_bytes(h[12..16].try_into().unwrap()) as usize;
    if size > 4 * 1024 * 1024 { return Err(std::io::Error::other("packet too large")); }
    let mut d = vec![0u8; size];
    s.read_exact(&mut d)?;
    Ok((id, d))
}

struct Cur<'a> { b: &'a [u8], i: usize }
impl<'a> Cur<'a> {
    fn u16(&mut self) -> Option<u16> { let v = u16::from_le_bytes(self.b.get(self.i..self.i + 2)?.try_into().ok()?); self.i += 2; Some(v) }
    fn u32(&mut self) -> Option<u32> { let v = u32::from_le_bytes(self.b.get(self.i..self.i + 4)?.try_into().ok()?); self.i += 4; Some(v) }
    fn i32(&mut self) -> Option<i32> { self.u32().map(|v| v as i32) }
    fn str(&mut self) -> Option<String> {
        let n = self.u16()? as usize;
        let s = self.b.get(self.i..self.i + n)?;
        self.i += n;
        Some(String::from_utf8_lossy(s).trim_end_matches('\0').to_string())
    }
    fn skip(&mut self, n: usize) -> Option<()> { if self.i + n > self.b.len() { None } else { self.i += n; Some(()) } }
}

fn parse(d: &[u8], proto: u32) -> Option<(String, String, Vec<Zone>)> {
    let mut c = Cur { b: d, i: 0 };
    c.u32()?; // data size
    c.i32()?; // type
    let name = c.str()?;
    if proto >= 1 { c.str()?; } // vendor
    c.str()?; // description
    let version = c.str()?;
    c.str()?; // serial
    c.str()?; // location
    let modes = c.u16()?;
    c.i32()?; // active mode
    for _ in 0..modes {
        c.str()?; c.i32()?; c.u32()?; c.u32()?; c.u32()?;
        if proto >= 3 { c.u32()?; c.u32()?; }
        c.u32()?; c.u32()?; c.u32()?;
        if proto >= 3 { c.u32()?; }
        c.u32()?; c.u32()?;
        let nc = c.u16()? as usize;
        c.skip(nc * 4)?;
    }
    let nz = c.u16()?;
    let mut zones = vec![];
    for _ in 0..nz {
        let zn = c.str()?;
        let kind = c.i32()?;
        c.u32()?; c.u32()?;
        let count = c.u32()? as usize;
        let ml = c.u16()?;
        if ml > 0 { let h = c.u32()? as usize; let w = c.u32()? as usize; c.skip(h * w * 4)?; }
        if proto >= 4 {
            let ns = c.u16()?;
            for _ in 0..ns { c.str()?; c.i32()?; c.u32()?; c.u32()?; }
        }
        zones.push(Zone { name: zn, leds: count, kind });
    }
    Some((name, version, zones))
}

impl OpenRgb {
    pub fn connect_all() -> Result<Vec<OpenRgb>, String> {
        let addr: SocketAddr = "127.0.0.1:6742".parse().unwrap();
        let open = || -> Result<(TcpStream, u32), String> {
            let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).map_err(|_| "SDK server not running on localhost:6742".to_string())?;
            s.set_read_timeout(Some(Duration::from_secs(2))).ok();
            s.set_nodelay(true).ok();
            send(&mut s, 0, REQ_PROTO, &MAX_PROTO.to_le_bytes()).map_err(|e| e.to_string())?;
            let proto = match recv(&mut s) { Ok((_, d)) if d.len() >= 4 => u32::from_le_bytes(d[0..4].try_into().unwrap()).min(MAX_PROTO), _ => 0 };
            send(&mut s, 0, SET_NAME, b"GlassCore\0").map_err(|e| e.to_string())?;
            Ok((s, proto))
        };
        let (mut s, proto) = open()?;
        send(&mut s, 0, REQ_COUNT, &[]).map_err(|e| e.to_string())?;
        let (_, d) = recv(&mut s).map_err(|e| e.to_string())?;
        let count = u32::from_le_bytes(d.get(0..4).ok_or("bad count")?.try_into().unwrap());
        let mut out = vec![];
        for i in 0..count {
            let (mut st, p) = if i == 0 { (s.try_clone().map_err(|e| e.to_string())?, proto) } else { open()? };
            send(&mut st, i, REQ_DATA, &p.to_le_bytes()).map_err(|e| e.to_string())?;
            let (_, d) = recv(&mut st).map_err(|e| e.to_string())?;
            if let Some((name, version, zones)) = parse(&d, p) {
                let _ = send(&mut st, i, SET_CUSTOM_MODE, &[]);
                out.push(OpenRgb { stream: st, index: i, name, version, zones, proto: p });
            }
        }
        Ok(out)
    }
}

impl Controller for OpenRgb {
    fn info(&self) -> ControllerInfo {
        ControllerInfo {
            id: format!("openrgb-{}", self.index),
            name: self.name.clone(),
            provider: format!("OpenRGB SDK (protocol {})", self.proto),
            firmware: self.version.clone(),
            zones: self.zones.iter().enumerate().map(|(i, z)| ZoneInfo {
                index: i,
                name: z.name.clone(),
                leds: z.leds,
                max_leds: z.leds,
                kind: match z.kind { 0 => ZoneKind::Group, _ => ZoneKind::Addressable },
                resizable: false,
            }).collect(),
            notes: vec![],
        }
    }
    fn set_zone(&mut self, zone: usize, colors: &[Rgb]) -> Result<(), String> {
        let mut d = Vec::with_capacity(10 + colors.len() * 4);
        let size = (4 + 4 + 2 + colors.len() * 4) as u32;
        d.extend_from_slice(&size.to_le_bytes());
        d.extend_from_slice(&(zone as u32).to_le_bytes());
        d.extend_from_slice(&(colors.len() as u16).to_le_bytes());
        for c in colors { d.extend_from_slice(&[c[0], c[1], c[2], 0]); }
        send(&mut self.stream, self.index, UPDATE_ZONE_LEDS, &d).map_err(|e| e.to_string())
    }
}
