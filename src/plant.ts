import type { Genome } from './genome';
import type { Species, Rare } from './species';
import { mulberry32, range, clamp01, smooth, lerp, angDiff, Rng } from './util';
import { Group, Shape, Pt, INK, C, hsl, mix, leafPts, ellipsePts, rotatePts } from './crayon';

/*
 * Growth model. A plant's visual state is a continuous value g:
 *   0 seed · 1 sprout · 2 seedling · 3 growing · 4 mature (flower open) · 5 seeds released
 * Growth animates g from k to k+1 (trees take quarter steps). Everything below is a pure function
 * of (species, structure, g, wilt, environment), so any in-between frame can be drawn.
 */

export interface Leaf {
  s: number;
  side: number; // -1 left, 1 right, 0 tip
  len: number;
  w: number;
  ang: number;
  bend: number;
  birth: number; // stem-growth value G at which it starts unfurling
  coty?: boolean;
}
export interface Axis {
  len: number;
  attachS: number;
  rel: number;
  depth: number;
  startG: number;
  endG: number;
  curve: number;
  freq: number;
  phase: number;
  width: number;
  leaves: Leaf[];
  kids: Axis[];
}

/** Things outside the plant that change how it looks. All values are pre-quantised by the caller. */
export interface Env {
  close: number; // 0 open .. 1 night-closed
  turn: number; // -1..1 where the sun is, relative to the plant (sunflowers)
  autumn: number; // 0..1 leaves turning orange
  winter: number; // 0..1 bare / resting
  spring: number; // 0..1 blossom time
  climb: { dx: number; h: number } | null; // vines: neighbour to climb, in plant units
}
export const ENV0: Env = { close: 0, turn: 0, autumn: 0, winter: 0, spring: 0, climb: null };

export interface DrawIn {
  sp: Species;
  main: Axis;
  gn: Genome;
  seed: number;
  g: number;
  wilt: number;
  rare: Rare | null;
  env: Env;
  golden?: boolean; // seed dropped by a shooting star
}
export interface Drawing {
  groups: Group[];
  pod: Pt | null; // where seeds launch from
}

/** Recursive, L-system-like branching skeleton, deterministic for (genome, seed). */
export function buildStructure(gn: Genome, seed: number, sp: Species = 'daisy'): Axis {
  const r = mulberry32(seed);
  const H = 200 * gn.height;
  const main = makeAxis(r, gn, H, 0, 0, 1);
  main.rel = gn.lean + range(r, -0.08, 0.08);
  // bushy plants: extra stems fanning out from the root
  const extra = sp === 'bush' ? 5 + Math.floor(r() * 4) : sp === 'daisy' && gn.clump > 0.4 ? 1 + Math.floor((gn.clump - 0.4) * 5) : 0;
  const rows = Math.ceil(extra / 2);
  for (let i = 0; i < extra; i++) {
    const side = i % 2 ? 1 : -1;
    const spread = (Math.floor(i / 2) + 1) / rows;
    const len = H * (1 - (sp === 'bush' ? 0.42 : 0.3) * spread) * range(r, 0.72, 0.95);
    const start = 0.06 + r() * 0.12;
    const kid = makeAxis(r, gn, len, 1, start, Math.min(1, start + range(r, 0.7, 0.85)));
    kid.attachS = 0;
    kid.rel = side * (sp === 'bush' ? 0.22 + 1.0 * spread : 0.18 + 0.45 * spread) * range(r, 0.85, 1.1);
    main.kids.push(kid);
  }
  const cl = 11 + gn.leafLen * 0.18;
  for (const side of [-1, 1])
    main.leaves.push({ s: -1, side, len: cl * range(r, 0.9, 1.1), w: 0.8, ang: 1.2, bend: 0.25, birth: 0.07, coty: true });
  return main;
}

function makeAxis(r: Rng, gn: Genome, len: number, depth: number, startG: number, endG: number): Axis {
  const ax: Axis = {
    len, attachS: 0, rel: 0, depth, startG, endG,
    curve: gn.curve * range(r, 0.6, 1.3) * (depth ? 0.8 : 1),
    freq: gn.freq * range(r, 0.8, 1.2),
    phase: range(r, 0, Math.PI * 2),
    width: depth === 0 ? 3.4 : depth === 1 ? 2.6 : 2,
    leaves: [], kids: [],
  };
  let s = depth === 0 ? len * 0.3 : gn.internode * range(r, 0.4, 0.8);
  let side = r() < 0.5 ? 1 : -1;
  while (s < len - 6) {
    const f = s / len;
    const reach = startG + (endG - startG) * f;
    const birth = Math.min(0.86, reach + 0.015);
    let branched = 0;
    if (depth < 2 && f > 0.22 && f < 0.8 && r() < gn.branchiness * (depth === 0 ? 0.55 : 0.3)) {
      const cs = reach + 0.03;
      if (cs < 0.8) {
        const bside = r() < 0.5 ? 1 : -1;
        const clen = (len - s) * range(r, 0.45, 0.75) + 10;
        const kid = makeAxis(r, gn, clen, depth + 1, cs, Math.min(1, cs + (1 - cs) * range(r, 0.75, 0.95)));
        kid.attachS = s;
        kid.rel = bside * gn.branchAngle * range(r, 0.8, 1.2);
        ax.kids.push(kid);
        branched = bside;
      }
    }
    const size = (1 - 0.35 * f) * (depth ? 0.8 : 1) * range(r, 0.85, 1.15);
    const mk = (sd: number): Leaf => ({
      s, side: sd, len: gn.leafLen * size * 1.15, w: gn.leafWidth * range(r, 0.9, 1.1),
      ang: gn.leafAngle * range(r, 0.8, 1.2), bend: gn.leafBend * range(r, 0.5, 1.3), birth,
    });
    if (gn.opposite > 0.5) {
      if (branched !== 1) ax.leaves.push(mk(1));
      if (branched !== -1) ax.leaves.push(mk(-1));
    } else {
      ax.leaves.push(mk(branched ? -branched : side));
      side = -side;
    }
    s += gn.internode * range(r, 0.8, 1.2) * (depth ? 0.8 : 1);
  }
  if (depth > 0)
    ax.leaves.push({ s: len, side: 0, len: gn.leafLen * 0.7, w: gn.leafWidth, ang: 0, bend: gn.leafBend, birth: Math.min(0.9, endG - 0.06) });
  return ax;
}

/** Map visual stage g to stem growth G in [0,1]. */
export function stemG(g: number): number {
  if (g <= 0) return 0;
  if (g < 1) return 0.06 * smooth(0.3, 1, g);
  if (g < 2) return lerp(0.06, 0.22, g - 1);
  if (g < 3) return lerp(0.22, 0.7, g - 2);
  return lerp(0.7, 1, smooth(3, 3.5, g));
}

/** Which way a vine runs along the ground. */
export const vineDir = (seed: number) => ((seed >> 3) & 1 ? 1 : -1);

// ---------------------------------------------------------------- shared pieces

const AUTUMN = '#c9762f';
const tone = (col: string, env: Env, dryT: number) => mix(mix(mix(col, AUTUMN, env.autumn * 0.75), '#93a093', env.winter * 0.35), C.dry, dryT);

/** Rotate, scale and move a list of shapes. */
export function xform(shapes: Shape[], dx: number, dy: number, rot = 0, sc = 1): Shape[] {
  const c = Math.cos(rot), s = Math.sin(rot);
  return shapes.map((sh) => ({ ...sh, pts: sh.pts.map(([x, y]) => [dx + (x * c - y * s) * sc, dy + (x * s + y * c) * sc] as Pt) }));
}

