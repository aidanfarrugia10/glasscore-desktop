import { createEffect, createSignal, For } from "solid-js";
import { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb } from "../lib/format";

const SWATCHES = ["#FF2D55", "#FF6A00", "#FFC400", "#3DDC84", "#00E5FF", "#2979FF", "#7C5CFF", "#FF3DCD", "#F2E6D0", "#FFFFFF"];

/** Saturation/value square + hue rail + hex field + swatches. Calls onChange while dragging. */
export default function ColorPicker(props: { value: string; onChange: (hex: string) => void; label?: string }) {
  const [hsv, setHsv] = createSignal<[number, number, number]>([0, 0, 1]);
  const [hex, setHex] = createSignal(props.value);
  let keepHue = false;
  createEffect(() => {
    const v = props.value;
    const [r, g, b] = hexToRgb(v);
    const [h, s, val] = rgbToHsv(r, g, b);
    const cur = hsv();
    setHsv([s > 0.001 || !keepHue ? h : cur[0], s, val]);
    setHex(v.toUpperCase());
  });
  const emit = (h: number, s: number, v: number) => {
    keepHue = true;
    setHsv([h, s, v]);
    const [r, g, b] = hsvToRgb(h, s, v);
    const x = rgbToHex(r, g, b);
    setHex(x);
    props.onChange(x);
  };
  const drag = (el: HTMLElement, fn: (fx: number, fy: number) => void) => (e: PointerEvent) => {
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
    };
    move(e);
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  let sv!: HTMLDivElement;
  let hue!: HTMLDivElement;
  return (
    <div class="col" style={{ gap: "12px" }} aria-label={props.label ?? "Colour picker"}>
      <div ref={sv} role="slider" aria-label="Saturation and brightness" tabIndex={0}
        style={{ position: "relative", height: "150px", "border-radius": "12px", cursor: "crosshair", "touch-action": "none",
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv()[0]}, 100%, 50%))`, border: "1px solid var(--line-2)" }}
        onPointerDown={(e) => drag(sv, (fx, fy) => emit(hsv()[0], fx, 1 - fy))(e)}
        onKeyDown={(e) => { const [h, s, v] = hsv(); if (e.key === "ArrowRight") emit(h, Math.min(1, s + 0.05), v); if (e.key === "ArrowLeft") emit(h, Math.max(0, s - 0.05), v); if (e.key === "ArrowUp") emit(h, s, Math.min(1, v + 0.05)); if (e.key === "ArrowDown") emit(h, s, Math.max(0, v - 0.05)); }}>
        <div style={{ position: "absolute", left: `calc(${hsv()[1] * 100}% - 9px)`, top: `calc(${(1 - hsv()[2]) * 100}% - 9px)`, width: "18px", height: "18px", "border-radius": "50%", border: "2.5px solid #fff", "box-shadow": "0 0 0 1px rgba(0,0,0,.4), 0 2px 6px rgba(0,0,0,.5)", background: hex(), "pointer-events": "none" }} />
      </div>
      <div ref={hue} role="slider" aria-label="Hue" aria-valuenow={Math.round(hsv()[0])} tabIndex={0}
        style={{ position: "relative", height: "14px", "border-radius": "7px", cursor: "pointer", "touch-action": "none", background: "linear-gradient(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)", border: "1px solid var(--line-2)" }}
        onPointerDown={(e) => drag(hue, (fx) => emit(fx * 360, Math.max(hsv()[1], 0.05), Math.max(hsv()[2], 0.2)))(e)}
        onKeyDown={(e) => { const [h, s, v] = hsv(); if (e.key === "ArrowRight") emit((h + 5) % 360, s, v); if (e.key === "ArrowLeft") emit((h + 355) % 360, s, v); }}>
        <div style={{ position: "absolute", left: `calc(${(hsv()[0] / 360) * 100}% - 9px)`, top: "-3px", width: "18px", height: "18px", "border-radius": "50%", background: "#fff", "box-shadow": "0 1px 6px rgba(0,0,0,.5)", "pointer-events": "none" }} />
      </div>
      <div class="row">
        <input class="input mono" style={{ width: "110px", "text-transform": "uppercase" }} value={hex()} aria-label="Hex colour"
          onChange={(e) => { const v = e.currentTarget.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) { const x = (v.startsWith("#") ? v : "#" + v).toUpperCase(); setHex(x); props.onChange(x); } else setHex(props.value); }} />
        <div class="row wrap" style={{ gap: "6px" }}>
          <For each={SWATCHES}>{(s) => <button class="swatch" style={{ background: s }} title={s} aria-label={`Use ${s}`} onClick={() => props.onChange(s)} />}</For>
        </div>
      </div>
    </div>
  );
}
