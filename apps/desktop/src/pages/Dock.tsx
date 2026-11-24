import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { call, on, type Win, type Focus } from "../lib/api";
import { loadPrefs, prefs } from "../lib/store";
import { file, clock } from "../lib/format";
import { Icon } from "../components/ui";

/** Floating glass dock (SHELL-01/02): pinned apps, running windows, focus timer, clock. */
export default function Dock() {
  const [wins, setWins] = createSignal<Win[]>([]);
  const [focus, setFocus] = createSignal<Focus | null>(null);
  const [now, setNow] = createSignal(new Date());
  const refresh = async () => {
    try { setWins(await call<Win[]>("windows_list")); setFocus(await call<Focus | null>("focus_current")); } catch { /* not in shell */ }
  };
  onMount(() => {
    loadPrefs();
    refresh();
    const a = setInterval(refresh, 2500);
    const b = setInterval(() => setNow(new Date()), 1000);
    on("focus", refresh);
    onCleanup(() => { clearInterval(a); clearInterval(b); });
  });
  const pins = () => prefs().dock_pins;
  const running = createMemo(() => {
    const seen = new Set<string>();
    return wins().filter((w) => { const k = w.exe.toLowerCase(); if (seen.has(k) || pins().some((p) => p.toLowerCase() === k)) return false; seen.add(k); return true; }).slice(0, 10);
  });
  const isRunning = (exe: string) => wins().some((w) => w.exe.toLowerCase() === exe.toLowerCase());
  const letter = (exe: string) => file(exe).replace(/\.exe$/i, "").slice(0, 2);
  const activate = (exe: string) => {
    const w = wins().find((x) => x.exe.toLowerCase() === exe.toLowerCase());
    if (w) call("wm_window", { hwnd: w.hwnd, action: "focus" });
    else call("launch_path", { path: exe }).catch(() => {});
  };
  return (
    <div class="dock-root" style={{ background: "transparent" }}>
      <nav class="dock" aria-label="Dock">
        <For each={pins()}>{(p) => <button class={`dock-app ${isRunning(p) ? "run" : ""}`} title={file(p)} aria-label={file(p)} onClick={() => activate(p)}>{letter(p)}</button>}</For>
        <Show when={pins().length && running().length}><div class="dock-sep" /></Show>
        <For each={running()}>{(w) => <button class="dock-app run" title={w.title} aria-label={w.title} onClick={() => call("wm_window", { hwnd: w.hwnd, action: "focus" })}>{letter(w.exe)}</button>}</For>
        <div class="dock-sep" />
        <Show when={focus()}>
          <div class="row small tn" style={{ padding: "0 8px", color: "var(--ac)" }} title="Focus session"><Icon name="play" size={13} />{clock(now().getTime() / 1000 - focus()!.start)}</div>
          <div class="dock-sep" />
        </Show>
        <div class="dock-clock tn">
          <div style={{ "font-weight": 600 }}>{now().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</div>
          <div class="small dim">{now().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</div>
        </div>
      </nav>
    </div>
  );
}