/** A thick tube along a centre line, with a rounded end cap. */
function tubePts(c: Pt[], r0: number, r1: number, cap = true): Pt[] {
  const n = c.length;
  const L: Pt[] = [], R: Pt[] = [];
  let dx = 0, dy = -1;
  for (let i = 0; i < n; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(n - 1, i + 1)];
    dx = b[0] - a[0];
    dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const r = lerp(r0, r1, n > 1 ? i / (n - 1) : 0);
    L.push([c[i][0] - dy * r, c[i][1] + dx * r]);
    R.push([c[i][0] + dy * r, c[i][1] - dx * r]);
  }
  const out = [...L];
  if (cap) {
    const e = c[n - 1], nx = -dy, ny = dx;
    for (let j = 1; j < 6; j++) {
      const t = (j / 6) * Math.PI;
      out.push([e[0] + r1 * (Math.cos(t) * nx + Math.sin(t) * dx), e[1] + r1 * (Math.cos(t) * ny + Math.sin(t) * dy)]);
    }
  }
  return [...out, ...R.reverse()];
}

function mound(out: Shape[], w = 12) {
  const mp: Pt[] = [[-w, 2], [-w / 2, -1.8], [0, -2.8], [w / 2, -1.8], [w, 2]];
  out.push({ kind: 'poly', pts: mp, fill: C.soil, fa: 0.35, gap: 2.2 });
  out.push({ kind: 'curve', pts: mp, stroke: C.soilDark, sw: 1.8, rough: 1.2 });
}

/** Each species has its own seed, so you can guess what will come up. Centred on (0,0). */
export function seedShapes(sp: Species, gn: Genome, golden = false): Shape[] {
  const tint = (base: string, k = 0.22) => (golden ? '#e8b730' : mix(base, hsl(gn.petalHue, gn.petalSat, gn.petalLight), k));
  const hl = (pts: Pt[]): Shape => ({ kind: 'curve', pts, stroke: '#ffffff', sw: 1, rough: 0.5 });
  switch (sp) {
    case 'daisy': {
      const c = tint('#e3d6ae');
      return [
        { kind: 'poly', pts: ellipsePts(0, 0, 4.6, 3.4, -0.15, 12), fill: c, fa: 0.5, gap: 1.5, weight: 1.2, stroke: INK, sw: 1.5 },
        hl([[-2, -1.5], [0, -2.1], [1.8, -1.3]]),
      ];
    }
    case 'bush': {
      // a little rose hip with a crown
      const c = tint('#b5523b', 0.3);
      return [
        { kind: 'poly', pts: ellipsePts(0, 0.5, 4.2, 5, 0, 12), fill: c, fa: 0.5, gap: 1.5, weight: 1.2, stroke: INK, sw: 1.5 },
        { kind: 'line', pts: [[0, -4.4], [0, -7.5]], stroke: INK, sw: 1.1, rough: 0.2 },
        { kind: 'line', pts: [[-1, -4.4], [-3.2, -6.8]], stroke: INK, sw: 1.1, rough: 0.2 },
        { kind: 'line', pts: [[1, -4.4], [3.2, -6.8]], stroke: INK, sw: 1.1, rough: 0.2 },
        hl([[-2, -1], [-1.4, -2.6]]),
      ];
    }
    case 'sunflower': {
      const c = tint('#56514c', 0.1);
      return [
        { kind: 'poly', pts: leafPts(-8, 0, Math.PI / 2, 16, 4.8, 0.75, 0, 8), fill: c, fa: 0.55, gap: 1.6, weight: 1.3, stroke: INK, sw: 1.7 },
        { kind: 'line', pts: [[-5, -1.7], [4, -1.1]], stroke: '#f3ecd6', sw: 1.3, rough: 0.5 },
        { kind: 'line', pts: [[-5, 1.7], [4, 1.1]], stroke: '#f3ecd6', sw: 1.3, rough: 0.5 },
      ];
    }
    case 'vine': {
      const c = tint('#7d6c3c', 0.3);
      const pts = ellipsePts(0, 0, 6.2, 4, 0, 14).map(([x, y]) => [x, y < 0 && Math.abs(x) < 3.2 ? y * 0.45 : y] as Pt);
      return [
        { kind: 'poly', pts, fill: c, fa: 0.5, gap: 1.6, weight: 1.3, stroke: INK, sw: 1.6 },
        { kind: 'curve', pts: [[5, -2], [8.5, -5.5], [11, -3.5], [9.5, -1.5]], stroke: C.grassDark, sw: 1.3, rough: 0.5 },
      ];
    }
    case 'cactus': {
      const c = tint('#97a05a', 0.15);
      const out: Shape[] = [{ kind: 'poly', pts: ellipsePts(0, 0, 5.4, 4.2, 0, 12), fill: c, fa: 0.5, gap: 1.5, weight: 1.2, stroke: INK, sw: 1.6 }];
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + 0.3;
        out.push({ kind: 'line', pts: [[Math.cos(a) * 5.4, Math.sin(a) * 4.2], [Math.cos(a) * 8.3, Math.sin(a) * 6.6]], stroke: INK, sw: 1, rough: 0.3 });
      }
      return out;
    }
    case 'mushroom': {
      const c = tint('#9c5a35', 0.4);
      return [
        { kind: 'poly', pts: [[-2, 0], [2, 0], [1.6, 4], [-1.6, 4]], fill: '#efe3c8', fa: 0.6, gap: 1.4, stroke: INK, sw: 1.4 },
        { kind: 'poly', pts: ellipsePts(0, 0.5, 6, 5, 0, 10, Math.PI, Math.PI * 2), fill: c, fa: 0.55, gap: 1.5, stroke: INK, sw: 1.6 },
        { kind: 'poly', pts: ellipsePts(-1.8, -2.4, 1, 0.8, 0, 6), fill: '#ffffff', fa: 0.9, gap: 1 },
      ];
    }
    case 'tree': {
      const c = tint('#a8743f', 0.1);
      return [
        { kind: 'poly', pts: ellipsePts(0, 1.6, 4.6, 5.6, 0, 12), fill: c, fa: 0.55, gap: 1.5, weight: 1.3, stroke: INK, sw: 1.6 },
        { kind: 'poly', pts: [...ellipsePts(0, -1.6, 5.8, 3.2, 0, 8, Math.PI, Math.PI * 2), [5.2, -0.6], [-5.2, -0.6]], fill: '#6e4a2b', fa: 0.6, gap: 1.6, style: 'cross-hatch', stroke: INK, sw: 1.6 },
        { kind: 'line', pts: [[0, -4.6], [1.2, -7.6]], stroke: INK, sw: 1.6, rough: 0.4 },
      ];
    }
  }
}

/** The planted seed: whole at first, then pushed aside as the sprout comes up. */
function shell(d: DrawIn, out: Shape[]) {
  const g = d.g;
  const shellK = 1 - smooth(1.5, 2.3, g);
  if (shellK <= 0.02) return;
  const crack = smooth(0.05, 0.5, g);
  const side = d.seed & 2 ? 1 : -1;
  const sc = 1.3 * (0.55 + 0.45 * shellK);
  const rot = side * (crack * 0.45 + (1 - shellK) * 1.1);
  const slide = side * (crack * 3.5 + (1 - shellK) * 7);
  out.push(...xform(seedShapes(d.sp, d.gn, d.golden), slide, -4.4 * sc, rot, sc));
}

interface Head {
  cx: number; cy: number; a: number;
  open: number; fall: number; podS?: number;
  gn: Genome; rare: Rare | null; dryT: number;
  petalMul?: number; discMul?: number;
  /** soft outlines for tiny flowers, so they don't turn into ink blots */
  soft?: boolean;
}

