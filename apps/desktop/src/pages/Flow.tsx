import { createMemo, createSignal, For, Show, Switch, Match, onCleanup, onMount } from "solid-js";
import { save } from "@tauri-apps/plugin-dialog";
import { call, on, type Task, type Focus, type RulesConfig, type Rule, type Clip, type AuditRow, type LightingConfig, type CoolingConfig } from "../lib/api";
import { tabOf, setTab, act, confirm, toast, prefs, savePrefs } from "../lib/store";
import { clock, dateStr, ago, duration } from "../lib/format";
import { Card, Tabs, Icon, Seg, Toggle, usePoll, Empty, Drawer, Modal, Row } from "../components/ui";

export default function Flow() {
  const tab = () => tabOf("flow", "tasks");
  return (
    <div class="page">
      <Tabs value={tab()} onChange={(t) => setTab("flow", t)} tabs={[
        { id: "tasks", label: "Tasks & focus", icon: "task" },
        { id: "automations", label: "Automations", icon: "zap" },
        { id: "tools", label: "Clipboard & tools", icon: "clip" },
      ]} />
      <Switch>
        <Match when={tab() === "tasks"}><Tasks /></Match>
        <Match when={tab() === "automations"}><Automations /></Match>
        <Match when={tab() === "tools"}><Tools /></Match>
      </Switch>
    </div>
  );
}

// ============================ tasks ============================

type View = "today" | "upcoming" | "backlog" | "overdue" | "done" | "board";

