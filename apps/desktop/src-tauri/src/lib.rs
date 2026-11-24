#![allow(non_snake_case, non_upper_case_globals, dead_code)]
//! GlassCore core agent: state, allow-listed commands, automation engine, tray,
//! hotkeys, dock window and glass backdrop.

mod audio;
mod broker;
mod cooling;
mod db;
mod eventlog;
mod network;
mod pdh;
mod procctl;
mod rgb;
mod rules;
mod services;
mod sysinv;
mod tasks;
mod telemetry;
mod tools;
mod winutil;
mod wm;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

type R<T> = Result<T, String>;

#[derive(Serialize, Deserialize, Clone)]
pub struct WmConfig {
    pub active_layout: String,
    pub custom: Vec<wm::Layout>,
    pub exclusions: Vec<String>,
    pub workspaces: Vec<wm::Workspace>,
    pub active_workspace: Option<String>,
}

impl Default for WmConfig {
    fn default() -> Self {
        Self { active_layout: "30-40-30".into(), custom: vec![], exclusions: vec![], workspaces: vec![], active_workspace: None }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Prefs {
    pub theme: String,       // dark | light | system | contrast
    pub glass: String,       // acrylic | mica | opaque
    pub glass_opacity: f32,  // 0..1 tint strength
    pub accent: String,
    pub reduced_motion: bool,
    pub density: String,     // comfortable | compact
    pub radius: u8,
    pub dock: bool,
    pub dock_autohide: bool,
    pub dock_pins: Vec<String>,
    pub start_hidden: bool,
    pub clipboard_history: bool,
    pub telemetry_paused: bool,
    pub hotkeys: HashMap<String, String>,
    pub modules: HashMap<String, bool>,
    pub notes: String,
    pub snippets: Vec<(String, String)>,
}

impl Default for Prefs {
    fn default() -> Self {
        let hk = [("palette", "Ctrl+Alt+Space"), ("snap", "Ctrl+Alt+<1-9>"), ("zone_prev", "Ctrl+Alt+Left"), ("zone_next", "Ctrl+Alt+Right"), ("gaming", "Ctrl+Alt+G")]
            .iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        Self {
            theme: "dark".into(), glass: "acrylic".into(), glass_opacity: 0.62, accent: "#7BCDD1".into(), reduced_motion: false,
            density: "comfortable".into(), radius: 14, dock: false, dock_autohide: true, dock_pins: vec![], start_hidden: false,
            clipboard_history: false, telemetry_paused: false, hotkeys: hk, modules: HashMap::new(), notes: String::new(), snippets: vec![],
        }
    }
}

pub struct AppState {
    db: Arc<db::Db>,
    tel: Arc<telemetry::Telemetry>,
    rgb: Arc<rgb::RgbEngine>,
    broker: Arc<broker::Broker>,
    clip: Arc<tools::Clipboard>,
    wm: Mutex<WmConfig>,
    prefs: Mutex<Prefs>,
    cooling: Mutex<cooling::CoolingConfig>,
    rules: Mutex<rules::RulesConfig>,
    rule_stats: Mutex<HashMap<String, rules::RuleStats>>,
    events: Mutex<VecDeque<(String, bool)>>, // (event, from_rule)
    undo_ws: Mutex<Vec<(isize, wm::Rect)>>,
    gaming: Mutex<Option<(String, bool)>>, // previous lighting preset, dock state
    hotkey_errors: Mutex<Vec<String>>,
}

impl AppState {
    fn save_wm(&self) { let _ = self.db.put("wm", &*self.wm.lock()); }
    fn save_prefs(&self) { let _ = self.db.put("prefs", &*self.prefs.lock()); }
    fn save_rgb(&self) { let _ = self.db.put("lighting", &*self.rgb.cfg.lock()); }
    fn save_cooling(&self) { let _ = self.db.put("cooling", &*self.cooling.lock()); }
    fn save_rules(&self) { let _ = self.db.put("rules", &*self.rules.lock()); }
    fn layout(&self, id: &str) -> Option<wm::Layout> {
        let c = self.wm.lock();
        c.custom.iter().cloned().chain(wm::builtin_layouts()).find(|l| l.id == id)
    }
    fn push_event(&self, e: &str, from_rule: bool) {
        let mut q = self.events.lock();
        q.push_back((e.to_string(), from_rule));
        while q.len() > 50 { q.pop_front(); }
    }
}

/// Privileged commands must come from the main window, never the dock (PRIVACY-02).
fn main_only(w: &Window) -> R<()> {
    if w.label() == "main" { Ok(()) } else { Err("Not permitted from this window".into()) }
}

// ======================= general =======================

#[tauri::command]
fn app_info(st: State<AppState>) -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "admin": winutil::is_admin(),
        "db": st.db.path.to_string_lossy(),
        "helper_available": broker::helper_exe().is_some(),
    })
}

#[tauri::command]
fn set_visible(st: State<AppState>, visible: bool) { st.tel.visible.store(visible, Ordering::Relaxed); }

#[tauri::command]
fn prefs_get(st: State<AppState>) -> Prefs { st.prefs.lock().clone() }

#[tauri::command]
fn prefs_set(app: AppHandle, st: State<AppState>, w: Window, prefs: Prefs) -> R<()> {
    main_only(&w)?;
    let old = st.prefs.lock().clone();
    st.clip.enabled.store(prefs.clipboard_history, Ordering::Relaxed);
    if !prefs.clipboard_history { st.clip.items.lock().retain(|c| c.pinned); }
    st.tel.paused.store(prefs.telemetry_paused, Ordering::Relaxed);
    let glass_changed = old.glass != prefs.glass || old.theme != prefs.theme;
    let dock_changed = old.dock != prefs.dock;
    *st.prefs.lock() = prefs.clone();
    st.save_prefs();
    if glass_changed { if let Some(win) = app.get_webview_window("main") { apply_glass(&win, &prefs); } }
    if dock_changed { toggle_dock(&app, prefs.dock); }
    let _ = app.emit("prefs", &prefs);
    Ok(())
}

#[tauri::command]
fn audit_log(st: State<AppState>, limit: i64) -> R<Vec<db::AuditRow>> { db::audit_list(&st.db, limit.clamp(1, 2000)) }

#[tauri::command]
fn diagnostics(st: State<AppState>) -> Value {
    let helper = broker::helper_exe();
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "admin": winutil::is_admin(),
        "db_integrity": st.db.integrity(),
        "db_path": winutil::redact(&st.db.path.to_string_lossy()),
        "helper_found": helper.is_some(),
        "helper_connected": st.broker.connected.load(Ordering::Relaxed),
        "helper_elevated": st.broker.elevated.load(Ordering::Relaxed),
        "rgb": st.rgb.status.lock().clone(),
        "telemetry_samples": st.tel.history.lock().len(),
        "telemetry_paused": st.tel.paused.load(Ordering::Relaxed),
        "hotkey_errors": st.hotkey_errors.lock().clone(),
        "webview": tauri::webview_version().unwrap_or_default(),
    })
}

#[tauri::command]
fn open_settings(uri: String) -> R<()> {
    // Only Windows Settings / control panel deep links (SYSTEM-12).
    let ok = uri.starts_with("ms-settings:") || ["devmgmt.msc", "services.msc", "eventvwr.msc", "taskmgr", "control", "msinfo32", "perfmon", "resmon", "sysdm.cpl", "appwiz.cpl", "mmsys.cpl", "ncpa.cpl", "powercfg.cpl", "diskmgmt.msc", "wf.msc"].contains(&uri.as_str());
    if !ok { return Err("Not an allowed settings link".into()); }
    let w = winutil::wide(&uri);
    unsafe {
        windows::Win32::UI::Shell::ShellExecuteW(None, windows::core::PCWSTR(winutil::wide("open").as_ptr()), windows::core::PCWSTR(w.as_ptr()), windows::core::PCWSTR::null(), windows::core::PCWSTR::null(), windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL);
    }
    Ok(())
}

