//! Client for the on-demand elevated hardware helper (privileged broker).
//! JSON lines over a per-session named pipe; authenticated with a per-install token.

use crate::winutil::*;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;
use windows::core::PCWSTR;
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

pub struct Broker {
    writer: Mutex<Option<std::fs::File>>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>,
    next: AtomicU64,
    pub connected: Arc<AtomicBool>,
    pub elevated: AtomicBool,
    pub last_snapshot: Arc<Mutex<Option<Value>>>,
}

pub fn data_dir() -> PathBuf {
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into())).join("GlassCore")
}

fn token_path() -> PathBuf { data_dir().join("broker.token") }

/// Create the token once; the file lives in the user's own profile (user-only ACL by inheritance).
pub fn ensure_token() -> String {
    let p = token_path();
    if let Ok(t) = std::fs::read_to_string(&p) {
        if t.trim().len() >= 32 { return t.trim().to_string(); }
    }
    use rand::Rng;
    let t: String = (0..48).map(|_| format!("{:x}", rand::rng().random_range(0..16u8))).collect();
    std::fs::create_dir_all(data_dir()).ok();
    std::fs::write(&p, &t).ok();
    t
}

fn pipe_name() -> String {
    let mut sid = 0u32;
    unsafe { let _ = windows::Win32::System::RemoteDesktop::ProcessIdToSessionId(std::process::id(), &mut sid); }
    format!(r"\\.\pipe\glasscore-broker-{}", sid)
}

pub fn helper_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidates = [
        dir.join("broker").join("glasscore-broker.exe"),
        dir.join("glasscore-broker.exe"),
        dir.join("../../../../broker/publish/glasscore-broker.exe"),
        dir.join("../../../broker/publish/glasscore-broker.exe"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

impl Broker {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            writer: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            connected: Arc::new(AtomicBool::new(false)),
            elevated: AtomicBool::new(false),
            last_snapshot: Arc::new(Mutex::new(None)),
        })
    }

    /// Start the helper elevated (UAC prompt) — only when the user asks for hardware control.
    pub fn launch_elevated(&self) -> Result<(), String> {
        let exe = helper_exe().ok_or("Hardware helper not found next to GlassCore")?;
        ensure_token();
        let file = wide(&exe.to_string_lossy());
        let verb = wide("runas");
        let args = wide(&format!("--token-file \"{}\"", token_path().to_string_lossy()));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(args.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };
        unsafe { ShellExecuteExW(&mut info).map_err(|_| "Elevation was cancelled".to_string())?; }
        Ok(())
    }

    pub fn connect(self: &Arc<Self>) -> Result<(), String> {
        if self.connected.load(Ordering::Relaxed) { return Ok(()); }
        let name = pipe_name();
        let f = std::fs::OpenOptions::new().read(true).write(true).open(&name).map_err(|_| "Hardware helper isn't running".to_string())?;
        let reader = f.try_clone().map_err(|e| e.to_string())?;
        *self.writer.lock() = Some(f);
        self.connected.store(true, Ordering::Relaxed);
        let pending = self.pending.clone();
        let connected = self.connected.clone();
        std::thread::spawn(move || {
            let mut r = BufReader::new(reader);
            let mut line = String::new();
            loop {
                line.clear();
                match r.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if let Ok(v) = serde_json::from_str::<Value>(&line) {
                            let id = v["id"].as_u64().unwrap_or(0);
                            if let Some(tx) = pending.lock().remove(&id) {
                                let res = if v["ok"].as_bool() == Some(true) { Ok(v["result"].clone()) } else { Err(v["error"].as_str().unwrap_or("helper error").to_string()) };
                                let _ = tx.send(res);
                            }
                        }
                    }
                }
            }
            connected.store(false, Ordering::Relaxed);
            for (_, tx) in pending.lock().drain() { let _ = tx.send(Err("Hardware helper disconnected".into())); }
        });
        let hello = self.call("hello", json!({ "token": ensure_token() }))?;
        self.elevated.store(hello["elevated"].as_bool().unwrap_or(false), Ordering::Relaxed);
        // keep-alive + sensor snapshot pump
        let me = self.clone();
        std::thread::spawn(move || {
            while me.connected.load(Ordering::Relaxed) {
                if let Ok(s) = me.call("hw.snapshot", json!({})) { *me.last_snapshot.lock() = Some(s); }
                std::thread::sleep(Duration::from_secs(1));
            }
        });
        Ok(())
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().insert(id, tx);
        {
            let mut w = self.writer.lock();
            let f = w.as_mut().ok_or("Hardware helper isn't connected")?;
            let msg = json!({ "id": id, "method": method, "params": params }).to_string() + "\n";
            if f.write_all(msg.as_bytes()).is_err() {
                self.connected.store(false, Ordering::Relaxed);
                *w = None;
                return Err("Hardware helper disconnected".into());
            }
        }
        rx.recv_timeout(Duration::from_secs(25)).map_err(|_| "Hardware helper timed out".to_string())?
    }
}
