//! Shared telemetry collector (FR-04). One instance per backend, adaptive cadence,
//! bounded history, quality tags. Never fabricates values: missing data is `None`.

use crate::pdh::Pdh;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use sysinfo::{Networks, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, CpuRefreshKind, MemoryRefreshKind, Disks, UpdateKind};
use tauri::{AppHandle, Emitter};

pub const HISTORY: usize = 600; // 10 min at 1 s

#[derive(Serialize, Clone, Default)]
pub struct Sample {
    pub ts: i64,
    pub cpu: f32,
    pub cores: Vec<f32>,
    pub cpu_mhz: u64,
    pub mem_used: u64,
    pub mem_total: u64,
    pub mem_avail: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    pub gpu: Option<f32>,
    pub gpu_engines: HashMap<String, f32>,
    pub gpu_mem_dedicated: Option<u64>,
    pub gpu_mem_shared: Option<u64>,
    pub net_rx: u64,
    pub net_tx: u64,
    pub disk_read: Option<f64>,
    pub disk_write: Option<f64>,
    pub disk_busy: Option<f64>,
    pub disk_queue: Option<f64>,
    pub procs: usize,
    pub threads: Option<f64>,
    pub uptime: u64,
    pub interval_ms: u64,
}

#[derive(Serialize, Clone)]
pub struct ProcRow {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub name: String,
    pub exe: Option<String>,
    pub cpu: f32,
    pub mem: u64,
    pub vmem: u64,
    pub read_bps: u64,
    pub write_bps: u64,
    pub start: u64,
    pub status: String,
    pub session: Option<u32>,
    pub threads: Option<usize>,
    pub new: bool,
    pub protected: bool,
}

#[derive(Serialize, Clone)]
pub struct DiskRow {
    pub name: String,
    pub mount: String,
    pub fs: String,
    pub total: u64,
    pub avail: u64,
    pub removable: bool,
    pub kind: String,
}

#[derive(Serialize, Clone)]
pub struct NetIf {
    pub name: String,
    pub rx_bps: u64,
    pub tx_bps: u64,
    pub rx_total: u64,
    pub tx_total: u64,
    pub mac: String,
}

pub struct Telemetry {
    pub history: Mutex<VecDeque<Sample>>,
    pub procs: Mutex<Vec<ProcRow>>,
    pub disks: Mutex<Vec<DiskRow>>,
    pub nets: Mutex<Vec<NetIf>>,
    pub visible: AtomicBool,
    pub gaming: AtomicBool,
    pub proc_demand: AtomicI64,
    pub paused: AtomicBool,
    pub exited: Mutex<VecDeque<(u32, String, i64)>>,
    pub started: Mutex<VecDeque<(u32, String, i64)>>,
}

impl Telemetry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            history: Mutex::new(VecDeque::with_capacity(HISTORY)),
            procs: Mutex::new(vec![]),
            disks: Mutex::new(vec![]),
            nets: Mutex::new(vec![]),
            visible: AtomicBool::new(true),
            gaming: AtomicBool::new(false),
            proc_demand: AtomicI64::new(0),
            paused: AtomicBool::new(false),
            exited: Mutex::new(VecDeque::new()),
            started: Mutex::new(VecDeque::new()),
        })
    }

    pub fn latest(&self) -> Option<Sample> {
        self.history.lock().back().cloned()
    }

    /// Mark that a consumer needs the process table (keeps it fresh for 5 s).
    pub fn want_procs(&self) {
        self.proc_demand.store(crate::db::now(), Ordering::Relaxed);
    }

    fn procs_wanted(&self) -> bool {
        crate::db::now() - self.proc_demand.load(Ordering::Relaxed) < 6
    }
}

const PROTECTED: &[&str] = &[
    "system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "services.exe", "lsass.exe",
    "winlogon.exe", "memory compression", "secure system", "lsaiso.exe", "fontdrvhost.exe",
    "dwm.exe", "svchost.exe", "msmpeng.exe", "system idle process", "idle",
];

pub fn is_protected(name: &str, pid: u32) -> bool {
    pid <= 4 || PROTECTED.contains(&name.to_lowercase().as_str())
}