#[tauri::command]
fn launch_path(st: State<AppState>, w: Window, path: String) -> R<()> {
    // Only executables/shortcuts the user pinned or saved in a workspace may be launched.
    let allowed = st.prefs.lock().dock_pins.iter().any(|p| p.eq_ignore_ascii_case(&path))
        || st.wm.lock().workspaces.iter().any(|ws| ws.entries.iter().any(|e| e.exe.eq_ignore_ascii_case(&path)));
    if !allowed { return Err("Pin the app first".into()); }
    let _ = w;
    let p = winutil::wide(&path);
    unsafe {
        windows::Win32::UI::Shell::ShellExecuteW(None, windows::core::PCWSTR(winutil::wide("open").as_ptr()), windows::core::PCWSTR(p.as_ptr()), windows::core::PCWSTR::null(), windows::core::PCWSTR::null(), windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL);
    }
    Ok(())
}

// ======================= telemetry & processes =======================

#[tauri::command]
fn telemetry_history(st: State<AppState>, last: Option<usize>) -> Vec<telemetry::Sample> {
    let h = st.tel.history.lock();
    let n = last.unwrap_or(h.len()).min(h.len());
    h.iter().skip(h.len() - n).cloned().collect()
}

#[tauri::command]
fn processes(st: State<AppState>) -> Vec<telemetry::ProcRow> {
    st.tel.want_procs();
    st.tel.procs.lock().clone()
}

#[tauri::command]
fn proc_events(st: State<AppState>) -> Value {
    json!({ "started": st.tel.started.lock().iter().rev().take(40).collect::<Vec<_>>(), "exited": st.tel.exited.lock().iter().rev().take(40).collect::<Vec<_>>() })
}

#[tauri::command]
fn disks(st: State<AppState>) -> Vec<telemetry::DiskRow> { st.tel.disks.lock().clone() }

#[tauri::command]
fn net_ifs(st: State<AppState>) -> Vec<telemetry::NetIf> { st.tel.nets.lock().clone() }

#[tauri::command]
fn proc_identity(pid: u32) -> procctl::Identity { procctl::identity(pid) }

#[tauri::command]
async fn proc_details(pid: u32) -> procctl::Details { tauri::async_runtime::spawn_blocking(move || procctl::details(pid)).await.unwrap() }

#[tauri::command]
fn proc_tree_preview(pid: u32) -> Vec<(u32, String)> { procctl::descendants(pid) }

#[tauri::command]
fn proc_action(st: State<AppState>, w: Window, action: String, pid: u32, created: Option<u64>, arg: Option<String>) -> R<String> {
    main_only(&w)?;
    let t = procctl::Target { pid, created };
    let res = match action.as_str() {
        "close" => procctl::close_gracefully(t).map(|n| format!("Asked {} window(s) to close", n)),
        "kill" => match procctl::terminate(t) {
            Err(e) if e.starts_with("Access denied") && st.broker.connected.load(Ordering::Relaxed) => {
                st.broker.call("proc.kill", json!({ "pid": pid, "created": created })).map(|v| v.as_str().unwrap_or("").to_string())
            }
            r => r.map(|p| format!("Ended {}", p)),
        },
        "kill_tree" => procctl::terminate_tree(t).map(|n| format!("Ended {} process(es)", n)),
        "suspend" => procctl::suspend(t, false).map(|_| "Suspended".into()),
        "resume" => procctl::suspend(t, true).map(|_| "Resumed".into()),
        "priority" => procctl::set_priority(t, arg.as_deref().unwrap_or("normal")).map(|_| "Priority changed".into()),
        "affinity" => {
            let mask = arg.and_then(|a| a.parse::<u64>().ok()).ok_or("bad mask")?;
            procctl::set_affinity(t, mask).map(|_| "Affinity changed".into())
        }
        _ => Err("Unknown action".into()),
    };
    st.db.audit("user", &format!("process.{}", action), &format!("PID {}", pid), &match &res { Ok(s) => s.clone(), Err(e) => format!("error: {}", e) });
    res
}

// ======================= network =======================

#[tauri::command]
async fn net_connections() -> Vec<network::Conn> { tauri::async_runtime::spawn_blocking(network::connections).await.unwrap() }

#[tauri::command]
async fn net_adapters() -> Vec<network::Adapter> { tauri::async_runtime::spawn_blocking(network::adapters).await.unwrap() }

#[tauri::command]
async fn net_probe(host: String, port: u16) -> Value {
    tauri::async_runtime::spawn_blocking(move || network::probe(&host, port)).await.unwrap()
}

// ======================= services / system =======================

#[tauri::command]
async fn svc_list() -> R<Vec<services::Svc>> { tauri::async_runtime::spawn_blocking(services::list).await.unwrap() }

#[tauri::command]
fn svc_dependents(name: String) -> Vec<String> { services::dependents(&name) }

#[tauri::command]
async fn svc_control(app: AppHandle, w: Window, name: String, action: String) -> R<String> {
    main_only(&w)?;
    let st = app.state::<AppState>();
    let n2 = name.clone();
    let a2 = action.clone();
    let direct = tauri::async_runtime::spawn_blocking(move || services::control(&n2, &a2)).await.unwrap();
    let res = match direct {
        Ok(()) => Ok("done".to_string()),
        Err(e) if e == "ACCESS_DENIED" => {
            if !st.broker.connected.load(Ordering::Relaxed) { Err("Needs administrator — start the hardware helper (Settings → Permissions)".to_string()) }
            else { st.broker.call("svc.control", json!({ "name": name, "action": action })).map(|v| v.as_str().unwrap_or("").to_string()) }
        }
        Err(e) => Err(e),
    };
    st.db.audit("user", &format!("service.{}", action), &name, &match &res { Ok(s) => s.clone(), Err(e) => format!("error: {}", e) });
    res
}

#[tauri::command]
fn svc_start_type(st: State<AppState>, w: Window, name: String, kind: String) -> R<String> {
    main_only(&w)?;
    let r = st.broker.call("svc.starttype", json!({ "name": name, "type": kind })).map(|v| v.as_str().unwrap_or("").to_string());
    st.db.audit("user", "service.start_type", &name, &format!("{:?}", r));
    r
}

#[tauri::command]
async fn devices() -> Vec<sysinv::Device> { tauri::async_runtime::spawn_blocking(sysinv::devices).await.unwrap() }
#[tauri::command]
fn sessions() -> Vec<sysinv::Session> { sysinv::sessions() }
#[tauri::command]
async fn inventory() -> sysinv::Inventory { tauri::async_runtime::spawn_blocking(sysinv::inventory).await.unwrap() }
#[tauri::command]
async fn installed_apps() -> Vec<sysinv::App> { tauri::async_runtime::spawn_blocking(sysinv::installed_apps).await.unwrap() }
#[tauri::command]
fn startup_items() -> Vec<sysinv::StartupItem> { sysinv::startup_items() }
#[tauri::command]
fn environment() -> Vec<sysinv::EnvVar> { sysinv::environment() }
#[tauri::command]
async fn events(channel: String, level: u8, limit: usize) -> R<Vec<eventlog::Event>> {
    tauri::async_runtime::spawn_blocking(move || eventlog::query(&channel, level, limit.min(500))).await.unwrap()
}

