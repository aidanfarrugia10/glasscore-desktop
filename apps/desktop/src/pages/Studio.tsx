import { createEffect, createMemo, createSignal, For, Show, Switch, Match, onCleanup } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  call, on, type LightingConfig, type RgbStatus, type Preset, type Effect, type HwStatus, type CoolingConfig, type CoolingProfile,
  type FanProfile, type Endpoint, type AppVolume, type Brightness, type Monitor, type ControllerInfo,
} from "../lib/api";
import { tabOf, setTab, act, confirm, toast, prefs } from "../lib/store";
import { temp } from "../lib/format";
import { Card, Tabs, Icon, Seg, Toggle, Slider, usePoll, Empty, Row, Bar } from "../components/ui";
import Rig3D, { SLOT_IDS } from "../components/Rig3D";
import ColorPicker from "../components/ColorPicker";
import CurveEditor from "../components/CurveEditor";

export default function Studio() {
  const tab = () => tabOf("studio", "lighting");
  return (
    <div class="page">
      <Tabs value={tab()} onChange={(t) => setTab("studio", t)} tabs={[
        { id: "lighting", label: "Lighting", icon: "light" },
        { id: "cooling", label: "Cooling", icon: "fan" },
        { id: "audio", label: "Audio & displays", icon: "audio" },
      ]} />
      <Switch>
        <Match when={tab() === "lighting"}><Lighting /></Match>
        <Match when={tab() === "cooling"}><Cooling /></Match>
        <Match when={tab() === "audio"}><Audio /></Match>
      </Switch>
    </div>
  );
}

// ============================ lighting ============================

const EFFECTS: { v: Effect; label: string }[] = [
  { v: "static", label: "Static" }, { v: "breathing", label: "Breathing" }, { v: "pulse", label: "Pulse" }, { v: "wave", label: "Wave" },
  { v: "rainbow", label: "Rainbow" }, { v: "cycle", label: "Colour cycle" }, { v: "temperature", label: "Temperature" }, { v: "off", label: "Off" },
];
const KIND: Record<string, [string, string]> = {
  group: ["Group colour", ""], addressable: ["Addressable LEDs", "ac"], independent_fan: ["Independent fan", "ok"], unsupported: ["Unsupported", "warn"],
};

