import { createMemo, createSignal, For, Show, Switch, Match } from "solid-js";
import { call, type Proc, type ProcDetails, type Conn, type Adapter, type HwStatus } from "../lib/api";
import { tabOf, setTab, history, latest, act, confirm, toast } from "../lib/store";
import { bytes, rate, pct, file, temp } from "../lib/format";
import { Card, Tabs, Icon, Search, Seg, usePoll, useSort, Drawer, Chart, Bar, Empty, Stat, Spark } from "../components/ui";

export default function Activity() {
  const tab = () => tabOf("activity", "processes");
  return (
    <div class="page">
      <Tabs value={tab()} onChange={(t) => setTab("activity", t)} tabs={[
        { id: "processes", label: "Processes", icon: "cpu" },
        { id: "performance", label: "Performance", icon: "activity" },
        { id: "network", label: "Network & ports", icon: "net" },
      ]} />
      <Switch>
        <Match when={tab() === "processes"}><Processes /></Match>
        <Match when={tab() === "performance"}><Performance /></Match>
        <Match when={tab() === "network"}><Network /></Match>
      </Switch>
    </div>
  );
}

// ============================ processes ============================

function Processes() {
  const procs = usePoll<Proc[]>(() => call("processes"), 1500, []);
  const events = usePoll<any>(() => call("proc_events"), 4000);
  const [q, setQ] = createSignal("");
  const [view, setView] = createSignal<"flat" | "tree" | "grouped">("grouped");
  const [selected, setSelected] = createSignal<Proc | null>(null);
  const sort = useSort<Proc>("cpu");

  const filtered = createMemo(() => {
    const s = q().toLowerCase();
    return (procs.data() ?? []).filter((p) => !s || p.name.toLowerCase().includes(s) || String(p.pid) === s || (p.exe ?? "").toLowerCase().includes(s));
  });

  // Grouped by executable name, summed.
  const grouped = createMemo(() => {
    const m = new Map<string, Proc & { count: number; members: Proc[] }>();
    for (const p of filtered()) {
      const g = m.get(p.name);
      if (!g) m.set(p.name, { ...p, count: 1, members: [p] });
      else { g.count++; g.cpu += p.cpu; g.mem += p.mem; g.read_bps += p.read_bps; g.write_bps += p.write_bps; g.members.push(p); g.new ||= p.new; }
    }
    return sort.sort([...m.values()] as any) as (Proc & { count: number; members: Proc[] })[];
  });

  // Parent/child tree, depth-annotated.
  const tree = createMemo(() => {
    const rows = filtered();
    const byPid = new Map(rows.map((p) => [p.pid, p]));
    const kids = new Map<number, Proc[]>();
    const roots: Proc[] = [];
    for (const p of rows) {
      if (p.ppid != null && byPid.has(p.ppid) && p.ppid !== p.pid) { const k = kids.get(p.ppid) ?? []; k.push(p); kids.set(p.ppid, k); }
      else roots.push(p);
    }
    const out: { p: Proc; depth: number }[] = [];
    const walk = (p: Proc, d: number) => { out.push({ p, depth: d }); for (const c of sort.sort(kids.get(p.pid) ?? [])) if (d < 12) walk(c, d + 1); };
    for (const r of sort.sort(roots)) walk(r, 0);
    return out;
  });

  const totals = () => {
    const s = latest();
    return { cpu: s?.cpu ?? 0, mem: s ? (s.mem_used / s.mem_total) * 100 : 0 };
  };

  const head = (k: keyof Proc, label: string, cls = "") => <th class={`sort ${cls}`} onClick={() => sort.toggle(k)}>{label}{sort.arrow(k)}</th>;

  return (
    <div class="col" style={{ gap: "var(--gap)" }}>
      <div class="row wrap">
        <Search value={q()} onInput={setQ} placeholder="Search name, PID or path" width="300px" />
        <Seg value={view()} onChange={setView} options={[{ v: "grouped", label: "Grouped" }, { v: "tree", label: "Tree" }, { v: "flat", label: "All" }]} />
        <span class="grow" />
        <span class="small muted tn">{(procs.data() ?? []).length} processes · CPU {pct(totals().cpu)} · RAM {pct(totals().mem)}</span>
      </div>
      <div class="grid" style={{ "grid-template-columns": "minmax(0,1fr) 280px", "align-items": "start" }}>
        <Card class="flush">
          <div class="table-wrap" style={{ "max-height": "calc(100vh - 230px)" }}>
            <table class="t">
              <thead><tr>
                {head("name", "Name")}{head("pid", "PID", "num")}{head("cpu", "CPU", "num")}{head("mem", "Memory", "num")}{head("read_bps", "Disk read", "num")}{head("write_bps", "Disk write", "num")}<th>Status</th>
              </tr></thead>
              <tbody>
                <Show when={view() === "grouped"}>
                  <For each={grouped()}>
                    {(g) => (
                      <tr class={`click ${g.new ? "new" : ""} ${selected()?.name === g.name ? "sel" : ""}`} onClick={() => setSelected(g.members.sort((a, b) => b.mem - a.mem)[0])}>
                        <td><div class="row" style={{ gap: "8px" }}><ProcIcon p={g} />{g.name}<Show when={g.count > 1}><span class="badge">{g.count}</span></Show><Show when={g.protected}><span class="badge warn" title="System-critical: unsafe actions are disabled">system</span></Show></div></td>
                        <td class="num tn dim">{g.count > 1 ? "—" : g.pid}</td>
                        <td class="num tn" style={{ color: g.cpu > 25 ? "var(--warn)" : undefined }}>{pct(g.cpu, 1)}</td>
                        <td class="num tn">{bytes(g.mem)}</td>
                        <td class="num tn dim">{g.read_bps ? rate(g.read_bps) : "—"}</td>
                        <td class="num tn dim">{g.write_bps ? rate(g.write_bps) : "—"}</td>
                        <td class="dim">{g.status}</td>
                      </tr>
                    )}
                  </For>
                </Show>
                <Show when={view() === "tree"}>
                  <For each={tree()}>
                    {({ p, depth }) => (
                      <tr class={`click ${p.new ? "new" : ""} ${selected()?.pid === p.pid ? "sel" : ""}`} onClick={() => setSelected(p)}>
                        <td><div class="row" style={{ gap: "8px", "padding-left": `${depth * 16}px` }}><Show when={depth > 0}><span class="dim">└</span></Show><ProcIcon p={p} />{p.name}<Show when={p.protected}><span class="badge warn">system</span></Show></div></td>
                        <td class="num tn dim">{p.pid}</td>
                        <td class="num tn">{pct(p.cpu, 1)}</td>
                        <td class="num tn">{bytes(p.mem)}</td>
                        <td class="num tn dim">{p.read_bps ? rate(p.read_bps) : "—"}</td>
                        <td class="num tn dim">{p.write_bps ? rate(p.write_bps) : "—"}</td>
                        <td class="dim">{p.status}</td>
                      </tr>
                    )}
                  </For>
                </Show>
                <Show when={view() === "flat"}>
                  <For each={sort.sort(filtered())}>
                    {(p) => (
                      <tr class={`click ${p.new ? "new" : ""} ${selected()?.pid === p.pid ? "sel" : ""}`} onClick={() => setSelected(p)}>
                        <td><div class="row" style={{ gap: "8px" }}><ProcIcon p={p} />{p.name}<Show when={p.protected}><span class="badge warn">system</span></Show></div></td>
                        <td class="num tn dim">{p.pid}</td>
                        <td class="num tn">{pct(p.cpu, 1)}</td>
                        <td class="num tn">{bytes(p.mem)}</td>
                        <td class="num tn dim">{p.read_bps ? rate(p.read_bps) : "—"}</td>
                        <td class="num tn dim">{p.write_bps ? rate(p.write_bps) : "—"}</td>
                        <td class="dim">{p.status}</td>
                      </tr>
                    )}
                  </For>
                </Show>
              </tbody>
            </table>
          </div>
        </Card>
        <div class="col" style={{ gap: "var(--gap)" }}>
          <Card title="Recently started" class="tight">
            <For each={(events.data()?.started ?? []).slice(0, 8)} fallback={<div class="small dim">None since GlassCore started.</div>}>
              {(e: any) => <div class="row small" style={{ padding: "3px 0" }}><i class="dot" style={{ background: "var(--ok)" }} /><span class="grow ellipsis">{e[1]}</span><span class="dim tn">{new Date(e[2] * 1000).toLocaleTimeString()}</span></div>}
            </For>
          </Card>
          <Card title="Recently exited" class="tight">
            <For each={(events.data()?.exited ?? []).slice(0, 8)} fallback={<div class="small dim">None yet.</div>}>
              {(e: any) => <div class="row small" style={{ padding: "3px 0" }}><i class="dot" style={{ background: "var(--t3)" }} /><span class="grow ellipsis">{e[1]}</span><span class="dim tn">{new Date(e[2] * 1000).toLocaleTimeString()}</span></div>}
            </For>
          </Card>
        </div>
      </div>
      <Show when={selected()}>{(p) => <Inspector p={p()} onClose={() => setSelected(null)} onDone={() => { setSelected(null); procs.refresh(); }} />}</Show>
    </div>
  );
}