/// Redacted diagnostic report (SYSTEM-07 / PRIVACY-17) — returned for preview, never uploaded.
#[tauri::command]
async fn system_report(app: AppHandle) -> String {
    let st = app.state::<AppState>();
    let inv = tauri::async_runtime::spawn_blocking(sysinv::inventory).await.unwrap();
    let devs = tauri::async_runtime::spawn_blocking(sysinv::devices).await.unwrap();
    let problems: Vec<_> = devs.iter().filter(|d| d.problem != 0).map(|d| format!("- {} [{}]: {}", d.name, d.class, d.status)).collect();
    let s = st.tel.latest();
    let mut out = format!(
        "# GlassCore diagnostic report\nGenerated: {}\n\n## System\nOS: {} {} (build {})\nBoot: {}, Secure Boot: {:?}\nCPU: {} ({}C/{}T)\nBoard: {} {}\nBIOS: {} {}\nRAM: {:.1} GB\nGPUs: {}\n\n## Now\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M"), inv.os_name, inv.os_version, inv.os_build, inv.boot_mode, inv.secure_boot,
        inv.cpu, inv.cpu_cores, inv.cpu_threads, inv.board_vendor, inv.board_model, inv.bios_vendor, inv.bios_version,
        inv.ram_total as f64 / 1073741824.0, inv.gpus.iter().map(|g| g.0.clone()).collect::<Vec<_>>().join(", "),
    );
    if let Some(s) = s {
        out += &format!("CPU {:.0}% · RAM {:.1}/{:.1} GB · {} processes\n", s.cpu, s.mem_used as f64 / 1073741824.0, s.mem_total as f64 / 1073741824.0, s.procs);
    }
    out += &format!("\n## Devices with problems ({})\n{}\n", problems.len(), if problems.is_empty() { "None".into() } else { problems.join("\n") });
    winutil::redact(&out)
}

// ======================= windows & layouts =======================

#[tauri::command]
fn monitors() -> Vec<wm::Monitor> { wm::monitors() }
#[tauri::command]
fn windows_list() -> Vec<wm::Win> { wm::windows_list() }

#[tauri::command]
fn wm_config(st: State<AppState>) -> Value {
    let c = st.wm.lock().clone();
    json!({ "config": c, "builtin": wm::builtin_layouts() })
}

#[tauri::command]
fn wm_set_config(st: State<AppState>, w: Window, config: WmConfig) -> R<()> {
    main_only(&w)?;
    *st.wm.lock() = config;
    st.save_wm();
    Ok(())
}

#[tauri::command]
fn wm_snap(st: State<AppState>, hwnd: Option<isize>, layout: Option<String>, zone: usize, span_to: Option<usize>) -> R<()> {
    let id = layout.unwrap_or_else(|| st.wm.lock().active_layout.clone());
    let l = st.layout(&id).ok_or("Unknown layout")?;
    let h = hwnd.or_else(wm::foreground).ok_or("No window to snap")?;
    let exe = wm::windows_list().into_iter().find(|w| w.hwnd == h).map(|w| w.exe).unwrap_or_default();
    if wm::excluded(&exe, &st.wm.lock().exclusions) { return Err("That app is on the exclusion list".into()); }
    match span_to { Some(b) => wm::span(h, &l, zone, b), None => wm::snap(h, &l, zone) }
}

/// Lay out a set of windows across the zones in order (layout preview "Apply").
#[tauri::command]
fn wm_arrange(st: State<AppState>, layout: String, hwnds: Vec<isize>) -> R<Value> {
    let l = st.layout(&layout).ok_or("Unknown layout")?;
    let mut failed = vec![];
    let mut undo = vec![];
    let wins = wm::windows_list();
    for (i, h) in hwnds.iter().enumerate().take(l.zones.len()) {
        if let Some(w) = wins.iter().find(|w| w.hwnd == *h) { undo.push((w.hwnd, w.rect)); }
        if let Err(e) = wm::snap(*h, &l, i) { failed.push(e); }
    }
    *st.undo_ws.lock() = undo;
    st.wm.lock().active_layout = layout;
    st.save_wm();
    Ok(json!({ "failed": failed }))
}

#[tauri::command]
fn wm_window(hwnd: isize, action: String) -> R<()> {
    match action.as_str() { "focus" => wm::focus(hwnd), "minimize" => wm::minimize(hwnd), _ => return Err("bad action".into()) }
    Ok(())
}

#[tauri::command]
fn ws_capture(st: State<AppState>, w: Window, name: String) -> R<wm::Workspace> {
    main_only(&w)?;
    let ex = st.wm.lock().exclusions.clone();
    let mut ws = wm::capture(&name, &ex);
    ws.layout = Some(st.wm.lock().active_layout.clone());
    ws.lighting = Some(st.rgb.cfg.lock().active.id.clone());
    ws.cooling = Some(st.cooling.lock().active.clone());
    st.wm.lock().workspaces.push(ws.clone());
    st.save_wm();
    Ok(ws)
}

fn activate_workspace(app: &AppHandle, id: &str, from_rule: bool) -> R<wm::RestoreReport> {
    let st = app.state::<AppState>();
    let ws = st.wm.lock().workspaces.iter().find(|w| w.id == id || w.name.eq_ignore_ascii_case(id)).cloned().ok_or("No such workspace")?;
    let rep = wm::restore(&ws);
    *st.undo_ws.lock() = rep.undo.clone();
    if let Some(l) = &ws.layout { st.wm.lock().active_layout = l.clone(); }
    if let Some(p) = &ws.lighting { let _ = apply_lighting_preset(&st, p); }
    if let Some(c) = &ws.cooling { let _ = apply_cooling(&st, c); }
    st.wm.lock().active_workspace = Some(ws.id.clone());
    st.save_wm();
    st.push_event(&format!("workspace:{}", ws.id), from_rule);
    st.db.audit(if from_rule { "rule" } else { "user" }, "workspace.activate", &ws.name, &format!("moved {}, launched {}, failed {}", rep.moved, rep.launched, rep.failed.len()));
    let _ = app.emit("workspace", &ws.id);
    Ok(rep)
}

#[tauri::command]
async fn ws_activate(app: AppHandle, id: String) -> R<wm::RestoreReport> {
    tauri::async_runtime::spawn_blocking(move || activate_workspace(&app, &id, false)).await.unwrap()
}

#[tauri::command]
fn ws_undo(st: State<AppState>) -> usize {
    let moves = std::mem::take(&mut *st.undo_ws.lock());
    wm::undo(&moves)
}

// ======================= lighting =======================

#[tauri::command]
fn rgb_status(st: State<AppState>) -> rgb::RgbStatus { st.rgb.status.lock().clone() }
#[tauri::command]
fn rgb_config(st: State<AppState>) -> rgb::LightingConfig { st.rgb.cfg.lock().clone() }

#[tauri::command]
fn rgb_set_config(st: State<AppState>, w: Window, config: rgb::LightingConfig) -> R<()> {
    main_only(&w)?;
    let rescan = {
        let old = st.rgb.cfg.lock();
        old.use_aura_usb != config.use_aura_usb || old.use_openrgb != config.use_openrgb || old.use_simulated != config.use_simulated
    };
    *st.rgb.cfg.lock() = config;
    st.save_rgb();
    if rescan { st.rgb.request_rescan(); }
    Ok(())
}

