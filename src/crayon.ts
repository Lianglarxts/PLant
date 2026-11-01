import rough from 'roughjs';
import type { RoughCanvas } from 'roughjs/bin/canvas';
import { hash } from './util';

export type Pt = [number, number];
export type Mat = [number, number, number, number, number, number];

export const INK = '#2e2823';
export const PAPER = '#F4EEDC';

/** Muted crayon palette. */
export const C = {
  grass: '#6c9a3e',
  grassDark: '#4c7a2c',
  leaf: '#5f8f3c',
  sky: '#8fb8d8',
  skyDark: '#6f98bf',
  sun: '#f2c64c',
  sunEdge: '#d9822b',
  brick: '#b5523b',
  pink: '#e6a3b4',
  soil: '#8f6240',
  soilDark: '#6b4529',
  dry: '#a3814f',
  pod: '#c4a062',
};

/**
 * A shape is drawn in two passes: its fill goes into a scratch layer that gets the wax-grain
 * mask, then its outline is drawn on top with rough.js.
 */
export interface Shape {
  kind: 'poly' | 'curve' | 'line';
  pts: Pt[];
  fill?: string;
  base?: string; // colour of the faint solid underlayer (defaults to fill)
  fa?: number; // alpha of the solid underlayer
  gap?: number;
  weight?: number;
  style?: string;
  angle?: number;
  stroke?: string;
  sw?: number;
  rough?: number;
}
export interface Group {
  shapes: Shape[];
}

// ---------- colour helpers ----------
export function hsl(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbHex(f(0) * 255, f(8) * 255, f(4) * 255);
}
function rgbHex(r: number, g: number, b: number) {
  const h = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}
export function mix(a: string, b: string, t: number): string {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (p: number, s: number) => (p >> s) & 255;
  return rgbHex(
    ch(pa, 16) + (ch(pb, 16) - ch(pa, 16)) * t,
    ch(pa, 8) + (ch(pb, 8) - ch(pa, 8)) * t,
    ch(pa, 0) + (ch(pb, 0) - ch(pa, 0)) * t,
  );
}

// ---------- textures ----------
let grainTile: HTMLCanvasElement | null = null;
/** Alpha mask of paper "tooth": blobby specks where wax didn't stick. */
function getGrain(): HTMLCanvasElement {
  if (grainTile) return grainTile;
  const S = 192;
  const small = document.createElement('canvas');
  small.width = small.height = S / 2;
  const sctx = small.getContext('2d')!;
  const id = sctx.createImageData(S / 2, S / 2);
  for (let i = 0; i < (S / 2) * (S / 2); i++) {
    const r = Math.random();
    id.data[i * 4 + 3] = r < 0.16 ? 235 : r < 0.5 ? Math.random() * 70 : 0;
  }
  sctx.putImageData(id, 0, 0);
  const tile = document.createElement('canvas');
  tile.width = tile.height = S;
  const tctx = tile.getContext('2d')!;
  tctx.imageSmoothingEnabled = true;
  tctx.drawImage(small, 0, 0, S, S);
  // fine pinholes + a few horizontal drag streaks
  const fid = tctx.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) if (Math.random() < 0.07) fid.data[i * 4 + 3] = 210;
  tctx.putImageData(fid, 0, 0);
  tctx.strokeStyle = 'rgba(0,0,0,0.5)';
  tctx.lineWidth = 1;
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    tctx.beginPath();
    tctx.moveTo(x, y);
    tctx.lineTo(x + 4 + Math.random() * 10, y + (Math.random() - 0.5) * 3);
    tctx.stroke();
  }
  grainTile = tile;
  return tile;
}