/** Petals + disc. Used by every flowering species. */
function flowerHead(out: Shape[], h: Head) {
  const { gn, open, fall, a } = h;
  const pm = h.petalMul ?? 1;
  const petalCol = mix(hsl(gn.petalHue, gn.petalSat, gn.petalLight), C.dry, h.dryT);
  const centerCol = mix(hsl(gn.centerHue, 48, gn.centerLight), C.dry, h.dryT * 0.5);
  const stripeCol = gn.petalLight > 70 ? hsl(gn.petalHue + 15, 62, 48) : mix(petalCol, '#ffffff', 0.65);
  const pc = Math.max(3, Math.round(gn.petalCount));
  const discR = (3 + gn.petalLen * 0.28 * pm) * (h.discMul ?? 1);
  const ring = (lenK: number, off: number, sw = 1.7) => {
    for (let i = 0; i < pc; i++) {
      const theta = a + (Math.PI * 2 * i) / pc + 0.3 + off;
      const bunched = a + (pc > 1 ? (i / (pc - 1) - 0.5) * 0.7 : 0);
      let ang = bunched + angDiff(bunched, theta) * open;
      const k = (0.35 + 0.65 * open) * (1 - fall);
      if (k < 0.04) continue;
      ang += fall * 0.9 * (Math.sin(theta - a) >= 0 ? 1 : -1);
      const r0 = discR * 0.55 * open;
      const bx = h.cx + Math.sin(ang) * r0, by = h.cy - Math.cos(ang) * r0 + fall * 10;
      const L = gn.petalLen * pm * k * lenK;
      out.push({
        kind: 'poly', pts: leafPts(bx, by, ang, L, L * gn.petalWidth * 0.5, gn.petalP, 0, 7),
        fill: petalCol, fa: h.soft ? 0.6 : 0.32, gap: 2.2, weight: 1.4, stroke: sw < 1.7 || h.soft ? mix(petalCol, INK, h.soft ? 0.35 : 0.55) : INK, sw: h.soft ? 1 : sw,
      });
      if (h.rare === 'striped' && L > 4) {
        const dx = Math.sin(ang), dy = -Math.cos(ang);
        out.push({ kind: 'line', pts: [[bx + dx * L * 0.18, by + dy * L * 0.18], [bx + dx * L * 0.82, by + dy * L * 0.82]], stroke: stripeCol, sw: 1.7, rough: 0.5 });
      }
    }
  };
  if (open > 0.02 && fall < 0.98) {
    ring(1, 0);
    if (h.rare === 'double') ring(0.64, Math.PI / pc, 1.2);
  }
  const cr = discR * open * (1 - (h.podS ?? 0));
  if (cr > 0.8) {
    out.push({ kind: 'poly', pts: ellipsePts(h.cx, h.cy, cr, cr * 0.95, 0, 12), fill: centerCol, fa: 0.45, gap: 1.7, style: 'cross-hatch', stroke: h.soft ? mix(centerCol, INK, 0.4) : INK, sw: h.soft ? 1 : 1.6 });
  }
}

/** Green pod that swells then splits open. Returns the launch point. */
function seedPod(out: Shape[], x: number, y: number, a: number, len: number, podS: number, burst: number, col: string): Pt {
  const dx = Math.sin(a), dy = -Math.cos(a);
  const pl = len * podS, pw = pl * 0.33;
  if (burst < 0.02) {
    out.push({ kind: 'poly', pts: leafPts(x, y, a, pl, pw, 1.1, 0, 8), fill: col, fa: 0.4, gap: 2, weight: 1.4, stroke: INK, sw: 1.8 });
    out.push({ kind: 'curve', pts: [[x + dx * pl * 0.15, y + dy * pl * 0.15], [x + dx * pl * 0.85, y + dy * pl * 0.85]], stroke: mix(col, INK, 0.5), sw: 1, rough: 0.8 });
  } else {
    const full = leafPts(x, y, a, pl, pw, 1.1, 0, 8);
    const n = 8; // right side = indices 0..n, left = n.. end + base
    const right = full.slice(0, n + 1);
    const left = [full[n], ...full.slice(n + 1), full[0]];
    for (const [sd, side] of [[1, right], [-1, left]] as [number, Pt[]][]) {
      out.push({ kind: 'poly', pts: rotatePts(side, x, y, sd * burst), fill: col, fa: 0.4, gap: 2, weight: 1.4, stroke: INK, sw: 1.8 });
    }
  }
  return [x + dx * pl * 0.6, y + dy * pl * 0.6];
}

/** Flower timeline shared by species that bloom at the tip. */
function bloomPhase(g: number) {
  return {
    bud: smooth(3.25, 3.6, g),
    open: smooth(3.55, 4, g),
    fall: smooth(4, 4.35, g),
    podS: smooth(4.15, 4.6, g),
    burst: smooth(4.7, 4.95, g),
  };
}

function bud(out: Shape[], x: number, y: number, a: number, size: number, petalCol: string, leafCol: string) {
  out.push({ kind: 'poly', pts: leafPts(x, y, a, size, size * 0.36, 1.35, 0, 7), fill: petalCol, fa: 0.35, gap: 2, stroke: INK, sw: 1.8 });
  for (const sd of [-1, 1])
    out.push({ kind: 'poly', pts: leafPts(x, y, a + sd * 0.55, size * 0.55, size * 0.16, 1, 0, 5), fill: leafCol, fa: 0.35, gap: 1.8, stroke: INK, sw: 1.5 });
}

// ---------------------------------------------------------------- species

export function drawPlant(d: DrawIn): Drawing {
  switch (d.sp) {
    case 'vine': return drawVine(d);
    case 'cactus': return drawCactus(d);
    case 'mushroom': return drawMushroom(d);
    case 'tree': return drawTree(d);
    default: return drawFlower(d);
  }
}

interface SP { x: number; y: number; a: number; }

