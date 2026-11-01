import type { Genome } from './genome';
import { mulberry32, range, clamp01, smooth, lerp, angDiff, Rng } from './util';
import { Group, Shape, Pt, INK, C, hsl, mix, leafPts, ellipsePts, rotatePts } from './crayon';

/*
 * Growth model. A plant's visual state is a continuous value g:
 *   0 seed · 1 sprout · 2 seedling · 3 growing · 4 mature (flower open) · 5 seeds released
 * Clicking animates g from k to k+1. Everything below is a pure function of (structure, g, wilt),
 * so any in-between frame can be drawn.
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

/** Recursive, L-system-like branching skeleton, deterministic for (genome, seed). */
export function buildStructure(gn: Genome, seed: number): Axis {
  const r = mulberry32(seed);
  const H = 200 * gn.height;
  const main = makeAxis(r, gn, H, 0, 0, 1);
  main.rel = gn.lean + range(r, -0.08, 0.08);
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

export interface Drawing {
  groups: Group[];
  pod: Pt | null; // where seeds launch from
}

export function seedColor(gn: Genome) {
  return hsl(26 + ((gn.centerHue * 1.7) % 18), 45, 52 + (gn.centerLight - 28) * 0.25);
}

interface SP { x: number; y: number; a: number; }

export function drawPlant(main: Axis, gn: Genome, g: number, wilt: number): Drawing {
  const G = stemG(g);
  const dryT = smooth(0, 0.7, wilt);
  const leafCol = mix(hsl(gn.leafHue, gn.leafSat, gn.leafLight), C.dry, dryT);
  const cotyCol = mix(hsl(gn.leafHue - 14, gn.leafSat + 6, gn.leafLight + 6), C.dry, dryT);
  const stemCol = mix(hsl(gn.leafHue + 6, gn.leafSat - 4, gn.leafLight - 6), C.dry, dryT);
  const curl = 1 - smooth(1.0, 1.8, g);
  const droop = gn.lean >= 0 ? 1 : -1;

  const mound: Shape[] = [];
  const stems: Shape[] = [];
  const leaves: Shape[] = [];
  const shell: Shape[] = [];
  const flower: Shape[] = [];
  let tip: SP | null = null;

  // --- soil mound
  const mp: Pt[] = [[-12, 2], [-6, -1.8], [0, -2.8], [6, -1.8], [12, 2]];
  mound.push({ kind: 'poly', pts: mp, fill: C.soil, fa: 0.35, gap: 2.2 });
  mound.push({ kind: 'curve', pts: mp, stroke: C.soilDark, sw: 1.8, rough: 1.2 });

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

  const walk = (ax: Axis, bx: number, by: number, a0: number, isMain: boolean) => {
    const span = Math.max(1e-4, ax.endG - ax.startG);
    const vis = ax.len * clamp01((G - ax.startG) / span);
    if (vis < 0.4) return;
    const hookLen = 11;
    const angleAt = (s: number) => {
      let a = a0 + ax.curve * (Math.sin((ax.freq * Math.PI * s) / ax.len + ax.phase) - Math.sin(ax.phase));
      a += wilt * droop * 1.5 * Math.pow(s / ax.len, 1.3);
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
    const w = ax.width * (isMain ? 0.55 + 0.45 * clamp01(G / 0.5) : 1);
    stems.push({ kind: 'curve', pts: sp, stroke: INK, sw: w + 2.2 });
    stems.push({ kind: 'curve', pts: sp, stroke: stemCol, sw: w, rough: 1.1 });

    for (const lf of ax.leaves) {
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
      walk(kid, p.x, p.y, p.a + kid.rel + wilt * Math.sign(kid.rel) * 0.35, false);
    }
    if (isMain) tip = last;
  };
  walk(main, 0, 0, main.rel, true);

  // --- seed shell: whole, then cracked into two halves that fall away
  const shellK = 1 - smooth(1.5, 2.3, g);
  if (shellK > 0.02) {
    const sc = seedColor(gn);
    const rx = 8 * (0.5 + 0.5 * shellK), ry = 5.3 * (0.5 + 0.5 * shellK);
    const crack = smooth(0.05, 0.5, g);
    const cy = -ry * 0.85;
    if (crack < 0.02) {
      const pts = ellipsePts(0, cy, rx, ry, -0.12, 14);
      shell.push({ kind: 'poly', pts, fill: sc, fa: 0.45, gap: 1.8, weight: 1.3, stroke: INK, sw: 1.8 });
      shell.push({ kind: 'curve', pts: [[-2.5, cy - 1.5], [0.5, cy - 2.2], [2.5, cy - 1]], stroke: mix(sc, '#ffffff', 0.5), sw: 1, rough: 0.6 });
    } else {
      const open = crack * 0.55 + (1 - shellK) * 0.9;
      const slide = (1 - shellK) * 6;
      for (const side of [-1, 1]) {
        let half = ellipsePts(0, cy, rx, ry, 0, 7, side < 0 ? Math.PI / 2 : -Math.PI / 2, side < 0 ? Math.PI * 1.5 : Math.PI / 2);
        // jagged crack edge
        half.push([side * 1.2, cy - ry * 0.5], [side * -0.4, cy], [side * 1.0, cy + ry * 0.5]);
        half = rotatePts(half, side * rx * 0.3, 0, side * open);
        half = half.map(([x, y]) => [x + side * slide, y] as Pt);
        shell.push({ kind: 'poly', pts: half, fill: sc, fa: 0.45, gap: 1.8, weight: 1.3, stroke: INK, sw: 1.7 });
      }
    }
  }

  // --- bud, flower, pod
  let pod: Pt | null = null;
  const t = tip as SP | null;
  if (t && g >= 3.25) {
    const dx = Math.sin(t.a), dy = -Math.cos(t.a);
    const budS = smooth(3.25, 3.6, g);
    const open = smooth(3.55, 4, g);
    const fall = smooth(4, 4.35, g);
    const podS = smooth(4.15, 4.6, g);
    const burst = smooth(4.7, 4.95, g);
    const petalCol = mix(hsl(gn.petalHue, gn.petalSat, gn.petalLight), C.dry, dryT);
    const centerCol = mix(hsl(gn.centerHue, 48, gn.centerLight), C.dry, dryT * 0.5);
    const cx = t.x + dx * 2.5, cy = t.y + dy * 2.5;
    const leafC = hsl(gn.leafHue, gn.leafSat, gn.leafLight);

    const bud = budS * (1 - smooth(0.05, 0.55, open));
    if (bud > 0.03) {
      const bl = (8 + gn.petalLen * 0.55) * bud;
      flower.push({ kind: 'poly', pts: leafPts(t.x, t.y, t.a, bl, bl * 0.36, 1.35, 0, 7), fill: petalCol, fa: 0.35, gap: 2, stroke: INK, sw: 1.8 });
      for (const sd of [-1, 1])
        flower.push({ kind: 'poly', pts: leafPts(t.x, t.y, t.a + sd * 0.55, bl * 0.55, bl * 0.16, 1, 0, 5), fill: leafC, fa: 0.35, gap: 1.8, stroke: INK, sw: 1.5 });
    }

    const pc = Math.round(gn.petalCount);
    const discR = 3 + gn.petalLen * 0.28;
    if (open > 0.02 && fall < 0.98) {
      for (let i = 0; i < pc; i++) {
        const theta = t.a + (Math.PI * 2 * i) / pc + 0.3;
        const bunched = t.a + (pc > 1 ? (i / (pc - 1) - 0.5) * 0.7 : 0);
        let ang = bunched + angDiff(bunched, theta) * open;
        const k = (0.35 + 0.65 * open) * (1 - fall);
        if (k < 0.04) continue;
        ang += fall * 0.9 * (Math.sin(theta - t.a) >= 0 ? 1 : -1);
        const r0 = discR * 0.55 * open;
        const bx = cx + Math.sin(ang) * r0, by = cy - Math.cos(ang) * r0 + fall * 10;
        const L = gn.petalLen * k;
        flower.push({
          kind: 'poly', pts: leafPts(bx, by, ang, L, L * gn.petalWidth * 0.5, gn.petalP, 0, 7),
          fill: petalCol, fa: 0.32, gap: 2.2, weight: 1.4, stroke: INK, sw: 1.7,
        });
      }
    }
    const cr = discR * open * (1 - podS);
    if (cr > 0.8) {
      flower.push({ kind: 'poly', pts: ellipsePts(cx, cy, cr, cr * 0.95, 0, 12), fill: centerCol, fa: 0.45, gap: 1.7, style: 'cross-hatch', stroke: INK, sw: 1.6 });
    }

    if (podS > 0.02) {
      const pl = (10 + gn.petalLen * 0.55) * podS;
      const pw = pl * 0.33;
      const podCol = mix(C.pod, C.dry, dryT * 0.6);
      if (burst < 0.02) {
        flower.push({ kind: 'poly', pts: leafPts(t.x, t.y, t.a, pl, pw, 1.1, 0, 8), fill: podCol, fa: 0.4, gap: 2, weight: 1.4, stroke: INK, sw: 1.8 });
        flower.push({ kind: 'curve', pts: [[t.x + dx * pl * 0.15, t.y + dy * pl * 0.15], [t.x + dx * pl * 0.85, t.y + dy * pl * 0.85]], stroke: mix(podCol, INK, 0.5), sw: 1, rough: 0.8 });
      } else {
        const full = leafPts(t.x, t.y, t.a, pl, pw, 1.1, 0, 8);
        const n = 8; // right side = indices 0..n, left = n.. end + base
        const right = full.slice(0, n + 1);
        const left = [full[n], ...full.slice(n + 1), full[0]];
        for (const [sd, side] of [[1, right], [-1, left]] as [number, Pt[]][]) {
          const half = rotatePts(side, t.x, t.y, sd * burst * 1.0);
          flower.push({ kind: 'poly', pts: half, fill: podCol, fa: 0.4, gap: 2, weight: 1.4, stroke: INK, sw: 1.8 });
        }
      }
      pod = [t.x + dx * pl * 0.6, t.y + dy * pl * 0.6];
    }
    if (!pod) pod = [cx, cy];
  }

  return {
    groups: [{ shapes: mound }, { shapes: [...stems, ...leaves] }, { shapes: shell }, { shapes: flower }],
    pod,
  };
}

/** Small loose seed used for flying/bouncing particles. */
export function seedGroups(color: string): Group[] {
  return [{ shapes: [{ kind: 'poly', pts: ellipsePts(0, 0, 6, 4, 0, 12), fill: color, fa: 0.5, gap: 1.6, weight: 1.3, stroke: INK, sw: 1.7 }] }];
}
