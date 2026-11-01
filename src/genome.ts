import { Rng, range, gauss, clamp } from './util';

export interface Genome {
  height: number;
  lean: number;
  curve: number;
  freq: number;
  internode: number;
  branchiness: number;
  branchAngle: number;
  leafLen: number;
  leafWidth: number;
  leafP: number;
  leafBend: number;
  leafAngle: number;
  opposite: number;
  leafHue: number;
  leafSat: number;
  leafLight: number;
  petalCount: number;
  petalLen: number;
  petalWidth: number;
  petalP: number;
  petalHue: number;
  petalSat: number;
  petalLight: number;
  centerHue: number;
  centerLight: number;
  seedCount: number;
}

type Kind = 'f' | 'int' | 'hue';
/** [min, max, mutation std-dev, kind] */
const SPEC: Record<keyof Genome, [number, number, number, Kind]> = {
  height: [0.65, 1.3, 0.06, 'f'],
  lean: [-0.25, 0.25, 0.04, 'f'],
  curve: [0, 0.45, 0.04, 'f'],
  freq: [0.6, 2.6, 0.15, 'f'],
  internode: [28, 52, 2.5, 'f'],
  branchiness: [0, 1, 0.08, 'f'],
  branchAngle: [0.35, 1.0, 0.05, 'f'],
  leafLen: [16, 34, 2, 'f'],
  leafWidth: [0.25, 0.85, 0.05, 'f'],
  leafP: [0.6, 1.4, 0.06, 'f'],
  leafBend: [0, 0.6, 0.05, 'f'],
  leafAngle: [0.6, 1.3, 0.06, 'f'],
  opposite: [0, 1, 0.1, 'f'],
  leafHue: [78, 140, 4, 'f'],
  leafSat: [28, 50, 2, 'f'],
  leafLight: [34, 50, 2, 'f'],
  petalCount: [4, 12, 0, 'int'],
  petalLen: [10, 26, 1.3, 'f'],
  petalWidth: [0.3, 0.9, 0.05, 'f'],
  petalP: [0.8, 1.8, 0.08, 'f'],
  petalHue: [0, 360, 9, 'hue'],
  petalSat: [30, 68, 3, 'f'],
  petalLight: [52, 82, 2.5, 'f'],
  centerHue: [20, 55, 4, 'f'],
  centerLight: [28, 58, 3, 'f'],
  seedCount: [2, 4, 0, 'int'],
};

/** Muted crayon flower colours: [hue, sat, light] */
const PETALS: [number, number, number][] = [
  [45, 66, 62], // sunflower yellow
  [9, 52, 52], // brick red
  [345, 52, 76], // soft pink
  [27, 62, 62], // tangerine
  [268, 30, 68], // lavender
  [205, 42, 66], // sky blue
  [42, 34, 81], // cream
];

export function randomGenome(r: Rng): Genome {
  const g = {} as Genome;
  for (const k of Object.keys(SPEC) as (keyof Genome)[]) {
    const [a, b, , kind] = SPEC[k];
    g[k] = kind === 'int' ? Math.floor(range(r, a, b + 0.999)) : range(r, a, b);
  }
  const p = PETALS[Math.floor(r() * PETALS.length)];
  g.petalHue = p[0] + gauss(r) * 5;
  g.petalSat = p[1];
  g.petalLight = p[2];
  return g;
}

export function mutate(parent: Genome, r: Rng): Genome {
  const g = { ...parent };
  for (const k of Object.keys(SPEC) as (keyof Genome)[]) {
    const [a, b, std, kind] = SPEC[k];
    if (kind === 'int') {
      if (r() < 0.3) g[k] = clamp(g[k] + (r() < 0.5 ? -1 : 1), a, b);
      continue;
    }
    let v = g[k] + gauss(r) * std;
    if (r() < 0.07) v += gauss(r) * std * 4; // occasional bigger jump
    g[k] = kind === 'hue' ? ((v % 360) + 360) % 360 : clamp(v, a, b);
  }
  if (r() < 0.04) {
    // rare colour jump to another crayon in the box
    const p = PETALS[Math.floor(r() * PETALS.length)];
    g.petalHue = p[0];
    g.petalSat = p[1];
    g.petalLight = p[2];
  }
  return g;
}

/** Fill in any trait missing from older saves. */
export function sanitize(g: Partial<Genome>, r: Rng): Genome {
  const base = randomGenome(r);
  const out = { ...base, ...g } as Genome;
  for (const k of Object.keys(SPEC) as (keyof Genome)[]) if (typeof out[k] !== 'number' || !isFinite(out[k])) out[k] = base[k];
  return out;
}
