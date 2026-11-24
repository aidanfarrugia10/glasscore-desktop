import { createMemo, createSignal, For, Show, Switch, Match } from "solid-js";
import { call, type Layout, type Monitor, type Win, type WmConfig, type Workspace, type Zone, type LightingConfig, type CoolingConfig } from "../lib/api";
import { tabOf, setTab, act, confirm, toast, prefs, savePrefs } from "../lib/store";
import { file } from "../lib/format";
import { Card, Tabs, Icon, Toggle, usePoll, Empty, Row, Slider } from "../components/ui";

export default function WorkspacePage() {
  const tab = () => tabOf("workspace", "layouts");
  return (
    <div class="page">
      <Tabs value={tab()} onChange={(t) => setTab("workspace", t)} tabs={[
        { id: "layouts", label: "Layouts & zones", icon: "workspace" },
        { id: "workspaces", label: "Workspaces", icon: "layers" },
        { id: "dock", label: "Dock", icon: "monitor" },
      ]} />
      <Switch>
        <Match when={tab() === "layouts"}><Layouts /></Match>
        <Match when={tab() === "workspaces"}><Workspaces /></Match>
        <Match when={tab() === "dock"}><DockSettings /></Match>
      </Switch>
    </div>
  );
}

function useWm() {
  const [cfg, setCfg] = createSignal<WmConfig | null>(null);
  const [builtin, setBuiltin] = createSignal<Layout[]>([]);
  const load = async () => { try { const r = await call<any>("wm_config"); setCfg(r.config); setBuiltin(r.builtin); } catch { /* preview */ } };
  load();
  const save = async (c: WmConfig) => { setCfg(c); await act(call("wm_set_config", { config: c })); };
  const all = () => [...builtin(), ...(cfg()?.custom ?? [])];
  return { cfg, save, all, load };
}

function MiniZones(props: { zones: Zone[] }) {
  return <div class="mini-zones"><For each={props.zones}>{(z) => <i style={{ left: `calc(${z.x * 100}% + 2px)`, top: `calc(${z.y * 100}% + 2px)`, width: `calc(${z.w * 100}% - 4px)`, height: `calc(${z.h * 100}% - 4px)` }} />}</For></div>;
}