function Tasks() {
  const tasks = usePoll<Task[]>(() => call("tasks_list", { archived: false }), 0, []);
  const focus = usePoll<Focus | null>(() => call("focus_current"), 5000);
  const stats = usePoll<[string, number, number][]>(() => call("focus_stats", { days: 14 }), 30000, []);
  const wm = usePoll<any>(() => call("wm_config"), 0);
  const [view, setView] = createSignal<View>("today");
  const [title, setTitle] = createSignal("");
  const [pri, setPri] = createSignal(2);
  const [due, setDue] = createSignal("");
  const [edit, setEdit] = createSignal<Task | null>(null);
  const [now, setNow] = createSignal(Date.now() / 1000);
  const [pomo, setPomo] = createSignal<number | null>(null); // pomodoro length in minutes
  const t = setInterval(() => setNow(Date.now() / 1000), 1000);
  onCleanup(() => clearInterval(t));
  on("tasks", () => tasks.refresh());
  on("focus", () => focus.refresh());

  const eod = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime() / 1000; };
  const sod = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; };
  const list = createMemo(() => {
    const all = tasks.data() ?? [];
    switch (view()) {
      case "today": return all.filter((x) => x.status !== "done" && (x.status === "active" || (x.due != null && x.due <= eod())));
      case "upcoming": return all.filter((x) => x.status !== "done" && x.due != null && x.due > eod());
      case "backlog": return all.filter((x) => x.status !== "done" && x.due == null);
      case "overdue": return all.filter((x) => x.status !== "done" && x.due != null && x.due < sod());
      case "done": return all.filter((x) => x.status === "done");
      default: return all;
    }
  });
  const count = (v: View) => { const cur = view(); setView(v); const n = list().length; setView(cur); return n; };
  const add = async () => {
    if (!title().trim()) return;
    const d = due() ? new Date(due() + "T17:00").getTime() / 1000 : view() === "today" ? Math.floor(eod() - 3600 * 6) : null;
    await act(call("task_create", { task: { title: title(), priority: pri(), due: d } }));
    setTitle(""); setDue(""); tasks.refresh();
  };
  const setStatus = async (x: Task, status: string) => { await act(call("task_status", { id: x.id, status }), status === "done" ? "Done — nice work" : undefined); tasks.refresh(); focus.refresh(); };
  const startFocus = async (id: number | null, minutes: number | null = null) => { setPomo(minutes); await act(call("focus_start", { taskId: id })); focus.refresh(); tasks.refresh(); };
  const elapsed = () => (focus.data() ? now() - focus.data()!.start : 0);
  const remaining = () => (pomo() ? pomo()! * 60 - elapsed() : null);
  // Pomodoro auto-stop
  let notified = false;
  const tick = setInterval(async () => {
    const r = remaining();
    if (r != null && r <= 0 && focus.data() && !notified) { notified = true; await call("focus_stop"); focus.refresh(); toast("Pomodoro finished — take a 5 minute break", "ok"); setPomo(null); }
    if (r == null || r > 0) notified = false;
  }, 1000);
  onCleanup(() => clearInterval(tick));
  const maxStat = () => Math.max(30, ...(stats.data() ?? []).map((s) => s[1]));

  const TaskRow = (p: { x: Task }) => (
    <div class="list-row" style={{ padding: "9px 10px" }}>
      <button class={`task-check ${p.x.status === "done" ? "on" : ""}`} aria-label={p.x.status === "done" ? "Mark not done" : "Complete"} onClick={() => setStatus(p.x, p.x.status === "done" ? "todo" : "done")}>
        <Show when={p.x.status === "done"}><Icon name="check" size={13} stroke={2.5} /></Show>
      </button>
      <div class="grow" style={{ "min-width": 0, cursor: "pointer" }} onClick={() => setEdit(p.x)}>
        <div class="ellipsis" style={{ "text-decoration": p.x.status === "done" ? "line-through" : undefined, color: p.x.status === "done" ? "var(--t3)" : undefined }}>{p.x.title}</div>
        <div class="row small dim" style={{ gap: "8px" }}>
          <span class={`pri-${p.x.priority}`}>{["Low", "Normal", "High", "Urgent"][p.x.priority]}</span>
          <Show when={p.x.due}><span style={{ color: p.x.due! < sod() && p.x.status !== "done" ? "var(--bad)" : undefined }}>Due {dateStr(p.x.due)}</span></Show>
          <Show when={p.x.project}><span>#{p.x.project}</span></Show>
          <Show when={p.x.checklist.length}><span>{p.x.checklist.filter((c) => c.done).length}/{p.x.checklist.length}</span></Show>
          <Show when={p.x.focused_s > 0}><span>{duration(p.x.focused_s)} focused{p.x.estimate_min ? ` / ${p.x.estimate_min}m est.` : ""}</span></Show>
          <Show when={p.x.recur}><span>↻ {p.x.recur}</span></Show>
          <Show when={p.x.workspace}><span>⧉ workspace</span></Show>
        </div>
      </div>
      <Show when={p.x.status !== "done"}>
        <button class="btn sm ghost icon" title="Start focus" aria-label="Start focus" onClick={() => startFocus(p.x.id)}><Icon name="play" size={13} /></button>
        <button class="btn sm ghost" title="Postpone a day" onClick={() => call("task_postpone", { id: p.x.id, days: 1 }).then(() => tasks.refresh())}>+1d</button>
      </Show>
    </div>
  );

  return (
    <div class="grid" style={{ "grid-template-columns": "minmax(0, 1fr) 330px", "align-items": "start" }}>
      <div class="col" style={{ gap: "var(--gap)" }}>
        <Card class="tight">
          <div class="row">
            <input id="new-task" class="input grow" placeholder="Add a task — press Enter" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
            <select class="input" value={pri()} onChange={(e) => setPri(+e.currentTarget.value)} aria-label="Priority"><option value="0">Low</option><option value="1">Normal</option><option value="2">High</option><option value="3">Urgent</option></select>
            <input class="input" type="date" value={due()} onInput={(e) => setDue(e.currentTarget.value)} aria-label="Due date" />
            <button class="btn primary" onClick={add}><Icon name="plus" size={15} />Add</button>
          </div>
        </Card>
        <div class="row wrap">
          <Seg value={view()} onChange={setView} options={[
            { v: "today", label: `Today ${count("today") || ""}` }, { v: "upcoming", label: "Upcoming" }, { v: "backlog", label: "Backlog" },
            { v: "overdue", label: `Overdue ${count("overdue") || ""}` }, { v: "done", label: "Completed" }, { v: "board", label: "Board" },
          ]} />
        </div>
        <Show when={view() !== "board"} fallback={
          <div class="grid g3" style={{ "align-items": "start" }}>
            <For each={[["todo", "To do"], ["active", "In progress"], ["done", "Done"]] as const}>
              {([st, label]) => (
                <Card title={label} class="tight" sub={`${(tasks.data() ?? []).filter((x) => x.status === st).length}`}>
                  <div class="col" style={{ gap: "6px", "min-height": "80px" }}
                    onDragOver={(e) => e.preventDefault()} onDrop={(e) => { const id = +(e.dataTransfer?.getData("text") ?? 0); const x = (tasks.data() ?? []).find((t) => t.id === id); if (x) setStatus(x, st); }}>
                    <For each={(tasks.data() ?? []).filter((x) => x.status === st).slice(0, 40)}>
                      {(x) => <div class="inset small" draggable="true" style={{ cursor: "grab" }} onDragStart={(e) => e.dataTransfer?.setData("text", String(x.id))} onClick={() => setEdit(x)}><span class={`pri-${x.priority}`}>●</span> {x.title}</div>}
                    </For>
                  </div>
                </Card>
              )}
            </For>
          </div>
        }>
          <Card class="tight">
            <For each={list()} fallback={<Empty title={view() === "today" ? "Nothing for today" : "Nothing here"} icon="task">{view() === "today" ? "Add a task above, or pull something from the backlog." : ""}</Empty>}>
              {(x) => <TaskRow x={x} />}
            </For>
          </Card>
        </Show>
      </div>

      <div class="col" style={{ gap: "var(--gap)" }}>
        <Card title="Focus" icon="play">
          <Show when={focus.data()} fallback={
            <div class="col">
              <div class="huge tn dim">0:00</div>
              <div class="row wrap">
                <button class="btn primary" onClick={() => startFocus(null)}><Icon name="play" size={14} />Open session</button>
                <button class="btn" onClick={() => startFocus(null, 25)}>Pomodoro 25</button>
                <button class="btn" onClick={() => startFocus(null, 50)}>50</button>
              </div>
            </div>
          }>
            <div class="col">
              <div class="huge tn">{remaining() != null ? clock(Math.max(0, remaining()!)) : clock(elapsed())}</div>
              <div class="small muted ellipsis">{(tasks.data() ?? []).find((x) => x.id === focus.data()!.task_id)?.title ?? "Unlinked session"}{pomo() ? ` · ${pomo()} min pomodoro` : ""}</div>
              <div class="small dim">{focus.data()!.interruptions} interruption(s)</div>
              <div class="row">
                <button class="btn" onClick={() => call("focus_interrupt").then(() => focus.refresh())}>Interrupted</button>
                <button class="btn" onClick={async () => { const r = await act(call<Focus>("focus_stop")); setPomo(null); focus.refresh(); tasks.refresh(); if (r) toast(`Logged ${duration(r.elapsed_s)} of focus`, "ok"); }}><Icon name="stop" size={13} />Stop</button>
              </div>
            </div>
          </Show>
        </Card>
        <Card title="Last 14 days" icon="activity" sub={`${(stats.data() ?? []).reduce((a, s) => a + s[1], 0)} min focused`}>
          <div class="row" style={{ "align-items": "flex-end", height: "90px", gap: "4px" }}>
            <For each={stats.data()} fallback={<div class="small dim">Focus sessions will appear here.</div>}>
              {(s) => <div title={`${s[0]}: ${s[1]} min, ${s[2]} session(s)`} style={{ flex: 1, height: `${Math.max(4, (s[1] / maxStat()) * 90)}px`, background: "var(--ac)", "border-radius": "4px 4px 2px 2px", opacity: 0.85 }} />}
            </For>
          </div>
        </Card>
      </div>

      <Show when={edit()}>{(x) => <TaskEditor task={x()} workspaces={wm.data()?.config.workspaces ?? []} onClose={() => { setEdit(null); tasks.refresh(); }} />}</Show>
    </div>
  );
}