fn apply_lighting_preset(st: &AppState, id: &str) -> R<()> {
    let mut c = st.rgb.cfg.lock();
    let p = c.presets.iter().find(|p| p.id == id || p.name.eq_ignore_ascii_case(id)).cloned().ok_or("No such lighting preset")?;
    c.active = p;
    drop(c);
    st.save_rgb();
    Ok(())
}

#[tauri::command]
fn rgb_apply_preset(st: State<AppState>, id: String) -> R<()> { apply_lighting_preset(&st, &id) }

#[tauri::command]
fn rgb_identify(st: State<AppState>, slot: String) -> R<()> {
    let s = st.rgb.cfg.lock().slots.iter().find(|s| s.id == slot).cloned().ok_or("No such fan")?;
    st.rgb.identify(&s)
}

#[tauri::command]
fn rgb_identify_zone(st: State<AppState>, controller: String, zone: usize, start: usize, count: usize) { st.rgb.identify_zone(&controller, zone, start, count); }

#[tauri::command]
fn rgb_resize(st: State<AppState>, w: Window, controller: String, zone: usize, leds: usize) -> R<()> {
    main_only(&w)?;
    st.rgb.resize(&controller, zone, leds)?;
    st.save_rgb();
    Ok(())
}

#[tauri::command]
fn rgb_rescan(st: State<AppState>) { st.rgb.request_rescan(); }

#[tauri::command]
fn rgb_conflict(st: State<AppState>) -> Option<String> {
    let c = rgb::conflict();
    st.rgb.status.lock().conflict = c.clone();
    c
}

/// Pause / resume Armoury Crate's lighting service so GlassCore can own the controller (RGB-03).
#[tauri::command]
fn rgb_oem_service(st: State<AppState>, w: Window, run: bool) -> R<String> {
    main_only(&w)?;
    let r = st.broker.call("svc.control", json!({ "name": "LightingService", "action": if run { "start" } else { "stop" } }))
        .map(|v| v.as_str().unwrap_or("").to_string());
    st.db.audit("user", "lighting.oem_service", "LightingService", &format!("{} -> {:?}", if run { "start" } else { "stop" }, r));
    if r.is_ok() { st.rgb.request_rescan(); }
    r
}

// ======================= hardware helper & cooling =======================

#[tauri::command]
fn hw_status(st: State<AppState>) -> Value {
    if !st.broker.connected.load(Ordering::Relaxed) { let _ = st.broker.connect(); }
    json!({
        "helper_found": broker::helper_exe().is_some(),
        "connected": st.broker.connected.load(Ordering::Relaxed),
        "elevated": st.broker.elevated.load(Ordering::Relaxed),
        "snapshot": st.broker.last_snapshot.lock().clone(),
    })
}

#[tauri::command]
async fn helper_start(app: AppHandle, w: Window) -> R<()> {
    main_only(&w)?;
    let st = app.state::<AppState>();
    if st.broker.connect().is_ok() { return Ok(()); }
    st.broker.launch_elevated()?;
    let b = st.broker.clone();
    tauri::async_runtime::spawn_blocking(move || {
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if b.connect().is_ok() { return Ok(()); }
        }
        Err("The helper started but didn't answer. Check that Windows allowed it to run.".to_string())
    }).await.unwrap()?;
    st.db.audit("user", "helper.start", "elevated", "connected");
    let active = st.cooling.lock().active.clone();
    let _ = apply_cooling(&st, &active);
    Ok(())
}

#[tauri::command]
fn helper_autostart(st: State<AppState>, w: Window, enable: bool) -> R<String> {
    main_only(&w)?;
    let r = st.broker.call("task.helper", json!({ "enable": enable })).map(|v| v.as_str().unwrap_or("").to_string());
    st.db.audit("user", "helper.autostart", &enable.to_string(), &format!("{:?}", r));
    r
}