function Lighting() {
  const [cfg, setCfg] = createSignal<LightingConfig | null>(null);
  const status = usePoll<RgbStatus>(() => call("rgb_status"), 3000);
  const hw = usePoll<HwStatus>(() => call("hw_status"), 3000);
  const [selSlots, setSelSlots] = createSignal<Set<string>>(new Set());
  const [selZones, setSelZones] = createSignal<Set<string>>(new Set());
  const [showMap, setShowMap] = createSignal(false);
  const load = async () => { try { setCfg(await call<LightingConfig>("rgb_config")); } catch { /* preview */ } };
  load();
  on("lighting", load);
  on<RgbStatus>("rgb-status", (s) => status.set(s));

  let timer: number | undefined;
  const commit = (next: LightingConfig) => {
    setCfg(next);
    clearTimeout(timer);
    timer = window.setTimeout(() => call("rgb_set_config", { config: next }).catch((e) => toast(String(e), "bad")), 120);
  };
  onCleanup(() => clearTimeout(timer));
  const active = () => cfg()?.active;
  const patchActive = (p: Partial<Preset>) => { const c = cfg(); if (c) commit({ ...c, active: { ...c.active, ...p } }); };

  const slotColor = (id: string) => active()?.slot_colors[id] ?? active()?.color ?? "#7BCDD1";
  const targetLabel = () => {
    const s = [...selSlots()], z = [...selZones()];
    if (s.length === 1) return `${cfg()?.slots.find((x) => x.id === s[0])?.name ?? s[0]} fan`;
    if (s.length > 1) return `${s.length} fans`;
    if (z.length === 1) return zoneName(z[0]);
    if (z.length > 1) return `${z.length} zones`;
    return "Everything";
  };
  const zoneName = (key: string) => {
    const [cid, zi] = key.split("#");
    const c = status.data()?.controllers.find((x) => x.id === cid);
    return c?.zones[+zi]?.name ?? key;
  };
  const pickerValue = () => {
    const s = [...selSlots()][0];
    if (s) return slotColor(s);
    const z = [...selZones()][0];
    if (z) return active()?.zone_colors[z] ?? active()?.color ?? "#7BCDD1";
    return active()?.color ?? "#7BCDD1";
  };
  const applyColor = (hex: string) => {
    const a = active();
    if (!a) return;
    const effect = a.effect === "rainbow" || a.effect === "cycle" || a.effect === "off" ? "static" : a.effect;
    if (selSlots().size) {
      const sc = { ...a.slot_colors };
      selSlots().forEach((id) => (sc[id] = hex));
      patchActive({ slot_colors: sc, effect });
    } else if (selZones().size) {
      const zc = { ...a.zone_colors };
      selZones().forEach((k) => (zc[k] = hex));
      patchActive({ zone_colors: zc, effect });
    } else patchActive({ color: hex, slot_colors: {}, zone_colors: {}, effect });
  };
  const pick = (id: string | null, additive: boolean) => {
    setSelZones(new Set<string>());
    if (!id) { if (!additive) setSelSlots(new Set<string>()); return; }
    const s = new Set(additive ? selSlots() : []);
    if (s.has(id) && (additive || selSlots().size === 1)) s.delete(id); else s.add(id);
    setSelSlots(s);
  };
  const toggleZone = (key: string) => {
    setSelSlots(new Set<string>());
    const s = new Set(selZones());
    s.has(key) ? s.delete(key) : s.add(key);
    setSelZones(s);
  };
  const savePreset = async () => {
    const c = cfg(); if (!c) return;
    const name = window.prompt?.("Name this lighting preset", c.active.name === "Default" ? "My preset" : c.active.name);
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const p = { ...c.active, id, name };
    commit({ ...c, active: p, presets: [...c.presets.filter((x) => x.id !== id), p] });
    toast(`Saved “${name}”`, "ok");
  };
  const ctrls = () => status.data()?.controllers ?? [];
  const unmapped = () => (cfg()?.slots ?? []).every((s) => !s.controller);

  return (
    <Show when={cfg()} fallback={<Card><div class="row"><div class="spin" />Loading lighting…</div></Card>}>
      <div class="col" style={{ gap: "var(--gap)" }}>
        <Show when={status.data()?.conflict}>
          <div class="card tight" style={{ "border-color": "color-mix(in srgb, var(--warn) 50%, var(--line))" }}>
            <div class="row">
              <Icon name="alert" style={{ color: "var(--warn)" }} />
              <div class="grow small">{status.data()!.conflict}</div>
              <button class="btn sm" onClick={async () => {
                if (!hw.data()?.elevated) return toast("Start the hardware helper first (Cooling tab) — pausing a service needs administrator rights", "bad");
                if (await confirm({ title: "Pause Armoury Crate lighting?", body: "GlassCore will stop the LightingService so it can't overwrite your colours. You can resume it here any time; nothing is uninstalled.", ok: "Pause it" }))
                  await act(call("rgb_oem_service", { run: false }), "Armoury Crate lighting paused");
              }}>Pause OEM lighting</button>
              <button class="btn sm ghost" onClick={() => act(call("rgb_oem_service", { run: true }), "Armoury Crate lighting resumed")}>Resume</button>
            </div>
          </div>
        </Show>

        <div class="grid" style={{ "grid-template-columns": "minmax(0, 1fr) 340px", "align-items": "start" }}>
          <Card title="Your rig" icon="studio" sub="Click a fan to colour it · Ctrl+click for several · drag to rotate"
            actions={<><button class="btn sm" onClick={() => setShowMap(!showMap())}><Icon name="layers" size={14} />Map fans to LEDs</button><Toggle value={cfg()!.enabled} onChange={(v) => commit({ ...cfg()!, enabled: v })} label="Lighting on" /></>}>
            <div class="rig">
              <Rig3D preset={() => active()!} slotColor={slotColor} selected={selSlots} temp={() => hw.data()?.snapshot?.cpuTemp ?? null} onPick={pick} reducedMotion={() => prefs().reduced_motion} />
            </div>
            <div class="row wrap" style={{ "margin-top": "12px", gap: "8px" }}>
              <For each={cfg()!.slots}>
                {(s) => (
                  <button class={`chip ${selSlots().has(s.id) ? "on" : ""}`} onClick={(e) => pick(s.id, e.ctrlKey || e.shiftKey)} title={s.controller ? `${s.count} LEDs from LED ${s.start + 1}` : "Not mapped to real LEDs yet"}>
                    <i class="dot" style={{ background: slotColor(s.id) }} />{s.name}<Show when={!s.controller}><span class="dim small">· unmapped</span></Show>
                  </button>
                )}
              </For>
              <span class="grow" />
              <button class="btn sm ghost" onClick={() => { setSelSlots(new Set(SLOT_IDS)); setSelZones(new Set<string>()); }}>Select all</button>
              <button class="btn sm ghost" onClick={() => { setSelSlots(new Set<string>()); setSelZones(new Set<string>()); }}>Clear</button>
            </div>
            <Show when={unmapped() && ctrls().length}>
              <div class="inset small" style={{ "margin-top": "10px" }}>
                <b>Tip:</b> the model is a preview until each fan is mapped to its LEDs. Open <a href="#" onClick={(e) => { e.preventDefault(); setShowMap(true); }}>Map fans to LEDs</a>, then use Identify to check which fan blinks.
              </div>
            </Show>
          </Card>

          <div class="col" style={{ gap: "var(--gap)" }}>
            <Card title="Colour" icon="light" sub={targetLabel()}>
              <div class="preview" style={{ background: `linear-gradient(135deg, ${pickerValue()}, color-mix(in srgb, ${pickerValue()} 45%, #000))`, "box-shadow": `0 0 36px -6px ${pickerValue()}` }}>
                <b style={{ color: "#fff", "text-shadow": "0 1px 4px rgba(0,0,0,.6)" }}>{targetLabel()}</b>
              </div>
              <div style={{ "margin-top": "14px" }}><ColorPicker value={pickerValue()} onChange={applyColor} /></div>
            </Card>
            <Card title="Presets" icon="layers" actions={<button class="btn sm" onClick={savePreset}><Icon name="plus" size={14} />Save current</button>}>
              <div class="row wrap" style={{ gap: "6px" }}>
                <For each={cfg()!.presets}>
                  {(p) => (
                    <button class={`chip ${active()!.id === p.id ? "on" : ""}`} onClick={() => commit({ ...cfg()!, active: { ...p } })} onContextMenu={async (e) => {
                      e.preventDefault();
                      if (cfg()!.presets.length > 1 && await confirm({ title: `Delete preset “${p.name}”?`, body: "Automation rules that use it will stop changing the lights.", danger: true, ok: "Delete" }))
                        commit({ ...cfg()!, presets: cfg()!.presets.filter((x) => x.id !== p.id) });
                    }} title="Right-click to delete">
                      <i class="dot" style={{ background: p.effect === "rainbow" || p.effect === "cycle" ? "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" : p.color }} />{p.name}
                    </button>
                  )}
                </For>
              </div>
            </Card>
          </div>
        </div>

        <Show when={showMap()}><Mapping cfg={cfg()!} ctrls={ctrls()} commit={commit} /></Show>

        <div class="grid g2" style={{ "align-items": "start" }}>
          <Card title="Effect" icon="zap">
            <div class="row wrap" style={{ gap: "6px", "margin-bottom": "14px" }}>
              <For each={EFFECTS}>{(e) => <button class={`chip ${active()!.effect === e.v ? "on" : ""}`} onClick={() => patchActive({ effect: e.v })}>{e.label}</button>}</For>
            </div>
            <div class="grid g2">
              <div><div class="row lbl" style={{ "margin-bottom": "6px" }}>Speed<span class="right tn">{active()!.speed}%</span></div><Slider value={active()!.speed} onInput={(v) => patchActive({ speed: v })} label="Effect speed" /></div>
              <div><div class="row lbl" style={{ "margin-bottom": "6px" }}>Brightness<span class="right tn">{active()!.brightness}%</span></div><Slider value={active()!.brightness} onInput={(v) => patchActive({ brightness: v })} label="LED brightness" /></div>
            </div>
            <Show when={["wave", "temperature"].includes(active()!.effect)}>
              <div class="row" style={{ "margin-top": "14px" }}>
                <span class="small muted grow">{active()!.effect === "temperature" ? "Hot colour (CPU at 85 °C) — the main colour is used when cool" : "Second wave colour"}</span>
                <input type="color" value={active()!.color2} onInput={(e) => patchActive({ color2: e.currentTarget.value })} aria-label="Second colour" style={{ width: "44px", height: "32px", border: 0, background: "transparent" }} />
              </div>
            </Show>
            <div class="divider" />
            <Row label="Night brightness cap" hint="Limit brightness between two hours (e.g. 23:00–07:00)">
              <Toggle value={!!cfg()!.night_cap} onChange={(v) => commit({ ...cfg()!, night_cap: v ? [23, 7, 25] : null })} />
            </Row>
            <Show when={cfg()!.night_cap}>
              <div class="row" style={{ "padding-top": "10px" }}>
                <span class="small muted">From</span>
                <input class="input tn" type="number" min="0" max="23" style={{ width: "64px" }} value={cfg()!.night_cap![0]} onChange={(e) => commit({ ...cfg()!, night_cap: [+e.currentTarget.value, cfg()!.night_cap![1], cfg()!.night_cap![2]] })} />
                <span class="small muted">to</span>
                <input class="input tn" type="number" min="0" max="23" style={{ width: "64px" }} value={cfg()!.night_cap![1]} onChange={(e) => commit({ ...cfg()!, night_cap: [cfg()!.night_cap![0], +e.currentTarget.value, cfg()!.night_cap![2]] })} />
                <span class="small muted">max</span>
                <input class="input tn" type="number" min="0" max="100" style={{ width: "70px" }} value={cfg()!.night_cap![2]} onChange={(e) => commit({ ...cfg()!, night_cap: [cfg()!.night_cap![0], cfg()!.night_cap![1], +e.currentTarget.value] })} />
                <span class="small muted">%</span>
              </div>
            </Show>
            <Row label="Animation frame cap" hint="Lower = less USB traffic and CPU">
              <Seg value={cfg()!.fps} onChange={(v) => commit({ ...cfg()!, fps: v })} options={[{ v: 15, label: "15" }, { v: 30, label: "30" }, { v: 60, label: "60" }]} />
            </Row>
          </Card>

          <Card title="Controllers" icon="layers" actions={<button class="btn sm" onClick={() => act(call("rgb_rescan"), "Rescanning lighting controllers")}><Icon name="refresh" size={14} />Rescan</button>}>
            <Show when={ctrls().length} fallback={<Empty title="No lighting controllers found" icon="light">{(status.data()?.errors ?? []).join(" · ") || "Turn on a provider below."}</Empty>}>
              <For each={ctrls()}>
                {(c) => (
                  <div class="inset" style={{ "margin-bottom": "10px" }}>
                    <div class="row"><b class="grow ellipsis">{c.name}</b><span class="badge ac">{c.provider}</span></div>
                    <div class="small dim" style={{ margin: "2px 0 10px" }}>Firmware {c.firmware || "—"}</div>
                    <For each={c.zones}>
                      {(z) => {
                        const key = `${c.id}#${z.index}`;
                        return (
                          <div class="row" style={{ padding: "5px 0", "border-top": "1px solid var(--line)" }}>
                            <button class={`chip ${selZones().has(key) ? "on" : ""}`} onClick={() => toggleZone(key)} title="Select to colour this zone">
                              <i class="dot" style={{ background: active()!.zone_colors[key] ?? active()!.color }} />{z.name}
                            </button>
                            <span class={`badge ${KIND[z.kind][1]}`}>{KIND[z.kind][0]}</span>
                            <span class="grow" />
                            <Show when={z.resizable} fallback={<span class="small dim tn">{z.leds} LED{z.leds === 1 ? "" : "s"}</span>}>
                              <input class="input tn" type="number" min="1" max={z.max_leds} style={{ width: "70px", height: "28px" }} value={z.leds} aria-label={`${z.name} LED count`}
                                onChange={(e) => act(call("rgb_resize", { controller: c.id, zone: z.index, leds: +e.currentTarget.value }), "LED count updated").then(() => status.refresh())} />
                            </Show>
                            <button class="btn sm ghost" onClick={() => call("rgb_identify_zone", { controller: c.id, zone: z.index, start: 0, count: z.leds })}>Identify</button>
                          </div>
                        );
                      }}
                    </For>
                    <For each={c.notes}>{(n) => <div class="small dim" style={{ "margin-top": "8px" }}>{n}</div>}</For>
                  </div>
                )}
              </For>
            </Show>
            <div class="lbl" style={{ margin: "12px 0 4px" }}>Providers</div>
            <Row label="ASUS Aura USB (direct)" hint="Talks to the motherboard's Aura LED controller. No admin needed.">
              <Toggle value={cfg()!.use_aura_usb} onChange={(v) => commit({ ...cfg()!, use_aura_usb: v })} />
            </Row>
            <Row label="OpenRGB SDK server" hint="localhost:6742 only — for other brands">
              <Toggle value={cfg()!.use_openrgb} onChange={(v) => commit({ ...cfg()!, use_openrgb: v })} />
            </Row>
            <Row label="Simulated controller" hint="Try every feature with no hardware">
              <Toggle value={cfg()!.use_simulated} onChange={(v) => commit({ ...cfg()!, use_simulated: v })} />
            </Row>
            <Show when={status.data()?.errors.length}><div class="small" style={{ color: "var(--warn)", "margin-top": "8px" }}>{status.data()!.errors.join(" · ")}</div></Show>
          </Card>
        </div>
      </div>
    </Show>
  );
}