function TaskEditor(props: { task: Task; workspaces: any[]; onClose: () => void }) {
  const [t, setT] = createSignal({ ...props.task });
  const [item, setItem] = createSignal("");
  const persist = async () => {
    const x = t();
    await act(call("task_update", { id: x.id, task: { title: x.title, notes: x.notes, project: x.project, priority: x.priority, due: x.due, estimate_min: x.estimate_min, workspace: x.workspace, checklist: x.checklist, recur: x.recur } }));
  };
  const close = async () => { await persist(); props.onClose(); };
  return (
    <Drawer title="Task" onClose={close} actions={
      <>
        <button class="btn sm ghost" onClick={async () => { await call("task_archive", { id: t().id, archived: true }); props.onClose(); }}>Archive</button>
        <button class="btn sm ghost danger icon" aria-label="Delete task" onClick={async () => { if (await confirm({ title: "Delete this task?", body: "Its focus history is deleted too. Archive instead to keep it.", danger: true, ok: "Delete" })) { await call("task_delete", { id: t().id }); props.onClose(); } }}><Icon name="trash" size={14} /></button>
      </>
    }>
      <div class="col">
        <input class="input" style={{ "font-size": "16px", height: "40px" }} value={t().title} onInput={(e) => setT({ ...t(), title: e.currentTarget.value })} aria-label="Title" />
        <div class="grid g2">
          <label class="col small">Priority<select class="input" value={t().priority} onChange={(e) => setT({ ...t(), priority: +e.currentTarget.value })}><option value="0">Low</option><option value="1">Normal</option><option value="2">High</option><option value="3">Urgent</option></select></label>
          <label class="col small">Due<input class="input" type="date" value={t().due ? new Date(t().due! * 1000).toISOString().slice(0, 10) : ""} onInput={(e) => setT({ ...t(), due: e.currentTarget.value ? new Date(e.currentTarget.value + "T17:00").getTime() / 1000 : null })} /></label>
          <label class="col small">Project<input class="input" value={t().project} onInput={(e) => setT({ ...t(), project: e.currentTarget.value })} /></label>
          <label class="col small">Estimate (min)<input class="input" type="number" min="0" value={t().estimate_min ?? ""} onInput={(e) => setT({ ...t(), estimate_min: e.currentTarget.value ? +e.currentTarget.value : null })} /></label>
          <label class="col small">Repeats<select class="input" value={t().recur ?? ""} onChange={(e) => setT({ ...t(), recur: e.currentTarget.value || null })}><option value="">Never</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
          <label class="col small">Workspace on focus<select class="input" value={t().workspace ?? ""} onChange={(e) => setT({ ...t(), workspace: e.currentTarget.value || null })}><option value="">None</option><For each={props.workspaces}>{(w) => <option value={w.id}>{w.name}</option>}</For></select></label>
        </div>
        <label class="col small">Notes<textarea class="input" rows="5" value={t().notes} onInput={(e) => setT({ ...t(), notes: e.currentTarget.value })} /></label>
        <div class="lbl">Checklist</div>
        <For each={t().checklist}>
          {(c, i) => (
            <div class="row">
              <button class={`task-check ${c.done ? "on" : ""}`} aria-label="Toggle item" onClick={() => setT({ ...t(), checklist: t().checklist.map((x, j) => (j === i() ? { ...x, done: !x.done } : x)) })}><Show when={c.done}><Icon name="check" size={12} stroke={2.5} /></Show></button>
              <span class="grow" style={{ "text-decoration": c.done ? "line-through" : undefined }}>{c.text}</span>
              <button class="btn sm ghost icon" aria-label="Remove item" onClick={() => setT({ ...t(), checklist: t().checklist.filter((_, j) => j !== i()) })}><Icon name="close" size={12} /></button>
            </div>
          )}
        </For>
        <div class="row"><input class="input grow" placeholder="Add checklist item" value={item()} onInput={(e) => setItem(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter" && item().trim()) { setT({ ...t(), checklist: [...t().checklist, { text: item().trim(), done: false }] }); setItem(""); } }} /></div>
        <div class="small dim">Created {ago(t().created)} · {duration(t().focused_s)} focused</div>
        <button class="btn primary" onClick={close}>Save</button>
      </div>
    </Drawer>
  );
}

// ============================ automations ============================

const TRIGGERS: { type: string; label: string; fields: [string, string, string][] }[] = [
  { type: "process_started", label: "An app starts", fields: [["name", "App (e.g. code.exe)", "text"]] },
  { type: "process_exited", label: "An app closes", fields: [["name", "App", "text"]] },
  { type: "foreground_app", label: "An app comes to the front", fields: [["name", "App", "text"]] },
  { type: "cpu_temp_above", label: "CPU temperature is high", fields: [["celsius", "Above °C", "number"], ["seconds", "For seconds", "number"]] },
  { type: "cpu_load_above", label: "CPU load is high", fields: [["percent", "Above %", "number"], ["seconds", "For seconds", "number"]] },
  { type: "gpu_load_above", label: "GPU load is high", fields: [["percent", "Above %", "number"], ["seconds", "For seconds", "number"]] },
  { type: "time", label: "At a time of day", fields: [["at", "Time", "time"]] },
  { type: "idle", label: "I've been away", fields: [["minutes", "Minutes idle", "number"]] },
  { type: "task_started", label: "A focus session starts", fields: [] },
  { type: "task_completed", label: "A task is completed", fields: [] },
  { type: "new_listening_port", label: "A new listening port opens", fields: [] },
  { type: "startup", label: "GlassCore starts", fields: [] },
];
const ACTIONS: { type: string; label: string; field?: [string, string, string] }[] = [
  { type: "set_lighting", label: "Switch lighting preset", field: ["preset", "Preset", "lighting"] },
  { type: "flash_lighting", label: "Flash the lights", field: ["color", "Colour", "color"] },
  { type: "lighting_brightness", label: "Set lighting brightness", field: ["percent", "Brightness %", "number"] },
  { type: "set_cooling", label: "Apply cooling profile", field: ["profile", "Profile", "cooling"] },
  { type: "activate_workspace", label: "Restore a workspace", field: ["id", "Workspace", "workspace"] },
  { type: "notify", label: "Show a notification", field: ["title", "Message", "text"] },
  { type: "set_volume", label: "Set volume", field: ["percent", "Volume %", "number"] },
  { type: "mute", label: "Mute / unmute", field: ["muted", "Mute", "bool"] },
  { type: "gaming_mode", label: "Gaming mode", field: ["on", "On", "bool"] },
  { type: "start_focus", label: "Start a focus session" },
  { type: "stop_focus", label: "Stop the focus session" },
];

function Automations() {
  const rules = usePoll<{ config: RulesConfig; stats: Record<string, any>; explain: Record<string, string> }>(() => call("rules_get"), 5000);
  const audit = usePoll<AuditRow[]>(() => call("audit_log", { limit: 60 }), 5000, []);
  const [editing, setEditing] = createSignal<Rule | null>(null);
  const cfg = () => rules.data()?.config;
  const saveCfg = async (c: RulesConfig) => { await act(call("rules_set", { config: c })); rules.refresh(); };
  const blank = (): Rule => ({ id: `rule-${Date.now()}`, name: "New rule", enabled: true, trigger: { type: "process_started", name: "" }, conditions: [], actions: [{ type: "notify", title: "Hello", body: "" }], cooldown_s: 30, max_per_min: 3, dry_run: false });
  return (
    <div class="col" style={{ gap: "var(--gap)" }}>
      <Card class="tight">
        <div class="row">
          <Icon name="zap" />
          <div class="grow"><b>Automations {cfg()?.enabled ? "are on" : "are paused"}</b><div class="small dim">Rules never run hidden: every firing is logged below. Each rule has a cooldown and a per-minute cap so it can't loop.</div></div>
          <span class="small muted">Kill switch</span>
          <Toggle value={cfg()?.enabled ?? false} onChange={(v) => cfg() && saveCfg({ ...cfg()!, enabled: v })} label="All automations" />
          <button class="btn primary" onClick={() => setEditing(blank())}><Icon name="plus" size={14} />New rule</button>
        </div>
      </Card>
      <div class="grid g2" style={{ "align-items": "start" }}>
        <For each={cfg()?.rules ?? []} fallback={<Card><Empty title="No rules yet" icon="zap" /></Card>}>
          {(r) => {
            const s = () => rules.data()?.stats[r.id];
            return (
              <Card class="tight">
                <div class="row">
                  <Toggle value={r.enabled} onChange={(v) => saveCfg({ ...cfg()!, rules: cfg()!.rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)) })} label={r.name} />
                  <b class="grow ellipsis">{r.name}</b>
                  <Show when={r.dry_run}><span class="badge warn">dry run</span></Show>
                  <button class="btn sm" onClick={() => setEditing(JSON.parse(JSON.stringify(r)))}>Edit</button>
                </div>
                <p class="small muted" style={{ margin: "8px 0" }}>{rules.data()?.explain[r.id]}</p>
                <div class="row small dim" style={{ gap: "12px" }}>
                  <span>Fired {s()?.fired ?? 0}×</span><Show when={s()?.failed}><span style={{ color: "var(--bad)" }}>{s().failed} failed</span></Show>
                  <Show when={s()?.last}><span>last {ago(s().last)}</span></Show><span>cooldown {r.cooldown_s}s</span>
                </div>
              </Card>
            );
          }}
        </For>
      </div>
      <Card title="Activity log" icon="note" sub="Rules, privileged actions and hardware changes">
        <div class="table-wrap" style={{ "max-height": "320px" }}>
          <table class="t">
            <thead><tr><th>When</th><th>By</th><th>Action</th><th>Target</th><th>Result</th></tr></thead>
            <tbody><For each={audit.data()}>{(a) => <tr><td class="dim tn">{new Date(a.ts * 1000).toLocaleString()}</td><td><span class="badge">{a.actor}</span></td><td>{a.action}</td><td class="dim">{a.target}</td><td class="dim">{a.result}</td></tr>}</For></tbody>
          </table>
        </div>
      </Card>
      <Show when={editing()}>{(r) => <RuleEditor rule={r()} onClose={() => setEditing(null)} onSave={async (nr) => {
        const c = cfg()!;
        const exists = c.rules.some((x) => x.id === nr.id);
        await saveCfg({ ...c, rules: exists ? c.rules.map((x) => (x.id === nr.id ? nr : x)) : [...c.rules, nr] });
        setEditing(null);
      }} onDelete={async () => { const c = cfg()!; await saveCfg({ ...c, rules: c.rules.filter((x) => x.id !== r().id) }); setEditing(null); }} />}</Show>
    </div>
  );
}