fn controllable_fans(st: &AppState) -> Vec<String> {
    st.broker.last_snapshot.lock().as_ref()
        .and_then(|s| s["fans"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter(|f| f["controllable"].as_bool() == Some(true))
        .filter_map(|f| f["id"].as_str().map(String::from))
        .collect()
}

fn apply_cooling(st: &AppState, id: &str) -> R<()> {
    let cfg = st.cooling.lock().clone();
    let p = cfg.profiles.iter().find(|p| p.id == id || p.name.eq_ignore_ascii_case(id)).cloned().ok_or("No such cooling profile")?;
    st.cooling.lock().active = p.id.clone();
    st.save_cooling();
    if !st.broker.connected.load(Ordering::Relaxed) { return Ok(()); }
    let fans = controllable_fans(st);
    if p.id == "auto" { st.broker.call("fan.release", json!({}))?; }
    else if !fans.is_empty() { st.broker.call("fan.apply", cooling::payload(&p, &fans))?; }
    st.db.audit("user", "cooling.apply", &p.name, &format!("{} fan(s)", fans.len()));
    Ok(())
}

#[tauri::command]
fn cooling_get(st: State<AppState>) -> cooling::CoolingConfig { st.cooling.lock().clone() }

#[tauri::command]
fn cooling_set(st: State<AppState>, w: Window, config: cooling::CoolingConfig) -> R<()> {
    main_only(&w)?;
    let active = config.active.clone();
    *st.cooling.lock() = config;
    st.save_cooling();
    apply_cooling(&st, &active)
}

#[tauri::command]
fn cooling_apply(st: State<AppState>, w: Window, id: String) -> R<()> { main_only(&w)?; apply_cooling(&st, &id) }

#[tauri::command]
fn cooling_release(st: State<AppState>) -> R<()> {
    st.cooling.lock().active = "auto".into();
    st.save_cooling();
    if st.broker.connected.load(Ordering::Relaxed) { st.broker.call("fan.release", json!({}))?; }
    Ok(())
}

// ======================= audio & displays =======================

#[tauri::command]
async fn audio_endpoints() -> R<Vec<audio::Endpoint>> { tauri::async_runtime::spawn_blocking(audio::endpoints).await.unwrap() }
#[tauri::command]
fn audio_set_volume(id: String, level: Option<f32>, mute: Option<bool>) -> R<()> { audio::set_volume(&id, level, mute) }
#[tauri::command]
fn audio_set_default(id: String) -> R<()> { audio::set_default(&id) }
#[tauri::command]
fn audio_sessions(id: String) -> R<Vec<audio::AppVolume>> { audio::sessions(&id) }
#[tauri::command]
fn audio_set_session(id: String, pid: u32, level: Option<f32>, mute: Option<bool>) -> R<()> { audio::set_session(&id, pid, level, mute) }
#[tauri::command]
async fn brightness_get() -> Vec<audio::Brightness> { tauri::async_runtime::spawn_blocking(audio::brightness).await.unwrap() }
#[tauri::command]
fn brightness_set(monitor: usize, value: u32) -> R<()> { audio::set_brightness(monitor, value) }

// ======================= tasks & focus =======================

#[tauri::command]
fn tasks_list(st: State<AppState>, archived: bool) -> R<Vec<tasks::Task>> { tasks::list(&st.db, archived) }
#[tauri::command]
fn task_create(st: State<AppState>, task: tasks::TaskInput) -> R<i64> { tasks::create(&st.db, task) }
#[tauri::command]
fn task_update(st: State<AppState>, id: i64, task: tasks::TaskInput) -> R<()> { tasks::update(&st.db, id, task) }
#[tauri::command]
fn task_status(app: AppHandle, st: State<AppState>, id: i64, status: String) -> R<()> {
    tasks::set_status(&st.db, id, &status)?;
    if status == "done" {
        if let Ok(Some(f)) = tasks::focus_current(&st.db) { if f.task_id == Some(id) { let _ = tasks::focus_stop(&st.db); } }
        st.push_event("task_completed", false);
    }
    let _ = app.emit("tasks", ());
    Ok(())
}
#[tauri::command]
fn task_archive(st: State<AppState>, id: i64, archived: bool) -> R<()> { tasks::archive(&st.db, id, archived) }
#[tauri::command]
fn task_delete(st: State<AppState>, id: i64) -> R<()> { tasks::delete(&st.db, id) }
#[tauri::command]
fn task_postpone(st: State<AppState>, id: i64, days: i64) -> R<()> { tasks::postpone(&st.db, id, days) }

#[tauri::command]
fn focus_start(app: AppHandle, st: State<AppState>, task_id: Option<i64>) -> R<i64> {
    let id = tasks::focus_start(&st.db, task_id)?;
    st.push_event("task_started", false);
    if let Some(t) = task_id {
        let ws = tasks::list(&st.db, false)?.into_iter().find(|x| x.id == t).and_then(|x| x.workspace);
        if let Some(ws) = ws { let a = app.clone(); std::thread::spawn(move || { let _ = activate_workspace(&a, &ws, false); }); }
    }
    let _ = app.emit("focus", ());
    Ok(id)
}
#[tauri::command]
fn focus_stop(app: AppHandle, st: State<AppState>) -> R<Option<tasks::Focus>> { let r = tasks::focus_stop(&st.db); let _ = app.emit("focus", ()); r }
#[tauri::command]
fn focus_interrupt(st: State<AppState>) -> R<()> { tasks::focus_interrupt(&st.db) }
#[tauri::command]
fn focus_current(st: State<AppState>) -> R<Option<tasks::Focus>> { tasks::focus_current(&st.db) }
#[tauri::command]
fn focus_stats(st: State<AppState>, days: i64) -> R<Vec<(String, i64, i64)>> { tasks::focus_stats(&st.db, days) }

// ======================= automation =======================

#[tauri::command]
fn rules_get(st: State<AppState>) -> Value {
    let c = st.rules.lock().clone();
    let stats = st.rule_stats.lock().clone();
    let explained: HashMap<String, String> = c.rules.iter().map(|r| (r.id.clone(), rules::explain(r))).collect();
    json!({ "config": c, "stats": stats, "explain": explained })
}

#[tauri::command]
fn rules_set(st: State<AppState>, w: Window, config: rules::RulesConfig) -> R<()> {
    main_only(&w)?;
    *st.rules.lock() = config;
    st.save_rules();
    Ok(())
}

#[tauri::command]
fn rule_explain(rule: rules::Rule) -> String { rules::explain(&rule) }

/// Run a rule's actions now, as a test (AUTOMATION-05). `dry` = only describe.
#[tauri::command]
fn rule_test(app: AppHandle, w: Window, rule: rules::Rule, dry: bool) -> R<Vec<String>> {
    main_only(&w)?;
    let st = app.state::<AppState>();
    let mut out = vec![];
    for a in &rule.actions {
        if dry { out.push(format!("Would {}", rules::explain(&rules::Rule { actions: vec![a.clone()], ..rule.clone() }).split(", ").last().unwrap_or("").trim_end_matches('.'))); }
        else { out.push(match exec_action(&app, &st, a) { Ok(s) => s, Err(e) => format!("Failed: {}", e) }); }
    }
    st.db.audit("user", if dry { "rule.dry_run" } else { "rule.test" }, &rule.name, &out.join("; "));
    Ok(out)
}

fn exec_action(app: &AppHandle, st: &AppState, a: &rules::Action) -> R<String> {
    use rules::Action::*;
    match a {
        SetLighting { preset } => apply_lighting_preset(st, preset).map(|_| format!("Lighting → {}", preset)),
        FlashLighting { color } => { st.rgb.flash(rgb::parse_hex(color)); Ok("Flashed lights".into()) }
        LightingBrightness { percent } => { st.rgb.cfg.lock().active.brightness = (*percent).min(100); st.save_rgb(); Ok(format!("Brightness {}%", percent)) }
        SetCooling { profile } => apply_cooling(st, profile).map(|_| format!("Cooling → {}", profile)),
        ActivateWorkspace { id } => {
            let a = app.clone();
            let id = id.clone();
            std::thread::spawn(move || { let _ = activate_workspace(&a, &id, true); });
            Ok("Workspace activating".into())
        }
        Notify { title, body } => { let _ = app.notification().builder().title(title).body(body).show(); Ok("Notified".into()) }
        SetVolume { percent } => audio::set_default_volume(Some(*percent as f32 / 100.0), None).map(|_| format!("Volume {}%", percent)),
        Mute { muted } => audio::set_default_volume(None, Some(*muted)).map(|_| "Mute changed".into()),
        GamingMode { on } => { set_gaming(app, st, *on); Ok(format!("Gaming mode {}", if *on { "on" } else { "off" })) }
        StartFocus => tasks::focus_start(&st.db, None).map(|_| { st.push_event("task_started", true); "Focus started".into() }),
        StopFocus => tasks::focus_stop(&st.db).map(|_| "Focus stopped".into()),
    }
}

fn set_gaming(app: &AppHandle, st: &AppState, on: bool) {
    st.tel.gaming.store(on, Ordering::Relaxed);
    let mut g = st.gaming.lock();
    if on && g.is_none() {
        let prev = st.rgb.cfg.lock().active.id.clone();
        let dock = st.prefs.lock().dock;
        *g = Some((prev, dock));
        let _ = apply_lighting_preset(st, "gaming");
        if dock { toggle_dock(app, false); }
    } else if !on {
        if let Some((prev, dock)) = g.take() {
            let _ = apply_lighting_preset(st, &prev);
            if dock { toggle_dock(app, true); }
        }
    }
    let _ = app.emit("gaming", on);
}

#[tauri::command]
fn gaming_mode(app: AppHandle, st: State<AppState>, on: bool) { set_gaming(&app, &st, on); }

fn spawn_rules(app: AppHandle) {
    std::thread::Builder::new().name("rules".into()).spawn(move || {
        let st = app.state::<AppState>();
        let mut last_fg = String::new();
        let mut seen_started = 0i64;
        let mut seen_exited = 0i64;
        let mut ports: Option<HashSet<(String, u16)>> = None;
        let mut tick = 0u64;
        let mut fired_startup = false;
        let mut last_minute = String::new();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            tick += 1;
            let cfg = st.rules.lock().clone();
            let now = db::now();
            // Facts
            let started: Vec<String> = st.tel.started.lock().iter().filter(|e| e.2 > seen_started).map(|e| e.1.to_lowercase()).collect();
            let exited: Vec<String> = st.tel.exited.lock().iter().filter(|e| e.2 > seen_exited).map(|e| e.1.to_lowercase()).collect();
            seen_started = st.tel.started.lock().back().map(|e| e.2).unwrap_or(seen_started);
            seen_exited = st.tel.exited.lock().back().map(|e| e.2).unwrap_or(seen_exited);
            let fg = wm::foreground().and_then(|h| wm::windows_list().into_iter().find(|w| w.hwnd == h)).map(|w| w.exe.rsplit('\\').next().unwrap_or("").to_lowercase()).unwrap_or_default();
            let fg_changed = fg != last_fg && !fg.is_empty();
            last_fg = fg.clone();
            let events: Vec<(String, bool)> = st.events.lock().drain(..).collect();
            let sample = st.tel.latest();
            let snap = st.broker.last_snapshot.lock().clone();
            let cpu_temp = snap.as_ref().and_then(|s| s["cpuTemp"].as_f64()).map(|v| v as f32);
            *st.rgb.cpu_temp.lock() = cpu_temp;
            let idle_s = unsafe {
                let mut li = windows::Win32::UI::Input::KeyboardAndMouse::LASTINPUTINFO { cbSize: 8, dwTime: 0 };
                if windows::Win32::UI::Input::KeyboardAndMouse::GetLastInputInfo(&mut li).as_bool() {
                    (windows::Win32::System::SystemInformation::GetTickCount().wrapping_sub(li.dwTime)) / 1000
                } else { 0 }
            };
            let mut new_port = false;
            if tick % 10 == 0 {
                let cur: HashSet<(String, u16)> = network::connections().into_iter().filter(|c| c.state == "Listening").map(|c| (c.proto, c.lport)).collect();
                if let Some(prev) = &ports { new_port = cur.difference(prev).next().is_some(); }
                ports = Some(cur);
            }
            let (hhmm, dow) = rules::hhmm_now();
            let minute_changed = hhmm != last_minute;
            last_minute = hhmm.clone();
            let running: HashSet<String> = st.tel.procs.lock().iter().map(|p| p.name.to_lowercase()).collect();
            if !cfg.enabled { continue; }

            for r in cfg.rules.iter().filter(|r| r.enabled) {
                let mut stats = st.rule_stats.lock();
                let s = stats.entry(r.id.clone()).or_default();
                use rules::Trigger::*;
                let held = |s: &mut rules::RuleStats, cond: bool, secs: u32| -> bool {
                    if cond { let since = *s.since.get_or_insert(now); now - since >= secs as i64 } else { s.since = None; false }
                };
                let hit = match &r.trigger {
                    ProcessStarted { name } => started.iter().any(|n| n == &name.to_lowercase()),
                    ProcessExited { name } => exited.iter().any(|n| n == &name.to_lowercase()),
                    ForegroundApp { name } => fg_changed && fg == name.to_lowercase(),
                    CpuTempAbove { celsius, seconds } => held(s, cpu_temp.map(|t| t > *celsius).unwrap_or(false), *seconds),
                    CpuLoadAbove { percent, seconds } => held(s, sample.as_ref().map(|x| x.cpu > *percent).unwrap_or(false), *seconds),
                    GpuLoadAbove { percent, seconds } => held(s, sample.as_ref().and_then(|x| x.gpu).map(|g| g > *percent).unwrap_or(false), *seconds),
                    Time { at, days } => minute_changed && &hhmm == at && (days.is_empty() || days.contains(&dow)),
                    Idle { minutes } => held(s, idle_s >= minutes * 60, 0),
                    TaskStarted => events.iter().any(|(e, from_rule)| e == "task_started" && !from_rule),
                    TaskCompleted => events.iter().any(|(e, from_rule)| e == "task_completed" && !from_rule),
                    NewListeningPort => new_port,
                    Startup => !fired_startup,
                };
                if !hit { continue; }
                let conds_ok = r.conditions.iter().all(|c| match c {
                    rules::Condition::TimeBetween { from, to } => rules::time_between(from, to),
                    rules::Condition::ProcessRunning { name } => running.contains(&name.to_lowercase()),
                    rules::Condition::ProcessNotRunning { name } => !running.contains(&name.to_lowercase()),
                });
                if !conds_ok { continue; }
                if rules::may_fire(r, s, now).is_err() { continue; }
                s.last = Some(now);
                s.recent.push_back(now);
                drop(stats);
                let mut results = vec![];
                let mut failed = false;
                for a in &r.actions {
                    if r.dry_run { results.push(format!("(dry run) {:?}", a)); continue; }
                    match exec_action(&app, &st, a) { Ok(m) => results.push(m), Err(e) => { failed = true; results.push(format!("failed: {}", e)); } }
                }
                let summary = results.join("; ");
                {
                    let mut stats = st.rule_stats.lock();
                    let s = stats.entry(r.id.clone()).or_default();
                    s.fired += 1;
                    if failed { s.failed += 1; }
                    s.last_result = summary.clone();
                }
                st.db.audit("rule", &r.name, &rules::explain(r), &summary);
                let _ = app.emit("rule-fired", json!({ "id": r.id, "name": r.name, "result": summary }));
            }
            fired_startup = true;
        }
    }).ok();
}

// ======================= tools =======================

#[tauri::command]
fn clip_list(st: State<AppState>) -> Vec<tools::Clip> { st.clip.items.lock().iter().cloned().collect() }
#[tauri::command]
fn clip_clear(st: State<AppState>) { st.clip.items.lock().retain(|c| c.pinned); }
#[tauri::command]
fn clip_pin(st: State<AppState>, id: u64, pinned: bool) { if let Some(c) = st.clip.items.lock().iter_mut().find(|c| c.id == id) { c.pinned = pinned; } }
#[tauri::command]
fn clip_delete(st: State<AppState>, id: u64) { st.clip.items.lock().retain(|c| c.id != id); }

#[tauri::command]
async fn screenshot(app: AppHandle, target: String, monitor: Option<usize>) -> R<Value> {
    if let Some(w) = app.get_webview_window("main") { if target != "window" { let _ = w.hide(); std::thread::sleep(std::time::Duration::from_millis(220)); } }
    let r = tauri::async_runtime::spawn_blocking(move || tools::screenshot(&target, monitor)).await.unwrap();
    if let Some(w) = app.get_webview_window("main") { let _ = w.show(); }
    let (path, w, h) = r?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(json!({ "path": path, "w": w, "h": h, "data": format!("data:image/png;base64,{}", b64(&bytes)) }))
}

#[tauri::command]
fn save_png(path: String, data: String) -> R<()> {
    let p = std::path::Path::new(&path);
    if p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()) != Some("png".into()) { return Err("Only .png files".into()); }
    let raw = data.split(',').nth(1).ok_or("bad data")?;
    std::fs::write(p, unb64(raw)?).map_err(|e| e.to_string())
}