function Layouts() {
  const wm = useWm();
  const mons = usePoll<Monitor[]>(() => call("monitors"), 10000, []);
  const wins = usePoll<Win[]>(() => call("windows_list"), 4000, []);
  const [mon, setMon] = createSignal(0);
  const [editing, setEditing] = createSignal<Layout | null>(null);
  const [selZone, setSelZone] = createSignal<number | null>(null);
  const [assign, setAssign] = createSignal<Record<number, number>>({});
  const [exclusion, setExclusion] = createSignal("");
  const m = () => (mons.data() ?? [])[mon()];
  const active = () => editing() ?? wm.all().find((l) => l.id === wm.cfg()?.active_layout) ?? wm.all()[0];
  const ratio = () => (m() ? m()!.work.w / m()!.work.h : 32 / 9);

  const setActive = (l: Layout) => { setEditing(null); setSelZone(null); const c = wm.cfg(); if (c) wm.save({ ...c, active_layout: l.id }); };
  const edit = (fn: (z: Zone[]) => Zone[]) => { const a = active(); if (!a) return; setEditing({ ...a, zones: fn(a.zones.map((z) => ({ ...z }))) }); };
  const split = (dir: "v" | "h") => {
    const i = selZone(); if (i == null) return toast("Select a zone first", "info");
    edit((zs) => { const z = zs[i]; const a = dir === "v" ? { ...z, w: z.w / 2 } : { ...z, h: z.h / 2 }; const b = dir === "v" ? { ...z, x: z.x + z.w / 2, w: z.w / 2 } : { ...z, y: z.y + z.h / 2, h: z.h / 2 }; zs.splice(i, 1, a, b); return zs; });
  };
  const merge = () => {
    const i = selZone(); if (i == null) return;
    edit((zs) => {
      const z = zs[i];
      const j = zs.findIndex((o, k) => k !== i && Math.abs(o.x - (z.x + z.w)) < 0.001 && Math.abs(o.y - z.y) < 0.001 && Math.abs(o.h - z.h) < 0.001);
      const jd = zs.findIndex((o, k) => k !== i && Math.abs(o.y - (z.y + z.h)) < 0.001 && Math.abs(o.x - z.x) < 0.001 && Math.abs(o.w - z.w) < 0.001);
      if (j >= 0) { zs[i] = { ...z, w: z.w + zs[j].w }; zs.splice(j, 1); }
      else if (jd >= 0) { zs[i] = { ...z, h: z.h + zs[jd].h }; zs.splice(jd, 1); }
      else toast("No neighbour of the same size to the right or below", "info");
      return zs;
    });
  };
  const saveCustom = () => {
    const e = editing(); const c = wm.cfg(); if (!e || !c) return;
    const name = window.prompt?.("Name this layout", e.name.startsWith("Custom") ? e.name : `${e.name} (custom)`) ?? "";
    if (!name) return;
    const id = `custom-${Date.now()}`;
    wm.save({ ...c, custom: [...c.custom, { ...e, id, name }], active_layout: id });
    setEditing(null);
  };
  const applyToWindows = async () => {
    const a = active(); if (!a) return;
    const hwnds = a.zones.map((_, i) => assign()[i]).filter((h) => h != null);
    if (!hwnds.length) return toast("Pick a window for at least one zone", "info");
    if (editing()) return toast("Save the custom layout first", "info");
    const r = await act(call<any>("wm_arrange", { layout: a.id, hwnds }));
    if (r) toast(r.failed.length ? `Arranged with ${r.failed.length} issue(s): ${r.failed[0]}` : "Windows arranged", r.failed.length ? "bad" : "ok", { label: "Undo", run: () => call("ws_undo") });
  };

  return (
    <Show when={wm.cfg()}>
      <div class="col" style={{ gap: "var(--gap)" }}>
        <Card title="Screen" icon="monitor" sub={m() ? `${m()!.bounds.w}×${m()!.bounds.h} at ${Math.round(m()!.scale * 100)}% · work area ${m()!.work.w}×${m()!.work.h}` : ""}
          actions={<div class="row">
            <Show when={(mons.data() ?? []).length > 1}>
              <select class="input" value={mon()} onChange={(e) => setMon(+e.currentTarget.value)} aria-label="Monitor">
                <For each={mons.data()}>{(x, i) => <option value={i()}>{x.name.replace("\\\\.\\", "")} {x.primary ? "(primary)" : ""}</option>}</For>
              </select>
            </Show>
          </div>}>
          <div class="monitor" style={{ width: "100%", "aspect-ratio": `${ratio()}`, "max-height": "300px" }}>
            <For each={active()?.zones ?? []}>
              {(z, i) => (
                <button class={`zone ${selZone() === i() ? "on" : ""}`} style={{ left: `calc(${z.x * 100}% + 4px)`, top: `calc(${z.y * 100}% + 4px)`, width: `calc(${z.w * 100}% - 8px)`, height: `calc(${z.h * 100}% - 8px)` }}
                  onClick={() => setSelZone(selZone() === i() ? null : i())}>
                  <div style={{ "text-align": "center" }}>
                    <div style={{ "font-size": "20px", "font-weight": 300 }}>{i() + 1}</div>
                    <div class="small">{Math.round(z.w * 100)}% × {Math.round(z.h * 100)}%</div>
                    <Show when={assign()[i()] != null}><div class="small ellipsis" style={{ "max-width": "160px", color: "var(--ac)" }}>{(wins.data() ?? []).find((w) => w.hwnd === assign()[i()])?.title}</div></Show>
                  </div>
                </button>
              )}
            </For>
          </div>
          <div class="row wrap" style={{ "margin-top": "12px" }}>
            <span class="small muted">Snap the focused window with <span class="kbd">Ctrl</span>+<span class="kbd">Alt</span>+<span class="kbd">1–9</span> · move between zones with <span class="kbd">Ctrl</span>+<span class="kbd">Alt</span>+<span class="kbd">←</span>/<span class="kbd">→</span></span>
            <span class="grow" />
            <button class="btn sm" onClick={() => split("v")} disabled={selZone() == null}>Split left/right</button>
            <button class="btn sm" onClick={() => split("h")} disabled={selZone() == null}>Split top/bottom</button>
            <button class="btn sm" onClick={merge} disabled={selZone() == null}>Merge</button>
            <Show when={editing()}><button class="btn sm primary" onClick={saveCustom}>Save layout</button><button class="btn sm ghost" onClick={() => setEditing(null)}>Discard</button></Show>
          </div>
          <Show when={selZone() != null && active()?.zones[selZone()!]}>
            {(() => {
              const z = () => active()!.zones[selZone()!];
              const field = (k: keyof Zone, label: string) => (
                <label class="row small">{label}
                  <input class="input tn" type="number" step="0.5" min="0" max="100" style={{ width: "80px" }} value={+(z()[k] * 100).toFixed(2)}
                    onChange={(e) => edit((zs) => { zs[selZone()!] = { ...zs[selZone()!], [k]: Math.max(0, Math.min(100, +e.currentTarget.value)) / 100 }; return zs; })} />%
                </label>
              );
              return (
                <div class="inset row wrap" style={{ "margin-top": "10px", gap: "16px" }}>
                  <b>Zone {selZone()! + 1}</b>{field("x", "Left")}{field("y", "Top")}{field("w", "Width")}{field("h", "Height")}
                  <Show when={m()}><span class="small dim tn">≈ {Math.round(z().w * m()!.work.w)}×{Math.round(z().h * m()!.work.h)} px</span></Show>
                </div>
              );
            })()}
          </Show>
        </Card>

        <Card title="Layouts" icon="workspace" sub="Resolution-independent — they adapt to any monitor">
          <div class="grid" style={{ "grid-template-columns": "repeat(auto-fill, minmax(150px, 1fr))", gap: "10px" }}>
            <For each={wm.all()}>
              {(l) => (
                <button class={`layout-tile ${active()?.id === l.id && !editing() ? "on" : ""}`} onClick={() => setActive(l)}
                  onContextMenu={async (e) => { e.preventDefault(); if (l.id.startsWith("custom") && await confirm({ title: `Delete “${l.name}”?`, body: "Workspaces using it will fall back to the default layout.", danger: true, ok: "Delete" })) { const c = wm.cfg()!; wm.save({ ...c, custom: c.custom.filter((x) => x.id !== l.id) }); } }}>
                  <MiniZones zones={l.zones} />
                  <div class="small ellipsis">{l.name}</div>
                </button>
              )}
            </For>
          </div>
          <div class="row" style={{ "margin-top": "14px" }}>
            <span class="small muted">Gap between windows</span>
            <div style={{ width: "200px" }}><Slider value={active()?.gap ?? 8} min={0} max={24} onInput={(v) => { const a = active(); if (a) setEditing({ ...a, gap: v }); }} label="Gap" /></div>
            <span class="small tn">{active()?.gap ?? 8}px</span>
          </div>
        </Card>

        <div class="grid g2" style={{ "align-items": "start" }}>
          <Card title="Arrange windows now" icon="layers" sub="Pick a window for each zone, then apply" actions={<button class="btn sm primary" onClick={applyToWindows}>Apply</button>}>
            <For each={active()?.zones ?? []}>
              {(_, i) => (
                <div class="row" style={{ padding: "4px 0" }}>
                  <span class="badge" style={{ width: "28px", "justify-content": "center" }}>{i() + 1}</span>
                  <select class="input grow" value={assign()[i()] ?? ""} onChange={(e) => setAssign({ ...assign(), [i()]: e.currentTarget.value ? +e.currentTarget.value : (undefined as any) })}>
                    <option value="">— leave empty —</option>
                    <For each={wins.data()}>{(w) => <option value={w.hwnd}>{w.title.slice(0, 70)} · {file(w.exe)}</option>}</For>
                  </select>
                </div>
              )}
            </For>
          </Card>
          <Card title="Never move these apps" icon="shield" sub="Games, launchers, admin tools…">
            <div class="row" style={{ "margin-bottom": "10px" }}>
              <input class="input grow" placeholder="e.g. steam.exe" value={exclusion()} onInput={(e) => setExclusion(e.currentTarget.value)} />
              <button class="btn" onClick={() => { const v = exclusion().trim().toLowerCase(); const c = wm.cfg()!; if (v && !c.exclusions.includes(v)) wm.save({ ...c, exclusions: [...c.exclusions, v] }); setExclusion(""); }}>Add</button>
            </div>
            <div class="row wrap" style={{ gap: "6px" }}>
              <For each={wm.cfg()!.exclusions} fallback={<span class="small dim">Windows shell surfaces are always excluded.</span>}>
                {(x) => <button class="chip" onClick={() => { const c = wm.cfg()!; wm.save({ ...c, exclusions: c.exclusions.filter((e) => e !== x) }); }} title="Remove">{x}<Icon name="close" size={12} /></button>}
              </For>
            </div>
          </Card>
        </div>
      </div>
    </Show>
  );
}