/** Daisy and sunflower: a branching stem with leaves and a flower at the tip. */
function drawFlower(d: DrawIn): Drawing {
  const { main, gn, g, wilt, env } = d;
  const sun = d.sp === 'sunflower';
  const G = stemG(g);
  const dryT = smooth(0, 0.7, wilt);
  const leafCol = tone(hsl(gn.leafHue, gn.leafSat, gn.leafLight), env, dryT);
  const cotyCol = tone(hsl(gn.leafHue - 14, gn.leafSat + 6, gn.leafLight + 6), env, dryT);
  const stemCol = tone(hsl(gn.leafHue + 6, gn.leafSat - 4, gn.leafLight - 6), env, dryT * 0.8);
  const curl = 1 - smooth(1.0, 1.8, g);
  const droop = gn.lean >= 0 ? 1 : -1;
  // sunflowers bend their head toward the sun, and hang it at night
  const turn = sun ? (env.turn * 0.75 + env.close * 1.1 * droop) * smooth(2.8, 3.6, g) : 0;

  const soil: Shape[] = [];
  const stems: Shape[] = [];
  const leaves: Shape[] = [];
  const shellS: Shape[] = [];
  const flower: Shape[] = [];
  let tip: SP | null = null;
  // daisies put a smaller flower on every branch tip, so branchy ones become bushy bouquets
  const multi = d.sp === 'daisy' || d.sp === 'bush';
  const sideTips: SP[] = [];
  mound(soil);

  const addLeaf = (px: number, py: number, a: number, lf: Leaf, k: number) => {
    const L = lf.len * k;
    if (L < 1.2) return;
    const A = lf.side === 0 ? a + lf.bend * 0.4 : a + lf.side * lf.ang * (0.2 + 0.8 * k) + wilt * lf.side * 0.95;
    const W = L * lf.w * 0.5 * Math.pow(k, 0.6);
    const pts = leafPts(px, py, A, L, W, lf.coty ? 1 : gn.leafP, lf.bend * (lf.side || 1) * (1 + wilt), lf.coty ? 7 : 8);
    const col = lf.coty ? cotyCol : leafCol;
    leaves.push({ kind: 'poly', pts, fill: col, fa: 0.34, gap: 3, weight: 1.4, stroke: INK, sw: 1.6, rough: 0.9 });
    if (!lf.coty && L > 7) {
      const dx = Math.sin(A), dy = -Math.cos(A);
      const vb = lf.bend * (lf.side || 1) * (1 + wilt) * L * 0.2;
      const nx = -dy, ny = dx;
      const vein: Pt[] = [0, 0.4, 0.75].map((u) => {
        const bo = vb * Math.sin(Math.PI * u * 0.9);
        return [px + dx * u * L + nx * bo, py + dy * u * L + ny * bo] as Pt;
      });
      leaves.push({ kind: 'curve', pts: vein, stroke: mix(col, INK, 0.55), sw: 1, rough: 0.9 });
    }
  };

  const walk = (ax: Axis, bx: number, by: number, a0: number, isMain: boolean): SP | null => {
    const span = Math.max(1e-4, ax.endG - ax.startG);
    const vis = ax.len * clamp01((G - ax.startG) / span);
    if (vis < 0.4) return null;
    const hookLen = 11;
    const angleAt = (s: number) => {
      let a = a0 + ax.curve * (Math.sin((ax.freq * Math.PI * s) / ax.len + ax.phase) - Math.sin(ax.phase));
      a += wilt * droop * 1.5 * Math.pow(s / ax.len, 1.3);
      if (isMain && turn) a += turn * Math.pow(s / ax.len, 3);
      if (isMain && curl > 0) {
        const h0 = vis - hookLen;
        if (s > h0) a += curl * 2.8 * ((s - h0) / hookLen) * droop;
      }
      return a;
    };
    const pts: SP[] = [{ x: bx, y: by, a: a0 }];
    let x = bx, y = by, s = 0;
    while (s < vis - 1e-6) {
      const st = Math.min(4, vis - s);
      const a = angleAt(s + st / 2);
      s += st;
      x += Math.sin(a) * st;
      y -= Math.cos(a) * st;
      pts.push({ x, y, a });
    }
    pts[pts.length - 1].a = angleAt(vis);
    const at = (q: number) => pts[Math.min(pts.length - 1, Math.max(0, Math.round(q / 4)))];

    const sp: Pt[] = [];
    for (let i = 0; i < pts.length; i += 3) sp.push([pts[i].x, pts[i].y]);
    const last = pts[pts.length - 1];
    if (sp.length < 2 || sp[sp.length - 1][0] !== last.x || sp[sp.length - 1][1] !== last.y) sp.push([last.x, last.y]);
    const w = ax.width * (isMain ? 0.55 + 0.45 * clamp01(G / 0.5) : 1) * (sun && isMain ? 1.35 : 1);
    stems.push({ kind: 'curve', pts: sp, stroke: INK, sw: w + 2.2 });
    stems.push({ kind: 'curve', pts: sp, stroke: stemCol, sw: w, rough: 1.1 });

    for (const lf of ax.leaves) {
      if (multi && lf.side === 0 && ax.depth >= 1) continue; // the branch tip holds a flower instead
      const k = clamp01((G - lf.birth) / 0.13);
      if (k <= 0.02) continue;
      const ls = lf.coty ? Math.min(ax.len * 0.2, vis) : lf.s;
      if (ls > vis + 0.01) continue;
      const p = at(ls);
      addLeaf(p.x, p.y, p.a, lf, k);
    }
    for (const kid of ax.kids) {
      if (kid.attachS > vis) continue;
      const p = at(kid.attachS);
      const kt = walk(kid, p.x, p.y, p.a + kid.rel + wilt * Math.sign(kid.rel) * 0.35, false);
      if (multi && kt && G >= kid.endG - 0.01) sideTips.push(kt);
    }
    if (isMain) tip = last;
    return last;
  };
  walk(main, 0, 0, main.rel, true);
  // some daisies grow a rosette of leaves around their foot
  if (multi && (d.seed >> 5) & 1 && G > 0.1) {
    const n = 3 + ((d.seed >> 7) & 3);
    const k = smooth(0.1, 0.45, G);
    for (let i = 0; i < n; i++) {
      const a = (i / (n - 1) - 0.5) * 2.7 + Math.sin(d.seed + i) * 0.12;
      const L = gn.leafLen * (0.75 + 0.3 * ((i * 7 + d.seed) % 3) / 2) * k;
      if (L < 1.5) continue;
      const A = a + wilt * Math.sign(a || 1) * 0.5;
      leaves.push({ kind: 'poly', pts: leafPts(Math.sin(a) * 2, -1, A, L, L * gn.leafWidth * 0.42, gn.leafP, gn.leafBend * Math.sign(a || 1), 8), fill: leafCol, fa: 0.34, gap: 3, weight: 1.4, stroke: INK, sw: 1.5, rough: 0.9 });
    }
  }
  shell(d, shellS);

  let pod: Pt | null = null;
  const t = tip as SP | null;
  if (t && g >= 3.25) {
    const ph = bloomPhase(g);
    const dx = Math.sin(t.a), dy = -Math.cos(t.a);
    const petalCol = mix(hsl(gn.petalHue, gn.petalSat, gn.petalLight), C.dry, dryT);
    const cx = t.x + dx * 2.5, cy = t.y + dy * 2.5;
    const budK = ph.bud * (1 - smooth(0.05, 0.55, ph.open));
    const bush = d.sp === 'bush';
    if (budK > 0.03) bud(flower, t.x, t.y, t.a, (8 + gn.petalLen * 0.55) * budK * (sun ? 1.4 : bush ? 0.8 : 1), petalCol, leafCol);
    const open = ph.open * (1 - 0.85 * env.close * (sun ? 0.5 : 1));
    flowerHead(flower, { cx, cy, a: t.a, open, fall: ph.fall, podS: ph.podS, gn, rare: d.rare, dryT, discMul: sun ? 1.75 : 0.9, petalMul: bush ? 0.95 : 1, soft: bush || (multi && sideTips.length > 1) });
    if (ph.podS > 0.02) pod = seedPod(flower, t.x, t.y, t.a, (10 + gn.petalLen * 0.55) * (sun ? 1.3 : 1), ph.podS, ph.burst, mix(C.pod, C.dry, dryT * 0.6));
    if (!pod) pod = [cx, cy];
    for (const st of sideTips) {
      const sdx = Math.sin(st.a), sdy = -Math.cos(st.a);
      if (budK > 0.03) bud(flower, st.x, st.y, st.a, (6 + gn.petalLen * 0.4) * budK, petalCol, leafCol);
      flowerHead(flower, { cx: st.x + sdx * 2, cy: st.y + sdy * 2, a: st.a, open, fall: ph.fall, podS: ph.podS, gn, rare: d.rare, dryT, petalMul: bush ? 0.9 : 0.72, discMul: 0.8, soft: true });
    }
  }
  return { groups: [{ shapes: soil }, { shapes: [...stems, ...leaves] }, { shapes: shellS }, { shapes: flower }], pod };
}

