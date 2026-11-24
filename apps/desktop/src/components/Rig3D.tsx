import { onCleanup, onMount } from "solid-js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { Preset } from "../lib/api";
import { hexToRgb, hsvToRgb } from "../lib/format";

/** JS mirror of the Rust `shade()` so the model shows exactly what the LEDs do. */
export function shade(p: Preset, base: [number, number, number], t: number, pos: number, temp: number | null): [number, number, number] {
  const sp = 0.1 + (p.speed / 100) * 1.9;
  const k = p.brightness / 100;
  const c2 = hexToRgb(p.color2);
  const lerp = (a: number[], b: number[], f: number) => a.map((v, i) => v + (b[i] - v) * Math.max(0, Math.min(1, f))) as [number, number, number];
  const sc = (c: number[], f: number) => c.map((v) => v * Math.max(0, Math.min(1, f))) as [number, number, number];
  let px: [number, number, number];
  switch (p.effect) {
    case "off": return [0, 0, 0];
    case "breathing": px = sc(base, 0.06 + 0.94 * (0.5 - 0.5 * Math.cos(t * sp * Math.PI))); break;
    case "pulse": { const f = (t * sp * 1.2) % 1; px = sc(base, f < 0.15 ? f / 0.15 : Math.pow(1 - (f - 0.15) / 0.85, 2)); break; }
    case "rainbow": px = hsvToRgb(t * sp * 90 + 360 * pos, 1, 1); break;
    case "cycle": px = hsvToRgb(t * sp * 60, 1, 1); break;
    case "wave": px = lerp(base, c2, 0.5 + 0.5 * Math.sin((pos * 2 - t * sp) * Math.PI * 2)); break;
    case "temperature": px = lerp(base, c2, temp == null ? 0.3 : Math.max(0, Math.min(1, (temp - 35) / 50))); break;
    default: px = base;
  }
  return sc(px, k);
}

export const SLOT_IDS = ["rear", "front1", "front2", "front3", "cpu"];

interface Props {
  preset: () => Preset;
  slotColor: (id: string) => string;
  selected: () => Set<string>;
  temp: () => number | null;
  onPick: (id: string | null, additive: boolean) => void;
  reducedMotion?: () => boolean;
}

