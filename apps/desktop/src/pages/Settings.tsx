import { createSignal, For, Show, Switch, Match, onMount } from "solid-js";
import { enable as autoOn, disable as autoOff, isEnabled as autoIs } from "@tauri-apps/plugin-autostart";
import { save, open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { call, inTauri } from "../lib/api";
import { tabOf, setTab, prefs, savePrefs, act, confirm, toast, go } from "../lib/store";
import { Card, Tabs, Icon, Seg, Toggle, Slider, Row, usePoll } from "../components/ui";

const ACCENTS = ["#7BCDD1", "#8FB8FF", "#9B8CFF", "#FF7AB6", "#FF8A65", "#E6BA6C", "#86CFA1", "#E9EEF4"];

export default function Settings() {
  const tab = () => tabOf("settings", "appearance");
  return (
    <div class="page">
      <Tabs value={tab()} onChange={(t) => setTab("settings", t)} tabs={[
        { id: "appearance", label: "Appearance", icon: "eye" },
        { id: "hotkeys", label: "Startup & hotkeys", icon: "key" },
        { id: "privacy", label: "Privacy & permissions", icon: "shield" },
        { id: "backup", label: "Backup", icon: "backup" },
        { id: "about", label: "About", icon: "info" },
      ]} />
      <Switch>
        <Match when={tab() === "appearance"}><Appearance /></Match>
        <Match when={tab() === "hotkeys"}><Hotkeys /></Match>
        <Match when={tab() === "privacy"}><Privacy /></Match>
        <Match when={tab() === "backup"}><Backup /></Match>
        <Match when={tab() === "about"}><About /></Match>
      </Switch>
    </div>
  );
}

function Appearance() {
  const p = prefs;
  return (
    <div class="grid g2" style={{ "align-items": "start" }}>
      <Card title="Theme" icon="eye">
        <Row label="Colour mode"><Seg value={p().theme} onChange={(v) => savePrefs({ theme: v })} options={[{ v: "dark", label: "Dark" }, { v: "light", label: "Light" }, { v: "system", label: "System" }, { v: "contrast", label: "High contrast" }]} /></Row>
        <Row label="Window material" hint="Acrylic blurs what's behind the window; Mica tints with your wallpaper"><Seg value={p().glass} onChange={(v) => savePrefs({ glass: v })} options={[{ v: "acrylic", label: "Glass" }, { v: "mica", label: "Mica" }, { v: "opaque", label: "Solid" }]} /></Row>
        <Show when={p().glass !== "opaque"}>
          <div style={{ padding: "10px 0", "border-bottom": "1px solid var(--line)" }}>
            <div class="row lbl" style={{ "margin-bottom": "6px" }}>Glass tint<span class="right tn">{Math.round(p().glass_opacity * 100)}%</span></div>
            <Slider value={Math.round(p().glass_opacity * 100)} min={20} max={95} onInput={(v) => savePrefs({ glass_opacity: v / 100 })} label="Glass tint" />
          </div>
        </Show>
        <Row label="Accent colour">
          <div class="row" style={{ gap: "6px" }}>
            <For each={ACCENTS}>{(a) => <button class="swatch" style={{ background: a, "box-shadow": p().accent.toUpperCase() === a ? "0 0 0 2px var(--t1)" : undefined }} aria-label={`Accent ${a}`} onClick={() => savePrefs({ accent: a })} />}</For>
            <input type="color" value={p().accent} onInput={(e) => savePrefs({ accent: e.currentTarget.value })} aria-label="Custom accent" style={{ width: "30px", height: "28px", border: 0, background: "transparent" }} />
          </div>
        </Row>
      </Card>
      <Card title="Layout & motion" icon="workspace">
        <div style={{ padding: "6px 0 10px", "border-bottom": "1px solid var(--line)" }}>
          <div class="row lbl" style={{ "margin-bottom": "6px" }}>Corner roundness<span class="right tn">{p().radius}px</span></div>
          <Slider value={p().radius} min={4} max={24} onInput={(v) => savePrefs({ radius: v })} label="Corner radius" />
        </div>
        <Row label="Density"><Seg value={p().density} onChange={(v) => savePrefs({ density: v })} options={[{ v: "comfortable", label: "Comfortable" }, { v: "compact", label: "Compact" }]} /></Row>
        <Row label="Reduce motion" hint="Also follows Windows' animation setting"><Toggle value={p().reduced_motion} onChange={(v) => savePrefs({ reduced_motion: v })} /></Row>
        <div class="card tight" style={{ "margin-top": "14px" }}>
          <div class="row"><i class="dot" style={{ background: "var(--ac)" }} /><b>Preview card</b><span class="grow" /><button class="btn sm primary">Primary</button><button class="btn sm">Secondary</button></div>
          <p class="small muted" style={{ "margin-top": "8px" }}>Changes apply instantly across GlassCore and the dock.</p>
        </div>
      </Card>
    </div>
  );
}

function Hotkeys() {
  const [auto, setAuto] = createSignal(false);
  const diag = usePoll<any>(() => call("diagnostics"), 0);
  onMount(async () => { if (inTauri) setAuto(await autoIs().catch(() => false)); });
  const keys: [string, string][] = [
    ["Open GlassCore + command palette", "Ctrl + Alt + Space"],
    ["Snap focused window to zone 1–9", "Ctrl + Alt + 1…9"],
    ["Move focused window to previous / next zone", "Ctrl + Alt + ← / →"],
    ["Toggle gaming mode", "Ctrl + Alt + G"],
    ["Command palette (inside GlassCore)", "Ctrl + K"],
    ["Jump to section 1–7 (inside GlassCore)", "Ctrl + 1…7"],
  ];
  return (
    <div class="grid g2" style={{ "align-items": "start" }}>
      <Card title="Startup" icon="power">
        <Row label="Start with Windows" hint="Opens quietly in the tray"><Toggle value={auto()} onChange={async (v) => { await act(v ? autoOn() : autoOff(), v ? "GlassCore will start with Windows" : "Removed from startup"); setAuto(await autoIs()); }} /></Row>
        <Row label="Start hidden" hint="Even when launched manually"><Toggle value={prefs().start_hidden} onChange={(v) => savePrefs({ start_hidden: v })} /></Row>
        <Row label="Hardware helper at sign-in" hint="So fan curves and Aura control resume without a UAC prompt">
          <button class="btn sm" onClick={() => go("studio", "cooling")}>Set up</button>
        </Row>
      </Card>
      <Card title="Global hotkeys" icon="key" sub="Registered only while GlassCore is running">
        <For each={keys}>{([a, k]) => <div class="row" style={{ padding: "8px 0", "border-bottom": "1px solid var(--line)" }}><span class="grow">{a}</span><span class="kbd" style={{ "font-size": "12px", padding: "1px 8px" }}>{k}</span></div>}</For>
        <Show when={diag.data()?.hotkey_errors?.length}>
          <div class="inset small" style={{ "margin-top": "12px", "border-color": "var(--warn)" }}>
            <b>Conflicts:</b> another app already uses these shortcuts, so GlassCore couldn't register them:
            <For each={diag.data().hotkey_errors}>{(e: string) => <div class="mono">{e}</div>}</For>
          </div>
        </Show>
      </Card>
    </div>
  );
}

function Privacy() {
  const diag = usePoll<any>(() => call("diagnostics"), 5000);
  return (
    <div class="grid g2" style={{ "align-items": "start" }}>
      <Card title="Your data" icon="shield" sub="Everything stays on this PC">
        <ul class="small muted" style={{ margin: "0 0 12px", "padding-left": "18px", "line-height": 1.8 }}>
          <li>No account, cloud, analytics or tracking — GlassCore never phones home.</li>
          <li>Settings, tasks and the activity log live in a local database in your profile.</li>
          <li>Command lines, window titles, URLs and clipboard contents are never written to disk.</li>
          <li>Exports and diagnostic reports strip your username, PC name and hardware IDs.</li>
        </ul>
        <Row label="Pause telemetry" hint="Stops CPU/RAM/network sampling"><Toggle value={prefs().telemetry_paused} onChange={(v) => savePrefs({ telemetry_paused: v })} /></Row>
        <Row label="Clipboard history" hint="Memory only, cleared when turned off"><Toggle value={prefs().clipboard_history} onChange={(v) => savePrefs({ clipboard_history: v })} /></Row>
        <div class="row" style={{ "margin-top": "14px" }}>
          <button class="btn danger" onClick={async () => { if (await confirm({ title: "Clear local activity data?", body: "Removes performance history, process start/exit history, clipboard history, focus sessions and the activity log. Settings, tasks, layouts and profiles are kept.", danger: true, ok: "Clear" })) act(call("clear_activity"), "Local activity data cleared"); }}>Clear activity data</button>
        </div>
      </Card>
      <Card title="Permissions" icon="key" sub="What runs with which rights">
        <Row label="GlassCore app" hint="Runs as you — never elevated"><span class={`badge ${diag.data()?.admin ? "warn" : "ok"}`}>{diag.data()?.admin ? "Elevated (not needed)" : "Standard user"}</span></Row>
        <Row label="Hardware helper" hint="Fans, sensors, Aura SDK, protected services. Allow-listed commands only.">
          <span class={`badge ${diag.data()?.helper_connected ? (diag.data()?.helper_elevated ? "warn" : "") : ""}`}>{diag.data()?.helper_connected ? (diag.data()?.helper_elevated ? "Administrator · on demand" : "Running, not elevated") : "Not running"}</span>
        </Row>
        <Row label="Lighting (ASUS Aura USB)" hint="USB HID access — no admin needed"><span class="badge">{diag.data()?.rgb?.controllers?.length ?? 0} controller(s)</span></Row>
        <Row label="Process / service actions" hint="Confirmed every time, logged, PID re-verified"><span class="badge ok">Confirm + audit</span></Row>
        <Row label="Network checks" hint="Only to hosts you type in"><span class="badge ok">Manual only</span></Row>
        <button class="btn" style={{ "margin-top": "12px" }} onClick={() => go("flow", "automations")}>View activity log</button>
      </Card>
    </div>
  );
}

function Backup() {
  const [tasks, setTasks] = createSignal(true);
  const exportIt = async () => {
    const json = await act(call<string>("backup_export", { includeTasks: tasks() }));
    if (!json) return;
    const p = await save({ defaultPath: `glasscore-profile-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "GlassCore profile", extensions: ["json"] }] });
    if (p) await act(call("save_text", { path: p, text: json }), "Profile exported");
  };
  const importIt = async () => {
    const p = await open({ multiple: false, filters: [{ name: "GlassCore profile", extensions: ["json"] }] });
    if (!p || Array.isArray(p)) return;
    const text = await act(call<string>("read_text", { path: p }));
    if (!text) return;
    if (await confirm({ title: "Import this profile?", body: "Preferences, lighting presets, cooling profiles and automations are replaced. Workspaces and tasks are merged. This PC's fan/LED mappings are kept.", ok: "Import" }))
      act(call<string>("backup_import", { json: text }), (r) => `Imported: ${r}`).then(() => setTimeout(() => location.reload(), 600));
  };
  return (
    <div class="grid g2" style={{ "align-items": "start" }}>
      <Card title="Export" icon="backup" sub="Portable JSON — no hardware IDs or absolute user paths">
        <Row label="Include tasks"><Toggle value={tasks()} onChange={setTasks} /></Row>
        <button class="btn primary" style={{ "margin-top": "12px" }} onClick={exportIt}>Export profile…</button>
      </Card>
      <Card title="Import" icon="backup" sub="From another PC or a backup">
        <p class="small muted">Imports merge rather than overwrite where possible, and unresolved hardware mappings are left for you to map on this PC.</p>
        <button class="btn" style={{ "margin-top": "12px" }} onClick={importIt}>Import profile…</button>
      </Card>
      <Card title="Database" icon="disk">
        <p class="small muted">A backup copy is made automatically every time GlassCore starts, before any migration.</p>
        <button class="btn" style={{ "margin-top": "10px" }} onClick={async () => { const d = await call<any>("diagnostics"); toast(`Integrity check: ${d.db_integrity}`, d.db_integrity === "ok" ? "ok" : "bad"); }}>Run integrity check</button>
      </Card>
    </div>
  );
}

function About() {
  const info = usePoll<any>(() => call("app_info"), 0);
  return (
    <div class="grid g2" style={{ "align-items": "start" }}>
      <Card title="GlassCore" icon="info">
        <div class="big">GlassCore <span class="dim small">v{info.data()?.version ?? "0.1.0"}</span></div>
        <p class="small muted" style={{ "margin-top": "8px" }}>A local-first Windows desktop command centre: ultrawide window zones, system observability, hardware lighting and cooling, tasks and user-approved automation.</p>
        <div class="row wrap" style={{ "margin-top": "14px" }}>
          <button class="btn" onClick={() => openUrl("https://github.com/aidanfarrugia10/glasscore")}><Icon name="external" size={14} />Source code</button>
          <button class="btn" onClick={() => openUrl("https://github.com/aidanfarrugia10/glasscore/security/policy")}>Report a security issue</button>
        </div>
      </Card>
      <Card title="Open-source components" icon="layers">
        <ul class="small muted" style={{ margin: 0, "padding-left": "18px", "line-height": 1.8 }}>
          <li>Tauri (MIT/Apache-2.0) · SolidJS (MIT) · three.js (MIT)</li>
          <li>LibreHardwareMonitor (MPL-2.0) — sensors &amp; fan control in the helper</li>
          <li>sysinfo, rusqlite, windows-rs (MIT/Apache-2.0)</li>
          <li>ASUS Aura USB protocol notes informed by the OpenRGB project's public documentation</li>
        </ul>
      </Card>
    </div>
  );
}
