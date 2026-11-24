import { createMemo, createSignal, For, Show, Switch, Match } from "solid-js";
import { save } from "@tauri-apps/plugin-dialog";
import { call, type Svc, type Device, type Session, type Inventory, type InstalledApp, type StartupItem, type LogEvent } from "../lib/api";
import { tabOf, setTab, act, confirm, toast } from "../lib/store";
import { bytes } from "../lib/format";
import { Card, Tabs, Icon, Search, Seg, usePoll, useSort, Drawer, Empty, Modal } from "../components/ui";

export default function SystemPage() {
  const tab = () => tabOf("system", "properties");
  return (
    <div class="page">
      <Tabs value={tab()} onChange={(t) => setTab("system", t)} tabs={[
        { id: "properties", label: "Properties", icon: "info" },
        { id: "services", label: "Services", icon: "system" },
        { id: "devices", label: "Devices", icon: "monitor" },
        { id: "apps", label: "Startup & apps", icon: "power" },
        { id: "diagnostics", label: "Logs & diagnostics", icon: "alert" },
        { id: "sessions", label: "Sessions", icon: "users" },
      ]} />
      <Switch>
        <Match when={tab() === "properties"}><Properties /></Match>
        <Match when={tab() === "services"}><Services /></Match>
        <Match when={tab() === "devices"}><Devices /></Match>
        <Match when={tab() === "apps"}><Apps /></Match>
        <Match when={tab() === "diagnostics"}><Diagnostics /></Match>
        <Match when={tab() === "sessions"}><Sessions /></Match>
      </Switch>
    </div>
  );
}

const links: [string, string][] = [
  ["System", "ms-settings:about"], ["Display", "ms-settings:display"], ["Sound", "ms-settings:sound"], ["Power", "ms-settings:powersleep"],
  ["Windows Update", "ms-settings:windowsupdate"], ["Apps", "ms-settings:appsfeatures"], ["Startup apps", "ms-settings:startupapps"],
  ["Device Manager", "devmgmt.msc"], ["Services", "services.msc"], ["Event Viewer", "eventvwr.msc"], ["Disk Management", "diskmgmt.msc"],
  ["Advanced system settings", "sysdm.cpl"], ["Firewall", "wf.msc"], ["Resource Monitor", "resmon"],
];