function ProcIcon(props: { p: Proc }) {
  const ch = () => props.p.name.replace(/\.exe$/i, "").slice(0, 1).toUpperCase();
  return <span style={{ width: "22px", height: "22px", "border-radius": "6px", background: "var(--raise-2)", display: "grid", "place-items": "center", "font-size": "11px", "font-weight": 600, flex: "none" }}>{ch()}</span>;
}

function Inspector(props: { p: Proc; onClose: () => void; onDone: () => void }) {
  const d = usePoll<ProcDetails>(() => call("proc_details", { pid: props.p.pid }), 0);
  const [prio, setPrio] = createSignal<string>("normal");
  const target = () => ({ pid: props.p.pid, created: d.data()?.created ?? null });
  const doAct = async (action: string, arg?: string) => {
    const r = await act(call<string>("proc_action", { action, ...target(), arg: arg ?? null }), (m) => m);
    if (r && ["kill", "kill_tree"].includes(action)) props.onDone();
    else d.refresh();
  };
  const kill = async () => {
    if (await confirm({ title: `End ${props.p.name}?`, body: "Unsaved work in this app will be lost. Try “Close windows” first to let it ask to save.", detail: [`PID ${props.p.pid}`, d.data()?.path ?? props.p.exe ?? ""], danger: true, ok: "End task" })) doAct("kill");
  };
  const killTree = async () => {
    const kids = await call<[number, string][]>("proc_tree_preview", { pid: props.p.pid });
    if (await confirm({ title: `End ${props.p.name} and ${kids.length} child process(es)?`, body: "These processes will be terminated:", detail: [`${props.p.pid}  ${props.p.name}`, ...kids.map(([pid, n]) => `${pid}  ${n}`)], danger: true, ok: "End process tree" })) doAct("kill_tree");
  };
  const cores = () => {
    const m = d.data()?.system_mask ?? 0;
    const out: number[] = [];
    for (let i = 0; i < 64; i++) if ((m / 2 ** i) % 2 >= 1) out.push(i);
    return out;
  };
  const toggleCore = (i: number) => {
    const cur = d.data()?.affinity ?? 0;
    const bit = 2 ** i;
    const next = (cur / bit) % 2 >= 1 ? cur - bit : cur + bit;
    if (next <= 0) return toast("At least one CPU must stay selected", "bad");
    doAct("affinity", String(next));
  };
  return (
    <Drawer title={props.p.name} onClose={props.onClose}>
      <div class="col" style={{ gap: "14px" }}>
        <div class="row wrap" style={{ gap: "6px" }}>
          <span class="badge">PID {props.p.pid}</span>
          <Show when={props.p.ppid}><span class="badge">Parent {props.p.ppid}</span></Show>
          <Show when={d.data()?.signature}><span class={`badge ${d.data()!.signature === "signed" || d.data()!.signature!.startsWith("catalog") ? "ok" : "warn"}`}>{d.data()!.signature}</span></Show>
          <Show when={props.p.protected}><span class="badge warn">System-critical</span></Show>
        </div>
        <div class="inset mono selectable small" style={{ "word-break": "break-all" }}>{d.data()?.path ?? props.p.exe ?? "Path not available (access denied)"}</div>
        <div class="grid g3">
          <Stat label="CPU" value={pct(props.p.cpu, 1)} />
          <Stat label="Memory" value={bytes(props.p.mem)} />
          <Stat label="Threads" value={d.data()?.threads.length ?? "—"} />
        </div>
        <div class="lbl">Actions</div>
        <div class="row wrap">
          <button class="btn" disabled={props.p.protected} onClick={() => doAct("close")}>Close windows</button>
          <button class="btn danger" disabled={props.p.protected} onClick={kill}>End task</button>
          <button class="btn danger" disabled={props.p.protected} onClick={killTree}>End tree</button>
          <button class="btn" disabled={props.p.protected} onClick={async () => { if (await confirm({ title: `Suspend ${props.p.name}?`, body: "A suspended app freezes until you resume it. Suspending the wrong process can hang other apps.", ok: "Suspend" })) doAct("suspend"); }}>Suspend</button>
          <button class="btn" disabled={props.p.protected} onClick={() => doAct("resume")}>Resume</button>
        </div>
        <div class="lbl">Priority <span class="dim" style={{ "text-transform": "none", "letter-spacing": 0 }}>· now {d.data()?.priority ?? "—"}</span></div>
        <div class="row">
          <select class="input grow" value={prio()} onChange={(e) => setPrio(e.currentTarget.value)} disabled={props.p.protected}>
            <option value="idle">Low</option><option value="below">Below normal</option><option value="normal">Normal</option><option value="above">Above normal</option><option value="high">High</option>
          </select>
          <button class="btn" disabled={props.p.protected} onClick={() => doAct("priority", prio())}>Apply</button>
          <button class="btn ghost" disabled={props.p.protected} onClick={() => doAct("priority", "normal")} title="Restore default">Reset</button>
        </div>
        <Show when={cores().length}>
          <div class="lbl">CPU affinity</div>
          <div class="row wrap" style={{ gap: "5px" }}>
            <For each={cores()}>{(i) => <button class={`chip ${((d.data()?.affinity ?? 0) / 2 ** i) % 2 >= 1 ? "on" : ""}`} style={{ "min-width": "44px", "justify-content": "center" }} disabled={props.p.protected} onClick={() => toggleCore(i)}>{i}</button>}</For>
          </div>
        </Show>
        <Show when={d.data()?.windows.length}>
          <div class="lbl">Windows</div>
          <For each={d.data()!.windows}>{(w) => <div class="small ellipsis">{w}</div>}</For>
        </Show>
        <Show when={d.data()?.children.length}>
          <div class="lbl">Child processes</div>
          <For each={d.data()!.children}>{([pid, n]) => <div class="small tn">{pid} · {n}</div>}</For>
        </Show>
        <Show when={d.data()?.modules.length}>
          <details><summary class="lbl" style={{ cursor: "pointer" }}>Loaded modules ({d.data()!.modules.length})</summary>
            <div class="mono small selectable" style={{ "max-height": "220px", overflow: "auto", "margin-top": "8px" }}><For each={d.data()!.modules}>{(m) => <div class="ellipsis">{m}</div>}</For></div>
          </details>
        </Show>
      </div>
    </Drawer>
  );
}

