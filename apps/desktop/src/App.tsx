import { createSignal, For, Match, onCleanup, onMount, Show, Switch, createMemo } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { call, on, inTauri, type HwStatus } from "./lib/api";
import { section, go, type Section, paletteOpen, setPaletteOpen, startTelemetry, loadPrefs, latest, toast, setTab } from "./lib/store";
import { Icon, Logo, Toasts, ConfirmHost, usePoll } from "./components/ui";
import { pct, temp } from "./lib/format";
import Home from "./pages/Home";
import WorkspacePage from "./pages/Workspace";
import Activity from "./pages/Activity";
import SystemPage from "./pages/System";
import Studio from "./pages/Studio";
import Flow from "./pages/Flow";
import Settings from "./pages/Settings";

const NAV: { id: Section; label: string; icon: string; title: string }[] = [
  { id: "home", label: "Home", icon: "home", title: "Home" },
  { id: "workspace", label: "Workspace", icon: "workspace", title: "Workspace" },
  { id: "activity", label: "Activity", icon: "activity", title: "Activity" },
  { id: "system", label: "System", icon: "system", title: "System" },
  { id: "studio", label: "Studio", icon: "studio", title: "Lighting, cooling & audio" },
  { id: "flow", label: "Flow", icon: "flow", title: "Tasks, automations & tools" },
  { id: "settings", label: "Settings", icon: "settings", title: "Settings" },
];

export default function App() {
  const [mini, setMini] = createSignal(false);
  const hw = usePoll<HwStatus>(() => call("hw_status"), 3000);

  onMount(async () => {
    await loadPrefs();
    startTelemetry();
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey && e.key.toLowerCase() === "k") || (e.ctrlKey && e.key === "/")) { e.preventDefault(); setPaletteOpen(true); }
      if (e.ctrlKey && /^[1-7]$/.test(e.key)) { e.preventDefault(); go(NAV[+e.key - 1].id); }
    };
    document.addEventListener("keydown", key);
    onCleanup(() => document.removeEventListener("keydown", key));
    on("palette", () => setPaletteOpen(true));
    on<{ name: string; result: string }>("rule-fired", (r) => toast(`${r.name}: ${r.result}`, "info"));
  });

  const win = () => (inTauri ? getCurrentWindow() : null);
  const title = createMemo(() => NAV.find((n) => n.id === section())?.title ?? "");

  return (
    <div class="shell">
      <nav class={`nav ${mini() ? "mini" : ""}`} aria-label="Primary">
        <div class="brand" data-tauri-drag-region>
          <Logo />
          <Show when={!mini()}><b>GlassCore</b></Show>
        </div>
        <div class="col" style={{ gap: "4px" }}>
          <For each={NAV}>
            {(n, i) => (
              <button class={`nav-item ${section() === n.id ? "on" : ""}`} onClick={() => go(n.id)} title={`${n.label}  (Ctrl+${i() + 1})`} aria-current={section() === n.id ? "page" : undefined}>
                <Icon name={n.icon} size={19} />
                <Show when={!mini()}><span>{n.label}</span></Show>
              </button>
            )}
          </For>
        </div>
        <div class="nav-foot">
          <Show when={!mini()}>
            <button class="status-pill" style={{ cursor: "pointer", "text-align": "left" }} onClick={() => go("studio", "cooling")} title="Hardware helper status">
              <i class="dot" style={{ background: hw.data()?.connected ? (hw.data()?.elevated ? "var(--ok)" : "var(--warn)") : "var(--t3)" }} />
              <span class="ellipsis">{hw.data()?.connected ? (hw.data()?.elevated ? "Hardware control on" : "Helper: read-only") : "Hardware control off"}</span>
            </button>
            <div class="status-pill tn">
              <Icon name="cpu" size={14} /> {pct(latest()?.cpu)}
              <span class="dim">·</span> <Icon name="temp" size={14} /> {temp(hw.data()?.snapshot?.cpuTemp)}
            </div>
          </Show>
          <button class="nav-item" onClick={() => setMini(!mini())} title={mini() ? "Expand sidebar" : "Collapse sidebar"}>
            <Icon name="sidebar" size={18} /><Show when={!mini()}><span>Collapse</span></Show>
          </button>
        </div>
      </nav>

      <main class="main">
        <header class="titlebar" data-tauri-drag-region>
          <h1 data-tauri-drag-region>{title()}</h1>
          <span class="spacer" data-tauri-drag-region />
          <button class="search-btn no-drag" onClick={() => setPaletteOpen(true)} aria-label="Search and commands">
            <Icon name="search" size={15} /><span class="grow" style={{ "text-align": "left" }}>Search or run a command</span><span class="kbd">Ctrl K</span>
          </button>
          <div class="row no-drag" style={{ gap: "2px", "margin-left": "8px" }}>
            <button class="capbtn" aria-label="Minimise" onClick={() => win()?.minimize()}><Icon name="min" size={14} /></button>
            <button class="capbtn" aria-label="Maximise" onClick={() => win()?.toggleMaximize()}><Icon name="max" size={12} /></button>
            <button class="capbtn close" aria-label="Hide to tray" title="Hide to tray (GlassCore keeps running)" onClick={() => win()?.hide()}><Icon name="close" size={14} /></button>
          </div>
        </header>
        <div class="content" id="content">
          <Switch>
            <Match when={section() === "home"}><Home /></Match>
            <Match when={section() === "workspace"}><WorkspacePage /></Match>
            <Match when={section() === "activity"}><Activity /></Match>
            <Match when={section() === "system"}><SystemPage /></Match>
            <Match when={section() === "studio"}><Studio /></Match>
            <Match when={section() === "flow"}><Flow /></Match>
            <Match when={section() === "settings"}><Settings /></Match>
          </Switch>
        </div>
      </main>

      <Show when={paletteOpen()}><Palette /></Show>
      <ConfirmHost />
      <Toasts />
    </div>
  );
}