/** Vine: pokes up, then runs sideways along the ground and climbs the first plant it reaches. */
function drawVine(d: DrawIn): Drawing {
  const { gn, g, wilt, env } = d;
  const r = mulberry32(d.seed ^ 0x2a);
  const dir = vineDir(d.seed);
  const G = stemG(g);
  const dryT = smooth(0, 0.7, wilt);
  const leafCol = tone(hsl(gn.leafHue, gn.leafSat, gn.leafLight), env, dryT);
  const stemCol = tone(hsl(gn.leafHue + 6, gn.leafSat - 4, gn.leafLight - 6), env, dryT * 0.8);
  const petalCol = mix(hsl(gn.petalHue, gn.petalSat, gn.petalLight), C.dry, dryT);
  const UP = 16; // length of the first upward poke
  const climb = env.climb;
  const full = UP + (climb ? climb.dx + climb.h : 120 + gn.height * 70);
  const vis = full * G;
  const phase = range(r, 0, 6);

  // centre line, one point every 4 units of length
  const P: SP[] = [];
  for (let s = 0; ; s = Math.min(vis, s + 4)) {
    let x: number, y: number;
    if (s <= UP) {
      x = dir * 2 * smooth(0, UP, s);
      y = -s;
    } else {
      const hx = s - UP;
      const run = climb ? Math.min(hx, climb.dx) : hx;
      x = dir * (2 + run);
      y = -UP + 12 * smooth(0, 26, run) + 2.6 * Math.sin(run * 0.13 + phase) * smooth(0, 20, run);
      if (climb && hx > climb.dx) {
        const up = hx - climb.dx;
        x += dir * 3.5 * Math.sin(up * 0.16 + phase);
        y -= up;
      }
    }
    P.push({ x, y, a: 0 });
    if (s >= vis) break;
  }
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    P[i].a = Math.atan2(b.x - a.x, -(b.y - a.y));
  }
  // curl the growing tip
  const soil: Shape[] = [];
  const stems: Shape[] = [];
  const leaves: Shape[] = [];
  const shellS: Shape[] = [];
  const flower: Shape[] = [];
  mound(soil);
  if (P.length >= 2) {
    const sp: Pt[] = P.filter((_, i) => i % 2 === 0 || i === P.length - 1).map((p) => [p.x, p.y + wilt * 4]);
    const last = P[P.length - 1];
    if (G < 0.95 && P.length > 3) {
      const a = last.a;
      sp.push([last.x + Math.sin(a + dir * 1.2) * 4, last.y - Math.cos(a + dir * 1.2) * 4], [last.x + Math.sin(a + dir * 2.6) * 5, last.y - Math.cos(a + dir * 2.6) * 5]);
    }
    stems.push({ kind: 'curve', pts: sp, stroke: INK, sw: 4.2 });
    stems.push({ kind: 'curve', pts: sp, stroke: stemCol, sw: 2.2, rough: 1 });
  }
  const at = (s: number) => P[Math.min(P.length - 1, Math.max(0, Math.round(s / 4)))];

  // cotyledons at the top of the poke
  if (G > 0.03) {
    const k = clamp01((vis - 6) / 10) * (1 - 0.4 * smooth(0.3, 0.6, G));
    const p = at(Math.min(UP * 0.8, vis));
    for (const sd of [-1, 1]) if (k > 0.05) leaves.push({ kind: 'poly', pts: leafPts(p.x, p.y, sd * 1.1, 9 * k, 4.5 * k, 1, 0.2 * sd, 7), fill: leafCol, fa: 0.34, gap: 2.4, stroke: INK, sw: 1.5 });
  }
  // leaves + flower nodes along the runner
  const nodes: { s: number; side: number }[] = [];
  let side = 1;
  for (let s = UP + 10; s < full - 4; s += 13 + r() * 5) {
    nodes.push({ s, side });
    side = -side;
  }
  const ph = bloomPhase(g);
  let pod: Pt | null = null;
  nodes.forEach((n, i) => {
    if (n.s > vis - 3) return;
    const p = at(n.s);
    const k = clamp01((vis - n.s) / 14);
    let A = p.a + n.side * 1.25;
    if (Math.cos(A) < -0.1) A = p.a - n.side * 1.25; // keep leaves off the ground
    A += wilt * n.side * 0.6;
    const L = gn.leafLen * k * (0.85 + 0.3 * r());
    if (L > 1.5) leaves.push({ kind: 'poly', pts: leafPts(p.x, p.y, A, L, L * gn.leafWidth * 0.5, 0.7, 0.15 * n.side, 8), fill: leafCol, fa: 0.34, gap: 2.6, weight: 1.3, stroke: INK, sw: 1.5 });
    // a flower on every third node
    if (i % 3 === 1 && g >= 3.25) {
      const fa = Math.cos(p.a) < 0.3 ? -n.side * 0.35 : p.a - dir * 0.9; // face up while running
      const fx = p.x + Math.sin(fa) * 6, fy = p.y - Math.cos(fa) * 6;
      stems.push({ kind: 'curve', pts: [[p.x, p.y], [fx, fy]], stroke: stemCol, sw: 1.6, rough: 0.6 });
      const budK = ph.bud * (1 - smooth(0.05, 0.55, ph.open));
      if (budK > 0.03) bud(flower, fx, fy, fa, 9 * budK, petalCol, leafCol);
      flowerHead(flower, { cx: fx, cy: fy, a: fa, open: ph.open * (1 - 0.85 * env.close), fall: ph.fall, podS: ph.podS, gn, rare: d.rare, dryT, petalMul: 0.9, discMul: 0.7 });
      if (ph.podS > 0.02) pod = seedPod(flower, fx, fy, fa, 12, ph.podS, ph.burst, mix(C.pod, C.dry, dryT * 0.6));
      else pod = [fx, fy];
    }
  });
  shell(d, shellS);
  if (!pod && P.length) pod = [P[P.length - 1].x, P[P.length - 1].y];
  return { groups: [{ shapes: soil }, { shapes: [...stems, ...leaves] }, { shapes: shellS }, { shapes: flower }], pod };
}