// ============================ performance ============================

function Performance() {
  const [range, setRange] = createSignal(120);
  const hw = usePoll<HwStatus>(() => call("hw_status"), 2000);
  const disks = usePoll<any[]>(() => call("disks"), 30000, []);
  const procs = usePoll<Proc[]>(() => call("processes"), 3000, []);
  const h = () => history().slice(-range());
  const s = () => latest();
  const top = (k: keyof Proc) => [...(procs.data() ?? [])].sort((a, b) => (b[k] as number) - (a[k] as number)).slice(0, 5);
  // Spike markers: samples where CPU jumped >25 points (PERF-09)
  const spikes = createMemo(() => {
    const d = h();
    const out: { at: number; label: string }[] = [];
    for (let i = 1; i < d.length; i++) if (d[i].cpu - d[i - 1].cpu > 25) out.push({ at: i, label: `CPU spike ${d[i - 1].cpu.toFixed(0)}→${d[i].cpu.toFixed(0)}%` });
    return out.slice(-12);
  });
  const engines = () => Object.entries(s()?.gpu_engines ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <div class="col" style={{ gap: "var(--gap)" }}>
      <div class="row">
        <Seg value={range()} onChange={setRange} options={[{ v: 30, label: "30 s" }, { v: 60, label: "1 min" }, { v: 300, label: "5 min" }, { v: 600, label: "10 min" }]} label="Time range" />
        <span class="grow" />
        <span class="small dim">Sampling every {((s()?.interval_ms ?? 1000) / 1000).toFixed(0)} s · dashed lines mark CPU spikes</span>
      </div>
      <div class="grid g2">
        <Card title="CPU" icon="cpu" sub={`${pct(s()?.cpu, 1)} · ${s() ? (s()!.cpu_mhz / 1000).toFixed(2) + " GHz" : ""} · ${temp(hw.data()?.snapshot?.cpuTemp)}`}>
          <Chart series={[{ data: h().map((x) => x.cpu), color: "var(--ac)", label: "CPU" }]} max={100} unit={(v) => `${v.toFixed(0)}%`} markers={spikes()} />
          <div class="grid" style={{ "grid-template-columns": `repeat(${Math.min(16, s()?.cores.length ?? 1)}, 1fr)`, gap: "4px", "margin-top": "12px" }}>
            <For each={s()?.cores ?? []}>{(c, i) => <div title={`Core ${i()}: ${c.toFixed(0)}%`} style={{ height: "28px", "border-radius": "5px", background: `color-mix(in srgb, var(--ac) ${Math.round(c)}%, var(--raise))` }} />}</For>
          </div>
        </Card>
        <Card title="Memory" icon="ram" sub={`${bytes(s()?.mem_used)} of ${bytes(s()?.mem_total)} · ${bytes(s()?.mem_avail)} available`}>
          <Chart series={[{ data: h().map((x) => (x.mem_used / x.mem_total) * 100), color: "#86cfa1", label: "In use" }]} max={100} unit={(v) => `${v.toFixed(1)}%`} />
          <div class="row small muted" style={{ "margin-top": "10px", gap: "18px" }}>
            <span>Page file {bytes(s()?.swap_used)} / {bytes(s()?.swap_total)}</span><span>{s()?.procs} processes</span><span>{s()?.threads?.toFixed(0) ?? "—"} threads</span>
          </div>
        </Card>
        <Card title="GPU" icon="gpu" sub={s()?.gpu == null ? "No GPU counters" : `${pct(s()!.gpu!)} · ${bytes(s()?.gpu_mem_dedicated)} dedicated · ${temp(hw.data()?.snapshot?.gpuTemp)}`}>
          <Chart series={[{ data: h().map((x) => x.gpu), color: "#9b8cff", label: "GPU (busiest engine)" }]} max={100} unit={(v) => `${v.toFixed(0)}%`} />
          <div class="grid g2" style={{ "margin-top": "10px", gap: "8px" }}>
            <For each={engines()}>{([k, v]) => <div><div class="row small"><span class="grow muted">{k}</span><span class="tn">{v.toFixed(0)}%</span></div><Bar value={v} color="#9b8cff" /></div>}</For>
          </div>
        </Card>
        <Card title="Disk & network" icon="disk" sub={`Busy ${pct(s()?.disk_busy)} · queue ${s()?.disk_queue?.toFixed(2) ?? "—"}`}>
          <Chart series={[
            { data: h().map((x) => (x.disk_read ?? 0) / 1048576), color: "#e6ba6c", label: "Disk read MB/s" },
            { data: h().map((x) => (x.disk_write ?? 0) / 1048576), color: "#ec8a78", label: "Disk write MB/s" },
            { data: h().map((x) => x.net_rx / 1048576), color: "#8fb8ff", label: "Net down MB/s" },
            { data: h().map((x) => x.net_tx / 1048576), color: "#7bcdd1", label: "Net up MB/s" },
          ]} unit={(v) => `${v.toFixed(2)} MB/s`} />
          <div class="legend" style={{ "margin-top": "8px" }}><span><i style={{ background: "#e6ba6c" }} />Disk read</span><span><i style={{ background: "#ec8a78" }} />Disk write</span><span><i style={{ background: "#8fb8ff" }} />Download</span><span><i style={{ background: "#7bcdd1" }} />Upload</span></div>
        </Card>
      </div>
      <div class="grid g3">
        <Card title="Top CPU" class="tight"><For each={top("cpu")}>{(p) => <div class="row small" style={{ padding: "4px 0" }}><span class="grow ellipsis">{p.name}</span><span class="tn">{pct(p.cpu, 1)}</span></div>}</For></Card>
        <Card title="Top memory" class="tight"><For each={top("mem")}>{(p) => <div class="row small" style={{ padding: "4px 0" }}><span class="grow ellipsis">{p.name}</span><span class="tn">{bytes(p.mem)}</span></div>}</For></Card>
        <Card title="Volumes" class="tight">
          <For each={disks.data() ?? []}>{(d) => <div style={{ padding: "4px 0" }}><div class="row small"><span class="grow">{d.mount} <span class="dim">{d.fs}</span></span><span class="tn dim">{bytes(d.total - d.avail)} / {bytes(d.total)}</span></div><Bar value={((d.total - d.avail) / Math.max(1, d.total)) * 100} color={(d.avail / d.total) < 0.1 ? "var(--bad)" : undefined} /></div>}</For>
        </Card>
      </div>
      <Show when={hw.data()?.snapshot?.sensors?.length}>
        <Card title="Hardware sensors" sub="From the hardware helper">
          <div class="grid g4" style={{ gap: "8px" }}>
            <For each={[...(hw.data()!.snapshot!.temps.map((t) => ({ ...t, type: "Temperature" }))), ...hw.data()!.snapshot!.sensors].slice(0, 40)}>
              {(x: any) => <div class="inset" style={{ padding: "8px 10px" }}><div class="small dim ellipsis" title={x.hw}>{x.name} · {x.type}</div><div class="tn">{x.value}{x.type === "Temperature" ? "°C" : x.type === "Load" ? "%" : x.type === "Clock" ? " MHz" : x.type === "Power" ? " W" : ""}</div></div>}
            </For>
          </div>
        </Card>
      </Show>
    </div>
  );
}

