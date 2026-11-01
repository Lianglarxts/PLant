import rough from 'roughjs';
import { Genome, randomGenome, mutate, sanitize } from './genome';
import { Axis, buildStructure, drawPlant, seedColor, seedGroups } from './plant';
import { renderSprite, Sprite, Pt } from './crayon';
import { buildBackground, renderGround, groundY, sunGroups, cloudGroups, dropGroups, SpriteBank } from './scene';
import { mulberry32, hash, range, clamp, clamp01, easeInOut } from './util';

const MAX_PLANTS = 40;
const BOIL_MS = 150;
const SAVE_KEY = 'crayon-garden-v1';

// ---------------- state ----------------
interface Plant {
  id: number;
  seed: number;
  xn: number; // 0..1 across the width
  depth: number; // 0 (back, at the soil line) .. 1 (front)
  gen: number;
  genome: Genome;
  stage: number; // 0..5
  anim: { from: number; to: number; t0: number; dur: number } | null;
  pendingAt: number; // time growth starts (after water drops), or 0
  wilt: number; // -1 = not wilting, else 0..1
  burst: boolean;
  g: number; // current visual stage
  struct: Axis;
  sprites: (Sprite | null)[];
  canvases: HTMLCanvasElement[];
  key: string;
  pod: Pt | null; // CSS px, relative to base
  hover: number;
  hoverTarget: number;
  poke: number;
}
interface FlyingSeed {
  sx: number; sy: number;
  tx: number; ty: number;
  xn: number; depth: number;
  t0: number; dur: number; peak: number;
  spin: number;
  genome: Genome; gen: number; color: string;
  state: 'fly' | 'hop' | 'fade';
  tLand: number;
  id: number;
}
interface Drop { x: number; y0: number; y1: number; t0: number; dur: number; }
interface Puff { x: number; y: number; t0: number; }

let plants: Plant[] = [];
let flying: FlyingSeed[] = [];
let drops: Drop[] = [];
let puffs: Puff[] = [];
let stats = { grown: 0, maxGen: 1 };
let nextId = 1;
let hintDone = false;
let dirty = false;

// ---------------- canvas ----------------
const canvas = document.getElementById('garden') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
let W = 0, H = 0, dpr = 1, worldScale = 1;
let bg: HTMLCanvasElement | null = null;
let grounds: ({ canvas: HTMLCanvasElement; top: number } | null)[] = [];
let bank = new SpriteBank(1);
let sunR = 40;
const clouds = [0, 1, 2].map((i) => ({ seed: 300 + i * 17, x: 0, y: 0, w: 120, speed: 6 + i * 3 }));

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.ceil(W * dpr);
  canvas.height = Math.ceil(H * dpr);
  worldScale = clamp(Math.min(H * 0.4, W * 0.55) / 200, 0.55, 1.6);
  bg = buildBackground(W, H, dpr);
  grounds = [null, null, null];
  bank = new SpriteBank(dpr);
  sunR = clamp(Math.min(W, H) * 0.06, 24, 50);
  const r = mulberry32(99);
  clouds.forEach((c, i) => {
    c.w = clamp(W * 0.14, 80, 170) * range(r, 0.8, 1.2);
    c.y = H * (0.07 + i * 0.05) + range(r, -10, 10);
    if (!c.x) c.x = range(r, 0, W);
  });
  for (const p of plants) p.key = '';
}

// ---------------- plants ----------------
function basePos(p: { xn: number; depth: number }): [number, number] {
  const x = p.xn * W;
  const gy = groundY(x, H);
  return [x, gy + 6 + p.depth * Math.max(0, H - gy - 46) * 0.85];
}
const plantScale = (p: Plant) => worldScale * (0.78 + 0.3 * p.depth);

function makePlant(o: { id?: number; seed: number; xn: number; depth: number; gen: number; genome: Genome; stage?: number; wilt?: number }): Plant {
  const stage = o.stage ?? 0;
  return {
    id: o.id ?? nextId++, seed: o.seed, xn: o.xn, depth: o.depth, gen: o.gen, genome: o.genome,
    stage, anim: null, pendingAt: 0, wilt: o.wilt ?? (stage >= 5 ? 0 : -1), burst: stage >= 5, g: stage,
    struct: buildStructure(o.genome, o.seed),
    sprites: [null, null, null], canvases: [0, 1, 2].map(() => document.createElement('canvas')),
    key: '', pod: null, hover: 0, hoverTarget: 0, poke: 0,
  };
}

