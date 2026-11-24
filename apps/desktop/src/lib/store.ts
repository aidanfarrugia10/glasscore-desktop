import { createSignal } from "solid-js";
import { call, on, inTauri, type Prefs, type Sample } from "./api";

// ---------- navigation ----------
export type Section = "home" | "workspace" | "activity" | "system" | "studio" | "flow" | "settings";
export const [section, setSection] = createSignal<Section>("home");
export const [subtab, setSubtab] = createSignal<Record<string, string>>({});
export function go(s: Section, tab?: string) {
  setSection(s);
  if (tab) setSubtab({ ...subtab(), [s]: tab });
}
export const tabOf = (s: Section, def: string) => subtab()[s] ?? def;
export const setTab = (s: Section, t: string) => setSubtab({ ...subtab(), [s]: t });

export const [paletteOpen, setPaletteOpen] = createSignal(false);

// ---------- telemetry (one shared stream for every widget) ----------
export const [history, setHistory] = createSignal<Sample[]>([]);
export const latest = () => history()[history().length - 1];

export async function startTelemetry() {
  try {
    setHistory(await call<Sample[]>("telemetry_history", { last: 600 }));
  } catch { /* preview */ }
  on<Sample>("telemetry", (s) => {
    const h = history();
    const next = h.length >= 600 ? h.slice(h.length - 599) : h.slice();
    next.push(s);
    setHistory(next);
  });
  document.addEventListener("visibilitychange", () => {
    if (inTauri) call("set_visible", { visible: document.visibilityState === "visible" }).catch(() => {});
  });
}

// ---------- preferences / theme ----------
const defaults: Prefs = {
  theme: "dark", glass: "acrylic", glass_opacity: 0.62, accent: "#7BCDD1", reduced_motion: false, density: "comfortable", radius: 14,
  dock: false, dock_autohide: true, dock_pins: [], start_hidden: false, clipboard_history: false, telemetry_paused: false,
  hotkeys: {}, modules: {}, notes: "", snippets: [],
};
export const [prefs, setPrefsSignal] = createSignal<Prefs>(defaults);

export function applyTheme(p: Prefs) {
  const root = document.documentElement;
  const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = p.theme === "system" ? (sysDark ? "dark" : "light") : p.theme;
  root.dataset.theme = theme;
  root.dataset.glass = p.glass;
  root.dataset.density = p.density;
  root.style.setProperty("--ac", p.accent);
  root.style.setProperty("--ac-soft", hexA(p.accent, theme === "light" ? 0.11 : 0.14));
  root.style.setProperty("--r", `${p.radius}px`);
  root.style.setProperty("--r-sm", `${Math.max(6, p.radius - 5)}px`);
  const base = theme === "light" ? "237, 240, 243" : "12, 17, 23";
  if (p.glass !== "opaque") root.style.setProperty("--tint", `rgba(${base}, ${p.glass_opacity})`);
  else root.style.removeProperty("--tint");
  const reduce = p.reduced_motion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.body.classList.toggle("rm", reduce);
}

export async function loadPrefs() {
  try {
    const p = await call<Prefs>("prefs_get");
    setPrefsSignal(p);
    applyTheme(p);
  } catch {
    applyTheme(defaults);
  }
  on<Prefs>("prefs", (p) => { setPrefsSignal(p); applyTheme(p); });
}

export async function savePrefs(patch: Partial<Prefs>) {
  const next = { ...prefs(), ...patch };
  setPrefsSignal(next);
  applyTheme(next);
  try { await call("prefs_set", { prefs: next }); } catch (e) { toast(String(e), "bad"); }
}

export function hexA(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// ---------- toasts (ACCESS-08) ----------
export interface Toast { id: number; text: string; kind: "ok" | "bad" | "info"; action?: { label: string; run: () => void } }
export const [toasts, setToasts] = createSignal<Toast[]>([]);
let tid = 0;
export function toast(text: string, kind: Toast["kind"] = "info", action?: Toast["action"]) {
  const id = ++tid;
  setToasts([...toasts(), { id, text, kind, action }]);
  setTimeout(() => setToasts(toasts().filter((t) => t.id !== id)), action ? 7000 : 4200);
}

/** Run a command and toast the outcome. */
export async function act<T>(p: Promise<T>, ok?: string | ((v: T) => string)): Promise<T | undefined> {
  try {
    const v = await p;
    if (ok) toast(typeof ok === "function" ? ok(v) : ok, "ok");
    return v;
  } catch (e) {
    toast(String(e).replace(/^Error:\s*/, ""), "bad");
    return undefined;
  }
}

// ---------- confirm dialog (PRIVACY-08) ----------
export interface ConfirmReq { title: string; body: string; detail?: string[]; danger?: boolean; ok?: string; resolve: (v: boolean) => void }
export const [confirmReq, setConfirmReq] = createSignal<ConfirmReq | null>(null);
export function confirm(o: Omit<ConfirmReq, "resolve">): Promise<boolean> {
  return new Promise((resolve) => setConfirmReq({ ...o, resolve }));
}