function Properties() {
  const inv = usePoll<Inventory>(() => call("inventory"), 0);
  const env = usePoll<any[]>(() => call("environment"), 0, []);
  const [rt, setRt] = createSignal<"general" | "hardware" | "advanced" | "about">("general");
  const [report, setReport] = createSignal<string | null>(null);
  const i = () => inv.data();
  return (
    <div class="grid" style={{ "grid-template-columns": "minmax(0, 1.4fr) minmax(0, 1fr)", "align-items": "start" }}>
      <Card class="flush">
        <div class="retro">
          <div class="retro-tabs" role="tablist">
            <For each={[["general", "General"], ["hardware", "Hardware"], ["advanced", "Advanced"], ["about", "About"]] as const}>
              {([id, l]) => <button class={rt() === id ? "on" : ""} role="tab" aria-selected={rt() === id} onClick={() => setRt(id)}>{l}</button>}
            </For>
          </div>
          <div style={{ padding: "22px", background: "var(--panel-solid)", "min-height": "420px" }}>
            <Show when={i()} fallback={<div class="row"><div class="spin" />Reading system information…</div>}>
              <Switch>
                <Match when={rt() === "general"}>
                  <div class="row" style={{ gap: "22px", "align-items": "flex-start" }}>
                    <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true"><rect x="6" y="10" width="84" height="58" rx="8" fill="var(--raise-2)" stroke="var(--line-2)" /><rect x="14" y="18" width="68" height="42" rx="4" fill="var(--ac-soft)" /><path d="M36 80h24M48 68v12" stroke="var(--t3)" stroke-width="3" stroke-linecap="round" /></svg>
                    <div class="col" style={{ gap: "14px" }}>
                      <div><div class="lbl">System</div><div style={{ "font-size": "17px" }}>{i()!.os_name}</div><div class="muted">Version {i()!.os_version} · Build {i()!.os_build} · {i()!.arch}</div></div>
                      <div><div class="lbl">Computer</div><div>{i()!.system_vendor} {i()!.system_model}</div><div class="muted">{i()!.cpu}</div><div class="muted">{bytes(i()!.ram_total, 0)} RAM</div></div>
                      <div><div class="lbl">Security</div><div class="row" style={{ gap: "6px" }}><span class="badge">{i()!.boot_mode}</span><span class={`badge ${i()!.secure_boot ? "ok" : "warn"}`}>Secure Boot {i()!.secure_boot == null ? "unknown" : i()!.secure_boot ? "on" : "off"}</span><Show when={i()!.is_admin}><span class="badge warn">Running elevated</span></Show></div></div>
                    </div>
                  </div>
                </Match>
                <Match when={rt() === "hardware"}>
                  <dl class="kv selectable">
                    <dt>Processor</dt><dd>{i()!.cpu}</dd>
                    <dt>Cores / threads</dt><dd>{i()!.cpu_cores} / {i()!.cpu_threads} · base {i()!.cpu_base_mhz} MHz</dd>
                    <dt>Memory</dt><dd>{bytes(i()!.ram_total)}</dd>
                    <dt>Motherboard</dt><dd>{i()!.board_vendor} {i()!.board_model}</dd>
                    <dt>BIOS</dt><dd>{i()!.bios_vendor} {i()!.bios_version} ({i()!.bios_date})</dd>
                    <For each={i()!.gpus}>{(g, n) => <><dt>Graphics {n() + 1}</dt><dd>{g[0]} · driver {g[1]}{g[2] ? ` · ${bytes(g[2], 0)}` : ""}</dd></>}</For>
                  </dl>
                  <div class="row wrap" style={{ "margin-top": "18px" }}>
                    <button class="btn" onClick={() => call("open_settings", { uri: "devmgmt.msc" })}>Device Manager</button>
                    <button class="btn" onClick={() => setTab("system", "devices")}>GlassCore device view</button>
                  </div>
                </Match>
                <Match when={rt() === "advanced"}>
                  <div class="col">
                    <div class="lbl">Environment variables (read-only)</div>
                    <div class="inset mono small selectable" style={{ "max-height": "300px", overflow: "auto" }}>
                      <For each={env.data()}>{(v) => <div style={{ "word-break": "break-all", padding: "2px 0" }}><b>{v.name}</b> = {v.name.toUpperCase() === "PATH" ? v.value.split(";").join(";\n") : v.value}</div>}</For>
                    </div>
                    <button class="btn" style={{ "align-self": "flex-start" }} onClick={() => call("open_settings", { uri: "sysdm.cpl" })}>Open Advanced system settings</button>
                  </div>
                </Match>
                <Match when={rt() === "about"}>
                  <dl class="kv">
                    <dt>Edition</dt><dd>{i()!.os_edition}</dd>
                    <dt>Installed</dt><dd>{i()!.install_date}</dd>
                    <dt>Activation</dt><dd class="muted">See Settings → Activation (product keys are never read)</dd>
                  </dl>
                  <button class="btn" style={{ "margin-top": "16px" }} onClick={() => call("open_settings", { uri: "ms-settings:activation" })}>Activation settings</button>
                </Match>
              </Switch>
            </Show>
          </div>
        </div>
      </Card>
      <div class="col" style={{ gap: "var(--gap)" }}>
        <Card title="Diagnostic report" icon="note" sub="Redacted — username and PC name removed">
          <p class="small muted" style={{ "margin-bottom": "12px" }}>Generate a summary you can share when asking for help. You see exactly what's in it before saving; nothing is uploaded.</p>
          <button class="btn primary" onClick={async () => setReport(await call<string>("system_report"))}>Preview report</button>
        </Card>
        <Card title="Windows tools" icon="external">
          <div class="row wrap" style={{ gap: "6px" }}>
            <For each={links}>{([l, u]) => <button class="chip" onClick={() => act(call("open_settings", { uri: u }))}>{l}</button>}</For>
          </div>
        </Card>
      </div>
      <Show when={report()}>
        <Modal onClose={() => setReport(null)} wide label="Diagnostic report">
          <h2>Diagnostic report preview</h2>
          <p class="small muted" style={{ "margin-bottom": "10px" }}>Check it over. Usernames and the PC name are already replaced with placeholders.</p>
          <pre class="inset mono selectable" style={{ "max-height": "50vh", overflow: "auto", "white-space": "pre-wrap" }}>{report()}</pre>
          <div class="row" style={{ "justify-content": "flex-end", "margin-top": "12px" }}>
            <button class="btn" onClick={() => { navigator.clipboard.writeText(report()!); toast("Copied", "ok"); }}>Copy</button>
            <button class="btn primary" onClick={async () => {
              const p = await save({ defaultPath: "glasscore-report.md", filters: [{ name: "Markdown", extensions: ["md"] }] });
              if (p) await act(call("save_text", { path: p, text: report()! }), "Report saved");
            }}>Save…</button>
          </div>
        </Modal>
      </Show>
    </div>
  );
}