pub fn spawn(app: AppHandle, t: Arc<Telemetry>) {
    std::thread::Builder::new()
        .name("telemetry".into())
        .spawn(move || run(app, t))
        .ok();
}

fn run(app: AppHandle, t: Arc<Telemetry>) {
    let Ok(mut sys) = System::new_with_specifics(
        RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::everything())
            .with_memory(MemoryRefreshKind::everything()),
    ) else { return };
    let Ok(mut nets) = Networks::new_with_refreshed_list() else { return };
    let Ok(mut disks) = Disks::new_with_refreshed_list() else { return };
    let mut pdh = Pdh::new();
    if let Some(p) = pdh.as_mut() {
        p.add("gpu_engine", r"\GPU Engine(*)\Utilization Percentage");
        p.add("gpu_ded", r"\GPU Adapter Memory(*)\Dedicated Usage");
        p.add("gpu_shr", r"\GPU Adapter Memory(*)\Shared Usage");
        p.add("disk_r", r"\PhysicalDisk(_Total)\Disk Read Bytes/sec");
        p.add("disk_w", r"\PhysicalDisk(_Total)\Disk Write Bytes/sec");
        p.add("disk_busy", r"\PhysicalDisk(_Total)\% Disk Time");
        p.add("disk_q", r"\PhysicalDisk(_Total)\Current Disk Queue Length");
        p.add("threads", r"\System\Threads");
        p.collect();
    }
    let mut known: HashMap<u32, String> = HashMap::new();
    let mut last = Instant::now();
    let mut tick: u64 = 0;
    let mut first_proc_scan = true;

    loop {
        // Adaptive cadence: 1 s visible, 5 s hidden, 10 s while gaming.
        let interval = if t.gaming.load(Ordering::Relaxed) {
            10_000
        } else if t.visible.load(Ordering::Relaxed) {
            1_000
        } else {
            5_000
        };
        std::thread::sleep(Duration::from_millis(interval));
        if t.paused.load(Ordering::Relaxed) {
            continue;
        }
        let dt = last.elapsed().as_secs_f64().max(0.2);
        last = Instant::now();
        tick += 1;

        sys.refresh_cpu_all();
        sys.refresh_memory();
        nets.refresh(true);
        if let Some(p) = pdh.as_ref() {
            p.collect();
        }

        let cores: Vec<f32> = sys.cpus().iter().map(|c| c.usage()).collect();
        let mhz = sys.cpus().first().map(|c| c.frequency()).unwrap_or(0);

        // GPU: max engine type utilisation summed across processes, per engine type.
        let mut engines: HashMap<String, f32> = HashMap::new();
        let (mut gpu, mut gded, mut gshr) = (None, None, None);
        if let Some(p) = pdh.as_ref() {
            let arr = p.array("gpu_engine");
            if !arr.is_empty() {
                for (inst, v) in arr {
                    // instance: pid_1234_luid_..._phys_0_eng_0_engtype_3D
                    let ty = inst.rsplit("engtype_").next().unwrap_or("Other").to_string();
                    *engines.entry(ty).or_insert(0.0) += v as f32;
                }
                for v in engines.values_mut() {
                    *v = v.min(100.0);
                }
                gpu = engines.values().cloned().fold(None, |a: Option<f32>, b| Some(a.map_or(b, |a| a.max(b))));
            }
            let d: f64 = p.array("gpu_ded").iter().map(|x| x.1).sum();
            let s: f64 = p.array("gpu_shr").iter().map(|x| x.1).sum();
            if d > 0.0 { gded = Some(d as u64); }
            if s > 0.0 { gshr = Some(s as u64); }
        }

        let (mut rx, mut tx) = (0u64, 0u64);
        let mut ifs = vec![];
        for (name, data) in nets.iter() {
            let r = (data.received() as f64 / dt) as u64;
            let w = (data.transmitted() as f64 / dt) as u64;
            rx += r;
            tx += w;
            ifs.push(NetIf {
                name: name.to_string_lossy().to_string(),
                rx_bps: r,
                tx_bps: w,
                rx_total: data.total_received(),
                tx_total: data.total_transmitted(),
                mac: data.mac_address().to_string(),
            });
        }
        *t.nets.lock() = ifs;

        if tick % 30 == 1 {
            disks.refresh(true);
            *t.disks.lock() = disks
                .iter()
                .map(|d| DiskRow {
                    name: d.name().to_string_lossy().to_string(),
                    mount: d.mount_point().to_string_lossy().to_string(),
                    fs: d.file_system().to_string_lossy().to_string(),
                    total: d.total_space(),
                    avail: d.available_space(),
                    removable: d.is_removable(),
                    kind: format!("{:?}", d.kind()),
                })
                .collect();
        }

        // Process table only while someone is looking, or every 10 ticks for rule triggers.
        let mut proc_count = known.len();
        if t.procs_wanted() || tick % 10 == 0 || first_proc_scan {
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing()
                    .with_cpu()
                    .with_memory()
                    .with_disk_usage()
                    .with_exe(UpdateKind::OnlyIfNotSet),
            );
            let ncpu = sys.cpus().len().max(1) as f32;
            let now = crate::db::now();
            let mut rows = Vec::with_capacity(sys.processes().len());
            let mut seen = HashMap::with_capacity(sys.processes().len());
            for (pid, p) in sys.processes() {
                let pid = pid.as_u32();
                let name = p.name().to_string_lossy().to_string();
                let is_new = !first_proc_scan && !known.contains_key(&pid);
                if is_new {
                    let mut s = t.started.lock();
                    s.push_back((pid, name.clone(), now));
                    if s.len() > 200 { s.pop_front(); }
                }
                seen.insert(pid, name.clone());
                let du = p.disk_usage();
                rows.push(ProcRow {
                    pid,
                    ppid: p.parent().map(|x| x.as_u32()),
                    exe: p.exe().map(|e| e.to_string_lossy().to_string()),
                    cpu: p.cpu_usage() / ncpu,
                    mem: p.memory(),
                    vmem: p.virtual_memory(),
                    read_bps: (du.read_bytes as f64 / dt) as u64,
                    write_bps: (du.written_bytes as f64 / dt) as u64,
                    start: p.start_time(),
                    status: format!("{:?}", p.status()),
                    session: p.session_id().map(|s| s.as_u32()),
                    threads: p.tasks().map(|t| t.len()),
                    new: is_new,
                    protected: is_protected(&name, pid),
                    name,
                });
            }
            for (pid, name) in known.iter() {
                if !seen.contains_key(pid) {
                    let mut e = t.exited.lock();
                    e.push_back((*pid, name.clone(), now));
                    if e.len() > 200 { e.pop_front(); }
                }
            }
            known = seen;
            first_proc_scan = false;
            proc_count = rows.len();
            *t.procs.lock() = rows;
        }

        let s = Sample {
            ts: chrono::Utc::now().timestamp_millis(),
            cpu: sys.global_cpu_usage(),
            cores,
            cpu_mhz: mhz,
            mem_used: sys.used_memory(),
            mem_total: sys.total_memory(),
            mem_avail: sys.available_memory(),
            swap_used: sys.used_swap(),
            swap_total: sys.total_swap(),
            gpu,
            gpu_engines: engines,
            gpu_mem_dedicated: gded,
            gpu_mem_shared: gshr,
            net_rx: rx,
            net_tx: tx,
            disk_read: pdh.as_ref().and_then(|p| p.value("disk_r")),
            disk_write: pdh.as_ref().and_then(|p| p.value("disk_w")),
            disk_busy: pdh.as_ref().and_then(|p| p.value("disk_busy")).map(|v| v.min(100.0)),
            disk_queue: pdh.as_ref().and_then(|p| p.value("disk_q")),
            procs: proc_count,
            threads: pdh.as_ref().and_then(|p| p.value("threads")),
            uptime: System::uptime().unwrap_or(0),
            interval_ms: interval,
        };
        {
            let mut h = t.history.lock();
            if h.len() >= HISTORY {
                h.pop_front();
            }
            h.push_back(s.clone());
        }
        if t.visible.load(Ordering::Relaxed) {
            let _ = app.emit("telemetry", &s);
        }
    }
}