function RuleEditor(props: { rule: Rule; onClose: () => void; onSave: (r: Rule) => void; onDelete: () => void }) {
  const [r, setR] = createSignal<Rule>(props.rule);
  const [explain, setExplain] = createSignal("");
  const [testOut, setTestOut] = createSignal<string[]>([]);
  const lighting = usePoll<LightingConfig>(() => call("rgb_config"), 0);
  const cooling = usePoll<CoolingConfig>(() => call("cooling_get"), 0);
  const wm = usePoll<any>(() => call("wm_config"), 0);
  const refresh = async () => { try { setExplain(await call<string>("rule_explain", { rule: r() })); } catch (e) { setExplain(String(e)); } };
  onMount(refresh);
  const upd = (p: Partial<Rule>) => { setR({ ...r(), ...p }); refresh(); };
  const trig = () => TRIGGERS.find((t) => t.type === r().trigger.type) ?? TRIGGERS[0];
  const setTrig = (type: string) => {
    const defs: Record<string, any> = { celsius: 80, seconds: 30, percent: 90, at: "22:00", minutes: 10, name: "", days: [] };
    const t = TRIGGERS.find((x) => x.type === type)!;
    const obj: any = { type };
    t.fields.forEach(([k]) => (obj[k] = defs[k]));
    if (type === "time") obj.days = [];
    upd({ trigger: obj });
  };
  const fieldInput = (obj: any, key: string, kind: string, set: (v: any) => void) => {
    if (kind === "number") return <input class="input tn" type="number" value={obj[key]} onInput={(e) => set(+e.currentTarget.value)} style={{ width: "110px" }} />;
    if (kind === "time") return <input class="input" type="time" value={obj[key]} onInput={(e) => set(e.currentTarget.value)} />;
    if (kind === "color") return <input type="color" value={obj[key] ?? "#3DDC84"} onInput={(e) => set(e.currentTarget.value.toUpperCase())} style={{ width: "44px", height: "32px", border: 0, background: "transparent" }} />;
    if (kind === "bool") return <Toggle value={!!obj[key]} onChange={set} />;
    if (kind === "lighting") return <select class="input" value={obj[key]} onChange={(e) => set(e.currentTarget.value)}><For each={lighting.data()?.presets ?? []}>{(p) => <option value={p.id}>{p.name}</option>}</For></select>;
    if (kind === "cooling") return <select class="input" value={obj[key]} onChange={(e) => set(e.currentTarget.value)}><For each={cooling.data()?.profiles ?? []}>{(p) => <option value={p.id}>{p.name}</option>}</For></select>;
    if (kind === "workspace") return <select class="input" value={obj[key]} onChange={(e) => set(e.currentTarget.value)}><option value="">Choose…</option><For each={wm.data()?.config.workspaces ?? []}>{(w: any) => <option value={w.id}>{w.name}</option>}</For></select>;
    return <input class="input grow" value={obj[key] ?? ""} onInput={(e) => set(e.currentTarget.value)} />;
  };
  return (
    <Modal onClose={props.onClose} wide label="Edit rule">
      <div class="row" style={{ "margin-bottom": "12px" }}>
        <input class="input grow" style={{ "font-size": "16px", height: "40px" }} value={r().name} onInput={(e) => upd({ name: e.currentTarget.value })} aria-label="Rule name" />
      </div>
      <div class="inset small" style={{ "margin-bottom": "14px" }}><b>Preview:</b> {explain()}</div>
      <div class="grid g2" style={{ gap: "18px" }}>
        <div class="col">
          <div class="lbl">When</div>
          <select class="input" value={r().trigger.type} onChange={(e) => setTrig(e.currentTarget.value)}><For each={TRIGGERS}>{(t) => <option value={t.type}>{t.label}</option>}</For></select>
          <For each={trig().fields}>{([k, label, kind]) => <label class="row small"><span style={{ width: "120px" }}>{label}</span>{fieldInput(r().trigger, k, kind, (v) => upd({ trigger: { ...r().trigger, [k]: v } }))}</label>}</For>
          <Show when={r().trigger.type === "time"}>
            <div class="row wrap" style={{ gap: "4px" }}>
              <For each={["S", "M", "T", "W", "T", "F", "S"]}>{(d, i) => <button class={`chip ${(r().trigger.days ?? []).includes(i()) ? "on" : ""}`} style={{ width: "36px", "justify-content": "center", padding: 0 }} onClick={() => { const days: number[] = r().trigger.days ?? []; upd({ trigger: { ...r().trigger, days: days.includes(i()) ? days.filter((x) => x !== i()) : [...days, i()] } }); }}>{d}</button>}</For>
              <span class="small dim">none = every day</span>
            </div>
          </Show>
          <div class="lbl" style={{ "margin-top": "8px" }}>Only if</div>
          <For each={r().conditions}>
            {(c, i) => (
              <div class="row small">
                <Show when={c.type === "time_between"} fallback={<>{c.type === "process_running" ? "App is running" : "App is not running"}<input class="input grow" value={c.name} onInput={(e) => upd({ conditions: r().conditions.map((x, j) => (j === i() ? { ...x, name: e.currentTarget.value } : x)) })} /></>}>
                  Between <input class="input" type="time" value={c.from} onInput={(e) => upd({ conditions: r().conditions.map((x, j) => (j === i() ? { ...x, from: e.currentTarget.value } : x)) })} /> and <input class="input" type="time" value={c.to} onInput={(e) => upd({ conditions: r().conditions.map((x, j) => (j === i() ? { ...x, to: e.currentTarget.value } : x)) })} />
                </Show>
                <button class="btn sm ghost icon" aria-label="Remove condition" onClick={() => upd({ conditions: r().conditions.filter((_, j) => j !== i()) })}><Icon name="close" size={12} /></button>
              </div>
            )}
          </For>
          <div class="row wrap" style={{ gap: "6px" }}>
            <button class="btn sm" onClick={() => upd({ conditions: [...r().conditions, { type: "time_between", from: "09:00", to: "17:00" }] })}>+ Time window</button>
            <button class="btn sm" onClick={() => upd({ conditions: [...r().conditions, { type: "process_running", name: "" }] })}>+ App running</button>
            <button class="btn sm" onClick={() => upd({ conditions: [...r().conditions, { type: "process_not_running", name: "" }] })}>+ App not running</button>
          </div>
        </div>
        <div class="col">
          <div class="lbl">Then</div>
          <For each={r().actions}>
            {(a, i) => {
              const def = () => ACTIONS.find((x) => x.type === a.type) ?? ACTIONS[0];
              return (
                <div class="inset col" style={{ gap: "8px" }}>
                  <div class="row">
                    <span class="badge">{i() + 1}</span>
                    <select class="input grow" value={a.type} onChange={(e) => { const t = ACTIONS.find((x) => x.type === e.currentTarget.value)!; const obj: any = { type: t.type }; if (t.field) obj[t.field[0]] = t.field[2] === "number" ? 50 : t.field[2] === "bool" ? true : t.field[2] === "color" ? "#3DDC84" : ""; if (t.type === "notify") obj.body = ""; upd({ actions: r().actions.map((x, j) => (j === i() ? obj : x)) }); }}>
                      <For each={ACTIONS}>{(x) => <option value={x.type}>{x.label}</option>}</For>
                    </select>
                    <button class="btn sm ghost icon" aria-label="Remove action" onClick={() => upd({ actions: r().actions.filter((_, j) => j !== i()) })}><Icon name="close" size={12} /></button>
                  </div>
                  <Show when={def().field}>
                    <label class="row small"><span style={{ width: "90px" }}>{def().field![1]}</span>{fieldInput(a, def().field![0], def().field![2], (v) => upd({ actions: r().actions.map((x, j) => (j === i() ? { ...x, [def().field![0]]: v } : x)) }))}</label>
                  </Show>
                </div>
              );
            }}
          </For>
          <button class="btn sm" style={{ "align-self": "flex-start" }} onClick={() => upd({ actions: [...r().actions, { type: "notify", title: "", body: "" }] })}>+ Add action</button>
          <div class="lbl" style={{ "margin-top": "8px" }}>Safety</div>
          <label class="row small"><span style={{ width: "150px" }}>Cooldown (seconds)</span><input class="input tn" type="number" min="1" style={{ width: "90px" }} value={r().cooldown_s} onInput={(e) => upd({ cooldown_s: Math.max(1, +e.currentTarget.value) })} /></label>
          <label class="row small"><span style={{ width: "150px" }}>Max runs per minute</span><input class="input tn" type="number" min="1" max="30" style={{ width: "90px" }} value={r().max_per_min} onInput={(e) => upd({ max_per_min: Math.max(1, +e.currentTarget.value) })} /></label>
          <Row label="Dry run" hint="Log what would happen without doing it"><Toggle value={r().dry_run} onChange={(v) => upd({ dry_run: v })} /></Row>
        </div>
      </div>
      <Show when={testOut().length}><div class="inset small" style={{ "margin-top": "12px" }}><For each={testOut()}>{(l) => <div>{l}</div>}</For></div></Show>
      <div class="row" style={{ "margin-top": "16px" }}>
        <button class="btn danger" onClick={async () => { if (await confirm({ title: "Delete this rule?", body: "It stops running immediately.", danger: true, ok: "Delete" })) props.onDelete(); }}>Delete</button>
        <span class="grow" />
        <button class="btn" onClick={async () => setTestOut((await act(call<string[]>("rule_test", { rule: r(), dry: true }))) ?? [])}>Dry run</button>
        <button class="btn" onClick={async () => setTestOut((await act(call<string[]>("rule_test", { rule: r(), dry: false }))) ?? [])}>Run actions now</button>
        <button class="btn primary" onClick={() => props.onSave(r())}>Save rule</button>
      </div>
    </Modal>
  );
}