function starterSeed(): Plant {
  const seed = (Math.random() * 1e9) | 0;
  const r = mulberry32(seed);
  return makePlant({ seed, xn: 0.5, depth: 0.35, gen: 1, genome: randomGenome(r) });
}

let renderDeadline = Infinity; // per-frame budget for rendering new sprite variants
function spriteFor(p: Plant, boil: number): Sprite | null {
  const wq = p.wilt < 0 ? 0 : Math.round(p.wilt * 24) / 24;
  const sc = plantScale(p);
  const gq = Math.round(p.g * 40) / 40; // ~50 re-renders per stage transition at most
  const key = `${gq}|${wq}|${sc.toFixed(3)}|${dpr}`;
  // a plant that has never been drawn can wait a frame or two (it "draws in" on load)
  if (p.key === '' && !p.sprites.some((q) => q) && performance.now() > renderDeadline) return null;
  if (key !== p.key) {
    p.key = key;
    p.sprites = [null, null, null];
  }
  let s = p.sprites[boil];
  if (!s && performance.now() > renderDeadline) {
    // out of budget this frame: show another boil variant of the same state, render it later
    const other = p.sprites.find((q) => q);
    if (other) return other;
  }
  if (!s) {
    const d = drawPlant(p.struct, p.genome, gq, wq);
    s = renderSprite(d.groups, sc, dpr, p.seed, boil, 8, p.canvases[boil]);
    p.sprites[boil] = s;
    p.pod = d.pod ? [d.pod[0] * sc, d.pod[1] * sc] : null;
  }
  return s;
}

function startGrow(p: Plant, now: number) {
  const from = p.stage;
  p.anim = { from, to: from + 1, t0: now, dur: from === 4 ? 1.6 : from === 3 ? 1.0 : 0.8 };
  p.pendingAt = 0;
}

function emitSeeds(p: Plant, now: number) {
  p.burst = true;
  const [bx, by] = basePos(p);
  const pod = p.pod ?? [0, -60 * plantScale(p)];
  const sx = bx + pod[0], sy = by + pod[1];
  const r = mulberry32(hash(p.seed, p.id, (now * 1000) | 0));
  const n = Math.round(p.genome.seedCount);
  const first = r() < 0.5 ? -1 : 1;
  for (let i = 0; i < n; i++) {
    // alternate sides, and push each pair further out so seeds don't pile up
    const dir = i % 2 === 0 ? first : -first;
    const ring = Math.floor(i / 2);
    let x = bx + dir * (range(r, 40, 90) + ring * 60) * Math.sqrt(worldScale);
    if (x < W * 0.04) x = W * 0.04 + (W * 0.04 - x);
    if (x > W * 0.96) x = W * 0.96 - (x - W * 0.96);
    x = clamp(x, W * 0.04, W * 0.96);
    const xn = x / W;
    const depth = clamp(p.depth + range(r, -0.3, 0.3), 0, 1);
    const [tx, ty] = basePos({ xn, depth });
    const genome = mutate(p.genome, r);
    flying.push({
      sx, sy, tx, ty, xn, depth, t0: now + i * 0.06, dur: range(r, 0.85, 1.25), peak: range(r, 50, 110) * Math.sqrt(worldScale),
      spin: range(r, -9, 9), genome, gen: p.gen + 1, color: seedColor(genome), state: 'fly', tLand: 0, id: nextId++,
    });
  }
}

function canSprout(x: number, y: number) {
  if (plants.length >= MAX_PLANTS) return false;
  const minD = 20 * worldScale;
  for (const q of plants) {
    const [qx, qy] = basePos(q);
    if (Math.hypot((qx - x) * 1, (qy - y) * 1.6) < minD) return false;
  }
  return true;
}

