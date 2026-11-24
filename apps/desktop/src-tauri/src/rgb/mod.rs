//! RGB lighting studio backend (FR-06).
//! Single-owner model: exactly one provider drives a controller at a time, and the
//! OEM service conflict is detected and surfaced before we write anything.

pub mod aura_usb;
pub mod openrgb;
pub mod sim;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub type Rgb = [u8; 3];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ZoneKind {
    /// 12 V header or fixed on-board area: one colour for the whole group.
    Group,
    /// 5 V ARGB chain: individual LEDs addressable along the data line.
    Addressable,
    /// A separately addressable fan (own header/channel).
    IndependentFan,
    Unsupported,
}

#[derive(Serialize, Clone, Debug)]
pub struct ZoneInfo {
    pub index: usize,
    pub name: String,
    pub leds: usize,
    pub max_leds: usize,
    pub kind: ZoneKind,
    pub resizable: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct ControllerInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub firmware: String,
    pub zones: Vec<ZoneInfo>,
    pub notes: Vec<String>,
}

pub trait Controller: Send {
    fn info(&self) -> ControllerInfo;
    fn set_zone(&mut self, zone: usize, colors: &[Rgb]) -> Result<(), String>;
    fn resize_zone(&mut self, _zone: usize, _leds: usize) -> Result<(), String> { Err("Not resizable".into()) }
    /// Leave the hardware in a safe state (RGB-12).
    fn release(&mut self) {}
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Effect { Static, Breathing, Rainbow, Cycle, Pulse, Wave, Temperature, Off }

/// One physical fan in the rig model, mapped onto a run of LEDs.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FanSlot {
    pub id: String,
    pub name: String,
    pub controller: Option<String>,
    pub zone: usize,
    pub start: usize,
    pub count: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LightingPreset {
    pub id: String,
    pub name: String,
    pub effect: Effect,
    pub speed: u8,
    pub brightness: u8,
    pub color: String,
    pub color2: String,
    #[serde(default)]
    pub zone_colors: HashMap<String, String>, // "controller#zone" -> hex
    #[serde(default)]
    pub slot_colors: HashMap<String, String>, // slot id -> hex
}

impl Default for LightingPreset {
    fn default() -> Self {
        Self { id: "default".into(), name: "Default".into(), effect: Effect::Static, speed: 50, brightness: 85, color: "#7BCDD1".into(), color2: "#7C5CFF".into(), zone_colors: HashMap::new(), slot_colors: HashMap::new() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LightingConfig {
    pub enabled: bool,
    pub active: LightingPreset,
    pub presets: Vec<LightingPreset>,
    pub slots: Vec<FanSlot>,
    pub fps: u8,
    /// RGB-17: cap brightness during night hours.
    pub night_cap: Option<(u8, u8, u8)>, // (from_hour, to_hour, max_brightness)
    pub use_aura_usb: bool,
    pub use_openrgb: bool,
    pub use_simulated: bool,
    pub zone_sizes: HashMap<String, usize>, // "controller#zone" -> led count
}

impl Default for LightingConfig {
    fn default() -> Self {
        let slot = |id: &str, name: &str| FanSlot { id: id.into(), name: name.into(), controller: None, zone: 0, start: 0, count: 0 };
        Self {
            enabled: true,
            active: LightingPreset::default(),
            presets: vec![
                LightingPreset::default(),
                LightingPreset { id: "focus".into(), name: "Focus".into(), effect: Effect::Static, speed: 30, brightness: 55, color: "#F2E6D0".into(), color2: "#F2E6D0".into(), ..Default::default() },
                LightingPreset { id: "gaming".into(), name: "Gaming".into(), effect: Effect::Wave, speed: 65, brightness: 100, color: "#FF2D55".into(), color2: "#7C5CFF".into(), ..Default::default() },
                LightingPreset { id: "night".into(), name: "Night".into(), effect: Effect::Breathing, speed: 15, brightness: 25, color: "#3D5AFE".into(), color2: "#3D5AFE".into(), ..Default::default() },
                LightingPreset { id: "thermal".into(), name: "Thermal".into(), effect: Effect::Temperature, speed: 50, brightness: 90, color: "#00B0FF".into(), color2: "#FF1744".into(), ..Default::default() },
            ],
            slots: vec![slot("rear", "Rear"), slot("front1", "Front top"), slot("front2", "Front middle"), slot("front3", "Front bottom"), slot("cpu", "CPU cooler")],
            fps: 30,
            night_cap: None,
            use_aura_usb: true,
            use_openrgb: false,
            use_simulated: false,
            zone_sizes: HashMap::new(),
        }
    }
}

#[derive(Serialize, Clone, Default)]
pub struct RgbStatus {
    pub controllers: Vec<ControllerInfo>,
    pub conflict: Option<String>,
    pub errors: Vec<String>,
    pub identify: Option<String>,
    pub frames: u64,
}

pub struct RgbEngine {
    pub cfg: Mutex<LightingConfig>,
    ctrls: Mutex<Vec<Box<dyn Controller>>>,
    pub status: Mutex<RgbStatus>,
    identify: Mutex<Option<(String, usize, usize, usize, Instant)>>, // controller, zone, start, count, until
    pub cpu_temp: Mutex<Option<f32>>,
    pub preview: Mutex<HashMap<String, Rgb>>, // slot id -> colour (for the 3D model)
    rescan: std::sync::atomic::AtomicBool,
    flash: Mutex<Option<(Rgb, Instant)>>, // notification flash (RGB-14)
}

pub fn parse_hex(s: &str) -> Rgb {
    let s = s.trim().trim_start_matches('#');
    if s.len() != 6 { return [124, 92, 255]; }
    let p = |i: usize| u8::from_str_radix(&s[i..i + 2], 16).unwrap_or(0);
    [p(0), p(2), p(4)]
}

pub fn hsv(h: f64, s: f64, v: f64) -> Rgb {
    let h = h.rem_euclid(360.0);
    let c = v * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = v - c;
    let (r, g, b) = match h as u32 {
        0..=59 => (c, x, 0.0), 60..=119 => (x, c, 0.0), 120..=179 => (0.0, c, x),
        180..=239 => (0.0, x, c), 240..=299 => (x, 0.0, c), _ => (c, 0.0, x),
    };
    [((r + m) * 255.0) as u8, ((g + m) * 255.0) as u8, ((b + m) * 255.0) as u8]
}

fn lerp(a: Rgb, b: Rgb, t: f64) -> Rgb {
    let t = t.clamp(0.0, 1.0);
    [0, 1, 2].map(|i| (a[i] as f64 + (b[i] as f64 - a[i] as f64) * t) as u8)
}

fn scale(c: Rgb, k: f64) -> Rgb {
    c.map(|v| (v as f64 * k.clamp(0.0, 1.0)) as u8)
}

/// Shared effect maths — also mirrored in the UI's 3D preview.
pub fn shade(p: &LightingPreset, base: Rgb, t: f64, pos: f64, temp: Option<f32>) -> Rgb {
    let sp = 0.1 + p.speed as f64 / 100.0 * 1.9;
    let k = p.brightness as f64 / 100.0;
    let c2 = parse_hex(&p.color2);
    let px = match p.effect {
        Effect::Off => [0, 0, 0],
        Effect::Static => base,
        Effect::Breathing => scale(base, 0.06 + 0.94 * (0.5 - 0.5 * (t * sp * std::f64::consts::PI).cos())),
        Effect::Pulse => { let f = (t * sp * 1.2).fract(); scale(base, if f < 0.15 { f / 0.15 } else { (1.0 - (f - 0.15) / 0.85).powf(2.0) }) }
        Effect::Rainbow => hsv(t * sp * 90.0 + 360.0 * pos, 1.0, 1.0),
        Effect::Cycle => hsv(t * sp * 60.0, 1.0, 1.0),
        Effect::Wave => lerp(base, c2, 0.5 + 0.5 * ((pos * 2.0 - t * sp) * std::f64::consts::TAU).sin()),
        Effect::Temperature => {
            let tt = temp.map(|t| ((t as f64 - 35.0) / 50.0).clamp(0.0, 1.0)).unwrap_or(0.3);
            lerp(base, c2, tt)
        }
    };
    scale(px, k)
}

impl RgbEngine {
    pub fn new(cfg: LightingConfig) -> Arc<Self> {
        Arc::new(Self {
            cfg: Mutex::new(cfg),
            ctrls: Mutex::new(vec![]),
            status: Mutex::new(RgbStatus::default()),
            identify: Mutex::new(None),
            cpu_temp: Mutex::new(None),
            preview: Mutex::new(HashMap::new()),
            rescan: std::sync::atomic::AtomicBool::new(true),
            flash: Mutex::new(None),
        })
    }

    pub fn request_rescan(&self) {
        self.rescan.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn identify(&self, slot: &FanSlot) -> Result<(), String> {
        let c = slot.controller.clone().ok_or("This fan isn't mapped to a controller yet")?;
        *self.identify.lock() = Some((c, slot.zone, slot.start, slot.count.max(1), Instant::now() + Duration::from_secs(4)));
        Ok(())
    }

    pub fn identify_zone(&self, controller: &str, zone: usize, start: usize, count: usize) {
        *self.identify.lock() = Some((controller.into(), zone, start, count.max(1), Instant::now() + Duration::from_secs(4)));
    }

    pub fn flash(&self, color: Rgb) {
        *self.flash.lock() = Some((color, Instant::now() + Duration::from_millis(1600)));
    }

    pub fn resize(&self, controller: &str, zone: usize, leds: usize) -> Result<(), String> {
        let mut cs = self.ctrls.lock();
        let c = cs.iter_mut().find(|c| c.info().id == controller).ok_or("No such controller")?;
        c.resize_zone(zone, leds)?;
        self.cfg.lock().zone_sizes.insert(format!("{}#{}", controller, zone), leds);
        drop(cs);
        self.refresh_status();
        Ok(())
    }

    fn refresh_status(&self) {
        let infos: Vec<ControllerInfo> = self.ctrls.lock().iter().map(|c| c.info()).collect();
        self.status.lock().controllers = infos;
    }

    fn discover(&self) {
        let cfg = self.cfg.lock().clone();
        let mut list: Vec<Box<dyn Controller>> = vec![];
        let mut errors = vec![];
        {
            let mut old = self.ctrls.lock();
            for c in old.iter_mut() { c.release(); }
            old.clear();
        }
        if cfg.use_aura_usb {
            match aura_usb::AuraUsb::open_all() {
                Ok(v) => for mut c in v {
                    let id = c.info().id;
                    for (k, n) in &cfg.zone_sizes {
                        if let Some((cid, z)) = k.split_once('#') {
                            if cid == id { let _ = c.resize_zone(z.parse().unwrap_or(0), *n); }
                        }
                    }
                    list.push(Box::new(c));
                },
                Err(e) => errors.push(format!("ASUS Aura USB: {}", e)),
            }
        }
        if cfg.use_openrgb {
            match openrgb::OpenRgb::connect_all() {
                Ok(v) => for c in v { list.push(Box::new(c)); },
                Err(e) => errors.push(format!("OpenRGB: {}", e)),
            }
        }
        if cfg.use_simulated || (list.is_empty() && cfg!(debug_assertions)) {
            list.push(Box::new(sim::Simulated::new()));
        }
        *self.ctrls.lock() = list;
        let mut st = self.status.lock();
        st.errors = errors;
        st.conflict = conflict();
        drop(st);
        self.refresh_status();
    }

    pub fn release_all(&self) {
        for c in self.ctrls.lock().iter_mut() { c.release(); }
    }
}

/// OEM lighting software that would fight us for the controller (RGB-03).
pub fn conflict() -> Option<String> {
    let Ok(mut sys) = sysinfo::System::new() else { return None };
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let names = ["lightingservice.exe", "armourycrate.exe", "openrgb.exe", "signalrgb.exe", "icue.exe", "nzxt cam.exe"];
    let mut found = vec![];
    for p in sys.processes().values() {
        let n = p.name().to_string_lossy().to_lowercase();
        if names.contains(&n.as_str()) && !found.contains(&n) { found.push(n); }
    }
    if found.iter().any(|n| n == "lightingservice.exe") {
        Some("Armoury Crate's LightingService is running and will overwrite colours. Use “Pause OEM lighting” (needs the hardware helper), or let Armoury Crate own the lights.".into())
    } else if !found.is_empty() {
        Some(format!("Other RGB software is running: {}", found.join(", ")))
    } else {
        None
    }
}

pub fn spawn(app: AppHandle, eng: Arc<RgbEngine>) {
    std::thread::Builder::new().name("rgb".into()).spawn(move || {
        let start = Instant::now();
        let mut last_sent: HashMap<(usize, usize), Vec<Rgb>> = HashMap::new();
        let mut last_keepalive = Instant::now();
        let mut frames: u64 = 0;
        let mut last_emit = Instant::now();
        loop {
            if eng.rescan.swap(false, std::sync::atomic::Ordering::Relaxed) {
                eng.discover();
                last_sent.clear();
                let _ = app.emit("rgb-status", eng.status.lock().clone());
            }
            let cfg = eng.cfg.lock().clone();
            let fps = cfg.fps.clamp(5, 60) as u64;
            let animated = !matches!(cfg.active.effect, Effect::Static | Effect::Off);
            let ident = eng.identify.lock().clone().filter(|(_, _, _, _, until)| Instant::now() < *until);
            let flash = eng.flash.lock().clone().filter(|(_, until)| Instant::now() < *until);
            let t = start.elapsed().as_secs_f64();
            let temp = *eng.cpu_temp.lock();
            let mut preset = cfg.active.clone();
            if let Some((from, to, cap)) = cfg.night_cap {
                let h = chrono::Local::now().format("%H").to_string().parse::<u8>().unwrap_or(12);
                let night = if from <= to { h >= from && h < to } else { h >= from || h < to };
                if night { preset.brightness = preset.brightness.min(cap); }
            }
            if !cfg.enabled { preset.effect = Effect::Off; }

            // Preview colours for the 3D rig (UI mirrors effects itself; this is the slot base colour).
            {
                let mut pv = eng.preview.lock();
                for (i, s) in cfg.slots.iter().enumerate() {
                    let base = parse_hex(preset.slot_colors.get(&s.id).unwrap_or(&preset.color));
                    pv.insert(s.id.clone(), shade(&preset, base, t, i as f64 / cfg.slots.len().max(1) as f64, temp));
                }
            }

            let keepalive = last_keepalive.elapsed() > Duration::from_secs(2);
            let mut errs = vec![];
            {
                let mut cs = eng.ctrls.lock();
                for (ci, c) in cs.iter_mut().enumerate() {
                    let info = c.info();
                    for z in &info.zones {
                        if z.kind == ZoneKind::Unsupported || z.leds == 0 { continue; }
                        let zkey = format!("{}#{}", info.id, z.index);
                        let zbase = parse_hex(preset.zone_colors.get(&zkey).unwrap_or(&preset.color));
                        let mut buf: Vec<Rgb> = vec![zbase; z.leds];
                        for s in cfg.slots.iter().filter(|s| s.controller.as_deref() == Some(info.id.as_str()) && s.zone == z.index) {
                            if let Some(hex) = preset.slot_colors.get(&s.id) {
                                let col = parse_hex(hex);
                                for i in s.start..(s.start + s.count).min(z.leds) { buf[i] = col; }
                            }
                        }
                        let n = buf.len().max(1) as f64;
                        let mut out: Vec<Rgb> = buf.iter().enumerate().map(|(i, b)| shade(&preset, *b, t, i as f64 / n, temp)).collect();
                        if let Some((col, _)) = flash {
                            let f = 0.5 + 0.5 * (t * 10.0).sin();
                            out = out.into_iter().map(|c| lerp(c, col, f)).collect();
                        }
                        if let Some((ic, iz, is, icount, _)) = &ident {
                            let on = (t * 4.0).fract() < 0.5;
                            out = vec![[0, 0, 0]; z.leds];
                            if *ic == info.id && *iz == z.index && on {
                                for i in *is..(*is + *icount).min(z.leds) { out[i] = [255, 255, 255]; }
                            }
                        }
                        let key = (ci, z.index);
                        let changed = last_sent.get(&key).map(|v| v != &out).unwrap_or(true);
                        if changed || keepalive {
                            if let Err(e) = c.set_zone(z.index, &out) { errs.push(format!("{}: {}", info.name, e)); }
                            last_sent.insert(key, out);
                        }
                    }
                }
            }
            if keepalive { last_keepalive = Instant::now(); }
            frames += 1;
            if !errs.is_empty() {
                let mut st = eng.status.lock();
                st.errors = errs;
                if last_emit.elapsed() > Duration::from_secs(2) {
                    let _ = app.emit("rgb-status", st.clone());
                    last_emit = Instant::now();
                }
                drop(st);
                // RGB-12: a controller vanished — rediscover after a pause.
                std::thread::sleep(Duration::from_secs(2));
                eng.request_rescan();
            }
            eng.status.lock().frames = frames;
            let busy = animated || ident.is_some() || flash.is_some();
            std::thread::sleep(Duration::from_millis(if busy { 1000 / fps } else { 120 }));
        }
    }).ok();
}
