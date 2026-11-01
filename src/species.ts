import type { Genome } from './genome';
import type { Rng } from './util';

export type Species = 'daisy' | 'sunflower' | 'bush' | 'vine' | 'cactus' | 'mushroom' | 'tree';
export type Rare = 'striped' | 'glow' | 'double' | 'giant';

export const SPECIES: Species[] = ['daisy', 'sunflower', 'bush', 'vine', 'cactus', 'mushroom', 'tree'];
export const RARES: Rare[] = ['striped', 'glow', 'double', 'giant'];

export interface SpeciesInfo {
  name: string;
  /** relative chance of a random seed being this species */
  weight: number;
  /** multiplier on the unassisted growth interval (lower = faster) */
  auto: number;
  /** how strongly the flower closes at night (0 = stays open) */
  close: number;
  /** how far seeds fly, in CSS px before world scaling */
  seedDist: [number, number];
  /** crayon colours for petals / caps / blossoms: [hue, sat, light] */
  palette: [number, number, number][];
  /** per-species overrides of the genome trait ranges */
  ranges: Partial<Record<keyof Genome, [number, number]>>;
}

export const SPECIES_INFO: Record<Species, SpeciesInfo> = {
  daisy: {
    name: 'Daisy', weight: 30, auto: 0.6, close: 1, seedDist: [40, 85],
    palette: [[45, 30, 93], [50, 72, 68], [340, 55, 80], [270, 35, 78], [22, 70, 66], [355, 58, 62], [200, 40, 76]],
    ranges: {
      height: [0.38, 0.9], branchiness: [0, 1], internode: [16, 40], leafLen: [9, 24], leafWidth: [0.18, 0.9],
      leafP: [0.6, 1.4], leafBend: [0, 0.7], lean: [-0.32, 0.32], curve: [0, 0.55], freq: [0.5, 3],
      petalCount: [8, 18], petalLen: [8, 16], petalWidth: [0.2, 0.5], petalP: [0.8, 1.4],
      centerHue: [28, 55], centerLight: [40, 62], seedCount: [4, 6], clump: [0, 1],
    },
  },
  bush: {
    name: 'Flower Bush', weight: 16, auto: 1.1, close: 0.3, seedDist: [35, 75],
    palette: [[345, 55, 72], [0, 60, 58], [290, 35, 70], [45, 30, 92], [20, 65, 70], [320, 45, 80]],
    ranges: {
      height: [0.42, 0.62], branchiness: [0.35, 0.8], internode: [15, 24], leafLen: [9, 14], leafWidth: [0.45, 0.8],
      curve: [0.05, 0.35], lean: [-0.1, 0.1], petalCount: [5, 7], petalLen: [6, 9], petalWidth: [0.55, 0.85], petalP: [0.8, 1.1],
      centerHue: [40, 55], centerLight: [55, 68], seedCount: [2, 4], clump: [0.85, 1],
    },
  },
  sunflower: {
    name: 'Sunflower', weight: 20, auto: 1.45, close: 0.45, seedDist: [50, 100],
    palette: [[44, 76, 58], [38, 80, 56], [28, 72, 55], [50, 70, 62]],
    ranges: {
      height: [1.35, 1.6], branchiness: [0, 0.12], internode: [38, 52], leafLen: [26, 36], leafWidth: [0.55, 0.85],
      lean: [-0.1, 0.1], curve: [0, 0.15],
      petalCount: [14, 18], petalLen: [15, 22], petalWidth: [0.38, 0.55], petalP: [0.9, 1.3],
      centerHue: [18, 28], centerLight: [22, 30], seedCount: [3, 4],
    },
  },
  vine: {
    name: 'Vine', weight: 15, auto: 0.9, close: 0.6, seedDist: [45, 95],
    palette: [[225, 45, 64], [275, 40, 64], [320, 45, 72], [200, 45, 70]],
    ranges: {
      height: [0.7, 1.1], leafLen: [11, 16], leafWidth: [0.6, 0.85],
      petalCount: [5, 6], petalLen: [7, 10], petalWidth: [0.6, 0.85], petalP: [0.8, 1.1],
      centerHue: [40, 55], centerLight: [70, 80], seedCount: [2, 3],
    },
  },
  cactus: {
    name: 'Cactus', weight: 13, auto: 1.0, close: 1, seedDist: [40, 80],
    palette: [[345, 60, 68], [15, 65, 62], [300, 40, 70], [45, 70, 64]],
    ranges: {
      height: [0.45, 0.8], leafHue: [95, 135], leafSat: [24, 38], leafLight: [38, 48],
      petalCount: [7, 10], petalLen: [8, 12], petalWidth: [0.35, 0.55],
      centerHue: [40, 55], centerLight: [55, 65], seedCount: [2, 3],
    },
  },
  mushroom: {
    name: 'Mushroom', weight: 15, auto: 0.8, close: 0, seedDist: [22, 55],
    palette: [[5, 58, 52], [28, 45, 48], [35, 42, 66], [280, 25, 56]],
    ranges: { height: [0.25, 0.45], petalCount: [2, 4], petalLen: [14, 22], seedCount: [3, 5] },
  },
  tree: {
    name: 'Tree', weight: 6, auto: 0.7, close: 0, seedDist: [25, 70],
    palette: [[345, 50, 83], [10, 55, 72], [330, 35, 88], [5, 60, 62]],
    ranges: {
      height: [1.45, 1.75], branchiness: [0.4, 1], leafHue: [88, 130], leafSat: [32, 48], leafLight: [36, 46],
      petalCount: [5, 5], petalLen: [5, 7], seedCount: [2, 3],
    },
  },
};

export function pickSpecies(r: Rng, from: Species[] = SPECIES): Species {
  const total = from.reduce((t, s) => t + SPECIES_INFO[s].weight, 0);
  let x = r() * total;
  for (const s of from) {
    x -= SPECIES_INFO[s].weight;
    if (x <= 0) return s;
  }
  return from[from.length - 1];
}

export const RARE_NAME: Record<Rare, string> = { striped: 'Striped', glow: 'Glowing', double: 'Double', giant: 'Giant' };

export function variantName(sp: Species, rare: Rare | null) {
  return (rare ? RARE_NAME[rare] + ' ' : '') + SPECIES_INFO[sp].name;
}

/** Trees take quarter steps before they mature. */
export const stepOf = (sp: Species, stage: number) => (sp === 'tree' && stage < 4 ? 0.25 : 1);
