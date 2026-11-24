import { createSignal, onCleanup, onMount, For, Show, JSX, createMemo, splitProps } from "solid-js";
import { confirmReq, setConfirmReq, toasts, setToasts } from "../lib/store";

// ---------- icons (original stroke set) ----------
const P: Record<string, string> = {
  home: "M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5",
  workspace: "M3 5h18v14H3zM9 5v14M15 5v14",
  activity: "M3 12h4l3-7 4 14 3-7h4",
  system: "M4 5h16v11H4zM8 20h8M12 16v4",
  studio: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 5a4 4 0 1 1 0 8 4 4 0 0 1 0-8z",
  flow: "M5 6h11M5 12h14M5 18h8M18 15l3 3-3 3",
  settings: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.8-4.8",
  min: "M6 12h12",
  max: "M6 6h12v12H6z",
  close: "M6 6l12 12M18 6 6 18",
  sidebar: "M3 4h18v16H3zM9 4v16",
  cpu: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  gpu: "M3 7h18v10H3zM7 17v3M17 17v3M8 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0M15 10h3",
  ram: "M3 8h18v8H3zM7 8v8M11 8v8M15 8v8M5 16v3M19 16v3",
  net: "M4 9a12 12 0 0 1 16 0M7 12.5a7 7 0 0 1 10 0M10 16a2.5 2.5 0 0 1 4 0M12 19.5h0",
  disk: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3zM4 6c0 1.7 3.6 3 8 3s8-1.3 8-3",
  temp: "M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0z",
  fan: "M12 12m-1.5 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M12 10.5C12 6 14 3 16.5 4.5S15 10 12 10.5zM13.5 12c4.5 0 7.5 2 6 4.5S14 15 13.5 12zM12 13.5C12 18 10 21 7.5 19.5S9 14 12 13.5zM10.5 12C6 12 3 10 4.5 7.5S10 9 10.5 12z",
  light: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z",
  audio: "M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11",
  task: "M9 11l3 3 8-8M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11",
  zap: "M13 3 4 14h7l-1 7 9-11h-7z",
  clip: "M9 4h6v3H9zM8 5H6v15h12V5h-2",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.4-8 9-4.6-.6-8-4.5-8-9V6z",
  key: "M14 10a4 4 0 1 0-4.6 4L4 19.5V21h3v-2h2v-2h2l1.4-1.4A4 4 0 0 0 14 10z",
  backup: "M12 3v12M7 10l5 5 5-5M4 19h16",
  info: "M12 8h0M11 11h1v6h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  play: "M7 5v14l11-7z",
  pause: "M8 5v14M16 5v14",
  stop: "M6 6h12v12H6z",
  refresh: "M20 11a8 8 0 1 0-2.3 5.6M20 4v7h-7",
  more: "M5 12h0M12 12h0M19 12h0",
  check: "M5 12.5l4.5 4.5L19 7",
  chev: "M9 6l6 6-6 6",
  down: "M6 9l6 6 6-6",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  copy: "M8 8h12v12H8zM4 16V4h12",
  pin: "M9 4h6l-1 6 4 3H6l4-3zM12 13v8",
  layers: "M12 3 3 8l9 5 9-5zM3 13l9 5 9-5",
  monitor: "M3 5h18v12H3zM9 21h6M12 17v4",
  bolt: "M13 3 4 14h7l-1 7 9-11h-7z",
  alert: "M12 4 2.5 20h19zM12 10v4M12 17h0",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  power: "M12 3v9M6.3 7.5a8 8 0 1 0 11.4 0",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  note: "M5 4h14v16H5zM9 8h6M9 12h6M9 16h3",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14a5 5 0 0 1 3.5 6",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  gamepad: "M6 9h12a4 4 0 0 1 4 4v1a3 3 0 0 1-5.4 1.8L15 14H9l-1.6 1.8A3 3 0 0 1 2 14v-1a4 4 0 0 1 4-4zM7 11v3M5.5 12.5h3M16 12h0M18 13.5h0",
};
export function Icon(props: { name: string; size?: number; stroke?: number; class?: string; style?: JSX.CSSProperties }) {
  return (
    <svg width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width={props.stroke ?? 1.7} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class={props.class} style={props.style}>
      <path d={P[props.name] ?? P.info} />
    </svg>
  );
}