/** Cactus: a ribbed column with arms, spines and a flower on top. */
function drawCactus(d: DrawIn): Drawing {
  const { gn, g, wilt, env } = d;
  const G = stemG(g);
  const dryT = smooth(0, 0.7, wilt);
  const body = mix(hsl(gn.leafHue, gn.leafSat, gn.leafLight), C.dry, dryT);
  const rib = mix(body, INK, 0.45);
  const Hf = 60 + 70 * gn.height;
  const h = Math.max(0, lerp(4, Hf, G) * smooth(0.25, 1, g));
  const Rw = 3 + 8 * smooth(0, 0.45, G);
  const lean = wilt * 0.25 * (d.seed & 1 ? 1 : -1);

  const soil: Shape[] = [];
  const arms: Shape[] = [];
  const trunk: Shape[] = [];
  const shellS: Shape[] = [];
  const flower: Shape[] = [];
  mound(soil, 14);
  const spines = (c: Pt[], R: number, out: Shape[]) => {
    for (let i = 1; i < c.length; i++) {
      const [x, y] = c[i];
      for (const sd of [-1, 1]) {
        const ex = x + sd * R;
        out.push({ kind: 'line', pts: [[ex, y], [ex + sd * 4, y - 2.5]], stroke: INK, sw: 1, rough: 0.2 });
      }
    }
  };
  if (h > 2) {
    const n = Math.max(2, Math.ceil(h / 9));
    const c: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const y = -(h - Rw) * (i / n);
      c.push([Math.sin(i * 0.9 + d.seed) * 0.8 + lean * -y, y]);
    }
    trunk.push({ kind: 'poly', pts: tubePts(c, Rw, Rw * 0.92), fill: body, fa: 0.4, gap: 2.4, weight: 1.4, style: 'hachure', angle: 80, stroke: INK, sw: 2 });
    for (const off of [-0.42, 0.42]) trunk.push({ kind: 'curve', pts: c.slice(0, -1).map(([x, y]) => [x + off * Rw, y - 2] as Pt), stroke: rib, sw: 1.1, rough: 0.6 });
    if (G > 0.25) spines(c.filter((_, i) => i % 2 === 1), Rw * 0.95, trunk);

    // arms
    const nArms = gn.branchiness > 0.66 ? 2 : gn.branchiness > 0.25 ? 1 : 0;
    const ka = smooth(0.5, 0.9, G);
    const s0 = d.seed & 4 ? 1 : -1;
    for (let i = 0; i < nArms && ka > 0.02; i++) {
      const sd = i === 0 ? s0 : -s0;
      const ay = -h * (0.36 + 0.16 * i);
      const ar = Rw * 0.62;
      const out = (Rw + 6 + 4 * i) * ka;
      const up = h * (0.3 - 0.05 * i) * ka;
      const ac: Pt[] = [[sd * Rw * 0.3, ay], [sd * (Rw * 0.5 + out * 0.6), ay + 1], [sd * (Rw * 0.4 + out), ay - ar * 0.6], [sd * (Rw * 0.4 + out), ay - ar - up]];
      arms.push({ kind: 'poly', pts: tubePts(ac, ar, ar * 0.9), fill: body, fa: 0.4, gap: 2.4, weight: 1.4, style: 'hachure', angle: 80, stroke: INK, sw: 1.9 });
      if (ka > 0.6) spines([ac[2], ac[3]], ar * 0.95, arms);
    }
  }
  shell(d, shellS);

  // flower on the crown, then a fruit that splits
  let pod: Pt | null = null;
  if (g >= 3.25) {
    const ph = bloomPhase(g);
    const tx = lean * h, ty = -h - 1;
    const petalCol = mix(hsl(gn.petalHue, gn.petalSat, gn.petalLight), C.dry, dryT);
    const budK = ph.bud * (1 - smooth(0.05, 0.55, ph.open));
    if (budK > 0.03) bud(flower, tx, ty + 2, 0, 11 * budK, petalCol, body);
    flowerHead(flower, { cx: tx, cy: ty - 2, a: 0, open: ph.open * (1 - 0.85 * env.close), fall: ph.fall, podS: ph.podS, gn, rare: d.rare, dryT, petalMul: 0.95, discMul: 0.8 });
    if (ph.podS > 0.02) {
      const fr = 6.5 * ph.podS;
      const fc = hsl(gn.petalHue, 55, 52);
      if (ph.burst < 0.02) flower.push({ kind: 'poly', pts: ellipsePts(tx, ty - fr * 0.8, fr * 0.8, fr, 0, 12), fill: fc, fa: 0.45, gap: 1.8, stroke: INK, sw: 1.7 });
      else for (const sd of [-1, 1]) flower.push({ kind: 'poly', pts: rotatePts(ellipsePts(tx, ty - fr * 0.8, fr * 0.8, fr, 0, 8, sd < 0 ? Math.PI / 2 : -Math.PI / 2, sd < 0 ? Math.PI * 1.5 : Math.PI / 2), tx, ty, sd * ph.burst), fill: fc, fa: 0.45, gap: 1.8, stroke: INK, sw: 1.7 });
      pod = [tx, ty - fr];
    } else pod = [tx, ty - 4];
  }
  return { groups: [{ shapes: soil }, { shapes: arms }, { shapes: trunk }, { shapes: shellS }, { shapes: flower }], pod };
}

/** Mushroom: a little cluster of caps that pops up together. */
function drawMushroom(d: DrawIn): Drawing {
  const { gn, g, wilt, rare } = d;
  const r = mulberry32(d.seed ^ 0x5f);
  const n = Math.max(1, Math.min(4, Math.round(gn.petalCount)));
  const dryT = smooth(0, 0.7, wilt);
  const capCol = mix(hsl(gn.petalHue, gn.petalSat, gn.petalLight - 6), C.dry, dryT);
  const stemCol = mix('#efe3c8', C.dry, dryT * 0.6);
  const soil: Shape[] = [];
  const stems: Shape[] = [];
  const caps: Shape[] = [];
  const shellS: Shape[] = [];
  mound(soil, 13);

  const SIZES = [1, 0.72, 0.58, 0.5];
  const order: { x: number; s: number; b: number }[] = [];
  for (let i = 0; i < n; i++) order.push({ x: i === 0 ? 0 : (i % 2 ? 1 : -1) * (12 + i * 7) * range(r, 0.85, 1.15), s: SIZES[i] * range(r, 0.9, 1.1), b: i * 0.22 });
  // draw back (small) caps first
  let pod: Pt | null = null;
  for (const m of [...order].reverse()) {
    const u = clamp01((Math.min(g, 4) - 1 - m.b) / 2.5);
    if (u <= 0.01) continue;
    const sh = m.s * (20 + 55 * gn.height) * smooth(0, 0.75, u);
    const R = m.s * (9 + gn.petalLen * 0.75) * (0.35 + 0.65 * smooth(0.15, 1, u));
    const capOpen = smooth(0.45, 1, u);
    const tilt = (m.x === 0 ? 0.1 : Math.sign(m.x) * 0.18) + wilt * 0.5 * (m.x >= 0 ? 1 : -1);
    const top: Pt = [m.x + Math.sin(tilt) * sh, -sh * Math.cos(tilt) * (1 - wilt * 0.35)];
    const sr = Math.max(1.6, R * 0.24);
    if (sh > 1) stems.push({ kind: 'poly', pts: tubePts([[m.x, 0], [(m.x + top[0]) / 2, top[1] / 2], top], sr * 1.15, sr, false), fill: stemCol, fa: 0.55, gap: 1.8, stroke: INK, sw: 1.6 });
    const ry = R * (0.95 - 0.45 * capOpen);
    const capPts = (cx: number, cy: number, rx: number, rh: number): Pt[] => [
      ...ellipsePts(0, 0, rx, rh, 0, 12, Math.PI, Math.PI * 2),
      [rx * 0.7, rh * 0.18], [0, rh * 0.26], [-rx * 0.7, rh * 0.18],
    ].map(([x, y]) => [cx + x * Math.cos(tilt) - y * Math.sin(tilt), cy + x * Math.sin(tilt) + y * Math.cos(tilt)] as Pt);
    const tiers = rare === 'double' ? 2 : 1;
    for (let t = 0; t < tiers; t++) {
      const k = t ? 0.6 : 1;
      const cy = top[1] - (t ? ry * 0.75 : 0);
      const cx = top[0] + (t ? Math.sin(tilt) * ry * 0.75 : 0);
      caps.push({ kind: 'poly', pts: capPts(cx, cy, R * k, ry * k), fill: capCol, fa: 0.45, gap: 2, weight: 1.5, stroke: INK, sw: 1.9 });
      if (rare === 'striped') {
        for (const f of [-0.6, -0.2, 0.2, 0.6]) caps.push({ kind: 'curve', pts: [[cx + f * R * k, cy - ry * k * 0.05], [cx + f * R * k * 0.7, cy - ry * k * 0.6], [cx + f * R * k * 0.25, cy - ry * k * 0.95]], stroke: mix(capCol, '#ffffff', 0.7), sw: 1.8, rough: 0.5 });
      } else if (capOpen > 0.3) {
        for (let j = 0; j < 3; j++) {
          const sx = cx + (j - 1) * R * k * 0.45, sy = cy - ry * k * (j === 1 ? 0.62 : 0.38);
          caps.push({ kind: 'poly', pts: ellipsePts(sx, sy, R * k * 0.12, R * k * 0.09, 0, 7), fill: '#ffffff', fa: 0.85, gap: 1, stroke: mix(capCol, INK, 0.3), sw: 0.8 });
        }
      }
    }
    if (m.x === 0) pod = [top[0], top[1] - ry];
  }
  shell(d, shellS);
  return { groups: [{ shapes: soil }, { shapes: stems }, { shapes: caps }, { shapes: shellS }], pod };
}