function Services() {
  const svcs = usePoll<Svc[]>(() => call("svc_list"), 6000, []);
  const [q, setQ] = createSignal("");
  const [state, setState] = createSignal<"all" | "Running" | "Stopped">("all");
  const [sel, setSel] = createSignal<Svc | null>(null);
  const sort = useSort<Svc>("display", 1);
  const rows = createMemo(() => {
    const s = q().toLowerCase();
    return sort.sort((svcs.data() ?? []).filter((v) => (state() === "all" || v.state === state()) && (!s || `${v.name} ${v.display} ${v.binary}`.toLowerCase().includes(s))));
  });
  const unusual = (v: Svc) => {
    const b = v.binary.toLowerCase();
    return b && !b.includes("\\windows\\") && !b.includes("program files") && !b.includes("programdata\\microsoft");
  };
  const control = async (v: Svc, action: string) => {
    const deps = await call<string[]>("svc_dependents", { name: v.name });
    const ok = await confirm({
      title: `${action[0].toUpperCase() + action.slice(1)} ${v.display}?`,
      body: deps.length ? `These running services depend on it and will be ${action === "stop" ? "stopped" : "restarted"} too:` : "This may need administrator rights.",
      detail: deps, danger: action === "stop", ok: action[0].toUpperCase() + action.slice(1),
    });
    if (!ok) return;
    await act(call("svc_control", { name: v.name, action }), `${v.display}: ${action} requested`);
    svcs.refresh();
  };
  return (
    <div class="col" style={{ gap: "var(--gap)" }}>
      <div class="row wrap">
        <Search value={q()} onInput={setQ} placeholder="Search services or executables" width="320px" />
        <Seg value={state()} onChange={setState} options={[{ v: "all", label: "All" }, { v: "Running", label: "Running" }, { v: "Stopped", label: "Stopped" }]} />
        <span class="grow" />
        <span class="small muted">{(svcs.data() ?? []).filter((s) => s.state === "Running").length} running of {(svcs.data() ?? []).length}</span>
      </div>
      <Card class="flush">
        <div class="table-wrap" style={{ "max-height": "calc(100vh - 230px)" }}>
          <table class="t">
            <thead><tr>
              <th class="sort" onClick={() => sort.toggle("display")}>Name{sort.arrow("display")}</th>
              <th class="sort" onClick={() => sort.toggle("state")}>Status{sort.arrow("state")}</th>
              <th class="sort" onClick={() => sort.toggle("start")}>Startup{sort.arrow("start")}</th>
              <th class="num">PID</th><th>Account</th><th></th>
            </tr></thead>
            <tbody>
              <For each={rows()}>
                {(v) => (
                  <tr class={`click ${sel()?.name === v.name ? "sel" : ""}`} onClick={() => setSel(v)}>
                    <td><div class="row" style={{ gap: "8px" }}><span class="ellipsis">{v.display}</span><Show when={unusual(v)}><span class="badge warn" title="Executable outside Windows / Program Files">unusual path</span></Show></div><div class="small dim">{v.name}</div></td>
                    <td><span class={`badge ${v.state === "Running" ? "ok" : ""}`}>{v.state}</span></td>
                    <td class="dim">{v.start}{v.delayed ? " (delayed)" : ""}</td>
                    <td class="num tn dim">{v.pid || "—"}</td>
                    <td class="dim small">{v.account.replace("NT AUTHORITY\\", "")}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div class="row" style={{ gap: "4px", "justify-content": "flex-end" }}>
                        <Show when={v.state !== "Running"}><button class="btn sm" onClick={() => control(v, "start")}>Start</button></Show>
                        <Show when={v.state === "Running"}><button class="btn sm" onClick={() => control(v, "restart")}>Restart</button><button class="btn sm danger" onClick={() => control(v, "stop")}>Stop</button></Show>
                      </div>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Card>
      <Show when={sel()}>{(v) => (
        <Drawer title={v().display} onClose={() => setSel(null)}>
          <div class="col">
            <p class="muted small">{v().description || "No description."}</p>
            <dl class="kv small selectable" style={{ "grid-template-columns": "110px 1fr" }}>
              <dt>Service name</dt><dd>{v().name}</dd><dt>Status</dt><dd>{v().state}</dd><dt>Startup</dt><dd>{v().start}{v().delayed ? " (delayed)" : ""}</dd>
              <dt>Process</dt><dd>{v().kind}{v().pid ? ` · PID ${v().pid}` : ""}</dd><dt>Account</dt><dd>{v().account}</dd>
              <dt>Executable</dt><dd class="mono" style={{ "word-break": "break-all" }}>{v().binary}</dd>
            </dl>
            <div class="lbl" style={{ "margin-top": "8px" }}>Change startup type</div>
            <p class="small dim">Needs the hardware helper (administrator). Protected Windows services are refused.</p>
            <div class="row wrap">
              <For each={[["auto", "Automatic"], ["delayed", "Automatic (delayed)"], ["manual", "Manual"], ["disabled", "Disabled"]] as const}>
                {([k, l]) => <button class="btn sm" onClick={async () => {
                  if (await confirm({ title: `Set ${v().display} to ${l}?`, body: `Currently: ${v().start}${v().delayed ? " (delayed)" : ""}. You can change it back here at any time.`, ok: "Change" }))
                    await act(call("svc_start_type", { name: v().name, kind: k }), "Startup type changed");
                  svcs.refresh();
                }}>{l}</button>}
              </For>
            </div>
          </div>
        </Drawer>
      )}</Show>
    </div>
  );
}

function Devices() {
  const devs = usePoll<Device[]>(() => call("devices"), 0, []);
  const [q, setQ] = createSignal("");
  const [problems, setProblems] = createSignal(false);
  const [sel, setSel] = createSignal<Device | null>(null);
  const [open, setOpen] = createSignal<Set<string>>(new Set());
  const groups = createMemo(() => {
    const s = q().toLowerCase();
    const m = new Map<string, Device[]>();
    for (const d of devs.data() ?? []) {
      if (problems() && d.problem === 0) continue;
      if (s && !`${d.name} ${d.class} ${d.manufacturer} ${d.hardware_ids.join(" ")}`.toLowerCase().includes(s)) continue;
      m.set(d.class, [...(m.get(d.class) ?? []), d]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });
  const bad = () => (devs.data() ?? []).filter((d) => d.problem !== 0).length;
  const toggle = (c: string) => { const n = new Set(open()); n.has(c) ? n.delete(c) : n.add(c); setOpen(n); };
  return (
    <div class="col" style={{ gap: "var(--gap)" }}>
      <div class="row wrap">
        <Search value={q()} onInput={(v) => { setQ(v); if (v) setOpen(new Set(groups().map((g) => g[0]))); }} placeholder="Search devices or hardware IDs" width="320px" />
        <button class={`chip ${problems() ? "on" : ""}`} onClick={() => setProblems(!problems())}><i class="dot" style={{ background: bad() ? "var(--bad)" : "var(--ok)" }} />{bad()} with problems</button>
        <button class="btn sm ghost" onClick={() => setOpen(new Set(groups().map((g) => g[0])))}>Expand all</button>
        <button class="btn sm ghost" onClick={() => setOpen(new Set<string>())}>Collapse all</button>
        <span class="grow" />
        <button class="btn sm" onClick={() => devs.refresh()}><Icon name="refresh" size={14} />Rescan</button>
      </div>
      <Card class="flush">
        <div style={{ "max-height": "calc(100vh - 230px)", overflow: "auto", padding: "6px" }}>
          <Show when={!devs.loading()} fallback={<div class="empty"><div class="spin" /></div>}>
            <For each={groups()}>
              {([cls, items]) => (
                <div>
                  <button class="list-row" style={{ width: "100%", border: 0, background: "transparent", cursor: "pointer" }} onClick={() => toggle(cls)} aria-expanded={open().has(cls)}>
                    <Icon name={open().has(cls) ? "down" : "chev"} size={14} />
                    <b class="grow" style={{ "text-align": "left", "font-weight": 600 }}>{cls}</b>
                    <Show when={items.some((d) => d.problem)}><span class="badge bad">{items.filter((d) => d.problem).length} problem</span></Show>
                    <span class="small dim">{items.length}</span>
                  </button>
                  <Show when={open().has(cls)}>
                    <For each={items}>
                      {(d) => (
                        <button class="list-row" style={{ width: "100%", border: 0, background: sel()?.instance === d.instance ? "var(--ac-soft)" : "transparent", cursor: "pointer", "padding-left": "38px", "text-align": "left" }} onClick={() => setSel(d)}>
                          <i class="dot" style={{ background: d.problem ? "var(--bad)" : "var(--ok)" }} />
                          <span class="grow ellipsis">{d.name}</span>
                          <span class="small dim ellipsis" style={{ "max-width": "30%" }}>{d.manufacturer}</span>
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Card>
      <Show when={sel()}>{(d) => (
        <Drawer title={d().name} onClose={() => setSel(null)}>
          <div class="col">
            <span class={`badge ${d().problem ? "bad" : "ok"}`} style={{ "align-self": "flex-start" }}>{d().status}</span>
            <dl class="kv small selectable" style={{ "grid-template-columns": "110px 1fr" }}>
              <dt>Class</dt><dd>{d().class}</dd><dt>Manufacturer</dt><dd>{d().manufacturer || "—"}</dd>
              <dt>Driver</dt><dd>{d().driver_provider} {d().driver_version} {d().driver_date ? `(${d().driver_date})` : ""}</dd>
              <dt>Instance ID</dt><dd class="mono" style={{ "word-break": "break-all" }}>{d().instance}</dd>
              <dt>Hardware IDs</dt><dd class="mono" style={{ "word-break": "break-all" }}><For each={d().hardware_ids}>{(h) => <div>{h}</div>}</For></dd>
            </dl>
            <Show when={d().problem}><div class="inset small">Windows reports problem code {d().problem}. Driver updates, rollback, disable and uninstall are done safely through Device Manager.</div></Show>
            <button class="btn" style={{ "align-self": "flex-start" }} onClick={() => call("open_settings", { uri: "devmgmt.msc" })}><Icon name="external" size={14} />Open in Device Manager</button>
          </div>
        </Drawer>
      )}</Show>
    </div>
  );
}

function Apps() {
  const startup = usePoll<StartupItem[]>(() => call("startup_items"), 0, []);
  const apps = usePoll<InstalledApp[]>(() => call("installed_apps"), 0, []);
  const [q, setQ] = createSignal("");
  const sort = useSort<InstalledApp>("name", 1);
  const rows = createMemo(() => sort.sort((apps.data() ?? []).filter((a) => !q() || `${a.name} ${a.publisher}`.toLowerCase().includes(q().toLowerCase()))));
  return (
    <div class="col" style={{ gap: "var(--gap)" }}>
      <Card title="Starts with Windows" icon="power" sub="Enable/disable these in Windows' own Startup apps page" actions={<button class="btn sm" onClick={() => call("open_settings", { uri: "ms-settings:startupapps" })}><Icon name="external" size={14} />Startup apps</button>}>
        <div class="table-wrap" style={{ "max-height": "300px" }}>
          <table class="t">
            <thead><tr><th>Name</th><th>Status</th><th>Location</th><th>Command</th></tr></thead>
            <tbody>
              <For each={startup.data()}>{(s) => <tr><td>{s.name}</td><td><span class={`badge ${s.enabled ? "ok" : ""}`}>{s.enabled ? "Enabled" : "Disabled"}</span></td><td class="dim">{s.location}</td><td class="mono small dim selectable">{s.command}</td></tr>}</For>
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Installed software" icon="layers" sub={`${(apps.data() ?? []).length} apps`} actions={<Search value={q()} onInput={setQ} placeholder="Search apps" />}>
        <div class="table-wrap" style={{ "max-height": "460px" }}>
          <table class="t">
            <thead><tr>
              <th class="sort" onClick={() => sort.toggle("name")}>Name{sort.arrow("name")}</th>
              <th class="sort" onClick={() => sort.toggle("version")}>Version{sort.arrow("version")}</th>
              <th class="sort" onClick={() => sort.toggle("publisher")}>Publisher{sort.arrow("publisher")}</th>
              <th class="sort num" onClick={() => sort.toggle("size_kb")}>Size{sort.arrow("size_kb")}</th>
              <th class="sort" onClick={() => sort.toggle("installed")}>Installed{sort.arrow("installed")}</th>
            </tr></thead>
            <tbody>
              <For each={rows()}>{(a) => <tr><td>{a.name}</td><td class="dim tn">{a.version}</td><td class="dim">{a.publisher}</td><td class="num tn dim">{a.size_kb ? bytes(a.size_kb * 1024) : "—"}</td><td class="dim tn">{a.installed ? `${a.installed.slice(0, 4)}-${a.installed.slice(4, 6)}-${a.installed.slice(6, 8)}` : ""}</td></tr>}</For>
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Diagnostics() {
  const [channel, setChannel] = createSignal("System");
  const [level, setLevel] = createSignal(3);
  const events = usePoll<LogEvent[]>(() => call("events", { channel: channel(), level: level(), limit: 150 }), 30000, []);
  const diag = usePoll<any>(() => call("diagnostics"), 10000);
  const [sel, setSel] = createSignal<LogEvent | null>(null);
  const reload = () => events.refresh();
  const lv = (l: number) => (l === 1 ? ["Critical", "bad"] : l === 2 ? ["Error", "bad"] : l === 3 ? ["Warning", "warn"] : ["Info", ""]);
  const checks = () => {
    const d = diag.data();
    if (!d) return [];
    return [
      ["Local database", d.db_integrity === "ok", d.db_integrity],
      ["Hardware helper installed", d.helper_found, d.helper_found ? "Found" : "Missing"],
      ["Hardware helper running", d.helper_connected, d.helper_connected ? (d.helper_elevated ? "Elevated" : "Read-only") : "Not running"],
      ["RGB controllers", d.rgb.controllers.length > 0, `${d.rgb.controllers.length} found`],
      ["RGB ownership", !d.rgb.conflict, d.rgb.conflict ? "Conflict" : "Clear"],
      ["Telemetry", !d.telemetry_paused, d.telemetry_paused ? "Paused" : `${d.telemetry_samples} samples`],
      ["Global hotkeys", !d.hotkey_errors.length, d.hotkey_errors.length ? `${d.hotkey_errors.length} conflict(s)` : "All registered"],
      ["WebView2", !!d.webview, d.webview || "Unknown"],
    ] as [string, boolean, string][];
  };
  const checklist: [string, string[]][] = [
    ["High CPU", ["Activity → Processes, sort by CPU", "Check if it's a Windows Update / indexing burst", "End or lower the priority of the culprit"]],
    ["High memory", ["Group by app in Processes to see totals", "Look for one process growing steadily (possible leak)", "Close browser tabs / restart the app"]],
    ["Running hot", ["Studio → Cooling: check fan RPMs aren't 0", "Switch to the Performance profile", "Clean dust filters; check the CPU cooler is seated"]],
    ["Packet loss / slow net", ["Run the connectivity check in Network", "Compare Wi-Fi vs Ethernet", "Restart the router; check for VPN interference"]],
  ];
  return (
    <div class="col" style={{ gap: "var(--gap)" }}>
      <div class="grid g2">
        <Card title="Self-check" icon="shield">
          <For each={checks()}>{([n, ok, v]) => <div class="row" style={{ padding: "6px 0", "border-bottom": "1px solid var(--line)" }}><i class="dot" style={{ background: ok ? "var(--ok)" : "var(--warn)" }} /><span class="grow">{n}</span><span class="small muted">{v}</span></div>}</For>
        </Card>
        <Card title="Troubleshooting" icon="info">
          <For each={checklist}>{([t, steps]) => <details style={{ padding: "6px 0", "border-bottom": "1px solid var(--line)" }}><summary style={{ cursor: "pointer" }}>{t}</summary><ol class="small muted" style={{ margin: "8px 0 4px", "padding-left": "20px" }}><For each={steps}>{(s) => <li>{s}</li>}</For></ol></details>}</For>
        </Card>
      </div>
      <Card title="Event log" icon="alert" actions={
        <div class="row">
          <select class="input" value={channel()} onChange={(e) => { setChannel(e.currentTarget.value); reload(); }} aria-label="Log channel">
            <option>System</option><option>Application</option><option>Setup</option>
          </select>
          <Seg value={level()} onChange={(v) => { setLevel(v); reload(); }} options={[{ v: 2, label: "Errors" }, { v: 3, label: "+ Warnings" }, { v: 4, label: "All" }]} />
          <button class="btn sm icon" onClick={reload} aria-label="Refresh"><Icon name="refresh" size={14} /></button>
        </div>
      }>
        <div class="table-wrap" style={{ "max-height": "420px" }}>
          <table class="t">
            <thead><tr><th>Level</th><th>Time</th><th>Source</th><th class="num">ID</th><th>Message</th></tr></thead>
            <tbody>
              <For each={events.data()} fallback={<tr><td colspan="5"><Empty title={events.loading() ? "Loading…" : "No events at this level"} /></td></tr>}>
                {(e) => <tr class="click" onClick={() => setSel(e)}><td><span class={`badge ${lv(e.level)[1]}`}>{lv(e.level)[0]}</span></td><td class="dim tn">{new Date(e.time).toLocaleString()}</td><td>{e.provider}</td><td class="num tn dim">{e.id}</td><td class="dim">{e.message.split("\n")[0]}</td></tr>}
              </For>
            </tbody>
          </table>
        </div>
      </Card>
      <Show when={sel()}>{(e) => (
        <Drawer title={`${e().provider} · ${e().id}`} onClose={() => setSel(null)}>
          <div class="col"><span class="small dim">{new Date(e().time).toLocaleString()} · {e().channel}</span><pre class="inset selectable small" style={{ "white-space": "pre-wrap" }}>{e().message || "(no message text)"}</pre></div>
        </Drawer>
      )}</Show>
    </div>
  );
}

function Sessions() {
  const s = usePoll<Session[]>(() => call("sessions"), 10000, []);
  return (
    <div class="col" style={{ gap: "var(--gap)" }}>
      <Card title="Signed-in sessions" icon="users" sub="From Windows Terminal Services. No keystrokes or window contents are recorded.">
        <table class="t">
          <thead><tr><th class="num">ID</th><th>User</th><th>Station</th><th>State</th><th>Connection</th><th></th></tr></thead>
          <tbody>
            <For each={s.data()}>{(x) => <tr><td class="num tn">{x.id}</td><td>{x.user ? `${x.domain ? x.domain + "\\" : ""}${x.user}` : <span class="dim">—</span>}</td><td class="dim">{x.station}</td><td><span class={`badge ${x.state === "Active" ? "ok" : ""}`}>{x.state}</span></td><td class="dim">{x.protocol}</td><td>{x.current ? <span class="badge ac">This session</span> : ""}</td></tr>}</For>
          </tbody>
        </table>
      </Card>
      <Card title="Remote Desktop" icon="monitor">
        <p class="small muted">Windows 11 Home can connect <i>to</i> other PCs but can't host Remote Desktop sessions. Pro and above can enable hosting in Settings.</p>
        <div class="row" style={{ "margin-top": "10px" }}>
          <button class="btn" onClick={() => call("open_settings", { uri: "ms-settings:remotedesktop" })}>Remote Desktop settings</button>
          <button class="btn" onClick={() => call("open_settings", { uri: "ms-settings:otherusers" })}>Other users</button>
        </div>
      </Card>
    </div>
  );
}