export function Logo(props: { size?: number }) {
  const s = props.size ?? 28;
  return (
    <svg width={s} height={s} viewBox="0 0 28 28" aria-hidden="true" style={{ flex: "none" }}>
      <rect x="1" y="1" width="26" height="26" rx="8" fill="var(--raise-2)" stroke="var(--line-2)" />
      <circle cx="14" cy="14" r="6.2" fill="none" stroke="var(--ac)" stroke-width="2.2" />
      <circle cx="14" cy="14" r="2" fill="var(--ac)" />
    </svg>
  );
}

// ---------- layout ----------
export function Card(props: { title?: JSX.Element; sub?: JSX.Element; actions?: JSX.Element; class?: string; style?: JSX.CSSProperties; children?: JSX.Element; icon?: string }) {
  return (
    <section class={`card ${props.class ?? ""}`} style={props.style}>
      <Show when={props.title || props.actions}>
        <div class="card-h">
          <Show when={props.icon}><Icon name={props.icon!} size={17} style={{ color: "var(--t3)" }} /></Show>
          <Show when={props.title}><h3>{props.title}</h3></Show>
          <Show when={props.sub}><span class="sub">{props.sub}</span></Show>
          <span class="grow" />
          {props.actions}
        </div>
      </Show>
      {props.children}
    </section>
  );
}

export function Tabs<T extends string>(props: { tabs: { id: T; label: string; icon?: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div class="tabs" role="tablist">
      <For each={props.tabs}>
        {(t) => (
          <button class={`tab ${props.value === t.id ? "on" : ""}`} role="tab" aria-selected={props.value === t.id} onClick={() => props.onChange(t.id)}>
            <Show when={t.icon}><Icon name={t.icon!} size={15} /></Show>
            {t.label}
          </button>
        )}
      </For>
    </div>
  );
}

export function Seg<T extends string | number>(props: { options: { v: T; label: string }[]; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <div class="seg" role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(o) => <button role="radio" aria-checked={props.value === o.v} class={props.value === o.v ? "on" : ""} onClick={() => props.onChange(o.v)}>{o.label}</button>}
      </For>
    </div>
  );
}