/** Tree: many small steps, then a big leafy background element. */
function drawTree(d: DrawIn): Drawing {
  const { gn, g, wilt, env } = d;
  const r = mulberry32(d.seed ^ 0x77);
  const gg = Math.min(g, 4);
  const TG = gg <= 0 ? 0 : gg < 1 ? 0.03 * smooth(0.3, 1, gg) : lerp(0.03, 1, Math.pow((gg - 1) / 3, 0.9));
  const Ht = 210 * gn.height;
  const h = Ht * TG;
  const dryT = smooth(0, 0.7, wilt);
  const bark = mix('#8a5a36', C.dry, dryT * 0.4);
  const leafCol = tone(hsl(gn.leafHue, gn.leafSat, gn.leafLight), env, dryT);
  const soil: Shape[] = [];
  const wood: Shape[] = [];
  const canopy: Shape[] = [];
  const extra: Shape[] = [];
  const shellS: Shape[] = [];
  mound(soil, 16);

  const phase = range(r, 0, 6);
  const trunkX = (s: number) => Math.sin((s / Math.max(1, Ht)) * 2.2 + phase) * 5 * TG - Math.sin(phase) * 5 * TG;
  const bw = 1.6 + 9 * TG, tw = 1 + 2.4 * TG;
  if (h > 1) {
    const n = Math.max(2, Math.ceil(h / 14));
    const c: Pt[] = [];
    for (let i = 0; i <= n; i++) c.push([trunkX((h * i) / n), (-h * i) / n]);
    wood.push({ kind: 'poly', pts: tubePts(c, bw, tw, false), fill: bark, fa: 0.5, gap: 2.4, weight: 1.4, style: 'hachure', angle: 85, stroke: INK, sw: 2 });
    for (let i = 0; i < Math.min(5, n); i++) {
      const y = -h * (0.15 + 0.15 * i), x = trunkX(-y);
      wood.push({ kind: 'curve', pts: [[x - bw * 0.3, y], [x, y - 4], [x + bw * 0.25, y - 1]], stroke: mix(bark, INK, 0.5), sw: 1, rough: 0.6 });
    }
  }
  // branches
  const nB = 3 + Math.round(gn.branchiness * 3);
  const ends: Pt[] = [];
  let sd = r() < 0.5 ? 1 : -1;
  for (let i = 0; i < nB; i++) {
    const f = 0.45 + (0.42 * i) / Math.max(1, nB - 1) + range(r, -0.03, 0.03);
    const ang = sd * range(r, 0.55, 0.95);
    const len = Ht * range(r, 0.24, 0.34) * (1 - f * 0.35);
    sd = -sd;
    const kb = clamp01((TG - 0.25 - f * 0.15) / 0.35);
    if (kb <= 0.02) continue;
    const by = -h * f, bx = trunkX(-by);
    const L = len * kb;
    const ex = bx + Math.sin(ang) * L, ey = by - Math.cos(ang) * L;
    const mx = bx + Math.sin(ang * 0.6) * L * 0.5, my = by - Math.cos(ang * 0.6) * L * 0.55;
    wood.push({ kind: 'curve', pts: [[bx, by], [mx, my], [ex, ey]], stroke: INK, sw: 2.2 + 3.2 * kb * (1 - f * 0.4) + 1.6 });
    wood.push({ kind: 'curve', pts: [[bx, by], [mx, my], [ex, ey]], stroke: bark, sw: 2.2 + 3.2 * kb * (1 - f * 0.4), rough: 0.8 });
    if (env.winter > 0.4) wood.push({ kind: 'curve', pts: [[mx - 3, my - 2.5], [ex, ey - 2.5]], stroke: '#ffffff', sw: 2.2, rough: 0.6 });
    ends.push([ex, ey]);
  }
  if (h > 1) ends.push([trunkX(h), -h]);

  // sprout leaves while it is small
  const sproutK = smooth(0.4, 1.2, gg) * (1 - smooth(0.25, 0.45, TG));
  if (sproutK > 0.03) {
    const tx = trunkX(h), ty = -h;
    for (const s2 of [-1, 1]) extra.push({ kind: 'poly', pts: leafPts(tx, ty, s2 * 0.9, 13 * sproutK, 5.5 * sproutK, 1, 0.2 * s2, 7), fill: leafCol, fa: 0.34, gap: 2.4, stroke: INK, sw: 1.5 });
  }
  // canopy blobs
  const kc = smooth(0.32, 0.9, TG) * (1 - env.winter) * (1 - 0.35 * env.autumn) * (1 - 0.4 * dryT);
  const blobs: [number, number, number][] = [];
  if (kc > 0.02) {
    for (const [ex, ey] of ends) blobs.push([ex, ey, (Ht * 0.12 + Ht * 0.06 * r()) * kc]);
    // fill the middle
    const top = -h;
    for (let i = 0; i < 3; i++) blobs.push([trunkX(h * 0.8) + range(r, -Ht * 0.12, Ht * 0.12), top * range(r, 0.72, 0.92), Ht * range(r, 0.12, 0.16) * kc]);
    for (const [x, y, R] of blobs) canopy.push({ kind: 'poly', pts: ellipsePts(x, y, R, R * 0.82, range(r, -0.3, 0.3), 14).map(([px, py], j) => [px + Math.sin(j * 2.1) * R * 0.06, py + Math.cos(j * 1.7) * R * 0.06] as Pt), fill: leafCol, fa: 0.42, gap: 3.2, weight: 1.5, stroke: mix(leafCol, INK, 0.3), sw: 1.3 });
  }
  // spring blossoms
  if (env.spring > 0.05 && kc > 0.4) {
    const cnt = Math.round(12 * env.spring);
    for (let i = 0; i < cnt; i++) {
      const [x, y, R] = blobs[i % blobs.length];
      const a = r() * Math.PI * 2, q = Math.sqrt(r()) * R * 0.7;
      flowerHead(extra, { cx: x + Math.cos(a) * q, cy: y + Math.sin(a) * q * 0.8, a: range(r, -0.5, 0.5), open: 1, fall: 0, gn, rare: d.rare, dryT, petalMul: 1.5, discMul: 0.5, soft: true });
    }
  }
  // fruit, which drops as seeds
  let pod: Pt | null = h > 1 ? [trunkX(h * 0.85), -h * 0.85] : null;
  const podS = smooth(4.15, 4.6, g) * (1 - smooth(4.7, 4.9, g));
  if (podS > 0.02 && blobs.length) {
    const fc = hsl(gn.petalHue, 55, 50);
    for (let i = 0; i < 6; i++) {
      const [x, y, R] = blobs[i % blobs.length];
      const fx = x + range(r, -0.5, 0.5) * R, fy = y + R * range(r, 0.1, 0.6);
      extra.push({ kind: 'line', pts: [[fx, fy - 5 * podS], [fx, fy - 2]], stroke: INK, sw: 1, rough: 0.3 });
      extra.push({ kind: 'poly', pts: ellipsePts(fx, fy, 3.8 * podS, 3.6 * podS, 0, 9), fill: fc, fa: 0.5, gap: 1.5, stroke: INK, sw: 1.5 });
      if (i === 0) pod = [fx, fy];
    }
  }
  shell(d, shellS);
  return { groups: [{ shapes: soil }, { shapes: wood }, { shapes: canopy }, { shapes: [...extra, ...shellS] }], pod };
}

