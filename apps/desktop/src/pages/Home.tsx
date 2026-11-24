import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { call, type Focus, type HwStatus, type LightingConfig, type CoolingConfig, type Task, type AuditRow } from "../lib/api";
import { history, latest, go, act } from "../lib/store";
import { bytes, rate, pct, temp, greeting, clock, ago, duration } from "../lib/format";
import { Card, Gauge, Icon, Spark, usePoll, Empty } from "../components/ui";

export default function Home() {
  const hw = usePoll<HwStatus>(() => call("hw_status"), 2000);
  const lighting = usePoll<LightingConfig>(() => call("rgb_config"), 5000);
  const cooling = usePoll<CoolingConfig>(() => call("cooling_get"), 5000);
  const focus = usePoll<Focus | null>(() => call("focus_current"), 5000);
  const tasks = usePoll<Task[]>(() => call("tasks_list", { archived: false }), 10000);
  const wm = usePoll<any>(() => call("wm_config"), 15000);
  const audit = usePoll<AuditRow[]>(() => call("audit_log", { limit: 8 }), 8000);
  const [now, setNow] = createSignal(Date.now());
  const t = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(t));

  const h = (k: (s: any) => number | null) => history().slice(-90).map(k);
  const s = () => latest();
  const memPct = () => (s() ? (s()!.mem_used / s()!.mem_total) * 100 : null);
  const today = createMemo(() => {
    const end = new Date(); end.setHours(23, 59, 59, 999);
    return (tasks.data() ?? []).filter((t) => t.status !== "done" && (t.due == null || t.due * 1000 <= end.getTime())).slice(0, 5);
  });
  const activeTask = () => (tasks.data() ?? []).find((t) => t.id === focus.data()?.task_id);

  return (
    <div class="page col" style={{ gap: "var(--gap)" }}>
      <div class="row" style={{ "align-items": "flex-end", "margin-bottom": "4px" }}>
        <div>
          <div class="huge">{greeting()}</div>
          <div class="muted" style={{ "margin-top": "6px" }}>
            {new Date(now()).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} · {new Date(now()).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            <Show when={s()}> · up {duration(s()!.uptime)}</Show>
          </div>
        </div>
        <span class="grow" />
        <button class="btn" onClick={() => act(call("gaming_mode", { on: true }), "Gaming mode on — Ctrl+Alt+G to leave")}><Icon name="gamepad" size={16} />Gaming mode</button>
      </div>

      {/* Live vitals */}
      <div class="grid g4">
        <Card class="tight">
          <div class="row" style={{ gap: "16px" }}>
            <Gauge value={s()?.cpu ?? null} size={92}><div><div class="tn" style={{ "font-size": "20px", "font-weight": 300 }}>{pct(s()?.cpu)}</div><div class="lbl" style={{ "font-size": "10px" }}>CPU</div></div></Gauge>
            <div class="grow col" style={{ gap: "4px" }}>
              <div class="small muted">{temp(hw.data()?.snapshot?.cpuTemp)} · {s() ? `${(s()!.cpu_mhz / 1000).toFixed(2)} GHz` : "—"}</div>
              <Spark data={h((x) => x.cpu)} max={100} height={42} />
            </div>
          </div>
        </Card>
        <Card class="tight">
          <div class="row" style={{ gap: "16px" }}>
            <Gauge value={s()?.gpu ?? null} size={92} color="#9b8cff"><div><div class="tn" style={{ "font-size": "20px", "font-weight": 300 }}>{s()?.gpu == null ? "—" : pct(s()!.gpu!)}</div><div class="lbl" style={{ "font-size": "10px" }}>GPU</div></div></Gauge>
            <div class="grow col" style={{ gap: "4px" }}>
              <div class="small muted">{temp(hw.data()?.snapshot?.gpuTemp)} · {bytes(s()?.gpu_mem_dedicated)} VRAM</div>
              <Spark data={h((x) => x.gpu)} max={100} height={42} color="#9b8cff" />
            </div>
          </div>
        </Card>
        <Card class="tight">
          <div class="row" style={{ gap: "16px" }}>
            <Gauge value={memPct()} size={92} color="#86cfa1"><div><div class="tn" style={{ "font-size": "20px", "font-weight": 300 }}>{pct(memPct())}</div><div class="lbl" style={{ "font-size": "10px" }}>Memory</div></div></Gauge>
            <div class="grow col" style={{ gap: "4px" }}>
              <div class="small muted">{bytes(s()?.mem_used)} of {bytes(s()?.mem_total)}</div>
              <Spark data={h((x) => (x.mem_used / x.mem_total) * 100)} max={100} height={42} color="#86cfa1" />
            </div>
          </div>
        </Card>
        <Card class="tight">
          <div class="col" style={{ gap: "6px" }}>
            <div class="row lbl"><Icon name="net" size={14} />Network<span class="right tn" style={{ "text-transform": "none", "letter-spacing": 0, color: "var(--t2)" }}>↓ {rate(s()?.net_rx)} · ↑ {rate(s()?.net_tx)}</span></div>
            <Spark data={h((x) => x.net_rx)} height={30} color="#8fb8ff" />
            <div class="row lbl" style={{ "margin-top": "4px" }}><Icon name="disk" size={14} />Disk<span class="right tn" style={{ "text-transform": "none", "letter-spacing": 0, color: "var(--t2)" }}>R {rate(s()?.disk_read)} · W {rate(s()?.disk_write)}</span></div>
            <Spark data={h((x) => (x.disk_read ?? 0) + (x.disk_write ?? 0))} height={30} color="#e6ba6c" />
          </div>
        </Card>
      </div>

      <div class="grid g3">
        {/* Focus */}
        <Card title="Focus" icon="task" actions={<button class="btn sm ghost" onClick={() => go("flow", "tasks")}>All tasks</button>}>
          <Show when={focus.data()} fallback={
            <div class="col">
              <div class="muted small">No focus session running.</div>
              <button class="btn primary" onClick={async () => { await act(call("focus_start", { taskId: null }), "Focus started"); focus.refresh(); }}><Icon name="play" size={15} />Start focus</button>
            </div>
          }>
            {(f) => (
              <div class="col">
                <div class="huge tn">{clock(now() / 1000 - f().start)}</div>
                <div class="muted ellipsis">{activeTask()?.title ?? "Unlinked session"}</div>
                <div class="row">
                  <button class="btn" onClick={async () => { await act(call("focus_interrupt"), "Interruption noted"); }}>Interrupted</button>
                  <button class="btn" onClick={async () => { await act(call("focus_stop"), (r: any) => `Logged ${duration(r?.elapsed_s ?? 0)}`); focus.refresh(); }}><Icon name="stop" size={14} />Stop</button>
                </div>
              </div>
            )}
          </Show>
          <div class="divider" />
          <div class="lbl" style={{ "margin-bottom": "6px" }}>Due today</div>
          <For each={today()} fallback={<div class="small dim">Nothing due — nice.</div>}>
            {(t) => (
              <div class="list-row" style={{ padding: "6px 4px" }}>
                <button class="task-check" aria-label={`Complete ${t.title}`} onClick={async () => { await act(call("task_status", { id: t.id, status: "done" }), "Task completed"); tasks.refresh(); }} />
                <span class="grow ellipsis">{t.title}</span>
                <button class="btn sm ghost icon" aria-label="Focus on this" title="Start focus on this task" onClick={async () => { await call("focus_start", { taskId: t.id }); focus.refresh(); }}><Icon name="play" size={13} /></button>
              </div>
            )}
          </For>
        </Card>

        {/* Lighting + cooling quick */}
        <Card title="Rig" icon="studio" actions={<button class="btn sm ghost" onClick={() => go("studio", "lighting")}>Open studio</button>}>
          <div class="lbl" style={{ "margin-bottom": "8px" }}>Lighting</div>
          <div class="row wrap">
            <For each={lighting.data()?.presets ?? []}>
              {(p) => (
                <button class={`chip ${lighting.data()?.active.id === p.id ? "on" : ""}`} onClick={async () => { await act(call("rgb_apply_preset", { id: p.id })); lighting.refresh(); }}>
                  <i class="dot" style={{ background: p.effect === "rainbow" || p.effect === "cycle" ? "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" : p.color }} />{p.name}
                </button>
              )}
            </For>
          </div>
          <div class="lbl" style={{ margin: "16px 0 8px" }}>Cooling</div>
          <div class="row wrap">
            <For each={cooling.data()?.profiles ?? []}>
              {(p) => <button class={`chip ${cooling.data()?.active === p.id ? "on" : ""}`} onClick={async () => { await act(call("cooling_apply", { id: p.id })); cooling.refresh(); }}><Icon name="fan" size={14} />{p.name}</button>}
            </For>
          </div>
          <div class="divider" />
          <Show when={hw.data()?.snapshot?.fans?.length} fallback={<div class="small dim">Fan speeds appear once the hardware helper is running. <a href="#" onClick={(e) => { e.preventDefault(); go("studio", "cooling"); }}>Set up</a></div>}>
            <div class="grid g2" style={{ gap: "8px" }}>
              <For each={hw.data()!.snapshot!.fans.filter((f) => f.rpm).slice(0, 6)}>
                {(f) => <div class="inset" style={{ padding: "8px 10px" }}><div class="small dim ellipsis">{f.name}</div><div class="tn">{f.rpm} <span class="small dim">RPM</span></div></div>}
              </For>
            </div>
          </Show>
        </Card>

        {/* Workspaces + activity */}
        <Card title="Workspaces" icon="workspace" actions={<button class="btn sm ghost" onClick={() => go("workspace", "workspaces")}>Manage</button>}>
          <Show when={wm.data()?.config.workspaces.length} fallback={<Empty title="No workspaces yet" icon="workspace">Arrange your windows, then save them as a workspace to restore everything with one click.</Empty>}>
            <div class="col" style={{ gap: "6px" }}>
              <For each={wm.data()!.config.workspaces}>
                {(w: any) => (
                  <button class="list-row" style={{ border: 0, background: wm.data()?.config.active_workspace === w.id ? "var(--ac-soft)" : "transparent", cursor: "pointer", "text-align": "left" }}
                    onClick={() => act(call<any>("ws_activate", { id: w.id }), (r: any) => `Restored ${r.moved} window(s)${r.failed.length ? `, ${r.failed.length} skipped` : ""}`)}>
                    <Icon name="layers" size={16} />
                    <span class="grow ellipsis">{w.name}</span>
                    <span class="small dim">{w.entries.length} apps</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <div class="divider" />
          <div class="lbl" style={{ "margin-bottom": "6px" }}>Recent activity</div>
          <For each={audit.data() ?? []} fallback={<div class="small dim">Nothing yet.</div>}>
            {(a) => <div class="row small" style={{ padding: "3px 0" }}><span class="badge">{a.actor}</span><span class="grow ellipsis muted">{a.action} {a.target}</span><span class="dim">{ago(a.ts)}</span></div>}
          </For>
        </Card>
      </div>
    </div>
  );
}
