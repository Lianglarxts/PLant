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

export function cloudGroups(w: number, seed: number, dark = false): Group[] {
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
  return [{
    shapes: [{
      kind: 'poly', pts, fill: dark ? '#8e99a6' : '#dbe7f0', base: dark ? '#c3cad2' : '#fdfaf2', fa: 0.92, gap: dark ? 3.5 : 5, weight: 1.6,
      style: 'hachure', angle: -20, stroke: dark ? '#5f6b78' : C.skyDark, sw: 2.3,
    }],
  }];
}

export function dropGroups(): Group[] {
  return [{ shapes: [{ kind: 'poly', pts: leafPts(0, 5, Math.PI, 13, 4.2, 1.6, 0, 6), fill: C.sky, fa: 0.5, gap: 1.6, stroke: '#4f7fae', sw: 1.6 }] }];
}

export function moonGroups(R: number): Group[] {
  const craters: Shape[] = [[-0.35, 0.3, 0.16], [0.3, 0.45, 0.11], [0.42, -0.1, 0.09]].map(([x, y, r]) => ({
    kind: 'poly', pts: ellipsePts(x * R, y * R, r * R, r * R * 0.85, 0, 9), fill: '#d8c98f', fa: 0.6, gap: 1.6, stroke: '#b9a76a', sw: 1.2,
  }));
  return [
    { shapes: [{ kind: 'poly', pts: ellipsePts(0, 0, R, R * 0.97, 0, 18), fill: '#f4ebc3', base: '#fbf6e2', fa: 0.85, gap: 3, weight: 1.6, stroke: '#b9a76a', sw: 2.4 }, ...craters] },
    {
      shapes: [
        { kind: 'curve', pts: [[-R * 0.42, -R * 0.12], [-R * 0.3, -R * 0.03], [-R * 0.18, -R * 0.12]], stroke: INK, sw: 1.8, rough: 0.4 },
        { kind: 'curve', pts: [[R * 0.08, -R * 0.12], [R * 0.2, -R * 0.03], [R * 0.32, -R * 0.12]], stroke: INK, sw: 1.8, rough: 0.4 },
        { kind: 'curve', pts: [[-R * 0.15, R * 0.15], [-R * 0.06, R * 0.22], [R * 0.04, R * 0.15]], stroke: INK, sw: 1.6, rough: 0.4 },
      ],
    },
  ];
}

export function starGroups(r: number): Group[] {
  const pts: Pt[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const q = i % 2 ? r * 0.45 : r;
    pts.push([Math.cos(a) * q, Math.sin(a) * q]);
  }
  return [{ shapes: [{ kind: 'poly', pts, fill: '#f2d25c', fa: 0.85, gap: 1.4, stroke: '#c99a2e', sw: 1.2 }] }];
}

export function leafBitGroups(color: string): Group[] {
  return [{ shapes: [{ kind: 'poly', pts: leafPts(0, 5, 0, 11, 3.6, 1, 0.25, 6), fill: color, fa: 0.55, gap: 1.6, stroke: INK, sw: 1.1 }] }];
}

export function flakeGroups(): Group[] {
  const out: Shape[] = [{ kind: 'poly', pts: ellipsePts(0, 0, 3.8, 3.8, 0, 8), fill: '#ffffff', base: '#ffffff', fa: 0.95, gap: 1, stroke: '#6f8ba3', sw: 1.4 }];
  return [{ shapes: out }];
}

/** Cartoon wind curl drifting across the sky. */
export function windGroups(seed: number): Group[] {
  const r = mulberry32(seed);
  const L = range(r, 50, 80);
  const pts: Pt[] = [];
  for (let x = 0; x <= L; x += 8) pts.push([x - L, Math.sin(x * 0.09 + seed) * 3]);
  const R = range(r, 5, 8);
  for (let i = 0; i <= 8; i++) {
    const a = -Math.PI / 2 + (i / 8) * Math.PI * 1.6;
    pts.push([Math.cos(a) * R, R + Math.sin(a) * R - R]);
  }
  return [{ shapes: [{ kind: 'curve', pts, stroke: '#8aa5bd', sw: 2, rough: 0.6 }] }];
}