/** Small loose seed used for flying/bouncing particles. */
export function seedGroups(sp: Species, gn: Genome, golden = false): Group[] {
  return [{ shapes: seedShapes(sp, gn, golden) }];
}

export interface Picked { sp: Species; gn: Genome; rare: Rare | null; }

/** One cut flower: a stem with a leaf and the open head, base at (x, y) leaning by angle a. */
function cutFlower(out: Shape[], f: Picked, x: number, y: number, a: number, len: number) {
  const { gn } = f;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const tx = x + dx * len, ty = y + dy * len;
  const stemCol = hsl(gn.leafHue + 6, gn.leafSat - 4, gn.leafLight - 6);
  out.push({ kind: 'curve', pts: [[x, y], [x + dx * len * 0.5 + a * 3, y + dy * len * 0.5], [tx, ty]], stroke: INK, sw: 4 });
  out.push({ kind: 'curve', pts: [[x, y], [x + dx * len * 0.5 + a * 3, y + dy * len * 0.5], [tx, ty]], stroke: stemCol, sw: 2, rough: 0.8 });
  const lx = x + dx * len * 0.45, ly = y + dy * len * 0.45;
  out.push({ kind: 'poly', pts: leafPts(lx, ly, a + (a >= 0 ? -1 : 1) * 1.1, gn.leafLen * 0.6, gn.leafLen * 0.17, gn.leafP, 0.2, 7), fill: hsl(gn.leafHue, gn.leafSat, gn.leafLight), fa: 0.34, gap: 2.4, stroke: INK, sw: 1.4 });
  const big = f.sp === 'sunflower' ? 0.75 : 1;
  flowerHead(out, { cx: tx, cy: ty, a, open: 1, fall: 0, gn, rare: f.rare, dryT: 0, petalMul: big, discMul: f.sp === 'sunflower' ? 1.4 : 0.9 });
}

/** A single picked flower, used while it flies to the vase. Base at (0,0). */
export function pickedGroups(f: Picked): Group[] {
  const out: Shape[] = [];
  cutFlower(out, f, 0, 0, 0, 34);
  return [{ shapes: out }];
}

interface VaseStyle { name: string; body: Pt[]; fill: string; base: string; rim: string; extra?: (out: Shape[]) => void; neck: number; }
/** Different vases to swap between once one is full. Base at (0,0), mouth at y = -36. */
export const VASES: VaseStyle[] = [
  { name: 'clay jar', body: [[-10, -36], [-9, -30], [-17, -18], [-18, -6], [-13, 0], [13, 0], [18, -6], [17, -18], [9, -30], [10, -36]], fill: '#d98b6a', base: '#f1c9b4', rim: '#a8603f', neck: 10,
    extra: (o) => o.push({ kind: 'curve', pts: [[-15, -16], [0, -13], [15, -16]], stroke: '#f6e3c8', sw: 2, rough: 0.6 }) },
  { name: 'blue jug', body: [[-9, -36], [-11, -28], [-18, -16], [-17, -4], [-11, 0], [11, 0], [17, -4], [18, -16], [11, -28], [9, -36]], fill: '#7fa7cf', base: '#d3e3f1', rim: '#4f7fae', neck: 9,
    extra: (o) => {
      o.push({ kind: 'curve', pts: [[16, -26], [26, -24], [25, -12], [17, -8]], stroke: INK, sw: 2.2, rough: 0.5 });
      for (const y of [-20, -10]) o.push({ kind: 'curve', pts: [[-16, y], [0, y + 2], [16, y]], stroke: '#ffffff', sw: 1.6, rough: 0.6 });
    } },
  { name: 'glass jar', body: [[-13, -36], [-13, -4], [-10, 0], [10, 0], [13, -4], [13, -36]], fill: '#cfe6ea', base: '#eef7f8', rim: '#8fb8c4', neck: 13,
    extra: (o) => {
      o.push({ kind: 'poly', pts: [[-12, -20], [12, -21], [12, -4], [9, -1], [-9, -1], [-12, -4]], fill: '#8fb8d8', fa: 0.4, gap: 2.2, stroke: '#6f98bf', sw: 1 });
      o.push({ kind: 'line', pts: [[-8, -32], [-8, -10]], stroke: '#ffffff', sw: 2, rough: 0.4 });
    } },
  { name: 'sunny pot', body: [[-12, -36], [-14, -30], [-11, -2], [-8, 0], [8, 0], [11, -2], [14, -30], [12, -36]], fill: '#f2c64c', base: '#fbecc0', rim: '#d9822b', neck: 12,
    extra: (o) => {
      for (const [x, y] of [[-5, -24], [5, -16], [-3, -8]] as Pt[]) o.push({ kind: 'poly', pts: ellipsePts(x, y, 2.4, 2.4, 0, 7), fill: '#ffffff', fa: 0.8, gap: 1, stroke: '#d9822b', sw: 1 });
    } },
  { name: 'green bottle', body: [[-5, -36], [-5, -28], [-15, -18], [-15, -3], [-11, 0], [11, 0], [15, -3], [15, -18], [5, -28], [5, -36]], fill: '#8cc06a', base: '#d9ecc9', rim: '#5d8f3f', neck: 5,
    extra: (o) => o.push({ kind: 'line', pts: [[-10, -16], [-10, -5]], stroke: '#ffffff', sw: 2, rough: 0.4 }) },
  { name: 'striped mug', body: [[-14, -36], [-14, -3], [-11, 0], [11, 0], [14, -3], [14, -36]], fill: '#f3ecd6', base: '#fbf6e6', rim: '#b5523b', neck: 14,
    extra: (o) => {
      for (const y of [-29, -19, -9]) o.push({ kind: 'line', pts: [[-13, y], [13, y]], stroke: '#e6a3b4', sw: 3.4, rough: 0.5 });
      o.push({ kind: 'curve', pts: [[14, -28], [23, -26], [23, -12], [14, -10]], stroke: INK, sw: 2.2, rough: 0.5 });
    } },
];

/** The vase in the corner with every picked flower fanned out. Base of the vase at (0,0). */
export function vaseGroups(items: Picked[], style = 0): Group[] {
  const v = VASES[((style % VASES.length) + VASES.length) % VASES.length];
  const flowers: Shape[] = [];
  const n = items.length;
  items.forEach((f, i) => {
    const a = n > 1 ? (i / (n - 1) - 0.5) * 1.1 : 0;
    const len = 46 + ((i * 37) % 3) * 9;
    cutFlower(flowers, f, a * Math.min(6, v.neck * 0.6), -34, a, len);
  });
  const shapes: Shape[] = [{ kind: 'poly', pts: v.body, fill: v.fill, base: v.base, fa: 0.75, gap: 2.4, weight: 1.4, style: 'hachure', angle: 70, stroke: INK, sw: 2 }];
  v.extra?.(shapes);
  shapes.push({ kind: 'poly', pts: ellipsePts(0, -36, v.neck, 2.6, 0, 10), fill: v.rim, fa: 0.6, gap: 1.6, stroke: INK, sw: 1.6 });
  return [{ shapes: flowers }, { shapes }];
}