let paperTile: HTMLCanvasElement | null = null;
export function getPaperTile(): HTMLCanvasElement {
  if (paperTile) return paperTile;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, S, S);
  const id = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) {
    const n = (Math.random() - 0.5) * 14;
    id.data[i * 4] += n;
    id.data[i * 4 + 1] += n;
    id.data[i * 4 + 2] += n * 0.9;
  }
  ctx.putImageData(id, 0, 0);
  // paper fibres
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * S, y = Math.random() * S, a = Math.random() * Math.PI;
    const l = 3 + Math.random() * 9;
    ctx.strokeStyle = Math.random() < 0.5 ? 'rgba(120,95,60,0.10)' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + 1.5, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
  paperTile = c;
  return c;
}

// ---------- drawing ----------
const rcMap = new WeakMap<HTMLCanvasElement, RoughCanvas>();
function rcOf(c: HTMLCanvasElement) {
  let r = rcMap.get(c);
  if (!r) {
    r = rough.canvas(c);
    rcMap.set(c, r);
  }
  return r;
}

let temp: HTMLCanvasElement | null = null;
function getTemp(w: number, h: number) {
  if (!temp) temp = document.createElement('canvas');
  if (temp.width < w || temp.height < h) {
    temp.width = Math.max(temp.width, w);
    temp.height = Math.max(temp.height, h);
  }
  return temp;
}

/**
 * Render groups of shapes onto `target` using transform `T` (units -> device pixels).
 * Within each group: fills (grain-masked) first, then rough outlines.
 */
