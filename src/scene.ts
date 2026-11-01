import { Group, Shape, Pt, INK, C, drawGroups, getPaperTile, ellipsePts, renderSprite, Sprite, leafPts } from './crayon';
import { mulberry32, range } from './util';

export function groundY(x: number, H: number) {
  return H * 0.64 + 9 * Math.sin(x * 0.007 + 0.6) + 5 * Math.sin(x * 0.019 + 2);
}

/** Paper + scribbled sky band. Static (paper does not boil). */
export function buildBackground(W: number, H: number, dpr: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.ceil(W * dpr);
  c.height = Math.ceil(H * dpr);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = ctx.createPattern(getPaperTile(), 'repeat')!;
  ctx.fillRect(0, 0, c.width, c.height);

  const band = (y: number, amp: number, ph: number): Pt[] => {
    const pts: Pt[] = [[-20, -20], [W + 20, -20]];
    for (let x = W + 20; x >= -20; x -= 40) pts.push([x, y + amp * Math.sin(x * 0.011 + ph) + 4 * Math.sin(x * 0.033)]);
    return pts;
  };
  const sky: Group[] = [
    { shapes: [{ kind: 'poly', pts: band(H * 0.19, 10, 1), fill: C.sky, fa: 0.16, gap: 9, weight: 2.4, style: 'zigzag', angle: 84 }] },
    { shapes: [{ kind: 'poly', pts: band(H * 0.09, 8, 3), fill: C.sky, fa: 0.1, gap: 12, weight: 2.2, style: 'hachure', angle: 87 }] },
  ];
  drawGroups(c, sky, [dpr, 0, 0, dpr, 0, 0], 4242, 0, 0.7);

  // soft vignette like an old sheet of paper
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createRadialGradient(c.width / 2, c.height / 2, Math.min(c.width, c.height) * 0.35, c.width / 2, c.height / 2, Math.max(c.width, c.height) * 0.75);
  g.addColorStop(0, 'rgba(120,90,50,0)');
  g.addColorStop(1, 'rgba(120,90,50,0.13)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/** Soil, wavy horizon line, grass tufts, pebbles. Rendered in 3 boil variants. */
export function groundGroups(W: number, H: number): { groups: Group[]; top: number } {
  const r = mulberry32(777 + Math.round(W));
  const top: Pt[] = [];
  for (let x = -30; x <= W + 30; x += 30) top.push([x, groundY(x, H)]);
  const soil: Pt[] = [...top, [W + 30, H + 30], [-30, H + 30]];
  const fills: Shape[] = [
    { kind: 'poly', pts: soil, fill: '#b08560', fa: 0.42, gap: 13, weight: 1.2, style: 'zigzag', angle: 70 },
  ];
  const marks: Shape[] = [];
  // soil scribbles
  const n = Math.round((W * (H * 0.36)) / 9000);
  for (let i = 0; i < n; i++) {
    const x = range(r, 0, W);
    const y = range(r, groundY(x, H) + 18, H - 6);
    const l = range(r, 5, 12);
    marks.push({ kind: 'curve', pts: [[x, y], [x + l * 0.5, y - 2.5], [x + l, y]], stroke: C.soilDark, sw: 1.4, rough: 1 });
  }
  // pebbles
  for (let i = 0; i < Math.round(W / 90); i++) {
    const x = range(r, 0, W);
    const y = range(r, groundY(x, H) + 24, H - 10);
    const s = range(r, 2.5, 5);
    fills.push({ kind: 'poly', pts: ellipsePts(x, y, s * 1.4, s, range(r, -0.4, 0.4), 9), fill: '#9a8c7a', fa: 0.4, gap: 1.6, stroke: '#5d5246', sw: 1.2 });
  }
  const line: Shape = { kind: 'curve', pts: top, stroke: C.soilDark, sw: 3.2, rough: 1.4 };
  // grass tufts along the soil line
  const grass: Shape[] = [];
  for (let x = range(r, 0, 20); x < W + 10; x += range(r, 20, 46)) {
    const gy = groundY(x, H) + 2;
    const blades = 3 + Math.floor(r() * 3);
    for (let b = 0; b < blades; b++) {
      const bx = x + (b - blades / 2) * 2.5;
      const h = range(r, 7, 17);
      const lean = range(r, -6, 6) + (b - blades / 2) * 2;
      grass.push({ kind: 'curve', pts: [[bx, gy], [bx + lean * 0.4, gy - h * 0.6], [bx + lean, gy - h]], stroke: r() < 0.5 ? C.grass : C.grassDark, sw: 2.1, rough: 1 });
    }
  }
  // a few tufts scattered on the soil too
  for (let i = 0; i < Math.round(W / 140); i++) {
    const x = range(r, 0, W);
    const gy = range(r, groundY(x, H) + 40, H - 14);
    for (let b = 0; b < 3; b++) grass.push({ kind: 'line', pts: [[x + b * 3, gy], [x + b * 3 + (b - 1) * 4, gy - range(r, 6, 11)]], stroke: C.grassDark, sw: 1.8, rough: 1 });
  }
  const y0 = H * 0.64 - 40;
  return { groups: [{ shapes: fills }, { shapes: [...marks, line, ...grass] }], top: y0 };
}

export function renderGround(W: number, H: number, dpr: number, boil: number, canvas?: HTMLCanvasElement) {
  const { groups, top } = groundGroups(W, H);
  const c = canvas ?? document.createElement('canvas');
  c.width = Math.ceil(W * dpr);
  c.height = Math.ceil((H - top) * dpr);
  drawGroups(c, groups, [dpr, 0, 0, dpr, 0, -top * dpr], 9001, boil);
  return { canvas: c, top };
}

export function sunGroups(R: number): Group[] {
  const rays: Shape[] = [];
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2;
    const r0 = R * 1.28, r1 = R * (i % 2 ? 1.62 : 1.78);
    rays.push({ kind: 'line', pts: [[Math.cos(a) * r0, Math.sin(a) * r0], [Math.cos(a) * r1, Math.sin(a) * r1]], stroke: '#e3a530', sw: 3, rough: 1.2 });
  }
  const disc = ellipsePts(0, 0, R, R * 0.97, 0, 18);
  return [
    { shapes: [{ kind: 'poly', pts: disc, fill: C.sun, fa: 0.45, gap: 3.2, weight: 2, stroke: C.sunEdge, sw: 2.6 }] },
    {
      shapes: [
        ...rays,
        { kind: 'line', pts: [[-R * 0.32, -R * 0.2], [-R * 0.3, -R * 0.06]], stroke: INK, sw: 2.2, rough: 0.8 },
        { kind: 'line', pts: [[R * 0.32, -R * 0.2], [R * 0.3, -R * 0.06]], stroke: INK, sw: 2.2, rough: 0.8 },
        { kind: 'curve', pts: [[-R * 0.38, R * 0.18], [0, R * 0.42], [R * 0.38, R * 0.18]], stroke: INK, sw: 2, rough: 0.8 },
      ],
    },
  ];
}

export function cloudGroups(w: number, seed: number): Group[] {
  const r = mulberry32(seed);
  const h = w * range(r, 0.38, 0.5);
  const bumps = 3 + Math.floor(r() * 3);
  const pts: Pt[] = [];
  const N = 40;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    let x = Math.cos(a) * w * 0.5, y = Math.sin(a) * h * 0.5;
    if (y < 0) {
      const m = 1 + 0.2 * Math.abs(Math.sin((a - Math.PI) * bumps));
      x *= m;
      y *= m;
    } else y *= 0.45;
    pts.push([x, y]);
  }
  return [{ shapes: [{ kind: 'poly', pts, fill: '#dbe7f0', base: '#fdfaf2', fa: 0.92, gap: 5, weight: 1.6, style: 'hachure', angle: -20, stroke: C.skyDark, sw: 2.3 }] }];
}

export function dropGroups(): Group[] {
  return [{ shapes: [{ kind: 'poly', pts: leafPts(0, 5, Math.PI, 13, 4.2, 1.6, 0, 6), fill: C.sky, fa: 0.5, gap: 1.6, stroke: '#4f7fae', sw: 1.6 }] }];
}

/** Cache of small sprites in 3 boil variants, keyed by name. */
export class SpriteBank {
  private m = new Map<string, Sprite[]>();
  constructor(public dpr: number) {}
  get(key: string, boil: number, sc: number, make: () => Group[], seed = 1): Sprite {
    const k = key + '|' + sc.toFixed(3);
    let arr = this.m.get(k);
    if (!arr) {
      arr = [];
      this.m.set(k, arr);
    }
    if (!arr[boil]) arr[boil] = renderSprite(make(), sc, this.dpr, seed, boil, 6);
    return arr[boil];
  }
  clear() {
    this.m.clear();
  }
}