// ============================ network ============================

function Network() {
  const conns = usePoll<Conn[]>(() => call("net_connections"), 3000, []);
  const adapters = usePoll<Adapter[]>(() => call("net_adapters"), 15000, []);
  const procs = usePoll<Proc[]>(() => call("processes"), 5000, []);
  const ifs = usePoll<any[]>(() => call("net_ifs"), 2000, []);
  const [q, setQ] = createSignal("");
  const [view, setView] = createSignal<"all" | "established" | "listening" | "external">("established");
  const [host, setHost] = createSignal("one.one.one.one");
  const [probe, setProbe] = createSignal<any>(null);
  const [seen] = createSignal(new Set<string>());
  const name = (pid: number) => (procs.data() ?? []).find((p) => p.pid === pid)?.name ?? (pid === 0 ? "System Idle" : pid === 4 ? "System" : `PID ${pid}`);
  const sort = useSort<Conn>("lport", 1);
  const rows = createMemo(() => {
    const s = q().toLowerCase();
    return sort.sort((conns.data() ?? []).filter((c) => {
      if (view() === "established" && c.state !== "Established") return false;
      if (view() === "listening" && !(c.state === "Listening" || (c.proto.startsWith("UDP") && c.remote === "*"))) return false;
      if (view() === "external" && c.scope !== "external") return false;
      return !s || `${c.local}:${c.lport} ${c.remote}:${c.rport} ${name(c.pid)}`.toLowerCase().includes(s);
    }));
  });
  const isNew = (c: Conn) => {
    const k = `${c.proto}${c.local}${c.lport}${c.remote}${c.rport}`;
    if (seen().has(k)) return false;
    seen().add(k);
    return seen().size > 30;
  };
  return (
    <div class="col" style={{ gap: "var(--gap)" }}>
      <div class="grid g3">
        <For each={(adapters.data() ?? []).filter((a) => a.up && a.kind !== "Loopback").slice(0, 3)}>
          {(a) => {
            const live = () => (ifs.data() ?? []).find((i) => i.name === a.name || a.description.includes(i.name));
            return (
              <Card class="tight" title={a.name} icon={a.kind === "Wi-Fi" ? "net" : "monitor"} actions={<div class="row" style={{ gap: "4px" }}><span class="badge ok">Up</span><Show when={a.vpn_like}><span class="badge ac">VPN</span></Show></div>}>
                <div class="small muted ellipsis">{a.description}</div>
                <div class="kv small" style={{ "grid-template-columns": "80px 1fr", "margin-top": "8px" }}>
                  <dt>Speed</dt><dd>{a.speed_mbps ? `${a.speed_mbps} Mbps` : "—"}</dd>
                  <dt>IP</dt><dd class="selectable ellipsis">{a.ips.filter((i) => !i.includes(":")).join(", ") || a.ips[0] || "—"}</dd>
                  <dt>Gateway</dt><dd class="selectable">{a.gateways.join(", ") || "—"}</dd>
                  <dt>DNS</dt><dd class="selectable ellipsis">{a.dns.slice(0, 2).join(", ") || "—"}</dd>
                  <dt>Live</dt><dd class="tn">↓ {rate(live()?.rx_bps)} · ↑ {rate(live()?.tx_bps)}</dd>
                </div>
              </Card>
            );
          }}
        </For>
      </div>
      <Card title="Connectivity check" icon="zap" sub="DNS lookup + TCP connect to a host you choose. Nothing else is sent.">
        <div class="row">
          <input class="input" style={{ width: "280px" }} value={host()} onInput={(e) => setHost(e.currentTarget.value)} aria-label="Host to check" />
          <button class="btn" onClick={async () => setProbe(await call("net_probe", { host: host(), port: 443 }))}>Check HTTPS reachability</button>
          <Show when={probe()}>
            <Show when={probe().ok} fallback={<span class="badge bad">Failed at {probe().stage}: {probe().error}</span>}>
              <span class="badge ok">Reachable</span><span class="small muted tn">DNS {probe().dns_ms} ms · connect {probe().connect_ms} ms · {probe().addr}</span>
            </Show>
          </Show>
        </div>
      </Card>
      <div class="row wrap">
        <Search value={q()} onInput={setQ} placeholder="Filter by address, port or app" width="300px" />
        <Seg value={view()} onChange={setView} options={[{ v: "established", label: "Active" }, { v: "listening", label: "Listening ports" }, { v: "external", label: "External" }, { v: "all", label: "All" }]} />
        <span class="grow" />
        <span class="small dim">Owning process shown per connection. Per-connection bandwidth isn't measured.</span>
      </div>
      <Card class="flush">
        <div class="table-wrap" style={{ "max-height": "460px" }}>
          <table class="t">
            <thead><tr>
              <th class="sort" onClick={() => sort.toggle("proto")}>Protocol{sort.arrow("proto")}</th>
              <th class="sort" onClick={() => sort.toggle("lport")}>Local{sort.arrow("lport")}</th>
              <th class="sort" onClick={() => sort.toggle("remote")}>Remote{sort.arrow("remote")}</th>
              <th class="sort" onClick={() => sort.toggle("state")}>State{sort.arrow("state")}</th>
              <th>Scope</th>
              <th class="sort" onClick={() => sort.toggle("pid")}>Process{sort.arrow("pid")}</th>
            </tr></thead>
            <tbody>
              <For each={rows()} fallback={<tr><td colspan="6"><Empty title="No connections match">Try another filter.</Empty></td></tr>}>
                {(c) => (
                  <tr class={isNew(c) ? "new" : ""}>
                    <td class="dim">{c.proto}</td>
                    <td class="mono selectable">{c.local}:{c.lport}</td>
                    <td class="mono selectable">{c.remote === "*" ? "*" : `${c.remote}:${c.rport}`}</td>
                    <td><span class={`badge ${c.state === "Established" ? "ok" : c.state === "Listening" ? "ac" : ""}`}>{c.state}</span></td>
                    <td class="dim">{c.scope}</td>
                    <td>{name(c.pid)} <span class="dim tn">{c.pid}</span></td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