interface Cmd { label: string; hint: string; icon: string; run: () => void }

function Palette() {
  const [q, setQ] = createSignal("");
  const [sel, setSel] = createSignal(0);
  const [extra, setExtra] = createSignal<Cmd[]>([]);
  onMount(async () => {
    const more: Cmd[] = [];
    try {
      const lc = await call<any>("rgb_config");
      for (const p of lc.presets) more.push({ label: `Lighting: ${p.name}`, hint: "Apply lighting preset", icon: "light", run: () => call("rgb_apply_preset", { id: p.id }).then(() => toast(`Lighting → ${p.name}`, "ok")) });
      const cc = await call<any>("cooling_get");
      for (const p of cc.profiles) more.push({ label: `Cooling: ${p.name}`, hint: "Apply cooling profile", icon: "fan", run: () => call("cooling_apply", { id: p.id }).then(() => toast(`Cooling → ${p.name}`, "ok")).catch((e) => toast(String(e), "bad")) });
      const wm = await call<any>("wm_config");
      for (const w of wm.config.workspaces) more.push({ label: `Workspace: ${w.name}`, hint: "Restore workspace", icon: "workspace", run: () => call("ws_activate", { id: w.id }).then(() => toast(`Workspace ${w.name} restored`, "ok")) });
      const wins = await call<any[]>("windows_list");
      for (const w of wins.slice(0, 40)) more.push({ label: w.title, hint: "Switch to window", icon: "monitor", run: () => call("wm_window", { hwnd: w.hwnd, action: "focus" }) });
    } catch { /* preview */ }
    setExtra(more);
  });
  const base: Cmd[] = [
    ...NAV.map((n) => ({ label: `Go to ${n.label}`, hint: n.title, icon: n.icon, run: () => go(n.id) })),
    { label: "Processes", hint: "Activity", icon: "cpu", run: () => go("activity", "processes") },
    { label: "Performance graphs", hint: "Activity", icon: "activity", run: () => go("activity", "performance") },
    { label: "Network connections & ports", hint: "Activity", icon: "net", run: () => go("activity", "network") },
    { label: "Services", hint: "System", icon: "system", run: () => go("system", "services") },
    { label: "Devices", hint: "System", icon: "system", run: () => go("system", "devices") },
    { label: "Event log & diagnostics", hint: "System", icon: "alert", run: () => go("system", "diagnostics") },
    { label: "System properties", hint: "System", icon: "info", run: () => go("system", "properties") },
    { label: "Lighting studio", hint: "Studio", icon: "light", run: () => go("studio", "lighting") },
    { label: "Fan control", hint: "Studio", icon: "fan", run: () => go("studio", "cooling") },
    { label: "Audio & displays", hint: "Studio", icon: "audio", run: () => go("studio", "audio") },
    { label: "Window layouts", hint: "Workspace", icon: "workspace", run: () => go("workspace", "layouts") },
    { label: "New task", hint: "Flow", icon: "task", run: () => { go("flow", "tasks"); setTimeout(() => document.getElementById("new-task")?.focus(), 50); } },
    { label: "Automations", hint: "Flow", icon: "zap", run: () => go("flow", "automations") },
    { label: "Clipboard & tools", hint: "Flow", icon: "clip", run: () => go("flow", "tools") },
    { label: "Take a screenshot", hint: "Tools", icon: "camera", run: () => { go("flow", "tools"); setTab("flow", "tools"); } },
    { label: "Toggle gaming mode", hint: "Lower telemetry, gaming lighting", icon: "gamepad", run: () => call("gaming_mode", { on: true }).then(() => toast("Gaming mode on — press Ctrl+Alt+G to leave", "ok")) },
    { label: "Return fans to BIOS control", hint: "Cooling", icon: "fan", run: () => call("cooling_release").then(() => toast("Fans returned to BIOS control", "ok")) },
    { label: "Open Windows Settings", hint: "ms-settings:", icon: "external", run: () => call("open_settings", { uri: "ms-settings:" }) },
  ];
  const items = createMemo(() => {
    const s = q().toLowerCase().trim();
    const all = [...base, ...extra()];
    return (s ? all.filter((c) => (c.label + " " + c.hint).toLowerCase().includes(s)) : all).slice(0, 60);
  });
  const run = (c?: Cmd) => { if (!c) return; setPaletteOpen(false); c.run(); };
  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && setPaletteOpen(false)}>
      <div class="palette" role="dialog" aria-label="Command palette">
        <input autofocus placeholder="Type a command, window, preset or page…" value={q()}
          onInput={(e) => { setQ(e.currentTarget.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setPaletteOpen(false);
            if (e.key === "ArrowDown") { e.preventDefault(); setSel(Math.min(sel() + 1, items().length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel(Math.max(sel() - 1, 0)); }
            if (e.key === "Enter") run(items()[sel()]);
          }} />
        <div class="items" role="listbox">
          <For each={items()}>
            {(c, i) => (
              <div class={`item ${i() === sel() ? "on" : ""}`} role="option" aria-selected={i() === sel()} onMouseEnter={() => setSel(i())} onClick={() => run(c)}>
                <Icon name={c.icon} size={16} />
                <span class="grow ellipsis">{c.label}</span>
                <span class="small dim ellipsis" style={{ "max-width": "40%" }}>{c.hint}</span>
              </div>
            )}
          </For>
          <Show when={!items().length}><div class="empty small">No matches</div></Show>
        </div>
      </div>
    </div>
  );
}