function landSeed(f: FlyingSeed) {
  const seed = hash(f.id, f.gen);
  plants.push(makePlant({ id: f.id, seed, xn: f.xn, depth: f.depth, gen: f.gen, genome: f.genome }));
  stats.maxGen = Math.max(stats.maxGen, f.gen);
  dirty = true;
}

// ---------------- update ----------------
function update(now: number, dt: number) {
  for (const p of plants) {
    if (p.pendingAt && now >= p.pendingAt) startGrow(p, now);
    if (p.anim) {
      const k = clamp01((now - p.anim.t0) / p.anim.dur);
      p.g = p.anim.from + easeInOut(k);
      if (p.anim.from === 4 && p.g >= 4.75 && !p.burst) {
        spriteFor(p, 0); // make sure pod position is current
        emitSeeds(p, now);
      }
      if (k >= 1) {
        p.stage = p.anim.to;
        p.g = p.stage;
        p.anim = null;
        if (p.stage === 4) stats.grown++;
        if (p.stage === 5) p.wilt = 0;
        dirty = true;
      }
    } else if (p.stage >= 5) {
      p.wilt = Math.min(1, p.wilt + dt / 9);
    }
    p.hover += (p.hoverTarget - p.hover) * Math.min(1, dt * 8);
    p.poke = Math.max(0, p.poke - dt * 2.2);
  }
  const before = plants.length;
  plants = plants.filter((p) => p.wilt < 1);
  if (plants.length !== before) dirty = true;

  for (const f of flying) {
    const u = (now - f.t0) / f.dur;
    if (f.state === 'fly' && u >= 1) {
      f.state = 'hop';
      f.tLand = now;
    }
    if (f.state === 'hop' && now - f.tLand > 0.5) {
      if (!canSprout(f.tx, f.ty) && plants.length < MAX_PLANTS) {
        // try a few nearby spots before giving up
        for (const [dx, dd] of [[18, 0], [-18, 0], [0, 0.12], [0, -0.12], [32, 0.08], [-32, -0.08], [32, -0.08], [-32, 0.08]]) {
          const xn = clamp(f.xn + (dx * worldScale) / W, 0.03, 0.97);
          const depth = clamp(f.depth + dd, 0, 1);
          const [tx, ty] = basePos({ xn, depth });
          if (canSprout(tx, ty)) {
            Object.assign(f, { xn, depth, tx, ty });
            break;
          }
        }
      }
      if (canSprout(f.tx, f.ty)) {
        landSeed(f);
        f.state = 'fade';
        f.tLand = -1; // remove
      } else {
        f.state = 'fade';
        f.tLand = now;
        puffs.push({ x: f.tx, y: f.ty, t0: now });
      }
    }
  }
  flying = flying.filter((f) => !(f.state === 'fade' && (f.tLand < 0 || now - f.tLand > 0.6)));
  drops = drops.filter((d) => now - d.t0 < d.dur + 0.25);
  puffs = puffs.filter((q) => now - q.t0 < 0.6);

  if (plants.length === 0 && flying.length === 0) {
    plants.push(starterSeed());
    dirty = true;
  }
  for (const c of clouds) {
    c.x += c.speed * dt;
    if (c.x - c.w > W + 20) c.x = -c.w - 20;
  }
}

