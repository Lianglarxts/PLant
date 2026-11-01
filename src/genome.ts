import { Rng, range, gauss, clamp, angDiff } from './util';
import { Species, SPECIES_INFO } from './species';

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
  /** how many stems come up from one root (bushy clumps) */
  clump: number;
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
  clump: [0, 0.3, 0.08, 'f'],
};

/** Trait range for a species (species overrides fall back to the global spec). */
function lim(k: keyof Genome, sp: Species): [number, number] {
  return SPECIES_INFO[sp].ranges[k] ?? [SPEC[k][0], SPEC[k][1]];
}
const KEYS = Object.keys(SPEC) as (keyof Genome)[];

function setPalette(g: Genome, sp: Species, r: Rng) {
  const pal = SPECIES_INFO[sp].palette;
  const p = pal[Math.floor(r() * pal.length)];
  g.petalHue = (p[0] + gauss(r) * 5 + 360) % 360;
  g.petalSat = p[1];
  g.petalLight = p[2];
}

export function randomGenome(r: Rng, sp: Species = 'daisy'): Genome {
  const g = {} as Genome;
  for (const k of KEYS) {
    const [a, b] = lim(k, sp);
    g[k] = SPEC[k][3] === 'int' ? Math.floor(range(r, a, b + 0.999)) : range(r, a, b);
  }
  setPalette(g, sp, r);
  return g;
}

export function mutate(parent: Genome, sp: Species, r: Rng): Genome {
  const g = { ...parent };
  for (const k of KEYS) {
    const [, , std, kind] = SPEC[k];
    const [a, b] = lim(k, sp);
    if (kind === 'int') {
      if (r() < 0.3) g[k] = clamp(g[k] + (r() < 0.5 ? -1 : 1), a, b);
      continue;
    }
    let v = g[k] + gauss(r) * std;
    if (r() < 0.07) v += gauss(r) * std * 4; // occasional bigger jump
    g[k] = kind === 'hue' ? ((v % 360) + 360) % 360 : clamp(v, a, b);
  }
  // rare colour jump to another crayon in the box
  if (r() < 0.04) setPalette(g, sp, r);
  return g;
}

/**
 * Child of two parents: every trait comes from one parent or a blend of both
 * (colours blend around the colour wheel), then mutates a little.
 */
export function crossbreed(a: Genome, b: Genome, sp: Species, r: Rng): Genome {
  const g = { ...a };
  for (const k of KEYS) {
    const kind = SPEC[k][3];
    const t = r() < 0.5 ? r() : r() < 0.5 ? 0 : 1;
    if (kind === 'int') g[k] = r() < 0.5 ? a[k] : b[k];
    else if (kind === 'hue') g[k] = (((a[k] + angDiff((a[k] * Math.PI) / 180, (b[k] * Math.PI) / 180) * (180 / Math.PI) * t) % 360) + 360) % 360;
    else g[k] = a[k] + (b[k] - a[k]) * t;
  }
  // keep the colour of the blend vivid: take saturation/lightness from the same parent as a pair
  const src = r() < 0.5 ? a : b;
  g.petalSat = src.petalSat;
  g.petalLight = src.petalLight;
  return mutate(fit(g, sp), sp, r);
}

/** Clamp every trait into the species' range. */
export function fit(g: Genome, sp: Species): Genome {
  const out = { ...g };
  for (const k of KEYS) {
    if (SPEC[k][3] === 'hue') continue;
    const [a, b] = lim(k, sp);
    out[k] = clamp(out[k], a, b);
  }
  return out;
}

/** Fill in any trait missing from older saves. */
export function sanitize(g: Partial<Genome>, sp: Species, r: Rng): Genome {
  const base = randomGenome(r, sp);
  const out = { ...base, ...g } as Genome;
  for (const k of KEYS) if (typeof out[k] !== 'number' || !isFinite(out[k])) out[k] = base[k];
  return fit(out, sp);
}