export function drawGroups(target: HTMLCanvasElement, groups: Group[], T: Mat, seed: number, boil: number, grain = 0.85) {
  const ctx = target.getContext('2d')!;
  const W = target.width, H = target.height;
  if (!W || !H) return;
  const rcT = rcOf(target);
  for (let gi = 0; gi < groups.length; gi++) {
    const shapes = groups[gi].shapes;
    let hasFill = false;
    for (const s of shapes) if (s.fill && s.kind === 'poly' && s.pts.length > 2) hasFill = true;

    if (hasFill) {
      const tmp = getTemp(W, H);
      const tctx = tmp.getContext('2d')!;
      const rcTmp = rcOf(tmp);
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.clearRect(0, 0, W, H);
      tctx.setTransform(...T);
      shapes.forEach((s, si) => {
        if (!s.fill || s.kind !== 'poly' || s.pts.length < 3) return;
        // faint solid wax underlayer
        tctx.globalAlpha = s.fa ?? 0.28;
        tctx.fillStyle = s.base ?? s.fill;
        tctx.beginPath();
        tctx.moveTo(s.pts[0][0], s.pts[0][1]);
        for (let i = 1; i < s.pts.length; i++) tctx.lineTo(s.pts[i][0], s.pts[i][1]);
        tctx.closePath();
        tctx.fill();
        tctx.globalAlpha = 1;
        // scribbled strokes
        rcTmp.polygon(s.pts, {
          fill: s.fill,
          fillStyle: s.style ?? 'zigzag',
          stroke: 'none',
          hachureGap: s.gap ?? 2.8,
          fillWeight: s.weight ?? 1.5,
          hachureAngle: s.angle ?? -30 - ((si * 23 + gi * 11) % 45),
          roughness: Math.min(1.3, sizeOf(s.pts) / 22),
          seed: hash(seed, gi * 977 + si, boil),
        });
      });
      // wax grain: knock specks out of the fills so paper shows through
      tctx.setTransform(1, 0, 0, 1, (boil * 37) % 192, (boil * 53) % 192);
      tctx.globalCompositeOperation = 'destination-out';
      tctx.globalAlpha = grain;
      tctx.fillStyle = tctx.createPattern(getGrain(), 'repeat')!;
      tctx.fillRect(-200, -200, W + 400, H + 400);
      tctx.globalAlpha = 1;
      tctx.globalCompositeOperation = 'source-over';
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(tmp, 0, 0, W, H, 0, 0, W, H);
      ctx.restore();
    }

    ctx.setTransform(...T);
    shapes.forEach((s, si) => {
      if (!s.stroke || s.pts.length < 2) return;
      const sz = sizeOf(s.pts);
      const o = {
        stroke: s.stroke,
        strokeWidth: s.sw ?? 2,
        // small shapes get less jitter so they don't turn into scribbled knots
        roughness: Math.min(s.rough ?? 1.5, 0.35 + sz / 28),
        disableMultiStroke: sz < 22,
        bowing: 1,
        seed: hash(seed, gi * 977 + si + 5000, boil),
      };
      if (s.kind === 'line' || s.pts.length === 2) {
        rcT.line(s.pts[0][0], s.pts[0][1], s.pts[s.pts.length - 1][0], s.pts[s.pts.length - 1][1], o);
      } else if (s.kind === 'poly') {
        // fewer control points = smoother hand-drawn loop instead of a knotted one
        const pts = s.pts.length > 12 ? s.pts.filter((_, i) => i % 2 === 0) : s.pts;
        rcT.curve([...pts, pts[0]], o);
      } else {
        rcT.curve(s.pts, o);
      }
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

// ---------- geometry helpers ----------
function sizeOf(pts: Pt[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return Math.hypot(x1 - x0, y1 - y0);
}
/** Leaf/petal-like outline from base point along angle A (0 = up, +cw). */
export function leafPts(px: number, py: number, A: number, L: number, W: number, P: number, bend = 0, n = 8): Pt[] {
  const dx = Math.sin(A), dy = -Math.cos(A), nx = -dy, ny = dx;
  const right: Pt[] = [], left: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const hw = W * Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(u, P))), 0.8);
    const bo = bend * L * 0.2 * Math.sin(Math.PI * u * 0.9);
    const cx = px + dx * u * L + nx * bo, cy = py + dy * u * L + ny * bo;
    right.push([cx + nx * hw, cy + ny * hw]);
    left.push([cx - nx * hw, cy - ny * hw]);
  }
  left.reverse();
  return [...right, ...left.slice(1, -1)];
}

export function ellipsePts(cx: number, cy: number, rx: number, ry: number, rot = 0, n = 14, a0 = 0, a1 = Math.PI * 2): Pt[] {
  const out: Pt[] = [];
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
  const cnt = full ? n : n + 1;
  for (let i = 0; i < cnt; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
    out.push([cx + x * cr - y * sr, cy + x * sr + y * cr]);
  }
  return out;
}

export function rotatePts(pts: Pt[], ox: number, oy: number, a: number): Pt[] {
  const c = Math.cos(a), s = Math.sin(a);
  return pts.map(([x, y]) => [ox + (x - ox) * c - (y - oy) * s, oy + (x - ox) * s + (y - oy) * c]);
}

export function boundsOf(groups: Group[], pad: number): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of groups)
    for (const s of g.shapes)
      for (const [x, y] of s.pts) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
  if (x0 === Infinity) return [-pad, -pad, pad, pad];
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

export interface Sprite {
  canvas: HTMLCanvasElement;
  ox: number; // CSS-px offset of canvas top-left from the anchor
  oy: number;
  w: number; // CSS-px size
  h: number;
}

/** Render groups (in units, anchored at 0,0) into a canvas scaled by sc, at device ratio dpr. */
export function renderSprite(groups: Group[], sc: number, dpr: number, seed: number, boil: number, pad = 8, canvas?: HTMLCanvasElement, grain?: number): Sprite {
  const [x0, y0, x1, y1] = boundsOf(groups, pad);
  const c = canvas ?? document.createElement('canvas');
  const wpx = Math.max(1, Math.ceil((x1 - x0) * sc * dpr));
  const hpx = Math.max(1, Math.ceil((y1 - y0) * sc * dpr));
  if (c.width !== wpx || c.height !== hpx) {
    c.width = wpx;
    c.height = hpx;
  } else {
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, wpx, hpx);
  }
  const k = sc * dpr;
  drawGroups(c, groups, [k, 0, 0, k, -x0 * k, -y0 * k], seed, boil, grain);
  return { canvas: c, ox: x0 * sc, oy: y0 * sc, w: wpx / dpr, h: hpx / dpr };
}