// ---------------- render ----------------
function render(now: number, boil: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (bg) ctx.drawImage(bg, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // sun
  const sun = bank.get('sun', boil, 1, () => sunGroups(sunR), 11);
  const sx = W - Math.max(sunR * 2.2, W * 0.09), sy = Math.max(sunR * 2, H * 0.1);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(Math.sin(now * 0.4) * 0.06);
  ctx.drawImage(sun.canvas, sun.ox, sun.oy, sun.w, sun.h);
  ctx.restore();

  // clouds
  for (const c of clouds) {
    const s = bank.get('cloud' + c.seed + '|' + c.w.toFixed(1), boil, 1, () => cloudGroups(c.w, c.seed), c.seed);
    ctx.drawImage(s.canvas, c.x + s.ox, c.y + s.oy + Math.sin(now * 0.5 + c.seed) * 2, s.w, s.h);
  }

  // ground
  if (!grounds[boil] && (performance.now() < renderDeadline || !grounds.some((g) => g))) grounds[boil] = renderGround(W, H, dpr, boil);
  const gr = (grounds[boil] ?? grounds.find((g) => g))!;
  ctx.drawImage(gr.canvas, 0, gr.top, gr.canvas.width / dpr, gr.canvas.height / dpr);

  // plants back-to-front
  const order = plants.map((p) => ({ p, pos: basePos(p) })).sort((a, b) => a.pos[1] - b.pos[1]);
  for (const { p, pos } of order) {
    const s = spriteFor(p, boil);
    if (!s) continue;
    const wig = (p.hover * 0.045 + p.poke * 0.08) * Math.sin(now * 13 + p.id);
    const fade = p.wilt < 0 ? 1 : 1 - smoothstep(0.55, 1, p.wilt);
    const sink = p.wilt < 0 ? 1 : 1 - 0.45 * smoothstep(0.45, 1, p.wilt);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(pos[0], pos[1]);
    if (wig) ctx.rotate(wig);
    if (sink !== 1) ctx.scale(1, sink);
    ctx.drawImage(s.canvas, s.ox, s.oy, s.w, s.h);
    ctx.restore();
  }

  // flying seeds
  for (const f of flying) {
    const s = bank.get('seed' + f.color, boil, worldScale * 0.85, () => seedGroups(f.color), 5);
    let x: number, y: number, rot: number, alpha = 1;
    const u = clamp01((now - f.t0) / f.dur);
    if (now < f.t0) continue;
    if (f.state === 'fly') {
      x = f.sx + (f.tx - f.sx) * u;
      y = f.sy + (f.ty - f.sy) * u - f.peak * 4 * u * (1 - u) - Math.max(0, f.sy - f.ty) * 0;
      rot = f.spin * (now - f.t0);
    } else {
      const t = now - f.tLand;
      x = f.tx;
      const hop = f.state === 'hop' ? (t < 0.28 ? Math.sin((t / 0.28) * Math.PI) * 10 : t < 0.44 ? Math.sin(((t - 0.28) / 0.16) * Math.PI) * 3.5 : 0) : 0;
      y = f.ty - hop * worldScale;
      rot = f.spin * f.dur * 0.6;
      if (f.state === 'fade') alpha = 1 - clamp01(t / 0.5);
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y - 3 * worldScale);
    ctx.rotate(rot);
    ctx.drawImage(s.canvas, s.ox, s.oy, s.w, s.h);
    ctx.restore();
  }

  // water drops
  const ds = bank.get('drop', boil, Math.max(0.8, worldScale * 0.85), dropGroups, 3);
  for (const d of drops) {
    const u = (now - d.t0) / d.dur;
    if (u < 0) continue;
    if (u <= 1) {
      const y = d.y0 + (d.y1 - d.y0) * u * u;
      ctx.drawImage(ds.canvas, d.x + ds.ox, y + ds.oy, ds.w, ds.h);
    } else {
      // little splash
      const k = (u - 1) / 0.6;
      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = '#4f7fae';
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      for (const a of [-2.4, -1.57, -0.7]) {
        const r0 = 3 + k * 6, r1 = 6 + k * 9;
        ctx.beginPath();
        ctx.moveTo(d.x + Math.cos(a) * r0, d.y1 + Math.sin(a) * r0);
        ctx.lineTo(d.x + Math.cos(a) * r1, d.y1 + Math.sin(a) * r1);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  // puffs where a seed couldn't sprout
  for (const q of puffs) {
    const k = (now - q.t0) / 0.6;
    ctx.save();
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = '#6b4529';
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI * (0.1 + 0.2 * i);
      ctx.beginPath();
      ctx.moveTo(q.x + Math.cos(a) * (4 + k * 8), q.y + Math.sin(a) * (4 + k * 8));
      ctx.lineTo(q.x + Math.cos(a) * (8 + k * 12), q.y + Math.sin(a) * (8 + k * 12));
      ctx.stroke();
    }
    ctx.restore();
  }
}
function smoothstep(a: number, b: number, x: number) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

// ---------------- input ----------------
function hitTest(x: number, y: number): Plant | null {
  let best: Plant | null = null, bestArea = Infinity;
  for (const p of plants) {
    if (p.wilt >= 0) continue;
    const [bx, by] = basePos(p);
    const s = p.sprites.find((q) => q) ?? null;
    let x0 = bx - 24, x1 = bx + 24, y0 = by - 38, y1 = by + 14;
    if (s && p.g >= 1.5) {
      x0 = Math.min(x0, bx + s.ox + 6);
      x1 = Math.max(x1, bx + s.ox + s.w - 6);
      y0 = Math.min(y0, by + s.oy + 4);
    }
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
      const area = (x1 - x0) * (y1 - y0);
      if (area < bestArea) {
        bestArea = area;
        best = p;
      }
    }
  }
  return best;
}

let hovered: Plant | null = null;
function setHover(p: Plant | null) {
  if (hovered === p) return;
  if (hovered) hovered.hoverTarget = 0;
  hovered = p;
  if (p) p.hoverTarget = 1;
  canvas.classList.toggle('can', !!p);
}

function water(p: Plant, now: number, px: number, py: number) {
  if (p.anim || p.pendingAt || p.stage >= 5) {
    p.poke = 1;
    return;
  }
  const [bx, by] = basePos(p);
  const s = p.sprites.find((q) => q);
  const top = s && p.g >= 1.5 ? by + s.oy : by - 30;
  const startY = Math.min(py, top) - 40;
  for (let i = 0; i < 4; i++) {
    drops.push({ x: bx + (i - 1.5) * 7 * worldScale + (Math.random() - 0.5) * 4, y0: startY - Math.random() * 15, y1: by - 4 - Math.random() * 6, t0: now + i * 0.07, dur: 0.38 });
  }
  p.pendingAt = now + 0.45;
  p.poke = 0.6;
  void px;
  if (!hintDone) {
    hintDone = true;
    hint.classList.add('hide');
  }
  dirty = true;
}

const pt = (e: PointerEvent): [number, number] => {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  const [x, y] = pt(e);
  setHover(hitTest(x, y));
});
canvas.addEventListener('pointerleave', () => setHover(null));
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const [x, y] = pt(e);
  const p = hitTest(x, y);
  if (p) water(p, performance.now() / 1000, x, y);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------- UI ----------------
const hint = document.getElementById('hint')!;
const elGrown = document.getElementById('s-grown')!;
const elGen = document.getElementById('s-gen')!;
const elSeeds = document.getElementById('s-seeds')!;
const elPlants = document.getElementById('s-plants')!;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const resetLabel = resetBtn.querySelector('.content')!;
const frames = Array.from(document.querySelectorAll<SVGSVGElement>('.paper .frame'));
let resetArmed = 0;

function drawFrames(boil: number) {
  for (const [i, svg] of frames.entries()) {
    const r = svg.getBoundingClientRect();
    const w = r.width, h = r.height;
    if (!w || !h) continue;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const rs = rough.svg(svg);
    const armed = i === 1 && resetArmed > performance.now();
    svg.appendChild(rs.rectangle(4, 4, w - 8, h - 8, {
      seed: hash(i + 1, boil), roughness: 1.5, stroke: '#2e2823', strokeWidth: 2,
      fill: armed ? '#f3c7c0' : '#fbf6e6', fillStyle: 'solid',
    }));
    svg.appendChild(rs.rectangle(4, 4, w - 8, h - 8, {
      seed: hash(i + 7, boil), roughness: 1.2, stroke: 'none',
      fill: armed ? '#b5523b' : i === 1 ? '#e6a3b4' : '#8fb8d8', fillStyle: 'hachure', hachureGap: 7, fillWeight: 1.2, hachureAngle: -60,
    }));
  }
}

let lastStats = '';
function updateStats() {
  const seeds = plants.filter((p) => p.stage === 0 && !p.anim).length + flying.filter((f) => f.state !== 'fade').length;
  const s = `${stats.grown}|${stats.maxGen}|${seeds}|${plants.length}`;
  if (s === lastStats) return;
  lastStats = s;
  elGrown.textContent = String(stats.grown);
  elGen.textContent = String(stats.maxGen);
  elSeeds.textContent = String(seeds);
  elPlants.textContent = String(plants.length);
}

resetBtn.addEventListener('click', () => {
  const now = performance.now();
  if (resetArmed > now) {
    resetArmed = 0;
    resetLabel.textContent = 'start over';
    plants = [starterSeed()];
    flying = [];
    drops = [];
    puffs = [];
    stats = { grown: 0, maxGen: 1 };
    hovered = null;
    dirty = true;
    save();
  } else {
    resetArmed = now + 3000;
    resetLabel.textContent = 'really? tap again';
    setTimeout(() => {
      if (resetArmed && resetArmed <= performance.now()) {
        resetArmed = 0;
        resetLabel.textContent = 'start over';
      }
    }, 3100);
  }
});

// ---------------- save / load ----------------
interface SavedPlant { id: number; seed: number; xn: number; depth: number; gen: number; genome: Genome; stage: number; wilt: number; }
function save() {
  const list: SavedPlant[] = plants.map((p) => {
    let stage = p.anim ? p.anim.to : p.pendingAt ? p.stage + 1 : p.stage;
    if (stage === 5 && !p.burst) stage = 4; // seeds not released yet: keep the flower
    return { id: p.id, seed: p.seed, xn: p.xn, depth: p.depth, gen: p.gen, genome: p.genome, stage, wilt: stage >= 5 ? Math.max(0, p.wilt) : -1 };
  });
  // seeds still in the air are saved as if they landed
  for (const f of flying) {
    if (f.state === 'fade' || list.length >= MAX_PLANTS) continue;
    if (!canSprout(f.tx, f.ty)) continue;
    list.push({ id: f.id, seed: hash(f.id, f.gen), xn: f.xn, depth: f.depth, gen: f.gen, genome: f.genome, stage: 0, wilt: -1 });
  }
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 1, plants: list, stats: { ...stats, maxGen: Math.max(stats.maxGen, ...list.map((p) => p.gen)) }, nextId, hintDone }));
  } catch {
    /* storage unavailable: keep playing without saving */
  }
  dirty = false;
}

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || d.v !== 1 || !Array.isArray(d.plants)) return false;
    const r = mulberry32(12345);
    plants = d.plants.slice(0, MAX_PLANTS).map((s: SavedPlant) =>
      makePlant({
        id: s.id, seed: s.seed | 0 || 1, xn: clamp(+s.xn || 0.5, 0, 1), depth: clamp(+s.depth || 0, 0, 1), gen: s.gen | 0 || 1,
        genome: sanitize(s.genome ?? {}, r), stage: clamp(s.stage | 0, 0, 5), wilt: s.stage >= 5 ? clamp(+s.wilt || 0, 0, 0.99) : -1,
      }),
    );
    stats = { grown: d.stats?.grown | 0, maxGen: Math.max(1, d.stats?.maxGen | 0) };
    nextId = Math.max(d.nextId | 0, ...plants.map((p) => p.id + 1), 1);
    hintDone = !!d.hintDone;
    return plants.length > 0;
  } catch {
    return false;
  }
}

// ---------------- boot ----------------
resize();
if (!load()) plants = [starterSeed()];
if (hintDone) hint.classList.add('hide');
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(resize, 120);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) save();
});
window.addEventListener('pagehide', save);
setInterval(() => {
  if (dirty || plants.some((p) => p.wilt >= 0)) save();
}, 3000);

let last = performance.now() / 1000;
let lastBoil = -1;
const perf: number[] | null = new URLSearchParams(location.search).has("debug") ? [] : null;
if (perf) (window as unknown as { __perf: number[] }).__perf = perf;
function frame(ms: number) {
  const now = ms / 1000;
  const dt = Math.min(0.05, Math.max(0, now - last));
  last = now;
  const boil = Math.floor(ms / BOIL_MS) % 3;
  const tw = performance.now();
  renderDeadline = tw + 7;
  update(now, dt);
  render(now, boil);
  if (boil !== lastBoil) {
    lastBoil = boil;
    drawFrames(boil);
  }
  updateStats();
  if (perf) perf.push(performance.now() - tw);
  requestAnimationFrame(frame);
}
document.fonts?.ready.then(() => drawFrames(lastBoil < 0 ? 0 : lastBoil));
requestAnimationFrame(frame);