export function Toggle(props: { value: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return <button class={`toggle ${props.value ? "on" : ""}`} role="switch" aria-checked={props.value} aria-label={props.label} disabled={props.disabled} onClick={() => props.onChange(!props.value)} />;
}

export function Slider(props: { value: number; min?: number; max?: number; step?: number; onInput: (v: number) => void; onChange?: (v: number) => void; plain?: boolean; track?: string; label?: string; disabled?: boolean }) {
  const min = () => props.min ?? 0;
  const max = () => props.max ?? 100;
  const p = () => ((props.value - min()) / (max() - min())) * 100;
  return (
    <input type="range" class={`slider ${props.plain ? "plain" : ""}`} aria-label={props.label} min={min()} max={max()} step={props.step ?? 1} value={props.value} disabled={props.disabled}
      style={{ "--p": `${p()}%`, ...(props.track ? { "--track": props.track } : {}) } as any}
      onInput={(e) => props.onInput(+e.currentTarget.value)} onChange={(e) => props.onChange?.(+e.currentTarget.value)} />
  );
}

export function Row(props: { label: JSX.Element; hint?: JSX.Element; children: JSX.Element }) {
  return (
    <div class="row" style={{ "min-height": "44px", "border-bottom": "1px solid var(--line)", padding: "6px 0" }}>
      <div class="grow">
        <div>{props.label}</div>
        <Show when={props.hint}><div class="small dim">{props.hint}</div></Show>
      </div>
      {props.children}
    </div>
  );
}

export function Empty(props: { title: string; children?: JSX.Element; icon?: string }) {
  return (
    <div class="empty">
      <Icon name={props.icon ?? "info"} size={26} />
      <b>{props.title}</b>
      <div class="small" style={{ "max-width": "460px" }}>{props.children}</div>
    </div>
  );
}

export function Stat(props: { label: string; value: JSX.Element; unit?: string; children?: JSX.Element; icon?: string; tone?: string }) {
  return (
    <div class="stat">
      <div class="row lbl" style={{ gap: "7px" }}><Show when={props.icon}><Icon name={props.icon!} size={14} /></Show>{props.label}</div>
      <div><span class="v tn" style={{ color: props.tone }}>{props.value}</span><Show when={props.unit}><span class="u">{props.unit}</span></Show></div>
      {props.children}
    </div>
  );
}

// ---------- charts ----------
export function Spark(props: { data: (number | null)[]; max?: number; height?: number; color?: string; fill?: boolean }) {
  const h = () => props.height ?? 36;
  const path = createMemo(() => {
    const d = props.data.map((v) => v ?? 0);
    if (d.length < 2) return { line: "", area: "" };
    const max = props.max ?? Math.max(1, ...d);
    const step = 100 / (d.length - 1);
    const pts = d.map((v, i) => `${(i * step).toFixed(2)},${(h() - (v / max) * (h() - 2) - 1).toFixed(2)}`);
    return { line: "M" + pts.join(" L"), area: `M0,${h()} L` + pts.join(" L") + ` L100,${h()} Z` };
  });
  return (
    <svg class="spark" viewBox={`0 0 100 ${h()}`} preserveAspectRatio="none" style={{ height: `${h()}px` }} aria-hidden="true">
      <Show when={props.fill !== false}><path d={path().area} fill={props.color ?? "var(--ac)"} opacity="0.13" /></Show>
      <path d={path().line} fill="none" stroke={props.color ?? "var(--ac)"} stroke-width="1.6" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

export function Chart(props: { series: { data: (number | null)[]; color: string; label: string }[]; max?: number; height?: number; unit?: (v: number) => string; markers?: { at: number; label: string }[] }) {
  const h = () => props.height ?? 180;
  const max = createMemo(() => props.max ?? Math.max(1, ...props.series.flatMap((s) => s.data.map((v) => v ?? 0))) * 1.1);
  const paths = createMemo(() =>
    props.series.map((s) => {
      const d = s.data;
      if (d.length < 2) return "";
      const step = 1000 / (d.length - 1);
      return "M" + d.map((v, i) => `${(i * step).toFixed(1)},${(h() - ((v ?? 0) / max()) * h()).toFixed(1)}`).join(" L");
    }),
  );
  const [hover, setHover] = createSignal<number | null>(null);
  const len = () => Math.max(...props.series.map((s) => s.data.length), 0);
  return (
    <div style={{ position: "relative" }}>
      <svg class="chart" viewBox={`0 0 1000 ${h()}`} preserveAspectRatio="none" style={{ height: `${h()}px` }}
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.round(((e.clientX - r.left) / r.width) * (len() - 1))); }}
        onMouseLeave={() => setHover(null)} role="img" aria-label={props.series.map((s) => s.label).join(", ")}>
        <For each={[0.25, 0.5, 0.75]}>{(f) => <line x1="0" x2="1000" y1={h() * f} y2={h() * f} stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke" />}</For>
        <For each={props.markers ?? []}>{(m) => <line x1={(m.at / Math.max(1, len() - 1)) * 1000} x2={(m.at / Math.max(1, len() - 1)) * 1000} y1="0" y2={h()} stroke="var(--warn)" stroke-dasharray="4 4" vector-effect="non-scaling-stroke" />}</For>
        <For each={paths()}>{(d, i) => <>
          <path d={d ? d + ` L1000,${h()} L0,${h()} Z` : ""} fill={props.series[i()].color} opacity="0.08" />
          <path d={d} fill="none" stroke={props.series[i()].color} stroke-width="1.8" vector-effect="non-scaling-stroke" />
        </>}</For>
        <Show when={hover() != null}><line x1={(hover()! / Math.max(1, len() - 1)) * 1000} x2={(hover()! / Math.max(1, len() - 1)) * 1000} y1="0" y2={h()} stroke="var(--t3)" vector-effect="non-scaling-stroke" /></Show>
      </svg>
      <Show when={hover() != null}>
        <div class="inset small" style={{ position: "absolute", top: "6px", left: `min(calc(${(hover()! / Math.max(1, len() - 1)) * 100}% + 10px), calc(100% - 180px))`, "pointer-events": "none", background: "var(--panel-solid)", padding: "6px 10px" }}>
          <For each={props.series}>{(s) => <div><i class="dot" style={{ background: s.color, display: "inline-block", "margin-right": "6px" }} />{s.label}: <b class="tn">{props.unit ? props.unit(s.data[hover()!] ?? 0) : (s.data[hover()!] ?? 0).toFixed(1)}</b></div>}</For>
          <For each={(props.markers ?? []).filter((m) => Math.abs(m.at - hover()!) < 3)}>{(m) => <div style={{ color: "var(--warn)" }}>{m.label}</div>}</For>
        </div>
      </Show>
    </div>
  );
}

export function Gauge(props: { value: number | null; max?: number; size?: number; label?: string; color?: string; children?: JSX.Element }) {
  const s = () => props.size ?? 112;
  const r = () => s() / 2 - 8;
  const c = () => 2 * Math.PI * r();
  const f = () => Math.max(0, Math.min(1, (props.value ?? 0) / (props.max ?? 100)));
  return (
    <div style={{ position: "relative", width: `${s()}px`, height: `${s()}px`, flex: "none" }}>
      <svg width={s()} height={s()} class="ring" aria-hidden="true">
        <circle cx={s() / 2} cy={s() / 2} r={r()} fill="none" stroke="var(--raise-2)" stroke-width="7" />
        <circle cx={s() / 2} cy={s() / 2} r={r()} fill="none" stroke={props.color ?? "var(--ac)"} stroke-width="7" stroke-linecap="round"
          stroke-dasharray={`${c()}`} stroke-dashoffset={`${c() * (1 - f())}`} style={{ transition: "stroke-dashoffset .6s var(--ease)" }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", "place-items": "center", "text-align": "center" }}>{props.children}</div>
    </div>
  );
}

export function Bar(props: { value: number; max?: number; color?: string }) {
  return <div class="bar"><i style={{ width: `${Math.min(100, (props.value / (props.max ?? 100)) * 100)}%`, background: props.color }} /></div>;
}

// ---------- overlays ----------
export function Modal(props: { onClose: () => void; children: JSX.Element; wide?: boolean; label?: string }) {
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
  onMount(() => document.addEventListener("keydown", key));
  onCleanup(() => document.removeEventListener("keydown", key));
  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class={`modal ${props.wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={props.label}>{props.children}</div>
    </div>
  );
}

export function Drawer(props: { title: JSX.Element; onClose: () => void; children: JSX.Element; actions?: JSX.Element }) {
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
  onMount(() => document.addEventListener("keydown", key));
  onCleanup(() => document.removeEventListener("keydown", key));
  return (
    <aside class="drawer" role="dialog" aria-modal="false">
      <div class="drawer-h">
        <h3 class="grow ellipsis" style={{ "font-size": "16px", "font-weight": 600 }}>{props.title}</h3>
        {props.actions}
        <button class="btn ghost icon" onClick={props.onClose} aria-label="Close"><Icon name="close" /></button>
      </div>
      <div class="drawer-b">{props.children}</div>
    </aside>
  );
}

export function ConfirmHost() {
  return (
    <Show when={confirmReq()}>
      {(r) => {
        const done = (v: boolean) => { r().resolve(v); setConfirmReq(null); };
        return (
          <Modal onClose={() => done(false)} label={r().title}>
            <h2>{r().title}</h2>
            <p class="muted" style={{ "margin-bottom": "12px" }}>{r().body}</p>
            <Show when={r().detail?.length}>
              <div class="inset mono selectable" style={{ "max-height": "180px", overflow: "auto", "margin-bottom": "14px" }}>
                <For each={r().detail}>{(d) => <div>{d}</div>}</For>
              </div>
            </Show>
            <div class="row" style={{ "justify-content": "flex-end" }}>
              <button class="btn" onClick={() => done(false)}>Cancel</button>
              <button class={`btn ${r().danger ? "danger solid" : "primary"}`} onClick={() => done(true)} autofocus>{r().ok ?? "Continue"}</button>
            </div>
          </Modal>
        );
      }}
    </Show>
  );
}

export function Toasts() {
  return (
    <div class="toasts" aria-live="polite">
      <For each={toasts()}>
        {(t) => (
          <div class={`toast ${t.kind}`}>
            <Icon name={t.kind === "bad" ? "alert" : t.kind === "ok" ? "check" : "info"} size={17} style={{ color: t.kind === "bad" ? "var(--bad)" : t.kind === "ok" ? "var(--ok)" : "var(--ac)", "margin-top": "1px" }} />
            <div class="grow selectable">{t.text}</div>
            <Show when={t.action}><button class="btn sm" onClick={() => { t.action!.run(); setToasts(toasts().filter((x) => x.id !== t.id)); }}>{t.action!.label}</button></Show>
          </div>
        )}
      </For>
    </div>
  );
}

// ---------- data helpers ----------
/** Poll a loader while the component is mounted and the window is visible. */
export function usePoll<T>(load: () => Promise<T>, ms: number, init?: T) {
  const [data, setData] = createSignal<T | undefined>(init);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  let alive = true;
  const run = async () => {
    try { const v = await load(); if (alive) { setData(() => v); setError(null); } }
    catch (e) { if (alive) setError(String(e)); }
    finally { if (alive) setLoading(false); }
  };
  run();
  const t = ms > 0 ? setInterval(() => { if (document.visibilityState === "visible") run(); }, ms) : undefined;
  onCleanup(() => { alive = false; if (t) clearInterval(t); });
  return { data, error, loading, refresh: run, set: setData };
}

export function Search(props: { value: string; onInput: (v: string) => void; placeholder?: string; width?: string }) {
  return (
    <div class="row" style={{ position: "relative", width: props.width ?? "260px" }}>
      <Icon name="search" size={15} style={{ position: "absolute", left: "11px", color: "var(--t3)" }} />
      <input class="input" type="search" style={{ width: "100%", "padding-left": "33px" }} placeholder={props.placeholder ?? "Search"} value={props.value} onInput={(e) => props.onInput(e.currentTarget.value)} aria-label={props.placeholder ?? "Search"} />
    </div>
  );
}

export type SortDir = 1 | -1;
export function useSort<T>(initial: keyof T, dir: SortDir = -1) {
  const [key, setKey] = createSignal<keyof T>(initial);
  const [d, setD] = createSignal<SortDir>(dir);
  const toggle = (k: keyof T) => { if (key() === k) setD((d() * -1) as SortDir); else { setKey(() => k); setD(-1); } };
  const sort = (rows: T[]) => [...rows].sort((a, b) => {
    const x = a[key()] as any, y = b[key()] as any;
    if (typeof x === "string") return x.localeCompare(y) * d();
    return ((x ?? 0) - (y ?? 0)) * d();
  });
  const arrow = (k: keyof T) => (key() === k ? (d() === 1 ? " ↑" : " ↓") : "");
  return { key, toggle, sort, arrow };
}
