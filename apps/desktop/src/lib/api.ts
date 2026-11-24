import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** True when running inside the Tauri shell (false in a plain browser preview). */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) throw new Error("Not running inside GlassCore");
  return invoke<T>(cmd, args);
}

export function on<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  if (!inTauri) return Promise.resolve(() => {});
  return listen<T>(event, (e) => cb(e.payload));
}

// ---------- types (mirrors of the Rust structs) ----------
export interface Sample {
  ts: number; cpu: number; cores: number[]; cpu_mhz: number;
  mem_used: number; mem_total: number; mem_avail: number; swap_used: number; swap_total: number;
  gpu: number | null; gpu_engines: Record<string, number>; gpu_mem_dedicated: number | null; gpu_mem_shared: number | null;
  net_rx: number; net_tx: number; disk_read: number | null; disk_write: number | null; disk_busy: number | null; disk_queue: number | null;
  procs: number; threads: number | null; uptime: number; interval_ms: number;
}
export interface Proc {
  pid: number; ppid: number | null; name: string; exe: string | null; cpu: number; mem: number; vmem: number;
  read_bps: number; write_bps: number; start: number; status: string; session: number | null; threads: number | null; new: boolean; protected: boolean;
}
export interface ProcDetails {
  pid: number; path: string | null; signature: string | null; priority: string | null; affinity: number | null; system_mask: number;
  windows: string[]; children: [number, string][]; created: number | null; threads: number[]; modules: string[];
}
export interface Conn { proto: string; local: string; lport: number; remote: string; rport: number; state: string; pid: number; scope: string }
export interface Adapter { name: string; description: string; kind: string; up: boolean; speed_mbps: number; mac: string; ips: string[]; gateways: string[]; dns: string[]; dhcp: boolean; vpn_like: boolean }
export interface Svc { name: string; display: string; state: string; pid: number; start: string; delayed: boolean; binary: string; account: string; kind: string; description: string }
export interface Device { name: string; class: string; manufacturer: string; instance: string; hardware_ids: string[]; driver_version: string; driver_date: string; driver_provider: string; problem: number; status: string }
export interface Session { id: number; station: string; user: string; domain: string; state: string; protocol: string; current: boolean }
export interface Inventory {
  os_name: string; os_version: string; os_build: string; os_edition: string; install_date: string; boot_mode: string; secure_boot: boolean | null;
  cpu: string; cpu_cores: number; cpu_threads: number; cpu_base_mhz: string; board_vendor: string; board_model: string;
  bios_vendor: string; bios_version: string; bios_date: string; system_vendor: string; system_model: string; ram_total: number;
  gpus: [string, string, number][]; hostname: string; arch: string; is_admin: boolean;
}
export interface InstalledApp { name: string; version: string; publisher: string; installed: string; size_kb: number; scope: string }
export interface StartupItem { name: string; command: string; location: string; enabled: boolean }
export interface LogEvent { channel: string; provider: string; id: number; level: number; time: string; message: string }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Monitor { key: string; name: string; bounds: Rect; work: Rect; dpi: number; scale: number; primary: boolean }
export interface Win { hwnd: number; title: string; pid: number; exe: string; rect: Rect; monitor: string; minimized: boolean; maximized: boolean }
export interface Zone { x: number; y: number; w: number; h: number }
export interface Layout { id: string; name: string; zones: Zone[]; gap: number }
export interface WsEntry { exe: string; title_hint: string; monitor: string; frac: Zone; launch: boolean; args: string }
export interface Workspace { id: string; name: string; entries: WsEntry[]; layout: string | null; lighting: string | null; cooling: string | null; monitoring: string | null }
export interface WmConfig { active_layout: string; custom: Layout[]; exclusions: string[]; workspaces: Workspace[]; active_workspace: string | null }
export type Effect = "static" | "breathing" | "rainbow" | "cycle" | "pulse" | "wave" | "temperature" | "off";
export interface Preset { id: string; name: string; effect: Effect; speed: number; brightness: number; color: string; color2: string; zone_colors: Record<string, string>; slot_colors: Record<string, string> }
export interface FanSlot { id: string; name: string; controller: string | null; zone: number; start: number; count: number }
export interface LightingConfig {
  enabled: boolean; active: Preset; presets: Preset[]; slots: FanSlot[]; fps: number; night_cap: [number, number, number] | null;
  use_aura_usb: boolean; use_openrgb: boolean; use_simulated: boolean; zone_sizes: Record<string, number>;
}
export interface ZoneInfo { index: number; name: string; leds: number; max_leds: number; kind: "group" | "addressable" | "independent_fan" | "unsupported"; resizable: boolean }
export interface ControllerInfo { id: string; name: string; provider: string; firmware: string; zones: ZoneInfo[]; notes: string[] }
export interface RgbStatus { controllers: ControllerInfo[]; conflict: string | null; errors: string[]; frames: number }
export interface FanProfile { mode: "auto" | "fixed" | "curve"; percent: number; curve: [number, number][]; source: "cpu" | "gpu" | "max"; hysteresis: number; step_up: number; step_down: number; min_percent: number }
export interface CoolingProfile { id: string; name: string; default: FanProfile; fans: Record<string, FanProfile> }
export interface CoolingConfig { active: string; profiles: CoolingProfile[] }
export interface HwFan { id: string; name: string; hw: string; rpm: number | null; percent: number | null; controllable: boolean; floor: number; managed: boolean }
export interface HwSnapshot { cpuTemp: number | null; gpuTemp: number | null; temps: { hw: string; kind: string; name: string; value: number }[]; fans: HwFan[]; sensors: { hw: string; kind: string; type: string; name: string; value: number }[]; emergency: boolean; board: string | null; error: string | null; pawnio: boolean }
export interface HwStatus { helper_found: boolean; connected: boolean; elevated: boolean; snapshot: HwSnapshot | null }
export interface Endpoint { id: string; name: string; flow: "output" | "input"; default: boolean; volume: number | null; muted: boolean | null; peak: number | null }
export interface AppVolume { pid: number; name: string; volume: number; muted: boolean; peak: number }
export interface Brightness { monitor: number; name: string; min: number; current: number; max: number }
export interface Task {
  id: number; title: string; notes: string; project: string; priority: number; status: "todo" | "active" | "done"; due: number | null; estimate_min: number | null;
  workspace: string | null; checklist: { text: string; done: boolean }[]; recur: string | null; created: number; completed: number | null; archived: boolean; focused_s: number;
}
export interface Focus { id: number; task_id: number | null; start: number; stop: number | null; elapsed_s: number; interruptions: number }
export interface Rule { id: string; name: string; enabled: boolean; trigger: any; conditions: any[]; actions: any[]; cooldown_s: number; max_per_min: number; dry_run: boolean }
export interface RulesConfig { enabled: boolean; rules: Rule[] }
export interface Prefs {
  theme: "dark" | "light" | "system" | "contrast"; glass: "acrylic" | "mica" | "opaque"; glass_opacity: number; accent: string; reduced_motion: boolean;
  density: "comfortable" | "compact"; radius: number; dock: boolean; dock_autohide: boolean; dock_pins: string[]; start_hidden: boolean;
  clipboard_history: boolean; telemetry_paused: boolean; hotkeys: Record<string, string>; modules: Record<string, boolean>; notes: string; snippets: [string, string][];
}
export interface Clip { id: number; ts: number; text: string; pinned: boolean }
export interface AuditRow { id: number; ts: number; actor: string; action: string; target: string; result: string }