/** White crayon snow lying along the soil line. */
export function snowCapGroups(W: number, H: number): { groups: Group[]; top: number } {
  const r = mulberry32(31 + Math.round(W));
  const top: Pt[] = [], bottom: Pt[] = [];
  for (let x = -30; x <= W + 30; x += 22) {
    const gy = groundY(x, H);
    top.push([x, gy - 3 - r() * 4]);
    bottom.unshift([x, gy + 5 + r() * 5]);
  }
  const drifts: Shape[] = [];
  for (let i = 0; i < Math.round(W / 70); i++) {
    const x = range(r, 0, W);
    const y = range(r, groundY(x, H) + 30, H - 10);
    drifts.push({ kind: 'poly', pts: ellipsePts(x, y, range(r, 14, 30), range(r, 3, 6), 0, 10), fill: '#ffffff', base: '#ffffff', fa: 0.8, gap: 2, stroke: '#b8cad8', sw: 1.2 });
  }
  return {
    groups: [{ shapes: [{ kind: 'poly', pts: [...top, ...bottom], fill: '#ffffff', base: '#ffffff', fa: 0.9, gap: 2.2, stroke: '#b8cad8', sw: 1.6 }, ...drifts] }],
    top: H * 0.64 - 40,
  };
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

export function renderSnowCap(W: number, H: number, dpr: number) {
  const { groups, top } = snowCapGroups(W, H);
  const c = document.createElement('canvas');
  c.width = Math.ceil(W * dpr);
  c.height = Math.ceil((H - top) * dpr);
  drawGroups(c, groups, [dpr, 0, 0, dpr, 0, -top * dpr], 555, 0);
  return { canvas: c, top };
}

/** Watering can, centred on its body; the spout tip is at CAN_TIP. */
export const CAN_TIP: Pt = [37, -13];
export function canGroups(): Group[] {
  const body: Pt[] = [[-16, -13], [14, -13], [16, 14], [-18, 14]];
  const spout: Pt[] = [[11, 5], [33, -15], [37, -11], [15, 11]];
  return [
    {
      shapes: [
        { kind: 'poly', pts: spout, fill: '#8fb8d8', fa: 0.55, gap: 2, stroke: INK, sw: 1.8 },
        { kind: 'poly', pts: ellipsePts(36, -14, 4.5, 2.6, -0.8, 8), fill: '#6f98bf', fa: 0.7, gap: 1.4, stroke: INK, sw: 1.4 },
      ],
    },
    {
      shapes: [
        { kind: 'poly', pts: body, fill: '#8fb8d8', fa: 0.55, gap: 2.4, stroke: INK, sw: 2 },
        { kind: 'curve', pts: [[-13, -13], [-3, -31], [10, -13]], stroke: INK, sw: 2.8, rough: 0.6 },
        { kind: 'curve', pts: [[-14, 1], [0, 2], [13, 0]], stroke: '#5b8fc0', sw: 1.6, rough: 0.6 },
      ],
    },
  ];
}

/** Crayon rainbow: six thick rough bands, centred at (0,0), upper half only. */
export function rainbowGroups(R: number): Group[] {
  const cols = ['#d9634f', '#f0a35c', '#f2d25c', '#8cc06a', '#6fa4d4', '#9b86c9'];
  const bw = Math.max(7, R * 0.045);
  return [{
    shapes: cols.map((c, i) => {
      const r = R - i * bw * 0.92;
      const pts: Pt[] = [];
      for (let k = 0; k <= 28; k++) {
        const a = Math.PI + (Math.PI * k) / 28;
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      return { kind: 'curve', pts, stroke: c, sw: bw, rough: 1.3 } as Shape;
    }),
  }];
}
