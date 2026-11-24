import { createSignal, For, Show } from "solid-js";

/** Temperature → duty curve editor (FANS-05). Drag points, double-click to add, right-click to remove. */
export default function CurveEditor(props: { points: [number, number][]; onChange: (p: [number, number][]) => void; floor: number; temp?: number | null; disabled?: boolean }) {
  const W = 520, H = 220, PAD = 34;
  const x = (t: number) => PAD + ((t - 20) / 80) * (W - PAD - 10);
  const y = (p: number) => H - PAD - (p / 100) * (H - PAD - 10);
  const tOf = (px: number) => Math.round(20 + ((px - PAD) / (W - PAD - 10)) * 80);
  const pOf = (py: number) => Math.round(((H - PAD - py) / (H - PAD - 10)) * 100);
  const [drag, setDrag] = createSignal<number | null>(null);
  let svg!: SVGSVGElement;
  const sorted = () => [...props.points].sort((a, b) => a[0] - b[0]);
  const local = (e: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };
  const move = (e: PointerEvent) => {
    const i = drag();
    if (i == null || props.disabled) return;
    const [px, py] = local(e);
    const pts = sorted().map((p) => [...p] as [number, number]);
    const lo = i > 0 ? pts[i - 1][0] + 1 : 20;
    const hi = i < pts.length - 1 ? pts[i + 1][0] - 1 : 100;
    pts[i] = [Math.max(lo, Math.min(hi, tOf(px))), Math.max(props.floor, Math.min(100, pOf(py)))];
    props.onChange(pts);
  };
  const interp = (t: number) => {
    const p = sorted();
    if (!p.length) return 0;
    if (t <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) if (t <= p[i][0]) return p[i - 1][1] + ((p[i][1] - p[i - 1][1]) * (t - p[i - 1][0])) / (p[i][0] - p[i - 1][0]);
    return p[p.length - 1][1];
  };
  return (
    <svg ref={svg} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", "touch-action": "none", opacity: props.disabled ? 0.5 : 1 }}
      onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}
      onDblClick={(e) => { if (props.disabled) return; const [px, py] = local(e); const t = tOf(px); if (t < 20 || t > 100) return; props.onChange([...props.points, [t, Math.max(props.floor, pOf(py))]].sort((a, b) => a[0] - b[0]) as [number, number][]); }}
      role="img" aria-label="Fan curve: temperature to fan speed">
      <For each={[0, 25, 50, 75, 100]}>{(p) => <><line x1={PAD} x2={W - 10} y1={y(p)} y2={y(p)} stroke="var(--line)" /><text x={PAD - 6} y={y(p) + 4} text-anchor="end" font-size="10" fill="var(--t3)">{p}%</text></>}</For>
      <For each={[20, 40, 60, 80, 100]}>{(t) => <><line x1={x(t)} x2={x(t)} y1={10} y2={H - PAD} stroke="var(--line)" /><text x={x(t)} y={H - PAD + 16} text-anchor="middle" font-size="10" fill="var(--t3)">{t}°C</text></>}</For>
      <rect x={PAD} y={y(props.floor)} width={W - PAD - 10} height={H - PAD - y(props.floor)} fill="var(--bad)" opacity="0.06" />
      <line x1={PAD} x2={W - 10} y1={y(props.floor)} y2={y(props.floor)} stroke="var(--bad)" stroke-dasharray="4 4" opacity="0.6" />
      <text x={W - 12} y={y(props.floor) - 4} text-anchor="end" font-size="10" fill="var(--bad)">min {props.floor}%</text>
      <rect x={x(90)} y={10} width={x(100) - x(90)} height={H - PAD - 10} fill="var(--warn)" opacity="0.07" />
      <text x={x(95)} y={22} text-anchor="middle" font-size="9" fill="var(--warn)">100% zone</text>
      <path d={"M" + sorted().map((p) => `${x(p[0])},${y(p[1])}`).join(" L")} fill="none" stroke="var(--ac)" stroke-width="2.5" />
      <path d={`M${x(sorted()[0]?.[0] ?? 20)},${H - PAD} L` + sorted().map((p) => `${x(p[0])},${y(p[1])}`).join(" L") + ` L${x(sorted()[sorted().length - 1]?.[0] ?? 100)},${H - PAD} Z`} fill="var(--ac)" opacity="0.1" />
      <Show when={props.temp != null}>
        <line x1={x(props.temp!)} x2={x(props.temp!)} y1={10} y2={H - PAD} stroke="var(--t1)" stroke-dasharray="2 3" />
        <circle cx={x(props.temp!)} cy={y(interp(props.temp!))} r="5" fill="var(--t1)" />
        <text x={x(props.temp!) + 6} y={y(interp(props.temp!)) - 8} font-size="10.5" fill="var(--t1)">{Math.round(props.temp!)}°C → {Math.round(interp(props.temp!))}%</text>
      </Show>
      <For each={sorted()}>
        {(p, i) => (
          <circle cx={x(p[0])} cy={y(p[1])} r={drag() === i() ? 8 : 6.5} fill="var(--panel-solid)" stroke="var(--ac)" stroke-width="2.5" style={{ cursor: props.disabled ? "default" : "grab" }}
            onPointerDown={(e) => { (e.currentTarget as any).ownerSVGElement.setPointerCapture(e.pointerId); setDrag(i()); }}
            onContextMenu={(e) => { e.preventDefault(); if (!props.disabled && props.points.length > 2) props.onChange(sorted().filter((_, j) => j !== i())); }}>
            <title>{p[0]}°C → {p[1]}% (right-click to remove)</title>
          </circle>
        )}
      </For>
    </svg>
  );
}