function Workspaces() {
  const wm = useWm();
  const lighting = usePoll<LightingConfig>(() => call("rgb_config"), 0);
  const cooling = usePoll<CoolingConfig>(() => call("cooling_get"), 0);
  const [name, setName] = createSignal("");
  const [open, setOpen] = createSignal<string | null>(null);
  const update = (ws: Workspace) => { const c = wm.cfg()!; wm.save({ ...c, workspaces: c.workspaces.map((w) => (w.id === ws.id ? ws : w)) }); };
  const capture = async () => {
    const n = name().trim() || `Workspace ${(wm.cfg()?.workspaces.length ?? 0) + 1}`;
    const ws = await act(call<Workspace>("ws_capture", { name: n }), (w) => `Saved “${w.name}” with ${w.entries.length} windows`);
    if (ws) { setName(""); wm.load(); setOpen(ws.id); }
  };
  return (
    <Show when={wm.cfg()}>
      <div class="col" style={{ gap: "var(--gap)" }}>
        <Card title="Save the current arrangement" icon="plus" sub="Captures every visible window's position on each monitor, plus the active layout, lighting and cooling">
          <div class="row">
            <input class="input" style={{ width: "320px" }} placeholder="Name, e.g. Coding, Gaming, Study" value={name()} onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && capture()} />
            <button class="btn primary" onClick={capture}>Save workspace</button>
            <button class="btn" onClick={() => act(call<number>("ws_undo"), (n) => `Restored ${n} window(s) to where they were`)}>Undo last restore</button>
          </div>
        </Card>
        <For each={wm.cfg()!.workspaces} fallback={<Card><Empty title="No workspaces yet" icon="layers">Arrange your apps how you like them, then save. Restoring moves running windows back and can launch missing apps.</Empty></Card>}>
          {(ws) => (
            <Card title={ws.name} icon="layers" sub={`${ws.entries.length} windows${wm.cfg()!.active_workspace === ws.id ? " · active" : ""}`} actions={
              <div class="row">
                <button class="btn sm primary" onClick={() => act(call<any>("ws_activate", { id: ws.id }), (r: any) => `Moved ${r.moved}, launched ${r.launched}${r.failed.length ? ` · ${r.failed.join("; ")}` : ""}`).then(() => wm.load())}><Icon name="play" size={13} />Restore</button>
                <button class="btn sm" onClick={() => setOpen(open() === ws.id ? null : ws.id)}>{open() === ws.id ? "Done" : "Edit"}</button>
                <button class="btn sm ghost danger icon" aria-label="Delete" onClick={async () => { if (await confirm({ title: `Delete “${ws.name}”?`, body: "Only the saved arrangement is deleted. No apps are closed.", danger: true, ok: "Delete" })) { const c = wm.cfg()!; wm.save({ ...c, workspaces: c.workspaces.filter((w) => w.id !== ws.id) }); } }}><Icon name="trash" size={14} /></button>
              </div>
            }>
              <div class="row wrap" style={{ gap: "6px" }}>
                <For each={ws.entries}>{(e) => <span class="chip" style={{ cursor: "default" }}><i class="dot" style={{ background: e.launch ? "var(--ok)" : "var(--t3)" }} />{file(e.exe)}</span>}</For>
              </div>
              <Show when={open() === ws.id}>
                <div class="divider" />
                <div class="grid g3" style={{ "margin-bottom": "12px" }}>
                  <label class="col small">Layout<select class="input" value={ws.layout ?? ""} onChange={(e) => update({ ...ws, layout: e.currentTarget.value || null })}><option value="">Keep current</option><For each={wm.all()}>{(l) => <option value={l.id}>{l.name}</option>}</For></select></label>
                  <label class="col small">Lighting<select class="input" value={ws.lighting ?? ""} onChange={(e) => update({ ...ws, lighting: e.currentTarget.value || null })}><option value="">Keep current</option><For each={lighting.data()?.presets ?? []}>{(p) => <option value={p.id}>{p.name}</option>}</For></select></label>
                  <label class="col small">Cooling<select class="input" value={ws.cooling ?? ""} onChange={(e) => update({ ...ws, cooling: e.currentTarget.value || null })}><option value="">Keep current</option><For each={cooling.data()?.profiles ?? []}>{(p) => <option value={p.id}>{p.name}</option>}</For></select></label>
                </div>
                <table class="t">
                  <thead><tr><th>App</th><th>Window</th><th>Position</th><th>Launch if missing</th><th></th></tr></thead>
                  <tbody>
                    <For each={ws.entries}>
                      {(e, i) => (
                        <tr>
                          <td>{file(e.exe)}</td>
                          <td class="dim ellipsis">{e.title_hint}</td>
                          <td class="dim tn small">{Math.round(e.frac.x * 100)}%, {Math.round(e.frac.y * 100)}% · {Math.round(e.frac.w * 100)}×{Math.round(e.frac.h * 100)}%</td>
                          <td><Toggle value={e.launch} onChange={(v) => update({ ...ws, entries: ws.entries.map((x, j) => (j === i() ? { ...x, launch: v } : x)) })} label="Launch if missing" /></td>
                          <td><button class="btn sm ghost icon" aria-label="Remove" onClick={() => update({ ...ws, entries: ws.entries.filter((_, j) => j !== i()) })}><Icon name="close" size={13} /></button></td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
                <p class="small dim" style={{ "margin-top": "8px" }}>Link a workspace to a task in Flow → Tasks and it restores automatically when you start focusing on that task.</p>
              </Show>
            </Card>
          )}
        </For>
      </div>
    </Show>
  );
}

function DockSettings() {
  const wins = usePoll<Win[]>(() => call("windows_list"), 5000, []);
  const exes = createMemo(() => [...new Set((wins.data() ?? []).map((w) => w.exe).filter(Boolean))]);
  return (
    <div class="grid g2" style={{ "align-items": "start" }}>
      <Card title="Floating dock" icon="monitor" sub="A glass dock that sits above the Windows taskbar — the taskbar itself is never touched">
        <Row label="Show the dock" hint="Pinned apps, running windows, focus timer and clock"><Toggle value={prefs().dock} onChange={(v) => savePrefs({ dock: v })} /></Row>
        <Row label="Hide during gaming mode"><Toggle value={prefs().dock_autohide} onChange={(v) => savePrefs({ dock_autohide: v })} /></Row>
        <p class="small dim" style={{ "margin-top": "10px" }}>The Windows taskbar always stays available. Turn the dock off any time; nothing in Explorer is modified.</p>
      </Card>
      <Card title="Pinned apps" icon="pin">
        <div class="col" style={{ gap: "6px" }}>
          <For each={prefs().dock_pins} fallback={<div class="small dim">Nothing pinned yet.</div>}>
            {(p) => <div class="row"><span class="grow ellipsis">{file(p)}</span><button class="btn sm ghost" onClick={() => savePrefs({ dock_pins: prefs().dock_pins.filter((x) => x !== p) })}>Unpin</button></div>}
          </For>
        </div>
        <div class="divider" />
        <div class="lbl" style={{ "margin-bottom": "6px" }}>Pin a running app</div>
        <div class="row wrap" style={{ gap: "6px" }}>
          <For each={exes().filter((e) => !prefs().dock_pins.includes(e))}>{(e) => <button class="chip" onClick={() => savePrefs({ dock_pins: [...prefs().dock_pins, e] })}><Icon name="plus" size={12} />{file(e)}</button>}</For>
        </div>
      </Card>
    </div>
  );
}