export default function Rig3D(props: Props) {
  let host!: HTMLDivElement;
  onMount(() => {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(8.2, 3.2, 11.5);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 8;
    controls.maxDistance = 22;
    controls.maxPolarAngle = Math.PI * 0.62;
    controls.target.set(0, -0.1, 0);
    controls.enablePan = false;

    scene.add(new THREE.AmbientLight(0x8890a0, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(4, 8, 6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fb4ff, 0.35);
    rim.position.set(-6, 2, -5);
    scene.add(rim);

    const metal = new THREE.MeshStandardMaterial({ color: 0x15181e, roughness: 0.55, metalness: 0.6 });
    const metal2 = new THREE.MeshStandardMaterial({ color: 0x1d2028, roughness: 0.5, metalness: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x0c0d11, roughness: 0.7, metalness: 0.3 });
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      b.position.set(x, y, z);
      scene.add(b);
      return b;
    };
    // Case: X depth (front +X), Y height, Z width (glass side +Z)
    const fx = 2.3, bx = -2.3, top = 2.45, bot = -2.45, gz = 1.15;
    box(4.7, 0.08, 2.4, metal, 0, top + 0.04, 0);
    box(4.7, 0.08, 2.4, metal, 0, bot - 0.04, 0);
    box(0.08, 5.0, 2.4, metal, bx - 0.04, 0, 0);
    box(4.7, 5.0, 0.08, metal, 0, 0, -gz - 0.04);
    box(0.22, 5.0, 0.12, dark, fx + 0.05, 0, gz - 0.05);
    box(0.22, 5.0, 0.12, dark, fx + 0.05, 0, -gz + 0.05);
    box(0.22, 0.14, 2.3, dark, fx + 0.05, top - 0.03, 0);
    box(0.22, 0.14, 2.3, dark, fx + 0.05, bot + 0.03, 0);
    for (const x of [-1.9, 1.9]) for (const z of [-0.85, 0.85]) box(0.5, 0.18, 0.3, dark, x, bot - 0.16, z);
    const tray = new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 0.8, emissive: new THREE.Color(0, 0, 0) });
    box(3.3, 3.6, 0.06, tray, -0.4, 0.55, -1.0);
    for (let i = 0; i < 2; i++) box(0.06, 1.1, 0.3, metal2, 0.62 + i * 0.13, 1.25, -0.82);
    box(3.9, 1.2, 2.25, new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.6, metalness: 0.4 }), -0.35, -1.85, 0);
    box(2.9, 0.62, 1.1, metal2, -0.7, -0.75, -0.42);
    box(2.9, 0.06, 1.12, new THREE.MeshStandardMaterial({ color: 0x2a2d35, roughness: 0.4, metalness: 0.7 }), -0.7, -0.45, -0.42);
    box(1.1, 0.12, 0.02, new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1.0, 0.62, 0.25), emissiveIntensity: 1.4 }), -0.55, -0.78, 0.14);
    box(0.55, 1.45, 1.05, new THREE.MeshStandardMaterial({ color: 0x262931, roughness: 0.35, metalness: 0.85 }), -0.75, 1.15, -0.45);
    box(0.6, 0.08, 1.1, dark, -0.75, 1.92, -0.45);

    // Fans
    const ledMats = new Map<string, THREE.MeshStandardMaterial>();
    const halos = new Map<string, THREE.Mesh>();
    const blades: THREE.Group[] = [];
    const pickables: THREE.Object3D[] = [];
    const glows = new Map<string, THREE.PointLight>();
    const addFan = (id: string, size: number, pos: THREE.Vector3) => {
      const g = new THREE.Group();
      g.position.copy(pos);
      g.rotation.y = Math.PI / 2; // face +X
      const h = size / 2, d = 0.25, w = 0.07;
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x121317, roughness: 0.6, metalness: 0.4 });
      for (const [bw, bh, x, y] of [[size, w, 0, h - w / 2], [size, w, 0, -h + w / 2], [w, size, h - w / 2, 0], [w, size, -h + w / 2, 0]] as const) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, d), frameMat);
        m.position.set(x, y, 0);
        g.add(m);
      }
      const r = h * 0.86;
      const led = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(0.5, 0.4, 1), emissiveIntensity: 1.25, roughness: 0.3 });
      ledMats.set(id, led);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.05, 12, 72), led);
      g.add(ring);
      const ring2 = new THREE.Mesh(new THREE.TorusGeometry(r * 0.28, 0.028, 10, 40), led);
      ring2.position.z = 0.1;
      g.add(ring2);
      const hub = new THREE.Mesh(new THREE.CircleGeometry(r * 0.26, 32), dark);
      hub.position.z = 0.11;
      g.add(hub);
      const bg = new THREE.Group();
      const bladeMat = new THREE.MeshStandardMaterial({ color: 0x2b2c36, roughness: 0.4, metalness: 0.2, transparent: true, opacity: 0.85 });
      for (let i = 0; i < 7; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(r * 0.55, r * 0.2, 0.02), bladeMat);
        b.position.set(r * 0.5, 0, 0);
        const piv = new THREE.Group();
        piv.rotation.z = (i * Math.PI * 2) / 7;
        b.rotation.x = 0.45;
        piv.add(b);
        bg.add(piv);
      }
      g.add(bg);
      blades.push(bg);
      const halo = new THREE.Mesh(new THREE.TorusGeometry(h * 1.03, 0.03, 8, 72), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      halo.position.z = d / 2 + 0.02;
      halo.visible = false;
      halos.set(id, halo);
      g.add(halo);
      const hit = new THREE.Mesh(new THREE.CircleGeometry(h, 24), new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
      hit.userData.slot = id;
      g.add(hit);
      pickables.push(hit, ring);
      ring.userData.slot = id;
      const pl = new THREE.PointLight(0x8866ff, 1.2, 3.2, 2);
      pl.position.set(0, 0, 0.4);
      g.add(pl);
      glows.set(id, pl);
      scene.add(g);
    };
    addFan("cpu", 1.2, new THREE.Vector3(-0.35, 1.15, -0.45));
    addFan("rear", 1.2, new THREE.Vector3(bx + 0.2, 1.35, -0.25));
    addFan("front1", 1.36, new THREE.Vector3(fx - 0.2, 1.48, 0));
    addFan("front2", 1.36, new THREE.Vector3(fx - 0.2, 0.05, 0));
    addFan("front3", 1.36, new THREE.Vector3(fx - 0.2, -1.38, 0));

    // Transparent shells
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.03, 4.75, 2.1), new THREE.MeshStandardMaterial({ color: 0x07080b, transparent: true, opacity: 0.62, roughness: 0.9, depthWrite: false }));
    mesh.position.set(fx + 0.1, 0, 0);
    scene.add(mesh);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(4.6, 4.9, 0.02), new THREE.MeshPhysicalMaterial({ color: 0x9fb0c8, transparent: true, opacity: 0.1, roughness: 0.05, metalness: 0.1, clearcoat: 1, depthWrite: false }));
    glass.position.set(-0.05, 0, gz);
    scene.add(glass);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.7, 0.5, 0.22);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const resize = () => {
      const w = host.clientWidth, h = host.clientHeight;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // Picking (click without drag)
    const ray = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const el = renderer.domElement;
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
      down = null;
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(pickables, false)[0];
      props.onPick(hit ? hit.object.userData.slot : null, e.ctrlKey || e.shiftKey);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);

    const clock = new THREE.Clock();
    let raf = 0;
    let last = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const t = clock.getElapsedTime();
      if (document.visibilityState !== "visible" || t - last < 1 / 40) return;
      last = t;
      const p = props.preset();
      const sel = props.selected();
      const temp = props.temp();
      let ar = 0, ag = 0, ab = 0;
      SLOT_IDS.forEach((id, i) => {
        const c = shade(p, hexToRgb(props.slotColor(id)), t, i / SLOT_IDS.length, temp);
        const col = new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255);
        const m = ledMats.get(id)!;
        m.emissive.copy(col);
        glows.get(id)!.color.copy(col);
        glows.get(id)!.intensity = 0.4 + (Math.max(...c) / 255) * 1.4;
        halos.get(id)!.visible = sel.has(id);
        ar += c[0]; ag += c[1]; ab += c[2];
      });
      tray.emissive.setRGB(ar / 5 / 255 * 0.12, ag / 5 / 255 * 0.12, ab / 5 / 255 * 0.12);
      if (!props.reducedMotion?.()) for (const b of blades) b.rotation.z -= 0.18;
      controls.update();
      composer.render();
    };
    loop();

    onCleanup(() => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      controls.dispose();
      composer.dispose();
      renderer.dispose();
      scene.traverse((o: any) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => m.dispose()); });
      el.remove();
    });
  });
  return <div ref={host} style={{ position: "absolute", inset: 0 }} />;
}