/// Save a user-chosen text export (report, backup, CSV trace). Extension allow-list only.
#[tauri::command]
fn save_text(path: String, text: String) -> R<()> {
    let p = std::path::Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
    if !["md", "txt", "json", "csv"].contains(&ext.as_str()) { return Err("Only .md, .txt, .json or .csv files".into()); }
    std::fs::write(p, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text(path: String) -> R<String> {
    let p = std::path::Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
    if ext != "json" { return Err("Only .json profile files can be imported".into()); }
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > 20 * 1024 * 1024 { return Err("File too large".into()); }
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

fn b64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len() * 4 / 3 + 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}

fn unb64(s: &str) -> R<Vec<u8>> {
    let val = |c: u8| -> R<u32> { Ok(match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' => 62, b'/' => 63, _ => return Err("bad base64".into()) } as u32) };
    let b: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(b.len() * 3 / 4);
    for c in b.chunks(4) {
        if c.len() < 4 { break; }
        let n = val(c[0])? << 18 | val(c[1])? << 12 | if c[2] == b'=' { 0 } else { val(c[2])? << 6 } | if c[3] == b'=' { 0 } else { val(c[3])? };
        out.push((n >> 16) as u8);
        if c[2] != b'=' { out.push((n >> 8) as u8); }
        if c[3] != b'=' { out.push(n as u8); }
    }
    Ok(out)
}

// ======================= backup =======================

#[derive(Serialize, Deserialize)]
struct Backup {
    format: String,
    version: u32,
    prefs: Option<Prefs>,
    lighting: Option<rgb::LightingConfig>,
    cooling: Option<cooling::CoolingConfig>,
    rules: Option<rules::RulesConfig>,
    wm: Option<WmConfig>,
    tasks: Option<Vec<tasks::Task>>,
}

/// Portable export (BACKUP-03/05): hardware identifiers and absolute user paths are stripped.
#[tauri::command]
fn backup_export(st: State<AppState>, include_tasks: bool) -> R<String> {
    let mut lighting = st.rgb.cfg.lock().clone();
    for s in lighting.slots.iter_mut() { s.controller = None; }
    lighting.zone_sizes.clear();
    let mut wmc = st.wm.lock().clone();
    for ws in wmc.workspaces.iter_mut() { for e in ws.entries.iter_mut() { e.exe = winutil::redact(&e.exe); e.monitor.clear(); } }
    let mut cool = st.cooling.lock().clone();
    for p in cool.profiles.iter_mut() { p.fans.clear(); }
    let b = Backup {
        format: "glasscore-profile".into(), version: 1,
        prefs: Some(st.prefs.lock().clone()), lighting: Some(lighting), cooling: Some(cool),
        rules: Some(st.rules.lock().clone()), wm: Some(wmc),
        tasks: if include_tasks { tasks::list(&st.db, true).ok() } else { None },
    };
    serde_json::to_string_pretty(&b).map_err(|e| e.to_string())
}

#[tauri::command]
fn backup_import(st: State<AppState>, w: Window, json: String) -> R<String> {
    main_only(&w)?;
    let b: Backup = serde_json::from_str(&json).map_err(|e| format!("Not a GlassCore profile: {}", e))?;
    if b.format != "glasscore-profile" { return Err("Not a GlassCore profile".into()); }
    let mut parts = vec![];
    if let Some(p) = b.prefs { *st.prefs.lock() = p; st.save_prefs(); parts.push("preferences"); }
    if let Some(mut l) = b.lighting {
        // Keep this PC's hardware mappings (unresolved mappings stay unmapped).
        let cur = st.rgb.cfg.lock().clone();
        l.slots = cur.slots; l.zone_sizes = cur.zone_sizes;
        *st.rgb.cfg.lock() = l; st.save_rgb(); parts.push("lighting");
    }
    if let Some(c) = b.cooling { *st.cooling.lock() = c; st.save_cooling(); parts.push("cooling"); }
    if let Some(r) = b.rules { *st.rules.lock() = r; st.save_rules(); parts.push("automations"); }
    if let Some(mut wmc) = b.wm {
        let cur = st.wm.lock().clone();
        // merge instead of overwrite (BACKUP-09)
        for ws in cur.workspaces { if !wmc.workspaces.iter().any(|x| x.id == ws.id) { wmc.workspaces.push(ws); } }
        *st.wm.lock() = wmc; st.save_wm(); parts.push("layouts & workspaces");
    }
    if let Some(ts) = b.tasks {
        let existing: HashSet<String> = tasks::list(&st.db, true)?.into_iter().map(|t| t.title).collect();
        let mut n = 0;
        for t in ts.into_iter().filter(|t| !existing.contains(&t.title)) {
            tasks::create(&st.db, tasks::TaskInput { title: t.title, notes: t.notes, project: t.project, priority: t.priority, due: t.due, estimate_min: t.estimate_min, workspace: t.workspace, checklist: Some(t.checklist), recur: t.recur })?;
            n += 1;
        }
        parts.push(if n > 0 { "tasks" } else { "tasks (none new)" });
    }
    st.db.audit("user", "backup.import", "profile", &parts.join(", "));
    Ok(parts.join(", "))
}

#[tauri::command]
fn clear_activity(st: State<AppState>, w: Window) -> R<()> {
    main_only(&w)?;
    st.tel.history.lock().clear();
    st.tel.started.lock().clear();
    st.tel.exited.lock().clear();
    st.clip.items.lock().clear();
    st.db.with(|c| c.execute_batch("DELETE FROM focus; DELETE FROM audit;"))?;
    st.db.audit("user", "privacy.clear_activity", "local", "cleared");
    Ok(())
}

// ======================= shell: glass, dock, tray, hotkeys =======================

fn apply_glass(win: &tauri::WebviewWindow, prefs: &Prefs) {
    let _ = window_vibrancy::clear_acrylic(win);
    let _ = window_vibrancy::clear_mica(win);
    let dark = prefs.theme != "light";
    match prefs.glass.as_str() {
        "mica" => { let _ = window_vibrancy::apply_mica(win, Some(dark)); }
        "acrylic" => { let _ = window_vibrancy::apply_acrylic(win, Some(if dark { (14, 18, 26, 120) } else { (240, 243, 246, 120) })); }
        _ => {}
    }
}

fn toggle_dock(app: &AppHandle, on: bool) {
    if let Some(w) = app.get_webview_window("dock") {
        if on { let _ = w.show(); } else { let _ = w.hide(); }
        return;
    }
    if !on { return; }
    let mons = wm::monitors();
    let m = mons.iter().find(|m| m.primary).or(mons.first());
    let (w, h) = (760.0, 76.0);
    let built = WebviewWindowBuilder::new(app, "dock", WebviewUrl::App("index.html?view=dock".into()))
        .title("GlassCore Dock")
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .build();
    if let (Ok(win), Some(m)) = (built, m) {
        let s = m.scale as f64;
        let x = m.work.x as f64 / s + (m.work.w as f64 / s - w) / 2.0;
        let y = (m.work.y + m.work.h) as f64 / s - h - 10.0;
        let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        let prefs = app.state::<AppState>().prefs.lock().clone();
        let _ = window_vibrancy::apply_acrylic(&win, Some(if prefs.theme != "light" { (14, 18, 26, 110) } else { (240, 243, 246, 110) }));
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        app.state::<AppState>().tel.visible.store(true, Ordering::Relaxed);
    }
}

fn quit(app: &AppHandle) {
    let st = app.state::<AppState>();
    st.rgb.release_all();
    if st.broker.connected.load(Ordering::Relaxed) {
        let _ = st.broker.call("fan.release", json!({}));
    }
    st.db.audit("user", "app.quit", "", "fans returned to BIOS, lighting released");
    app.exit(0);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let st = app.state::<AppState>();
    let presets: Vec<(String, String)> = st.rgb.cfg.lock().presets.iter().map(|p| (p.id.clone(), p.name.clone())).collect();
    let open = MenuItem::with_id(app, "show", "Open GlassCore", true, None::<&str>)?;
    let mut light_items: Vec<MenuItem<tauri::Wry>> = vec![];
    for (id, name) in &presets { light_items.push(MenuItem::with_id(app, format!("light:{}", id), name, true, None::<&str>)?); }
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = light_items.iter().map(|m| m as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    let lighting = Submenu::with_items(app, "Lighting", true, &refs)?;
    let cool = Submenu::with_items(app, "Cooling", true, &[
        &MenuItem::with_id(app, "cool:auto", "Auto (BIOS)", true, None::<&str>)?,
        &MenuItem::with_id(app, "cool:quiet", "Quiet", true, None::<&str>)?,
        &MenuItem::with_id(app, "cool:balanced", "Balanced", true, None::<&str>)?,
        &MenuItem::with_id(app, "cool:performance", "Performance", true, None::<&str>)?,
    ])?;
    let gaming = MenuItem::with_id(app, "gaming", "Toggle gaming mode", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause_rules", "Pause / resume automations", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit GlassCore", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &lighting, &cool, &gaming, &pause, &PredefinedMenuItem::separator(app)?, &quit_i])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("GlassCore")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| {
            let st = app.state::<AppState>();
            let id = e.id.as_ref();
            match id {
                "show" => show_main(app),
                "quit" => quit(app),
                "gaming" => { let on = !st.tel.gaming.load(Ordering::Relaxed); set_gaming(app, &st, on); }
                "pause_rules" => { let mut r = st.rules.lock(); r.enabled = !r.enabled; drop(r); st.save_rules(); let _ = app.emit("rules", ()); }
                _ if id.starts_with("light:") => { let _ = apply_lighting_preset(&st, &id[6..]); let _ = app.emit("lighting", ()); }
                _ if id.starts_with("cool:") => { let _ = apply_cooling(&st, &id[5..]); let _ = app.emit("cooling", ()); }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn digit(i: usize) -> Code {
    [Code::Digit1, Code::Digit2, Code::Digit3, Code::Digit4, Code::Digit5, Code::Digit6, Code::Digit7, Code::Digit8, Code::Digit9][i]
}

fn register_hotkeys(app: &AppHandle) {
    let ca = Some(Modifiers::CONTROL | Modifiers::ALT);
    let mut list = vec![Shortcut::new(ca, Code::Space), Shortcut::new(ca, Code::ArrowLeft), Shortcut::new(ca, Code::ArrowRight), Shortcut::new(ca, Code::KeyG)];
    for i in 0..9 { list.push(Shortcut::new(ca, digit(i))); }
    let st = app.state::<AppState>();
    for s in list {
        if let Err(e) = app.global_shortcut().register(s) {
            st.hotkey_errors.lock().push(format!("{}: {}", s.into_string(), e));
        }
    }
}

fn on_hotkey(app: &AppHandle, s: &Shortcut) {
    let st = app.state::<AppState>();
    let ca = Some(Modifiers::CONTROL | Modifiers::ALT);
    if *s == Shortcut::new(ca, Code::Space) {
        show_main(app);
        let _ = app.emit("palette", ());
        return;
    }
    if *s == Shortcut::new(ca, Code::KeyG) {
        let on = !st.tel.gaming.load(Ordering::Relaxed);
        set_gaming(app, &st, on);
        return;
    }
    let layout_id = st.wm.lock().active_layout.clone();
    let Some(layout) = st.layout(&layout_id) else { return };
    let Some(h) = wm::foreground() else { return };
    let exe = wm::windows_list().into_iter().find(|w| w.hwnd == h).map(|w| w.exe).unwrap_or_default();
    if wm::excluded(&exe, &st.wm.lock().exclusions) { return; }
    for i in 0..9 {
        if *s == Shortcut::new(ca, digit(i)) { let _ = wm::snap(h, &layout, i); return; }
    }
    let n = layout.zones.len();
    if n == 0 { return; }
    let cur = wm::current_zone(h, &layout);
    if *s == Shortcut::new(ca, Code::ArrowLeft) {
        let _ = wm::snap(h, &layout, cur.map(|c| (c + n - 1) % n).unwrap_or(0));
    } else if *s == Shortcut::new(ca, Code::ArrowRight) {
        let _ = wm::snap(h, &layout, cur.map(|c| (c + 1) % n).unwrap_or(0));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, s, e| {
            if e.state() == ShortcutState::Pressed { on_hotkey(app, s); }
        }).build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--tray"])))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = broker::data_dir();
            let db = Arc::new(db::Db::open(dir.clone()).map_err(|e| e.to_string())?);
            let prefs: Prefs = db.get("prefs").unwrap_or_default();
            let lighting: rgb::LightingConfig = db.get("lighting").unwrap_or_default();
            let tel = telemetry::Telemetry::new();
            tel.paused.store(prefs.telemetry_paused, Ordering::Relaxed);
            let rgb_eng = rgb::RgbEngine::new(lighting);
            let clip = tools::Clipboard::new();
            clip.enabled.store(prefs.clipboard_history, Ordering::Relaxed);
            let state = AppState {
                db: db.clone(),
                tel: tel.clone(),
                rgb: rgb_eng.clone(),
                broker: broker::Broker::new(),
                clip: clip.clone(),
                wm: Mutex::new(db.get("wm").unwrap_or_default()),
                prefs: Mutex::new(prefs.clone()),
                cooling: Mutex::new(db.get("cooling").unwrap_or_default()),
                rules: Mutex::new(db.get("rules").unwrap_or_default()),
                rule_stats: Mutex::new(HashMap::new()),
                events: Mutex::new(VecDeque::new()),
                undo_ws: Mutex::new(vec![]),
                gaming: Mutex::new(None),
                hotkey_errors: Mutex::new(vec![]),
            };
            app.manage(state);
            broker::ensure_token();
            let handle = app.handle().clone();
            telemetry::spawn(handle.clone(), tel);
            rgb::spawn(handle.clone(), rgb_eng);
            tools::spawn_watcher(clip);
            spawn_rules(handle.clone());
            // Reconnect to an already-running helper (e.g. the opt-in logon task) and re-apply cooling.
            {
                let h2 = handle.clone();
                std::thread::spawn(move || {
                    for _ in 0..30 {
                        let st = h2.state::<AppState>();
                        if st.broker.connect().is_ok() {
                            std::thread::sleep(std::time::Duration::from_secs(2));
                            let active = st.cooling.lock().active.clone();
                            let _ = apply_cooling(&st, &active);
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_secs(2));
                    }
                });
            }
            build_tray(&handle)?;
            register_hotkeys(&handle);
            if let Some(win) = app.get_webview_window("main") {
                apply_glass(&win, &prefs);
                let hidden = std::env::args().any(|a| a == "--tray") || prefs.start_hidden;
                if !hidden { let _ = win.show(); } else { handle.state::<AppState>().tel.visible.store(false, Ordering::Relaxed); }
            }
            if prefs.dock { toggle_dock(&handle, true); }
            db.audit("user", "app.start", env!("CARGO_PKG_VERSION"), "ok");
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                        window.app_handle().state::<AppState>().tel.visible.store(false, Ordering::Relaxed);
                    }
                    WindowEvent::Focused(true) => window.app_handle().state::<AppState>().tel.visible.store(true, Ordering::Relaxed),
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info, set_visible, prefs_get, prefs_set, audit_log, diagnostics, open_settings, launch_path,
            telemetry_history, processes, proc_events, disks, net_ifs, proc_identity, proc_details, proc_tree_preview, proc_action,
            net_connections, net_adapters, net_probe,
            svc_list, svc_dependents, svc_control, svc_start_type,
            devices, sessions, inventory, installed_apps, startup_items, environment, events, system_report,
            monitors, windows_list, wm_config, wm_set_config, wm_snap, wm_arrange, wm_window, ws_capture, ws_activate, ws_undo,
            rgb_status, rgb_config, rgb_set_config, rgb_apply_preset, rgb_identify, rgb_identify_zone, rgb_resize, rgb_rescan, rgb_conflict, rgb_oem_service,
            hw_status, helper_start, helper_autostart, cooling_get, cooling_set, cooling_apply, cooling_release,
            audio_endpoints, audio_set_volume, audio_set_default, audio_sessions, audio_set_session, brightness_get, brightness_set,
            tasks_list, task_create, task_update, task_status, task_archive, task_delete, task_postpone,
            focus_start, focus_stop, focus_interrupt, focus_current, focus_stats,
            rules_get, rules_set, rule_explain, rule_test, gaming_mode,
            clip_list, clip_clear, clip_pin, clip_delete, screenshot, save_png, save_text, read_text,
            backup_export, backup_import, clear_activity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GlassCore");
}