// ============================ tools ============================

function Tools() {
  const clips = usePoll<Clip[]>(() => call("clip_list"), 2000, []);
  const [shot, setShot] = createSignal<{ path: string; data: string; w: number; h: number } | null>(null);
  const [snipName, setSnipName] = createSignal("");
  const [snipText, setSnipText] = createSignal("");
  const transform = (text: string, how: string) => {
    switch (how) {
      case "plain": return text.replace(/\s+\n/g, "\n").trim();
      case "code": return "```\n" + text.trim() + "\n```";
      case "json": try { return JSON.stringify(JSON.parse(text), null, 2); } catch { toast("Not valid JSON", "bad"); return null; }
      case "md": return text.split("\n").map((l) => (l.trim() ? `- ${l.trim()}` : l)).join("\n");
      case "file": return text.split(/[\\/]/).pop() ?? text;
      default: return text;
    }
  };
  const copy = async (text: string | null) => { if (text == null) return; await navigator.clipboard.writeText(text); toast("Copied", "ok"); };
  const capture = async (target: string) => { const r = await act(call<any>("screenshot", { target, monitor: 0 })); if (r) setShot(r); };
  return (
    <div class="col" style={{ gap: "var(--gap)" }}>
      <div class="grid g2" style={{ "align-items": "start" }}>
        <Card title="Clipboard history" icon="clip" sub="Off by default · kept in memory only · password-manager copies are skipped"
          actions={<><Toggle value={prefs().clipboard_history} onChange={(v) => savePrefs({ clipboard_history: v })} label="Clipboard history" /><button class="btn sm ghost" onClick={() => call("clip_clear").then(() => clips.refresh())}>Clear</button></>}>
          <Show when={prefs().clipboard_history} fallback={<p class="small muted">Turn on to keep the last 60 text copies. Anything that looks like a password or API key, and anything a password manager marks as private, is never stored.</p>}>
            <div class="col" style={{ gap: "6px", "max-height": "420px", overflow: "auto" }}>
              <For each={clips.data()} fallback={<div class="small dim">Copy some text and it'll show up here.</div>}>
                {(c) => (
                  <div class="inset" style={{ padding: "8px 10px" }}>
                    <div class="small selectable" style={{ "white-space": "pre-wrap", "max-height": "64px", overflow: "hidden" }}>{c.text.slice(0, 400)}</div>
                    <div class="row" style={{ "margin-top": "6px", gap: "4px" }}>
                      <span class="small dim">{ago(c.ts)}</span><span class="grow" />
                      <button class="btn sm" onClick={() => copy(c.text)}>Copy</button>
                      <select class="input" style={{ height: "28px", "font-size": "12px" }} onChange={(e) => { copy(transform(c.text, e.currentTarget.value)); e.currentTarget.value = ""; }} aria-label="Paste as">
                        <option value="">Copy as…</option><option value="plain">Plain text</option><option value="md">Markdown list</option><option value="code">Code block</option><option value="json">Pretty JSON</option><option value="file">File name</option>
                      </select>
                      <button class="btn sm ghost icon" aria-label={c.pinned ? "Unpin" : "Pin"} onClick={() => call("clip_pin", { id: c.id, pinned: !c.pinned }).then(() => clips.refresh())}><Icon name="pin" size={13} style={{ color: c.pinned ? "var(--ac)" : undefined }} /></button>
                      <button class="btn sm ghost icon" aria-label="Delete" onClick={() => call("clip_delete", { id: c.id }).then(() => clips.refresh())}><Icon name="close" size={12} /></button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Card>
        <div class="col" style={{ gap: "var(--gap)" }}>
          <Card title="Screenshot" icon="camera" sub="Saved to Pictures\Screenshots">
            <div class="row wrap">
              <button class="btn" onClick={() => capture("screen")}>All screens</button>
              <button class="btn" onClick={() => capture("monitor")}>Main monitor</button>
              <button class="btn" onClick={() => capture("window")}>Active window</button>
            </div>
          </Card>
          <Card title="Snippets" icon="note" sub="Reusable text — click to copy">
            <div class="col" style={{ gap: "6px" }}>
              <For each={prefs().snippets} fallback={<div class="small dim">No snippets yet.</div>}>
                {([n, t], i) => <div class="row"><button class="chip grow" style={{ "justify-content": "flex-start" }} onClick={() => copy(t)}>{n}</button><button class="btn sm ghost icon" aria-label="Delete snippet" onClick={() => savePrefs({ snippets: prefs().snippets.filter((_, j) => j !== i()) })}><Icon name="close" size={12} /></button></div>}
              </For>
            </div>
            <div class="divider" />
            <div class="col">
              <input class="input" placeholder="Name" value={snipName()} onInput={(e) => setSnipName(e.currentTarget.value)} />
              <textarea class="input" rows="3" placeholder="Text" value={snipText()} onInput={(e) => setSnipText(e.currentTarget.value)} />
              <button class="btn" style={{ "align-self": "flex-start" }} onClick={() => { if (snipName() && snipText()) { savePrefs({ snippets: [...prefs().snippets, [snipName(), snipText()]] }); setSnipName(""); setSnipText(""); } }}>Save snippet</button>
            </div>
          </Card>
          <Card title="Quick note" icon="edit">
            <textarea class="input" rows="6" style={{ width: "100%" }} placeholder="Jot something down…" value={prefs().notes} onChange={(e) => savePrefs({ notes: e.currentTarget.value })} />
          </Card>
        </div>
      </div>
      <Show when={shot()}>{(s) => <Annotate shot={s()} onClose={() => setShot(null)} />}</Show>
    </div>
  );
}

function Annotate(props: { shot: { path: string; data: string; w: number; h: number }; onClose: () => void }) {
  let canvas!: HTMLCanvasElement;
  const [tool, setTool] = createSignal<"pen" | "rect" | "redact">("rect");
  const [color, setColor] = createSignal("#FF3B30");
  const history: ImageData[] = [];
  let img: HTMLImageElement;
  onMount(() => {
    img = new Image();
    img.onload = () => { canvas.width = img.width; canvas.height = img.height; canvas.getContext("2d")!.drawImage(img, 0, 0); };
    img.src = props.shot.data;
  });
  const pos = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height]; };
  let start: number[] | null = null;
  let snap: ImageData | null = null;
  const down = (e: PointerEvent) => {
    const ctx = canvas.getContext("2d")!;
    history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (history.length > 20) history.shift();
    start = pos(e);
    snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
    canvas.setPointerCapture(e.pointerId);
    if (tool() === "pen") { ctx.beginPath(); ctx.moveTo(start[0], start[1]); }
  };
  const move = (e: PointerEvent) => {
    if (!start) return;
    const ctx = canvas.getContext("2d")!;
    const [x, y] = pos(e);
    ctx.strokeStyle = color(); ctx.lineWidth = Math.max(3, canvas.width / 400); ctx.lineCap = "round";
    if (tool() === "pen") { ctx.lineTo(x, y); ctx.stroke(); return; }
    ctx.putImageData(snap!, 0, 0);
    if (tool() === "rect") ctx.strokeRect(start[0], start[1], x - start[0], y - start[1]);
    else { ctx.fillStyle = "#111"; ctx.fillRect(start[0], start[1], x - start[0], y - start[1]); }
  };
  const up = () => { start = null; };
  const undo = () => { const h = history.pop(); if (h) canvas.getContext("2d")!.putImageData(h, 0, 0); };
  const saveAs = async () => {
    const p = await save({ defaultPath: props.shot.path.replace(".png", "-annotated.png"), filters: [{ name: "PNG", extensions: ["png"] }] });
    if (p) await act(call("save_png", { path: p, data: canvas.toDataURL("image/png") }), "Saved");
  };
  return (
    <Modal onClose={props.onClose} wide label="Annotate screenshot">
      <div class="row" style={{ "margin-bottom": "10px" }}>
        <h2 class="grow" style={{ margin: 0 }}>Annotate</h2>
        <Seg value={tool()} onChange={setTool} options={[{ v: "rect", label: "Box" }, { v: "pen", label: "Pen" }, { v: "redact", label: "Redact" }]} />
        <input type="color" value={color()} onInput={(e) => setColor(e.currentTarget.value)} aria-label="Colour" style={{ width: "40px", height: "32px", border: 0, background: "transparent" }} />
        <button class="btn" onClick={undo}>Undo</button>
        <button class="btn" onClick={() => { canvas.toBlob((b) => b && navigator.clipboard.write([new ClipboardItem({ "image/png": b })]).then(() => toast("Copied image", "ok"))); }}>Copy</button>
        <button class="btn primary" onClick={saveAs}>Save as…</button>
      </div>
      <canvas ref={canvas} class="annot" style={{ width: "100%" }} onPointerDown={down} onPointerMove={move} onPointerUp={up} />
      <div class="small dim" style={{ "margin-top": "6px" }}>Original saved at {props.shot.path}. Redact boxes are solid — the hidden content can't be recovered from the saved file.</div>
    </Modal>
  );
}