function Mapping(props: { cfg: LightingConfig; ctrls: ControllerInfo[]; commit: (c: LightingConfig) => void }) {
  const setSlot = (i: number, patch: any) => {
    const slots = props.cfg.slots.map((s, j) => (j === i ? { ...s, ...patch } : s));
    props.commit({ ...props.cfg, slots });
  };
  const zonesFor = (cid: string | null) => props.ctrls.find((c) => c.id === cid)?.zones.filter((z) => z.kind !== "unsupported") ?? [];
  const autoSplit = () => {
    const best = props.ctrls.flatMap((c) => c.zones.filter((z) => z.kind === "addressable").map((z) => ({ c, z }))).sort((a, b) => b.z.leds - a.z.leds)[0];
    if (!best) return toast("No addressable zone to split", "bad");
    const order = ["rear", "front1", "front2", "front3"];
    const per = Math.max(1, Math.floor(best.z.leds / order.length));
    props.commit({ ...props.cfg, slots: props.cfg.slots.map((s) => { const i = order.indexOf(s.id); return i < 0 ? s : { ...s, controller: best.c.id, zone: best.z.index, start: i * per, count: per }; }) });
    toast(`Split ${best.z.leds} LEDs into 4 fans of ${per}. Use Identify to check the order.`, "ok");
  };
  return (
    <Card title="Map fans to LEDs" icon="layers" sub="Daisy-chained ARGB fans share one header — tell GlassCore which LEDs belong to which fan"
      actions={<button class="btn sm" onClick={autoSplit}>Auto-split 4 case fans</button>}>
      <table class="t">
        <thead><tr><th>Fan</th><th>Controller</th><th>Zone / header</th><th class="num">First LED</th><th class="num">LEDs</th><th></th></tr></thead>
        <tbody>
          <For each={props.cfg.slots}>
            {(s, i) => (
              <tr>
                <td><b>{s.name}</b></td>
                <td>
                  <select class="input" value={s.controller ?? ""} onChange={(e) => setSlot(i(), { controller: e.currentTarget.value || null, zone: zonesFor(e.currentTarget.value)[0]?.index ?? 0, start: 0, count: zonesFor(e.currentTarget.value)[0]?.leds ?? 0 })}>
                    <option value="">Not mapped</option>
                    <For each={props.ctrls}>{(c) => <option value={c.id}>{c.name}</option>}</For>
                  </select>
                </td>
                <td>
                  <select class="input" value={s.zone} disabled={!s.controller} onChange={(e) => setSlot(i(), { zone: +e.currentTarget.value })}>
                    <For each={zonesFor(s.controller)}>{(z) => <option value={z.index}>{z.name} ({z.leds})</option>}</For>
                  </select>
                </td>
                <td class="num"><input class="input tn" type="number" min="1" style={{ width: "76px" }} value={s.start + 1} disabled={!s.controller} onChange={(e) => setSlot(i(), { start: Math.max(0, +e.currentTarget.value - 1) })} /></td>
                <td class="num"><input class="input tn" type="number" min="0" style={{ width: "76px" }} value={s.count} disabled={!s.controller} onChange={(e) => setSlot(i(), { count: Math.max(0, +e.currentTarget.value) })} /></td>
                <td><button class="btn sm" disabled={!s.controller} onClick={() => act(call("rgb_identify", { slot: s.id }), `${s.name}: blinking white for 4 s`)}>Identify</button></td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <p class="small dim" style={{ "margin-top": "10px" }}>Single-LED fans on a 12 V header can only share one colour; per-fan colours need addressable (3-pin 5 V) fans or separate headers.</p>
    </Card>
  );
}

// ============================ cooling ============================

function Cooling() {
  const hw = usePoll<HwStatus>(() => call("hw_status"), 1500);
  const [cfg, setCfg] = createSignal<CoolingConfig | null>(null);
  const [editing, setEditing] = createSignal<string>("balanced");
  const [fanSel, setFanSel] = createSignal<string | null>(null);
  const [starting, setStarting] = createSignal(false);
  const load = async () => { try { const c = await call<CoolingConfig>("cooling_get"); setCfg(c); if (c.active !== "auto") setEditing(c.active); } catch { /* preview */ } };
  load();
  on("cooling", load);
  const snap = () => hw.data()?.snapshot;
  const fans = () => snap()?.fans ?? [];
  const controllable = () => fans().filter((f) => f.controllable);
  const prof = () => cfg()?.profiles.find((p) => p.id === editing());
  const fp = (): FanProfile | undefined => { const p = prof(); if (!p) return; return fanSel() ? p.fans[fanSel()!] ?? p.default : p.default; };
  const floor = () => (fanSel() ? fans().find((f) => f.id === fanSel())?.floor ?? 20 : 20);
  let timer: number | undefined;
  const save = (c: CoolingConfig) => {
    setCfg(c);
    clearTimeout(timer);
    timer = window.setTimeout(() => call("cooling_set", { config: c }).catch((e) => toast(String(e), "bad")), 400);
  };
  const patchFp = (patch: Partial<FanProfile>) => {
    const c = cfg(), p = prof(), f = fp();
    if (!c || !p || !f) return;
    const nf = { ...f, ...patch };
    const np: CoolingProfile = fanSel() ? { ...p, fans: { ...p.fans, [fanSel()!]: nf } } : { ...p, default: nf };
    save({ ...c, profiles: c.profiles.map((x) => (x.id === p.id ? np : x)) });
  };
  const start = async () => {
    setStarting(true);
    await act(call("helper_start"), "Hardware control enabled");
    setStarting(false);
    hw.refresh();
  };
  const stalled = (f: any) => f.managed && (f.percent ?? 0) > 35 && f.rpm === 0;

  return (
    <div class="col" style={{ gap: "var(--gap)" }}>
      <Card title="Hardware control" icon="shield" actions={
        <Show when={hw.data()?.connected && hw.data()?.elevated} fallback={<button class="btn primary" disabled={starting() || !hw.data()?.helper_found} onClick={start}>{starting() ? "Waiting for Windows…" : "Enable hardware control"}</button>}>
          <span class="badge ok">Elevated helper running</span>
        </Show>
      }>
        <Show when={hw.data()?.helper_found} fallback={<p class="small" style={{ color: "var(--warn)" }}>The hardware helper (glasscore-broker.exe) wasn't found next to GlassCore. Reinstall to restore it.</p>}>
          <p class="small muted">Fan speeds and sensors need a small helper running as administrator. It only accepts a fixed list of safe commands from GlassCore, returns every fan to BIOS control if GlassCore closes or stops responding, and pushes all fans to 100% if the CPU or GPU reaches 90 °C.</p>
          <Show when={hw.data()?.elevated}>
            <Row label="Start the helper when I sign in" hint="Uses an elevated Task Scheduler entry so there's no UAC prompt each boot">
              <Toggle value={false} onChange={(v) => act(call("helper_autostart", { enable: v }), v ? "Helper will start at sign-in" : "Removed from sign-in")} />
            </Row>
          </Show>
          <Show when={snap() && !snap()!.pawnio}>
            <div class="inset small" style={{ "margin-top": "10px" }}>
              <b>Fan control driver not installed.</b> Reading and writing your motherboard's fan chip needs the free, signed PawnIO driver. Sensors and RPM may still work without it.
              <div class="row" style={{ "margin-top": "8px" }}><button class="btn sm" onClick={() => openUrl("https://pawnio.eu/")}><Icon name="external" size={13} />Get PawnIO</button></div>
            </div>
          </Show>
          <Show when={snap()?.error}><div class="small" style={{ color: "var(--warn)", "margin-top": "8px" }}>{snap()!.error}</div></Show>
          <Show when={snap()?.emergency}><div class="inset small" style={{ "margin-top": "10px", "border-color": "var(--bad)", color: "var(--bad)" }}>Thermal emergency: all managed fans are at 100% until temperatures drop below 85 °C.</div></Show>
        </Show>
      </Card>

      <div class="grid g4">
        <Card class="tight"><div class="lbl">CPU</div><div class="big tn">{temp(snap()?.cpuTemp)}</div></Card>
        <Card class="tight"><div class="lbl">GPU</div><div class="big tn">{temp(snap()?.gpuTemp)}</div></Card>
        <Card class="tight"><div class="lbl">Board</div><div class="ellipsis" style={{ "margin-top": "8px" }}>{snap()?.board ?? "—"}</div></Card>
        <Card class="tight"><div class="lbl">Fans</div><div class="big tn">{controllable().length}<span class="small dim"> controllable of {fans().length}</span></div></Card>
      </div>

      <Card title="Fans" icon="fan" sub="Click a fan to give it its own curve">
        <Show when={fans().length} fallback={<Empty title="No fan readings yet" icon="fan">{hw.data()?.connected ? "The helper didn't find any fan headers. Install PawnIO and restart the helper." : "Enable hardware control above to read fan speeds."}</Empty>}>
          <div class="grid g4" style={{ gap: "10px" }}>
            <For each={fans()}>
              {(f) => (
                <button class="inset" style={{ "text-align": "left", cursor: f.controllable ? "pointer" : "default", "border-color": fanSel() === f.id ? "var(--ac)" : stalled(f) ? "var(--bad)" : undefined }}
                  onClick={() => f.controllable && setFanSel(fanSel() === f.id ? null : f.id)}>
                  <div class="row"><b class="grow ellipsis">{f.name}</b><Icon name="fan" size={16} style={{ color: "var(--ac)", animation: f.rpm ? `rot ${Math.max(0.25, 1800 / f.rpm)}s linear infinite` : "none" }} /></div>
                  <div class="small dim ellipsis">{f.hw}</div>
                  <div class="row" style={{ "margin-top": "8px", "align-items": "baseline" }}><span class="big tn">{f.rpm ?? "—"}</span><span class="small dim">RPM</span><span class="grow" /><span class="tn small">{f.percent != null ? `${f.percent}%` : ""}</span></div>
                  <Bar value={f.percent ?? 0} />
                  <div class="row" style={{ "margin-top": "8px", gap: "4px" }}>
                    <span class={`badge ${f.controllable ? (f.managed ? "ac" : "") : "warn"}`}>{f.controllable ? (f.managed ? "GlassCore" : "BIOS") : "Monitor only"}</span>
                    <Show when={stalled(f)}><span class="badge bad">Stalled?</span></Show>
                    <Show when={cfg()?.profiles.find((p) => p.id === editing())?.fans[f.id]}><span class="badge">custom</span></Show>
                  </div>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Card>

      <Show when={cfg()}>
        <Card title="Profiles" icon="layers" actions={<button class="btn sm" onClick={() => act(call("cooling_release"), "All fans returned to BIOS control").then(load)}>Return all to BIOS</button>}>
          <div class="row wrap" style={{ gap: "6px", "margin-bottom": "16px" }}>
            <For each={cfg()!.profiles}>
              {(p) => (
                <button class={`chip ${cfg()!.active === p.id ? "on" : ""}`} onClick={async () => { setEditing(p.id); await act(call("cooling_apply", { id: p.id }), `Cooling → ${p.name}`); load(); }}>
                  <Show when={cfg()!.active === p.id}><Icon name="check" size={13} /></Show>{p.name}
                </button>
              )}
            </For>
            <button class="chip" onClick={() => {
              const c = cfg()!;
              const id = `custom-${Date.now()}`;
              const base = c.profiles.find((p) => p.id === "balanced") ?? c.profiles[1];
              save({ ...c, profiles: [...c.profiles, { ...base, id, name: `Custom ${c.profiles.length - 3}`, fans: {} }] });
              setEditing(id);
            }}><Icon name="plus" size={13} />New profile</button>
          </div>
          <Show when={prof() && prof()!.id !== "auto"} fallback={<p class="small muted">Auto hands every fan to your motherboard's own BIOS curve. Pick or create a profile to customise.</p>}>
            <div class="row" style={{ "margin-bottom": "10px" }}>
              <input class="input" style={{ width: "220px" }} value={prof()!.name} disabled={["quiet", "balanced", "performance"].includes(prof()!.id)} aria-label="Profile name"
                onChange={(e) => save({ ...cfg()!, profiles: cfg()!.profiles.map((x) => (x.id === prof()!.id ? { ...x, name: e.currentTarget.value } : x)) })} />
              <span class="badge">{fanSel() ? `Editing: ${fans().find((f) => f.id === fanSel())?.name}` : "Editing: all fans"}</span>
              <Show when={fanSel() && prof()!.fans[fanSel()!]}><button class="btn sm ghost" onClick={() => { const p = prof()!; const { [fanSel()!]: _, ...rest } = p.fans; save({ ...cfg()!, profiles: cfg()!.profiles.map((x) => (x.id === p.id ? { ...p, fans: rest } : x)) }); }}>Use profile default</button></Show>
              <span class="grow" />
              <Show when={!["quiet", "balanced", "performance"].includes(prof()!.id)}>
                <button class="btn sm danger" onClick={async () => { if (await confirm({ title: `Delete “${prof()!.name}”?`, body: "Fans using it go back to BIOS control.", danger: true, ok: "Delete" })) { const c = cfg()!; save({ ...c, active: c.active === prof()!.id ? "auto" : c.active, profiles: c.profiles.filter((x) => x.id !== prof()!.id) }); setEditing("balanced"); } }}>Delete</button>
              </Show>
            </div>
            <div class="grid" style={{ "grid-template-columns": "minmax(0, 1.5fr) minmax(0, 1fr)", gap: "20px" }}>
              <div>
                <Seg value={fp()!.mode} onChange={(v) => patchFp({ mode: v })} options={[{ v: "curve", label: "Curve" }, { v: "fixed", label: "Fixed speed" }, { v: "auto", label: "BIOS" }]} />
                <div style={{ "margin-top": "12px" }}>
                  <Show when={fp()!.mode === "curve"}>
                    <CurveEditor points={fp()!.curve.length ? fp()!.curve : [[30, 30], [60, 60], [85, 100]]} onChange={(pts) => patchFp({ curve: pts })} floor={Math.max(floor(), fp()!.min_percent)}
                      temp={fp()!.source === "gpu" ? snap()?.gpuTemp : fp()!.source === "max" ? Math.max(snap()?.cpuTemp ?? 0, snap()?.gpuTemp ?? 0) || null : snap()?.cpuTemp} />
                    <div class="small dim">Drag points · double-click to add · right-click to remove</div>
                  </Show>
                  <Show when={fp()!.mode === "fixed"}>
                    <div class="row lbl" style={{ "margin-bottom": "6px" }}>Speed<span class="right tn">{fp()!.percent}%</span></div>
                    <Slider value={fp()!.percent} min={Math.max(floor(), fp()!.min_percent)} onInput={(v) => patchFp({ percent: v })} label="Fixed fan speed" />
                  </Show>
                  <Show when={fp()!.mode === "auto"}><p class="small muted">This fan follows the BIOS curve in this profile.</p></Show>
                </div>
              </div>
              <div class="col">
                <Row label="Temperature source"><Seg value={fp()!.source} onChange={(v) => patchFp({ source: v })} options={[{ v: "cpu", label: "CPU" }, { v: "gpu", label: "GPU" }, { v: "max", label: "Hottest" }]} /></Row>
                <div><div class="row lbl" style={{ margin: "8px 0 4px" }}>Hysteresis<span class="right tn">{fp()!.hysteresis} °C</span></div><Slider value={fp()!.hysteresis} min={0} max={10} onInput={(v) => patchFp({ hysteresis: v })} label="Hysteresis" /><div class="small dim">Ignore temperature drops smaller than this, so fans don't hunt up and down.</div></div>
                <div><div class="row lbl" style={{ margin: "8px 0 4px" }}>Ramp up<span class="right tn">{fp()!.step_up}%/s</span></div><Slider value={fp()!.step_up} min={1} max={30} onInput={(v) => patchFp({ step_up: v })} label="Ramp up rate" /></div>
                <div><div class="row lbl" style={{ margin: "8px 0 4px" }}>Ramp down<span class="right tn">{fp()!.step_down}%/s</span></div><Slider value={fp()!.step_down} min={1} max={20} onInput={(v) => patchFp({ step_down: v })} label="Ramp down rate" /></div>
                <div><div class="row lbl" style={{ margin: "8px 0 4px" }}>Minimum speed<span class="right tn">{Math.max(floor(), fp()!.min_percent)}%</span></div><Slider value={fp()!.min_percent} min={0} max={60} onInput={(v) => patchFp({ min_percent: v })} label="Minimum speed" /><div class="small dim">CPU and pump headers can never go below 30%; other fans not below 20%.</div></div>
              </div>
            </div>
          </Show>
        </Card>
      </Show>
    </div>
  );
}

// ============================ audio & displays ============================

function Audio() {
  const eps = usePoll<Endpoint[]>(() => call("audio_endpoints"), 1500, []);
  const out = () => (eps.data() ?? []).find((e) => e.flow === "output" && e.default);
  const sessions = usePoll<AppVolume[]>(() => (out() ? call("audio_sessions", { id: out()!.id }) : Promise.resolve([])), 1500, []);
  const bright = usePoll<Brightness[]>(() => call("brightness_get"), 0, []);
  const mons = usePoll<Monitor[]>(() => call("monitors"), 0, []);
  const ep = (flow: "output" | "input") => (eps.data() ?? []).filter((e) => e.flow === flow);
  const setVol = (id: string, level: number) => call("audio_set_volume", { id, level: level / 100, mute: null }).catch((e) => toast(String(e), "bad"));
  const bbox = createMemo(() => {
    const m = mons.data() ?? [];
    if (!m.length) return null;
    const x0 = Math.min(...m.map((v) => v.bounds.x)), y0 = Math.min(...m.map((v) => v.bounds.y));
    const x1 = Math.max(...m.map((v) => v.bounds.x + v.bounds.w)), y1 = Math.max(...m.map((v) => v.bounds.y + v.bounds.h));
    return { x0, y0, w: x1 - x0, h: y1 - y0 };
  });
  const Endpoints = (p: { flow: "output" | "input" }) => (
    <For each={ep(p.flow)} fallback={<div class="small dim">No devices.</div>}>
      {(e) => (
        <div class="inset" style={{ "margin-bottom": "8px", "border-color": e.default ? "var(--ac)" : undefined }}>
          <div class="row">
            <b class="grow ellipsis">{e.name}</b>
            <Show when={e.default} fallback={<button class="btn sm" onClick={() => act(call("audio_set_default", { id: e.id }), `Default ${p.flow} → ${e.name}`).then(() => eps.refresh())}>Make default</button>}><span class="badge ac">Default</span></Show>
          </div>
          <div class="row" style={{ "margin-top": "8px" }}>
            <button class="btn sm icon" aria-label={e.muted ? "Unmute" : "Mute"} onClick={() => call("audio_set_volume", { id: e.id, level: null, mute: !e.muted }).then(() => eps.refresh())}>
              <Icon name="audio" size={15} style={{ opacity: e.muted ? 0.35 : 1 }} />
            </button>
            <div class="grow"><Slider value={Math.round((e.volume ?? 0) * 100)} onInput={(v) => setVol(e.id, v)} onChange={() => eps.refresh()} label={`${e.name} volume`} /></div>
            <span class="tn small" style={{ width: "40px", "text-align": "right" }}>{Math.round((e.volume ?? 0) * 100)}%</span>
          </div>
          <div class="bar" style={{ height: "3px", "margin-top": "6px" }}><i style={{ width: `${(e.peak ?? 0) * 100}%`, background: p.flow === "input" ? "var(--ok)" : "var(--ac)", transition: "width .15s" }} /></div>
        </div>
      )}
    </For>
  );
  return (
    <div class="col" style={{ gap: "var(--gap)" }}>
      <div class="grid g2" style={{ "align-items": "start" }}>
        <Card title="Output" icon="audio"><Endpoints flow="output" /></Card>
        <Card title="Input" icon="audio" sub="Live level shows when an app is using the mic"><Endpoints flow="input" /></Card>
      </div>
      <Card title="App mixer" icon="layers" sub={out()?.name}>
        <For each={sessions.data()} fallback={<div class="small dim">No apps are playing audio right now.</div>}>
          {(s) => (
            <div class="row" style={{ padding: "6px 0", "border-bottom": "1px solid var(--line)" }}>
              <span style={{ width: "200px" }} class="ellipsis">{s.name}</span>
              <button class="btn sm icon" aria-label={s.muted ? "Unmute" : "Mute"} onClick={() => call("audio_set_session", { id: out()!.id, pid: s.pid, level: null, mute: !s.muted }).then(() => sessions.refresh())}><Icon name="audio" size={14} style={{ opacity: s.muted ? 0.35 : 1 }} /></button>
              <div class="grow"><Slider value={Math.round(s.volume * 100)} onInput={(v) => call("audio_set_session", { id: out()!.id, pid: s.pid, level: v / 100, mute: null })} label={`${s.name} volume`} /></div>
              <span class="tn small" style={{ width: "40px", "text-align": "right" }}>{Math.round(s.volume * 100)}%</span>
              <div style={{ width: "60px" }}><Bar value={s.peak * 100} /></div>
            </div>
          )}
        </For>
      </Card>
      <div class="grid g2" style={{ "align-items": "start" }}>
        <Card title="Displays" icon="monitor" actions={<button class="btn sm" onClick={() => call("open_settings", { uri: "ms-settings:display" })}><Icon name="external" size={13} />Display settings</button>}>
          <Show when={bbox()}>
            <div style={{ position: "relative", height: "170px", margin: "6px 0 14px" }}>
              <For each={mons.data()}>
                {(m) => (
                  <div class="monitor" style={{
                    position: "absolute", left: `${((m.bounds.x - bbox()!.x0) / bbox()!.w) * 100}%`, top: `${((m.bounds.y - bbox()!.y0) / bbox()!.h) * 170}px`,
                    width: `calc(${(m.bounds.w / bbox()!.w) * 100}% - 6px)`, height: `${(m.bounds.h / bbox()!.h) * 170 - 6}px`, display: "grid", "place-items": "center", "border-color": m.primary ? "var(--ac)" : undefined,
                  }}>
                    <div style={{ "text-align": "center" }}><b>{m.name.replace("\\\\.\\", "")}</b><div class="small dim">{m.bounds.w}×{m.bounds.h} · {Math.round(m.scale * 100)}%</div></div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Card>
        <Card title="Brightness (DDC/CI)" icon="light" sub="External monitors that support DDC/CI">
          <For each={bright.data()} fallback={<div class="small dim">No displays accepted DDC/CI brightness queries. Many monitors have it turned off in their on-screen menu; laptop panels use Windows' own slider.</div>}>
            {(b) => (
              <div style={{ padding: "6px 0" }}>
                <div class="row small"><span class="grow">{b.name || `Display ${b.monitor + 1}`}</span><span class="tn">{b.current}</span></div>
                <Slider value={b.current} min={b.min} max={b.max} onInput={(v) => { bright.set((bright.data() ?? []).map((x) => (x === b ? { ...x, current: v } : x))); }} onChange={(v) => act(call("brightness_set", { monitor: b.monitor, value: v }))} label="Brightness" />
              </div>
            )}
          </For>
        </Card>
      </div>
    </div>
  );
}
