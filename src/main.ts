import rough from 'roughjs';
import { Genome, randomGenome, mutate, sanitize, crossbreed } from './genome';
import { Book, Bouquet } from './book';
import { beeGroups, butterflyGroups, snailGroups, birdGroups, moleGroups, moundGroups } from './creatures';
import { Sound } from './sound';
import { World, Weather, DAY, SEASON_DAYS, WEATHER_WORD } from './world';
import { Axis, Env, Picked, buildStructure, drawPlant, seedGroups, vineDir, vaseGroups, pickedGroups, VASES } from './plant';
import { Species, Rare, SPECIES, SPECIES_INFO, RARES, pickSpecies, stepOf, variantName } from './species';
import { renderSprite, Sprite, Pt } from './crayon';
import {
  buildBackground, renderGround, groundY, sunGroups, cloudGroups, dropGroups, SpriteBank,
  moonGroups, starGroups, leafBitGroups, flakeGroups, windGroups, renderSnowCap, canGroups, CAN_TIP, rainbowGroups,
} from './scene';
import { mulberry32, hash, range, clamp, clamp01, easeInOut } from './util';

const MAX_PLANTS = 40;
const BOIL_MS = 150;
const SAVE_KEY = 'crayon-garden-v2';
const OLD_SAVE_KEY = 'crayon-garden-v1';
const params = new URLSearchParams(location.search);
/** ?speed=N runs the whole garden N times faster (handy for testing timers). */
const SPEED = Math.max(0.1, +(params.get('speed') ?? 1) || 1);
const clock = () => (performance.now() / 1000) * SPEED;
/** Seconds between growth steps when left alone. */
const AUTO_MIN = 20, AUTO_MAX = 40;

// ---------------- state ----------------
interface Plant {
  id: number;
  seed: number;
  xn: number; // 0..1 across the width
  depth: number; // 0 (back, at the soil line) .. 1 (front)
  gen: number;
  genome: Genome;
  species: Species;
  rare: Rare | null;
  bloomed: boolean; // has reached maturity (counted once)
  climb: { dx: number; h: number } | null; // vines: the neighbour being climbed, in plant units
  climbAt: number;
  stale: Sprite | null; // last good sprite, shown while a new state renders
  mate: { genome: Genome; species: Species } | null; // pollen a bee brought from another flower
  golden: boolean; // grown from a shooting star's seed
  stage: number; // 0..5 (trees take quarter steps)
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
  nextAuto: number; // time of the next unassisted growth step, 0 = not scheduled
  wateredAt: number;
}
interface FlyingSeed {
  sx: number; sy: number;
  tx: number; ty: number;
  xn: number; depth: number;
  t0: number; dur: number; peak: number;
  spin: number;
  genome: Genome; gen: number; species: Species; rare: Rare | null; golden: boolean;
  state: 'fly' | 'hop' | 'fade';
  tLand: number;
  id: number;
}
interface Drop { x: number; y0: number; y1: number; t0: number; dur: number; }
interface Puff { x: number; y: number; t0: number; }
interface Spark { x: number; y: number; t0: number; color: string; size: number; }
interface Bee { x: number; y: number; route: Plant[]; leg: number; hover: number; seed: number; dir: number; done: boolean; }

let plants: Plant[] = [];
let flying: FlyingSeed[] = [];
let drops: Drop[] = [];
let puffs: Puff[] = [];
let sparks: Spark[] = [];
let bees: Bee[] = [];
let beeCheck = 0;
let beeTipShown = false;
let stats = { grown: 0, maxGen: 1 };
const world = new World();
/** Rain, snow, falling leaves and wind curls. */
interface Particle {
  kind: 'rain' | 'snow' | 'leaf' | 'wind';
  x: number; y: number; vx: number; vy: number;
  rot: number; vr: number; floor: number; landed: number; seed: number; color: string;
}
let parts: Particle[] = [];
let stars: { x: number; y: number; s: number; ph: number }[] = [];
let snowCap: { canvas: HTMLCanvasElement; top: number } | null = null;
/** The sky, cut exactly along the wavy soil line, so tints never spill onto the ground. */
let skyPath: Path2D | null = null;
let lastSeason = -1;
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
// the first three clouds are always out; the rest drift in on cloudy and rainy days
const clouds = [0, 1, 2, 3, 4, 5, 6].map((i) => ({
  seed: 300 + i * 17, x: 0, y: 0, w: 120, speed: 6 + (i % 3) * 3, vis: i < 3 ? 1 : 0,
  held: false, rainUntil: 0, rk: 0, // dragged clouds rain on the spot below them
}));
type Cloud = (typeof clouds)[number];

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
    c.w = clamp(W * 0.14, 80, 170) * range(r, 0.8, 1.2) * (i >= 3 ? 1.15 : 1);
    c.y = H * (i < 3 ? 0.07 + i * 0.05 : 0.05 + (i - 3) * 0.06) + range(r, -10, 10);
    if (!c.x) c.x = range(r, 0, W);
  });
  [can.hx, can.hy] = canHome();
  if (!can.held) [can.x, can.y] = [can.hx, can.hy];
  stars = [];
  for (let i = 0; i < Math.min(70, Math.round((W * H) / 14000)); i++) stars.push({ x: range(r, 0, W), y: range(r, H * 0.03, H * 0.48), s: range(r, 0.5, 1), ph: range(r, 0, 6) });
  snowCap = null;
  skyPath = new Path2D();
  skyPath.moveTo(-10, -10);
  skyPath.lineTo(W + 10, -10);
  for (let x = W + 10; x >= -10; x -= 8) skyPath.lineTo(x, groundY(x, H) + 1.5);
  skyPath.closePath();
  for (const p of plants) p.key = '';
}

// ---------------- plants ----------------
function basePos(p: { xn: number; depth: number }): [number, number] {
  const x = p.xn * W;
  const gy = groundY(x, H);
  return [x, gy + 6 + p.depth * Math.max(0, H - gy - 46) * 0.85];
}
const plantScale = (p: Plant) => worldScale * (0.78 + 0.3 * p.depth) * (p.rare === 'giant' ? 1.45 : 1);

interface PlantInit {
  id?: number; seed: number; xn: number; depth: number; gen: number; genome: Genome;
  species: Species; rare?: Rare | null; stage?: number; wilt?: number; bloomed?: boolean; golden?: boolean;
}
function makePlant(o: PlantInit): Plant {
  const stage = o.stage ?? 0;
  return {
    id: o.id ?? nextId++, seed: o.seed, xn: o.xn, depth: o.depth, gen: o.gen, genome: o.genome,
    species: o.species, rare: o.rare ?? null, bloomed: o.bloomed ?? stage >= 4, climb: null, climbAt: 0, stale: null, mate: null, golden: !!o.golden,
    stage, anim: null, pendingAt: 0, wilt: o.wilt ?? (stage >= 5 ? 0 : -1), burst: stage >= 5, g: stage,
    struct: buildStructure(o.genome, o.seed, o.species),
    sprites: [null, null, null], canvases: [0, 1, 2].map(() => document.createElement('canvas')),
    key: '', pod: null, hover: 0, hoverTarget: 0, poke: 0, nextAuto: 0, wateredAt: -9,
  };
}

function starterSeed(): Plant {
  const seed = (Math.random() * 1e9) | 0;
  const r = mulberry32(seed);
  const species = pickSpecies(r, ['daisy', 'sunflower', 'bush', 'vine', 'cactus']);
  return makePlant({ seed, xn: 0.5, depth: 0.35, gen: 1, genome: randomGenome(r, species), species });
}

// ---------------- environment hooks ----------------
const sunPos = () => world.sunPos(W, H);
const isSunny = () => world.light > 0.5 && (world.weather === 'sun' || world.weather === 'wind');
const isNight = () => world.night > 0.5;
const winterRest = () => world.seasonK('winter') > 0.5;
/** Under a tree or a sunflower. */
function shaded(p: Plant) {
  const [bx] = basePos(p);
  return plants.some((q) => q !== p && q.wilt < 0 && ((q.species === 'tree' && q.stage >= 2.5) || (q.species === 'sunflower' && q.stage >= 3)) &&
    Math.abs(basePos(q)[0] - bx) < (q.species === 'tree' ? 110 : 50) * plantScale(q));
}
const isDark = (p: Plant) => isNight() || !isSunny() || shaded(p);
/** Why this plant can't grow right now, or null if it can. */
function growBlock(p: Plant): string | null {
  if (p.species === 'cactus' && !isSunny()) return 'cactus only grows in the sun';
  if (p.species === 'mushroom' && !isDark(p)) return 'mushrooms only grow in shade or at night';
  return null;
}
const q5 = (v: number) => Math.round(v * 5) / 5;
function envFor(p: Plant): Env {
  const e: Env = { close: 0, turn: 0, autumn: 0, winter: 0, spring: 0, climb: null };
  if (SPECIES_INFO[p.species].close > 0 && p.rare !== 'glow') e.close = q5(smooth(0.3, 0.8, world.night));
  const sun = sunPos();
  if (p.species === 'sunflower' && sun && world.light > 0.5) e.turn = Math.round(clamp((sun[0] - basePos(p)[0]) / (W * 0.4), -1, 1) * 4) / 4;
  e.autumn = q5(world.autumnK);
  e.winter = q5(world.seasonK('winter'));
  e.spring = q5(world.seasonK('spring'));
  if (p.species === 'vine') e.climb = p.climb;
  return e;
}
const envKey = (e: Env) => `${e.close}|${e.turn}|${e.autumn}|${e.winter}|${e.spring}|${e.climb ? e.climb.dx + ',' + e.climb.h : ''}`;

// ---------------- bees & cross-breeding ----------------
/** Where a bee lands on a flower (CSS px), or null if it has no flower right now. */
function flowerPoint(p: Plant): [number, number] | null {
  if (!p.pod || p.wilt >= 0 || !plants.includes(p)) return null;
  const [bx, by] = basePos(p);
  return [bx + p.pod[0], by + p.pod[1] - 5 * worldScale];
}
const canPollinate = (p: Plant) =>
  p.stage === 4 && !p.anim && p.wilt < 0 && !p.mate && p.species !== 'mushroom' && p.species !== 'tree' && !bees.some((b) => b.route.includes(p));

/** When two open flowers are close, a bee flies between them. */
function spawnBees(now: number) {
  if (now < beeCheck) return;
  beeCheck = now + 2.5;
  if (bees.length >= 2 || world.light < 0.5 || world.rain > 0.3 || world.snowing > 0.3) return;
  const c = plants.filter(canPollinate);
  let pair: [Plant, Plant] | null = null, bd = Infinity;
  for (let i = 0; i < c.length; i++)
    for (let j = i + 1; j < c.length; j++) {
      const [ax, ay] = basePos(c[i]), [bx, by] = basePos(c[j]);
      const d = Math.hypot(ax - bx, (ay - by) * 1.5);
      if (d < 280 * worldScale && d < bd) {
        bd = d;
        pair = [c[i], c[j]];
      }
    }
  if (!pair) return;
  const from = Math.random() < 0.5 ? -1 : 1;
  bees.push({ x: from < 0 ? -30 : W + 30, y: H * (0.25 + Math.random() * 0.2), route: [pair[0], pair[1], pair[0]], leg: 0, hover: 0, seed: Math.random() * 100, dir: -from, done: false });
}

function updateBees(now: number, dt: number) {
  const speed = 150 * Math.sqrt(worldScale);
  for (const b of bees) {
    if (world.light < 0.4 || world.rain > 0.5) b.leg = b.route.length; // head home at dusk or in rain
    let target: [number, number] | null = null;
    while (b.leg < b.route.length && !(target = flowerPoint(b.route[b.leg]))) b.leg = b.route.length; // flower gone: leave
    if (!target) target = [b.dir > 0 ? W + 40 : -40, H * 0.15];
    const dx = target[0] - b.x, dy = target[1] - b.y, d = Math.hypot(dx, dy);
    if (Math.abs(dx) > 2) b.dir = dx > 0 ? 1 : -1;
    if (d > 3) {
      const st = Math.min(d, speed * dt);
      b.x += (dx / d) * st;
      b.y += (dy / d) * st;
    } else if (b.leg < b.route.length) {
      b.hover += dt;
      if (b.hover > 0.9) {
        // carrying pollen: the flower it lands on gets the previous flower's pollen
        if (b.leg > 0) {
          const to = b.route[b.leg], fromP = b.route[b.leg - 1];
          if (plants.includes(fromP)) {
            to.mate = { genome: fromP.genome, species: fromP.species };
            to.nextAuto = Math.max(to.nextAuto, now + 6); // give it a moment before seeding
            if (!beeTipShown) {
              beeTipShown = true;
              toast('a bee mixed pollen: their seeds will be a blend of both');
            }
          }
        }
        b.leg++;
        b.hover = 0;
      }
    } else b.done = true;
    if (b.x < -60 || b.x > W + 60) b.done = b.leg >= b.route.length;
  }
  bees = bees.filter((b) => !b.done);
}

// ---------------- butterflies, snail, birds ----------------
interface Butterfly { x: number; y: number; vx: number; vy: number; tx: number; ty: number; target: Plant | null; rest: number; leaving: boolean; color: string; seed: number; }
interface Snail { x: number; depth: number; dir: number; speed: number; seed: number; }
interface Bird {
  x: number; y: number; state: 'in' | 'peck' | 'perch' | 'out'; until: number; color: string; seed: number;
  prey: Plant | null; perch: Plant | null; px: number; py: number; dir: number; pass: boolean;
}
const BFLY_COLORS = ['#e6a3b4', '#f2c64c', '#8fb8d8', '#c7a0d8', '#f0a35c'];
const BIRD_COLORS = ['#8fb8d8', '#c8644a', '#a8743f'];
let butterflies: Butterfly[] = [];
let snail: Snail | null = null;
let birds: Bird[] = [];
let birdAt = 25;
let snailAt = 15;
let birdTipShown = false;

const niceOut = () => world.light > 0.6 && world.rain < 0.3 && world.snowing < 0.3;

function updateFauna(now: number, dt: number) {
  // --- butterflies visit open flowers on fine days
  const flowers = plants.filter((p) => p.stage === 4 && !p.anim && p.wilt < 0 && p.species !== 'mushroom' && p.pod);
  const want = niceOut() && world.seasonK('winter') < 0.5 ? Math.min(3, Math.ceil(flowers.length / 2) + (world.season === 'summer' ? 1 : 0)) : 0;
  const active = butterflies.filter((b) => !b.leaving);
  if (active.length < want && Math.random() < dt * 0.25) {
    const from = Math.random() < 0.5 ? -1 : 1;
    butterflies.push({ x: from < 0 ? -20 : W + 20, y: H * range(Math.random, 0.2, 0.5), vx: -from * 40, vy: 0, tx: W / 2, ty: H * 0.4, target: null, rest: 0, leaving: false, color: BFLY_COLORS[Math.floor(Math.random() * BFLY_COLORS.length)], seed: Math.random() * 100 });
  } else if (active.length > want) active[0].leaving = true;
  for (const b of butterflies) {
    if (b.target && (!plants.includes(b.target) || b.target.stage !== 4 || b.target.wilt >= 0)) {
      b.target = null;
      b.rest = 0;
    }
    if (b.leaving) {
      b.tx = b.x < W / 2 ? -60 : W + 60;
      b.ty = H * 0.1;
    } else if (b.rest > 0 && b.target) {
      const fp = flowerPoint(b.target);
      b.rest -= dt;
      if (fp) {
        b.x = fp[0];
        b.y = fp[1] - 2;
      }
      b.vx = b.vy = 0;
      if (b.rest <= 0) b.target = null;
      continue;
    } else if (Math.hypot(b.tx - b.x, b.ty - b.y) < 8 || (!b.target && Math.random() < dt * 0.3)) {
      if (b.target) b.rest = range(Math.random, 2, 5);
      else if (flowers.length && Math.random() < 0.6) {
        b.target = flowers[Math.floor(Math.random() * flowers.length)];
        const fp = flowerPoint(b.target);
        if (fp) [b.tx, b.ty] = fp;
      } else {
        b.target = null;
        b.tx = range(Math.random, W * 0.05, W * 0.95);
        b.ty = H * range(Math.random, 0.2, 0.55);
      }
    }
    if (b.target && b.rest <= 0) {
      const fp = flowerPoint(b.target);
      if (fp) [b.tx, b.ty] = fp;
    }
    const dx = b.tx - b.x, dy = b.ty - b.y, d = Math.hypot(dx, dy) || 1;
    const sp = 75 * Math.sqrt(worldScale);
    b.vx += ((dx / d) * sp - b.vx) * Math.min(1, dt * 2.5);
    b.vy += ((dy / d) * sp - b.vy) * Math.min(1, dt * 2.5) + Math.sin(now * 5 + b.seed) * 60 * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
  }
  butterflies = butterflies.filter((b) => !(b.leaving && (b.x < -50 || b.x > W + 50)));

  // --- a snail crawls across, mostly after rain
  if (!snail && now > snailAt) {
    snailAt = now + range(Math.random, 60, 140);
    if (world.seasonK('winter') < 0.5 && (world.rain > 0.2 || world.weather === 'cloudy' || Math.random() < 0.35)) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      snail = { x: dir > 0 ? -25 : W + 25, depth: range(Math.random, 0.45, 1), dir, speed: 9 * worldScale, seed: Math.random() * 10 };
    }
  }
  if (snail) {
    snail.x += snail.dir * snail.speed * dt;
    if (snail.x < -40 || snail.x > W + 40) snail = null;
  }

  // --- birds drop by: perch on a tree, or peck up a seed
  if (now > birdAt) {
    birdAt = now + range(Math.random, 30, 75);
    if (niceOut() && birds.length < 2) {
      const from = Math.random() < 0.5 ? -1 : 1;
      const b: Bird = { x: from < 0 ? -30 : W + 30, y: H * range(Math.random, 0.08, 0.25), state: 'in', until: 0, color: BIRD_COLORS[Math.floor(Math.random() * 3)], seed: Math.random() * 10, prey: null, perch: null, px: 0, py: 0, dir: -from, pass: false };
      const seeds = plants.filter((p) => p.stage === 0 && !p.anim && !p.pendingAt && p.g < 0.2 && !p.rare);
      const trees = plants.filter((p) => p.species === 'tree' && p.stage >= 3 && p.wilt < 0 && (p.sprites.some((s) => s) || p.stale));
      if (seeds.length && Math.random() < 0.55) b.prey = seeds[Math.floor(Math.random() * seeds.length)];
      else if (trees.length && Math.random() < 0.85) {
        b.perch = trees[Math.floor(Math.random() * trees.length)];
        const s = (b.perch.sprites.find((q) => q) ?? b.perch.stale)!;
        b.px = range(Math.random, -0.22, 0.22) * s.w;
        b.py = s.oy + s.h * range(Math.random, 0.06, 0.16);
      } else b.pass = true;
      birds.push(b);
      sound.chirp();
    }
  }
  const bsp = 210 * Math.sqrt(worldScale);
  for (const b of birds) {
    let tx: number, ty: number;
    if (b.state === 'out' || b.pass) {
      tx = b.dir > 0 ? W + 60 : -60;
      ty = H * 0.05;
    } else if (b.prey) {
      if (!plants.includes(b.prey) || b.prey.stage !== 0 || b.prey.anim || b.prey.pendingAt) {
        b.prey = null;
        b.state = 'out';
        continue;
      }
      [tx, ty] = basePos(b.prey);
      tx += b.dir * -10 * worldScale; // stand beside it
    } else if (b.perch) {
      if (!plants.includes(b.perch) || world.seasonK('winter') > 0.9) {
        b.state = 'out';
        continue;
      }
      const [bx, by] = basePos(b.perch);
      tx = bx + b.px;
      ty = by + b.py;
    } else {
      b.state = 'out';
      continue;
    }
    if (b.state === 'in' || b.state === 'out') {
      const dx = tx - b.x, dy = ty - b.y, d = Math.hypot(dx, dy);
      if (Math.abs(dx) > 2) b.dir = dx > 0 ? 1 : -1;
      if (d < 4 && b.state === 'in') {
        b.x = tx;
        b.y = ty;
        b.state = b.prey ? 'peck' : 'perch';
        b.until = now + (b.prey ? 1.8 : range(Math.random, 4, 9));
      } else {
        const st = Math.min(d, bsp * dt);
        b.x += (dx / (d || 1)) * st;
        b.y += (dy / (d || 1)) * st;
      }
    } else {
      b.x = tx;
      b.y = ty;
      if (now > b.until) {
        if (b.state === 'peck' && b.prey && plants.includes(b.prey)) {
          // not every seed survives
          plants = plants.filter((q) => q !== b.prey);
          puffs.push({ x: tx, y: ty, t0: now });
          dirty = true;
          if (!birdTipShown) {
            birdTipShown = true;
            toast('a bird ate a seed! tap birds to shoo them away');
          }
        }
        b.prey = null;
        b.perch = null;
        b.state = 'out';
        b.dir = b.x < W / 2 ? -1 : 1;
      }
    }
  }
  birds = birds.filter((b) => !((b.state === 'out' || b.pass) && (b.x < -50 || b.x > W + 50)));
}

/** Tapping near a bird sends it off. Returns true if one was shooed. */
function shooBird(x: number, y: number) {
  for (const b of birds) {
    if (b.state === 'out' || Math.hypot(b.x - x, b.y - 8 * worldScale - y) > 34 * worldScale) continue;
    b.state = 'out';
    b.prey = null;
    b.perch = null;
    b.dir = x < b.x ? 1 : -1;
    return true;
  }
  return false;
}

function drawFauna(now: number, boil: number) {
  const cs = Math.max(1, worldScale * 1.25);
  if (snail) {
    const f = Math.floor(now * 1.6 + snail.seed) % 2;
    const s = bank.get('snail' + f, boil, cs * 0.9, () => snailGroups(f), 41);
    const [, y] = basePos({ xn: snail.x / W, depth: snail.depth });
    ctx.save();
    ctx.translate(snail.x, y);
    ctx.scale(snail.dir, 1);
    ctx.drawImage(s.canvas, s.ox, s.oy, s.w, s.h);
    ctx.restore();
  }
  for (const b of birds) {
    const flying = b.state === 'in' || b.state === 'out';
    const f = flying ? Math.floor(now * 9 + b.seed) % 2 : b.state === 'peck' ? 2 + (Math.floor(now * 4) % 2) : 2;
    const s = bank.get('bird' + f + b.color, boil, cs, () => birdGroups(f, b.color), 43);
    ctx.save();
    ctx.translate(b.x, b.y - (flying ? 0 : 9 * cs));
    ctx.scale(b.dir, 1);
    ctx.drawImage(s.canvas, s.ox, s.oy, s.w, s.h);
    ctx.restore();
  }
  for (const b of butterflies) {
    const f = b.rest > 0 ? (Math.floor(now * 1.4 + b.seed) % 2 ? 0 : 2) : Math.floor(now * 11 + b.seed) % 3;
    const s = bank.get('bfly' + f + b.color, boil, cs * 0.9, () => butterflyGroups(f, b.color), 47);
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.scale(b.vx < -1 ? -1 : 1, 1);
    ctx.rotate(b.rest > 0 ? -0.5 : Math.sin(now * 3 + b.seed) * 0.15);
    ctx.drawImage(s.canvas, s.ox, s.oy, s.w, s.h);
    ctx.restore();
  }
}

/** Twinkling gold sparkle used on rare seeds. */
function twinkle(x: number, y: number, now: number, seed: number, size: number) {
  ctx.save();
  ctx.strokeStyle = '#e0a620';
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.7;
  for (let i = 0; i < 3; i++) {
    const a = Math.sin(now * 2.6 + seed * 1.7 + i * 2.1);
    if (a < 0.05) continue;
    const ang = seed + i * 2.1 + now * 0.5;
    const px = x + Math.cos(ang) * size * 1.3, py = y - size * 0.5 + Math.sin(ang) * size * 0.8;
    const r = size * 0.5 * a;
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.moveTo(px - r, py);
    ctx.lineTo(px + r, py);
    ctx.moveTo(px, py - r);
    ctx.lineTo(px, py + r);
    ctx.stroke();
  }
  ctx.restore();
}

/** Vines look for a neighbour in the direction they run, and climb it. */
function updateClimb(p: Plant, now: number) {
  if (p.species !== 'vine' || now < p.climbAt || p.wilt >= 0) return;
  p.climbAt = now + 1;
  const sc = plantScale(p);
  const [bx, by] = basePos(p);
  const dir = vineDir(p.seed);
  const reach = (136 + p.genome.height * 70) * sc;
  let best: { dx: number; h: number } | null = null, bd = Infinity;
  for (const q of plants) {
    if (q === p || q.species === 'vine' || q.species === 'mushroom' || q.wilt >= 0 || q.g < 2) continue;
    const [qx, qy] = basePos(q);
    const dx = (qx - bx) * dir;
    if (dx < 16 * sc || dx > reach * 0.8 || Math.abs(qy - by) > 45 * worldScale) continue;
    const s = q.sprites.find((x) => x) ?? q.stale;
    const qh = s ? -s.oy - 12 : 0;
    if (qh < 30 || dx >= bd) continue;
    bd = dx;
    best = { dx: Math.round(dx / sc / 4) * 4, h: Math.round(Math.min((qh * 0.85) / sc, 170) / 10) * 10 };
  }
  if ((best?.dx ?? -1) !== (p.climb?.dx ?? -1) || (best?.h ?? -1) !== (p.climb?.h ?? -1)) p.climb = best;
}

let renderDeadline = Infinity; // per-frame budget for rendering new sprite variants
function spriteFor(p: Plant, boil: number): Sprite | null {
  const wq = p.wilt < 0 ? 0 : Math.round(p.wilt * 24) / 24;
  const sc = plantScale(p);
  const gq = Math.round(p.g * 40) / 40; // ~50 re-renders per stage transition at most
  const env = envFor(p);
  const key = `${gq}|${wq}|${sc.toFixed(3)}|${dpr}|${envKey(env)}`;
  // a plant that has never been drawn can wait a frame or two (it "draws in" on load)
  if (p.key === '' && !p.sprites.some((q) => q) && !p.stale && performance.now() > renderDeadline) return null;
  if (key !== p.key) {
    p.stale = p.sprites.find((q) => q) ?? p.stale;
    p.key = key;
    p.sprites = [null, null, null];
  }
  let s = p.sprites[boil];
  if (!s && performance.now() > renderDeadline) {
    // out of budget this frame: show another variant (or the previous state), render it later
    const other = p.sprites.find((q) => q) ?? p.stale;
    if (other) return other;
  }
  if (!s) {
    const d = drawPlant({ sp: p.species, main: p.struct, gn: p.genome, seed: p.seed, g: gq, wilt: wq, rare: p.rare, env, golden: p.golden });
    s = renderSprite(d.groups, sc, dpr, p.seed, boil, 8, p.canvases[boil]);
    if (p.stale && p.stale.canvas === s.canvas) p.stale = null;
    p.sprites[boil] = s;
    p.pod = d.pod ? [d.pod[0] * sc, d.pod[1] * sc] : null;
  }
  return s;
}

function startGrow(p: Plant, now: number) {
  const from = p.stage;
  const step = stepOf(p.species, from);
  p.anim = { from, to: from + step, t0: now, dur: step < 1 ? 0.9 : from === 4 ? 1.6 : from === 3 ? 1.0 : 0.8 };
  p.pendingAt = 0;
  p.nextAuto = 0;
  sound.grow();
}

function emitSeeds(p: Plant, now: number) {
  p.burst = true;
  sound.pop();
  const [bx, by] = basePos(p);
  const pod = p.pod ?? [0, -60 * plantScale(p)];
  const sx = bx + pod[0], sy = by + pod[1];
  const r = mulberry32(hash(p.seed, p.id, (now * 1000) | 0));
  const n = Math.round(p.genome.seedCount);
  const first = r() < 0.5 ? -1 : 1;
  const [d0, d1] = SPECIES_INFO[p.species].seedDist;
  for (let i = 0; i < n; i++) {
    // alternate sides, and push each pair further out so seeds don't pile up
    const dir = i % 2 === 0 ? first : -first;
    const ring = Math.floor(i / 2);
    let x = bx + dir * (range(r, d0, d1) + ring * d1 * 0.6) * Math.sqrt(worldScale);
    // wind carries seeds further
    x += world.windDir * (world.wind * 110 + world.gust * 180) * worldScale * range(r, 0.6, 1.2);
    if (x < W * 0.04) x = W * 0.04 + (W * 0.04 - x);
    if (x > W * 0.96) x = W * 0.96 - (x - W * 0.96);
    x = clamp(x, W * 0.04, W * 0.96);
    const xn = x / W;
    // cross-pollinated: a mix of both parents. Otherwise half the seeds take after the parent
    // and the rest can be anything (rarer species less often).
    const mate = p.mate;
    const species = mate ? (r() < 0.5 ? p.species : mate.species) : r() < 0.5 ? p.species : pickSpecies(r);
    const depth = species === 'tree' ? range(r, 0, 0.15) : clamp(p.depth + range(r, -0.3, 0.3), 0, 1);
    const [tx, ty] = basePos({ xn, depth });
    const genome = mate ? crossbreed(p.genome, mate.genome, species, r) : species === p.species ? mutate(p.genome, species, r) : randomGenome(r, species);
    // 1 in 20 seeds is a rare mutation; rare parents sometimes pass theirs on
    const rare: Rare | null = r() < 0.05 ? RARES[Math.floor(r() * RARES.length)] : p.rare && species === p.species && r() < 0.25 ? p.rare : null;
    flying.push({
      sx, sy, tx, ty, xn, depth, t0: now + i * 0.06, dur: range(r, 0.85, 1.25), peak: range(r, 50, 110) * Math.sqrt(worldScale),
      spin: range(r, -9, 9), genome, gen: p.gen + 1, species, rare, golden: false, state: 'fly', tLand: 0, id: nextId++,
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
  plants.push(makePlant({ id: f.id, seed, xn: f.xn, depth: f.depth, gen: f.gen, genome: f.genome, species: f.species, rare: f.rare, golden: f.golden }));
  stats.maxGen = Math.max(stats.maxGen, f.gen);
  dirty = true;
}

// ---------------- update ----------------
function update(now: number, dt: number) {
  for (const p of plants) {
    if (p.pendingAt && now >= p.pendingAt) startGrow(p, now);
    // slow unassisted growth: watering only speeds it up
    if (!p.anim && !p.pendingAt && p.stage < 5) {
      if (!p.nextAuto) p.nextAuto = now + range(Math.random, AUTO_MIN, AUTO_MAX) * SPECIES_INFO[p.species].auto * (1 - 0.2 * world.seasonK('spring'));
      else if (world.rain > 0.3) p.nextAuto -= dt * 1.5 * world.rain; // rain makes everything grow faster
      if (p.nextAuto && now >= p.nextAuto) {
        if (growBlock(p) || winterRest()) p.nextAuto = now + 4; // wait for the right conditions (or spring)
        else {
          startGrow(p, now);
          p.poke = 0.35;
        }
      }
    }
    updateClimb(p, now);
    if (p.anim) {
      const k = clamp01((now - p.anim.t0) / p.anim.dur);
      p.g = p.anim.from + easeInOut(k);
      if (p.anim.from >= 4 && p.g >= 4.75 && !p.burst) {
        spriteFor(p, 0); // make sure pod position is current
        emitSeeds(p, now);
      }
      if (k >= 1) {
        p.stage = p.anim.to;
        p.g = p.stage;
        p.anim = null;
        if (p.stage >= 4 && !p.bloomed) {
          p.bloomed = true;
          stats.grown++;
        }
        if (p.stage >= 4 && book.discover(p.species, p.rare, p.genome, p.seed)) {
          toast(`new in your book: ${variantName(p.species, p.rare)}!`, 3200);
          sound.bloom();
          bookBtn.classList.remove('wiggle');
          void bookBtn.offsetWidth;
          bookBtn.classList.add('wiggle');
        }
        if (p.stage >= 5) {
          if (p.species === 'tree') {
            // trees stay: fruit again next time
            p.stage = 4;
            p.g = 4;
            p.burst = false;
          } else p.wilt = 0;
        }
        dirty = true;
      }
    } else if (p.stage >= 5) {
      p.wilt = Math.min(1, p.wilt + dt / 9);
    }
    p.hover += (p.hoverTarget - p.hover) * Math.min(1, dt * 8);
    p.poke = Math.max(0, p.poke - dt * 2.2);
  }
  spawnBees(now);
  updateBees(now, dt);
  updateFauna(now, dt);
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
  sparks = sparks.filter((q) => now - q.t0 < 0.7);

  if (plants.length === 0 && flying.length === 0) {
    plants.push(starterSeed());
    dirty = true;
  }
  // ---- world: time, weather, seasons
  const was = world.update(dt, Math.random);
  if (was) onWeatherChange(was, now);
  if (world.seasonIndex !== lastSeason) {
    if (lastSeason >= 0) toast(`${world.season} is here`, 3000);
    lastSeason = world.seasonIndex;
  }
  const windSign = world.wind + world.gust > 0.4 ? world.windDir : 1;
  clouds.forEach((c, i) => {
    const want = i < 3 || c.held || c.rk > 0.05 ? 1 : i < 5 ? (world.cloud > 0.25 ? 1 : 0) : world.cloud > 0.6 ? 1 : 0;
    c.vis += (want - c.vis) * Math.min(1, dt / 3);
    if (c.held) return;
    c.x += c.speed * dt * (1 + 3 * world.wind + 8 * world.gust) * windSign;
    if (c.x - c.w > W + 20) c.x = -c.w - 20;
    if (c.x + c.w < -20) c.x = W + c.w + 20;
  });
  updateParticles(now, dt);
  updateTools(now, dt / SPEED);
  updateSurprises(now, dt);
  updateTips();
  sound.update(realNow(), {
    light: world.light,
    rain: Math.max(world.rain, ...clouds.map((c) => c.rk * 0.7)),
    wind: Math.min(1, world.wind + world.gust),
    snow: world.snowing,
  });
}

function onWeatherChange(was: Weather, now: number) {
  dirty = true;
  // sometimes a rainbow after the rain
  if (was === 'rain' && world.light > 0.5 && Math.random() < 0.65) rainbow = { t0: now, dur: 28, x: range(Math.random, 0.35, 0.65) };
}

// ---------------- small surprises: rainbow, shooting star, mole ----------------
let rainbow: { t0: number; dur: number; x: number } | null = null;
let shooting: { x0: number; y0: number; x1: number; y1: number; t0: number; gift: boolean } | null = null;
interface Mole { phase: 'up' | 'grab' | 'down' | 'dig' | 'up2' | 'drop' | 'down2'; t0: number; x0: number; y0: number; x1: number; y1: number; plant: Plant; xn: number; depth: number; }
let mole: Mole | null = null;
let moleAt = 60;
let moleTipShown = false;
const sound = new Sound();
const MOLE_TIMES: Record<Mole['phase'], number> = { up: 0.8, grab: 1.1, down: 0.6, dig: 2.2, up2: 0.8, drop: 0.9, down2: 0.6 };
const MOLE_NEXT: Record<Mole['phase'], Mole['phase'] | null> = { up: 'grab', grab: 'down', down: 'dig', dig: 'up2', up2: 'drop', drop: 'down2', down2: null };

function updateSurprises(now: number, dt: number) {
  if (rainbow && now - rainbow.t0 > rainbow.dur) rainbow = null;
  // shooting stars on clear nights; some leave a golden seed
  if (!shooting && world.night > 0.85 && world.cloud < 0.4 && Math.random() < dt / 35) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    const x0 = W * range(Math.random, 0.2, 0.8), y0 = H * range(Math.random, 0.05, 0.2);
    const len = W * range(Math.random, 0.18, 0.3);
    shooting = { x0, y0, x1: clamp(x0 + dir * len, W * 0.06, W * 0.94), y1: y0 + len * 0.45, t0: now, gift: Math.random() < 0.6 };
  }
  if (shooting && now - shooting.t0 > 1.1) {
    if (shooting.gift && plants.length + flying.length < MAX_PLANTS) {
      const s = shooting;
      const species = pickSpecies(Math.random);
      const xn = clamp(s.x1 / W, 0.05, 0.95), depth = species === 'tree' ? range(Math.random, 0, 0.15) : range(Math.random, 0.2, 0.9);
      const [tx, ty] = basePos({ xn, depth });
      flying.push({
        sx: s.x1, sy: s.y1, tx, ty, xn, depth, t0: now, dur: 2.2, peak: 10, spin: 3, genome: randomGenome(Math.random, species), gen: 1,
        species, rare: RARES[Math.floor(Math.random() * RARES.length)], golden: true, state: 'fly', tLand: 0, id: nextId++,
      });
      toast('a shooting star dropped a golden seed!', 3200);
    }
    shooting = null;
  }
  // a mole pops up under a seed and moves it somewhere else
  if (!mole && now > moleAt) {
    moleAt = now + range(Math.random, 80, 180);
    const seeds = plants.filter((p) => p.stage === 0 && !p.anim && !p.pendingAt && p.g < 0.2);
    if (seeds.length && world.snowCover < 0.3) {
      const p = seeds[Math.floor(Math.random() * seeds.length)];
      const [x0, y0] = basePos(p);
      for (let tries = 0; tries < 8; tries++) {
        const xn = clamp(p.xn + range(Math.random, 0.12, 0.3) * (Math.random() < 0.5 ? -1 : 1), 0.05, 0.95);
        const depth = clamp(p.depth + range(Math.random, -0.3, 0.3), 0.1, 1);
        const [x1, y1] = basePos({ xn, depth });
        if (canSprout(x1, y1)) {
          mole = { phase: 'up', t0: now, x0, y0, x1, y1, plant: p, xn, depth };
          break;
        }
      }
    }
  }
  if (mole && now - mole.t0 > MOLE_TIMES[mole.phase]) {
    const m = mole;
    if (m.phase === 'grab') {
      if (!plants.includes(m.plant) || m.plant.stage !== 0 || m.plant.anim || m.plant.pendingAt) {
        mole = { ...m, phase: 'down2', t0: now }; // the seed got going: leave it be
        return;
      }
      plants = plants.filter((q) => q !== m.plant);
    }
    if (m.phase === 'drop') {
      Object.assign(m.plant, { xn: m.xn, depth: m.depth, key: '' });
      if (plants.length < MAX_PLANTS) plants.push(m.plant);
      dirty = true;
      if (!moleTipShown) {
        moleTipShown = true;
        toast('a mole moved a seed!');
      }
    }
    const next = MOLE_NEXT[m.phase];
    mole = next ? { ...m, phase: next, t0: now } : null;
  }
}

function drawRainbow(now: number) {
  if (!rainbow) return;
  const k = Math.min(smooth(0, 3, now - rainbow.t0), 1 - smooth(rainbow.dur - 5, rainbow.dur, now - rainbow.t0));
  if (k <= 0.01) return;
  const R = Math.min(W * 0.42, H * 0.55);
  const s = bank.get('rainbow', 0, 1, () => rainbowGroups(R), 51);
  ctx.globalAlpha = k * 0.75;
  ctx.drawImage(s.canvas, W * rainbow.x + s.ox, groundY(W * rainbow.x, H) + 4 + s.oy, s.w, s.h);
  ctx.globalAlpha = 1;
}

function drawShootingStar(now: number, boil: number) {
  if (!shooting) return;
  const s = shooting;
  const u = clamp01((now - s.t0) / 1.1);
  const e = 1 - (1 - u) * (1 - u);
  const hx = s.x0 + (s.x1 - s.x0) * e, hy = s.y0 + (s.y1 - s.y0) * e;
  const tx = s.x0 + (s.x1 - s.x0) * Math.max(0, e - 0.35), ty = s.y0 + (s.y1 - s.y0) * Math.max(0, e - 0.35);
  const g = ctx.createLinearGradient(tx, ty, hx, hy);
  g.addColorStop(0, 'rgba(242,210,92,0)');
  g.addColorStop(1, 'rgba(242,210,92,0.95)');
  ctx.save();
  ctx.strokeStyle = g;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  const st = bank.get('star', boil, 1.8 * Math.sqrt(worldScale), () => starGroups(4.5), 7);
  ctx.globalAlpha = 1 - u * 0.3;
  ctx.drawImage(st.canvas, hx + st.ox, hy + st.oy, st.w, st.h);
  ctx.restore();
}

function drawMole(now: number, boil: number) {
  if (!mole) return;
  const m = mole;
  const k = clamp01((now - m.t0) / MOLE_TIMES[m.phase]);
  const atStart = m.phase === 'up' || m.phase === 'grab' || m.phase === 'down';
  const sc = worldScale * 1.1;
  let x = atStart ? m.x0 : m.x1, y = atStart ? m.y0 : m.y1;
  // how far the mole is out of the ground, 0..1
  let out = m.phase === 'up' || m.phase === 'up2' ? easeInOut(k) : m.phase === 'down' || m.phase === 'down2' ? 1 - easeInOut(k) : m.phase === 'dig' ? 0 : 1;
  if (m.phase === 'dig') {
    x = m.x0 + (m.x1 - m.x0) * easeInOut(k);
    y = m.y0 + (m.y1 - m.y0) * easeInOut(k);
    out = 0;
  }
  const mound = bank.get('mound', boil, sc, moundGroups, 53);
  if (out > 0.01) {
    const s = bank.get('mole', boil, sc, moleGroups, 55);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 40 * sc, y - 60 * sc, 80 * sc, 60 * sc - 2);
    ctx.clip();
    ctx.translate(x, y + (1 - out) * 22 * sc + Math.sin(now * 12) * (m.phase === 'grab' ? 1.5 : 0));
    ctx.drawImage(s.canvas, s.ox, s.oy, s.w, s.h);
    // the seed in its paws
    if (m.phase === 'grab' || m.phase === 'down' || m.phase === 'up2' || (m.phase === 'drop' && k < 0.5)) {
      const ss = bank.get(`seed|${m.plant.species}|${Math.round(m.plant.genome.petalHue / 15)}|${m.plant.golden ? 1 : 0}`, boil, worldScale * 0.85, () => seedGroups(m.plant.species, m.plant.genome, m.plant.golden), 5);
      ctx.drawImage(ss.canvas, ss.ox, -3 * sc + ss.oy, ss.w, ss.h);
    }
    ctx.restore();
  }
  // the mound (a moving bump while it digs)
  ctx.save();
  ctx.translate(x, y);
  if (m.phase === 'dig') ctx.scale(0.7, 0.6 + 0.15 * Math.sin(now * 14));
  ctx.drawImage(mound.canvas, mound.ox, mound.oy, mound.w, mound.h);
  ctx.restore();
}

// ---------------- gentle tips for the extra things you can do ----------------
const TIPS = [
  'tip: drag the watering can over plants to water them',
  'tip: drag a cloud to make it rain on one spot',
  'tip: hold an open flower to pick it for your vase',
  'tip: swipe fast across the garden to make wind',
];
let tipIndex = 0;
let tipAt = 0;
function updateTips() {
  if (!hintDone || tipIndex >= TIPS.length) return;
  const t = realNow();
  if (!tipAt) tipAt = t + 25;
  if (t < tipAt || toastEl.classList.contains('show') || book.isOpen) return;
  toast(TIPS[tipIndex++], 4200);
  tipAt = t + 40;
  dirty = true;
}

/** Rain, snow, autumn leaves and wind curls. */
function updateParticles(now: number, dt: number) {
  const spawn = (rate: number) => {
    const n = rate * dt;
    return Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
  };
  const wx = world.windDir * (world.wind * 120 + world.gust * 260);

  if (parts.length < 450) {
    const widthK = W / 1000;
    for (let i = spawn(150 * world.rain * widthK); i > 0; i--) {
      const x = range(Math.random, -60, W + 60);
      parts.push({ kind: 'rain', x, y: -20, vx: wx * 0.9, vy: range(Math.random, 560, 700), rot: 0, vr: 0, floor: floorAt(x), landed: 0, seed: 0, color: '' });
    }
    for (let i = spawn(45 * world.snowing * widthK); i > 0; i--) {
      const x = range(Math.random, -60, W + 60);
      parts.push({ kind: 'snow', x, y: -10, vx: wx * 0.5, vy: range(Math.random, 40, 75), rot: 0, vr: 0, floor: floorAt(x), landed: 0, seed: Math.random() * 6, color: '' });
    }
    if (world.wind + world.gust > 0.5) {
      for (let i = spawn(0.9 * (world.wind + world.gust)); i > 0; i--) {
        const dir = world.windDir;
        parts.push({ kind: 'wind', x: dir > 0 ? -90 : W + 90, y: range(Math.random, H * 0.12, H * 0.55), vx: dir * range(Math.random, 220, 320), vy: 0, rot: 0, vr: 0, floor: 0, landed: 0, seed: Math.floor(Math.random() * 5), color: '' });
      }
    }
    // autumn leaves drift off trees (and a few off other plants)
    const ak = world.autumnK;
    if (ak > 0.05) {
      for (const p of plants) {
        if (p.wilt >= 0 || p.g < 2) continue;
        const rate = (p.species === 'tree' ? 0.7 : p.species === 'cactus' || p.species === 'mushroom' ? 0 : 0.04) * ak * (1 + world.wind * 2);
        if (!rate || Math.random() > rate * dt) continue;
        const s = p.sprites.find((q) => q) ?? p.stale;
        if (!s) continue;
        const [bx, by] = basePos(p);
        const COLORS = ['#c9762f', '#b5523b', '#e3a530', '#a8643a'];
        parts.push({
          kind: 'leaf', x: bx + s.ox + Math.random() * s.w, y: by + s.oy + Math.random() * s.h * 0.45, vx: wx * 0.6, vy: range(Math.random, 30, 55),
          rot: Math.random() * 6, vr: range(Math.random, -2, 2), floor: by + range(Math.random, -4, 22), landed: 0, seed: Math.random() * 6, color: COLORS[Math.floor(Math.random() * 4)],
        });
      }
    }
  }
  for (const q of parts) {
    if (q.landed) continue;
    if (q.kind === 'snow' || q.kind === 'leaf') {
      q.x += (q.vx + Math.sin(now * 1.7 + q.seed) * (q.kind === 'leaf' ? 30 : 14)) * dt;
      q.vx += (wx * (q.kind === 'leaf' ? 0.6 : 0.5) - q.vx) * Math.min(1, dt);
      q.rot += q.vr * dt;
    } else q.x += q.vx * dt;
    q.y += q.vy * dt;
    if (q.kind !== 'wind' && q.y >= q.floor) {
      q.y = q.floor;
      q.landed = now;
    }
  }
  parts = parts.filter((q) => {
    if (q.kind === 'wind') return q.x > -120 && q.x < W + 120;
    if (!q.landed) return q.x > -100 && q.x < W + 100;
    return now - q.landed < (q.kind === 'rain' ? 0 : q.kind === 'snow' ? 1.2 : 3.5);
  });
}

/** A random spot on the soil below x, for rain to land on. */
function floorAt(x: number) {
  const gy = groundY(x, H);
  return gy + 4 + Math.random() * (H - gy) * 0.9;
}

function drawSky(now: number, boil: number) {
  const n = world.night, warm = world.warm, cl = world.cloud;
  const gy = H * 0.66;
  const sky = skyPath!;
  if (warm > 0.01) {
    const g = ctx.createLinearGradient(0, 0, 0, gy);
    g.addColorStop(0, 'rgba(236,140,90,0)');
    g.addColorStop(1, `rgba(236,140,90,${0.32 * warm})`);
    ctx.fillStyle = g;
    ctx.fill(sky);
  }
  if (cl > 0.01) {
    ctx.fillStyle = `rgba(118,128,142,${0.2 * cl})`;
    ctx.fill(sky);
  }
  if (n > 0.01) {
    const g = ctx.createLinearGradient(0, 0, 0, gy);
    g.addColorStop(0, `rgba(22,30,70,${0.78 * n})`);
    g.addColorStop(1, `rgba(45,55,100,${0.5 * n})`);
    ctx.fillStyle = g;
    ctx.fill(sky);
  }
  // stars
  const sa = smooth(0.25, 0.85, n) * (1 - cl * 0.85);
  if (sa > 0.02) {
    for (const st of stars) {
      const tw = 0.55 + 0.45 * Math.sin(now * 1.8 + st.ph);
      const s = bank.get('star', boil, st.s * Math.sqrt(worldScale), () => starGroups(4.5), 7);
      ctx.globalAlpha = sa * tw;
      ctx.drawImage(s.canvas, st.x + s.ox, st.y + s.oy, s.w, s.h);
    }
    ctx.globalAlpha = 1;
  }
  // moon
  const mp = world.moonPos(W, H);
  if (mp) {
    const m = bank.get('moon', boil, 1, () => moonGroups(sunR * 0.8), 13);
    ctx.globalAlpha = 1 - cl * 0.6;
    ctx.drawImage(m.canvas, mp[0] + m.ox, mp[1] + m.oy, m.w, m.h);
    ctx.globalAlpha = 1;
  }
}

/** Night and storm darkening over the whole garden, then glowing flowers on top. */
function drawShade(now: number) {
  const n = world.night, cl = world.cloud;
  if (n > 0.01 || cl > 0.01) {
    ctx.fillStyle = `rgba(20,26,62,${0.36 * n})`;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = `rgba(90,96,112,${0.08 * cl * (1 - n)})`;
    ctx.fillRect(0, 0, W, H);
  }
  if (n > 0.15) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const p of plants) {
      if (p.rare !== 'glow' || p.wilt >= 0.6 || !p.pod || p.g < 2.5) continue;
      const [bx, by] = basePos(p);
      const x = bx + p.pod[0], y = by + p.pod[1];
      const R = 46 * plantScale(p) * (0.9 + 0.1 * Math.sin(now * 2 + p.id));
      const g = ctx.createRadialGradient(x, y, 2, x, y, R);
      g.addColorStop(0, `rgba(255,232,140,${0.85 * n})`);
      g.addColorStop(0.4, `rgba(255,220,120,${0.35 * n})`);
      g.addColorStop(1, 'rgba(255,220,120,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - R, y - R, R * 2, R * 2);
    }
    ctx.restore();
  }
}

function drawWeather(now: number, boil: number) {
  const drop = bank.get('drop', boil, Math.max(0.7, worldScale * 0.75), dropGroups, 3);
  const flake = bank.get('flake', boil, Math.max(0.8, worldScale * 0.8), flakeGroups, 4);
  for (const q of parts) {
    if (q.kind === 'rain') {
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate(-Math.atan2(q.vx, q.vy));
      ctx.drawImage(drop.canvas, drop.ox, drop.oy, drop.w, drop.h);
      ctx.restore();
    } else if (q.kind === 'snow') {
      ctx.globalAlpha = q.landed ? 1 - (now - q.landed) / 1.2 : 1;
      ctx.drawImage(flake.canvas, q.x + flake.ox, q.y + flake.oy, flake.w, flake.h);
      ctx.globalAlpha = 1;
    } else if (q.kind === 'leaf') {
      const s = bank.get('leafbit' + q.color, boil, worldScale * 0.8, () => leafBitGroups(q.color), 9);
      ctx.save();
      ctx.globalAlpha = q.landed ? clamp01(1 - (now - q.landed - 2.5)) : 1;
      ctx.translate(q.x, q.y);
      ctx.rotate(q.landed ? 1.4 : q.rot);
      ctx.drawImage(s.canvas, s.ox, s.oy, s.w, s.h);
      ctx.restore();
    } else {
      const s = bank.get('wind' + q.seed, boil, worldScale * 0.9, () => windGroups(q.seed + 1), 17);
      const edge = Math.min(q.x + 90, W + 90 - q.x) / 140;
      ctx.save();
      ctx.globalAlpha = clamp01(edge) * 0.85;
      ctx.translate(q.x, q.y);
      ctx.scale(Math.sign(q.vx) || 1, 1);
      ctx.drawImage(s.canvas, s.ox, s.oy, s.w, s.h);
      ctx.restore();
    }
  }
}

// ---------------- render ----------------
function render(now: number, boil: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (bg) ctx.drawImage(bg, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  drawSky(now, boil);
  drawShootingStar(now, boil);
  drawRainbow(now);

  // sun
  const sp = sunPos();
  if (sp) {
    const sun = bank.get('sun', boil, 1, () => sunGroups(sunR), 11);
    ctx.save();
    ctx.globalAlpha = 1 - world.cloud * 0.45;
    ctx.translate(sp[0], sp[1]);
    ctx.rotate(Math.sin(now * 0.4) * 0.06);
    ctx.drawImage(sun.canvas, sun.ox, sun.oy, sun.w, sun.h);
    ctx.restore();
  }

  // clouds (rain clouds are a darker crayon)
  const darkK = clamp01(world.rain + world.snowing);
  for (const c of clouds) {
    if (c.vis < 0.02) continue;
    const y = c.y + Math.sin(now * 0.5 + c.seed) * 2;
    ctx.globalAlpha = c.vis;
    if (darkK < 0.98) {
      const s = bank.get('cloud' + c.seed + '|' + c.w.toFixed(1), boil, 1, () => cloudGroups(c.w, c.seed), c.seed);
      ctx.drawImage(s.canvas, c.x + s.ox, y + s.oy, s.w, s.h);
    }
    const dk = Math.max(darkK, c.rk);
    if (dk > 0.02) {
      const s = bank.get('dcloud' + c.seed + '|' + c.w.toFixed(1), boil, 1, () => cloudGroups(c.w, c.seed, true), c.seed);
      ctx.globalAlpha = c.vis * dk;
      ctx.drawImage(s.canvas, c.x + s.ox, y + s.oy, s.w, s.h);
    }
    ctx.globalAlpha = 1;
  }

  // ground
  if (!grounds[boil] && (performance.now() < renderDeadline || !grounds.some((g) => g))) grounds[boil] = renderGround(W, H, dpr, boil);
  const gr = (grounds[boil] ?? grounds.find((g) => g))!;
  ctx.drawImage(gr.canvas, 0, gr.top, gr.canvas.width / dpr, gr.canvas.height / dpr);
  if (world.snowCover > 0.01) {
    snowCap ??= renderSnowCap(W, H, dpr);
    ctx.globalAlpha = smooth(0, 0.6, world.snowCover);
    ctx.drawImage(snowCap.canvas, 0, snowCap.top, snowCap.canvas.width / dpr, snowCap.canvas.height / dpr);
    ctx.globalAlpha = 1;
  }

  // plants back-to-front
  const order = plants.map((p) => ({ p, pos: basePos(p) })).sort((a, b) => a.pos[1] - b.pos[1]);
  for (const { p, pos } of order) {
    const s = spriteFor(p, boil);
    if (!s) continue;
    const wig = (p.hover * 0.045 + p.poke * 0.08) * Math.sin(now * 13 + p.id);
    // wind: the top leans with the wind and sways; stiff plants move less
    const stiff = p.species === 'tree' ? 0.35 : p.species === 'cactus' || p.species === 'mushroom' ? 0.08 : p.species === 'vine' ? 0.25 : p.species === 'bush' ? 0.5 : 1;
    const sway = stiff * (world.windDir * (world.wind * 0.06 + world.gust * 0.16) + Math.sin(now * 2.3 + p.id * 1.7) * (0.012 + world.wind * 0.05 + world.gust * 0.08));
    const fade = p.wilt < 0 ? 1 : 1 - smoothstep(0.55, 1, p.wilt);
    const sink = p.wilt < 0 ? 1 : 1 - 0.45 * smoothstep(0.45, 1, p.wilt);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(pos[0], pos[1]);
    if (wig) ctx.rotate(wig);
    if (sway) ctx.transform(1, 0, -sway, 1, 0, 0);
    if (sink !== 1) ctx.scale(1, sink);
    ctx.drawImage(s.canvas, s.ox, s.oy, s.w, s.h);
    ctx.restore();
    if (p.rare && p.g < 1.6) twinkle(pos[0], pos[1] - 6 * worldScale, now, p.id, 10 * worldScale);
  }

  drawMole(now, boil);
  drawFauna(now, boil);

  // bees
  for (const b of bees) {
    const s = bank.get('bee' + (Math.floor(now * 14) % 2), boil, Math.max(1, worldScale * 1.15), () => beeGroups(Math.floor(now * 14) % 2), 21);
    ctx.save();
    ctx.translate(b.x, b.y + Math.sin(now * 9 + b.seed) * 3);
    ctx.scale(b.dir, 1);
    ctx.drawImage(s.canvas, s.ox, s.oy, s.w, s.h);
    ctx.restore();
  }

  // flying seeds
  for (const f of flying) {
    const s = bank.get(`seed|${f.species}|${Math.round(f.genome.petalHue / 15)}|${f.golden ? 1 : 0}`, boil, worldScale * 0.85, () => seedGroups(f.species, f.genome, f.golden), 5);
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
    if ((f.rare || f.golden) && alpha > 0.5) twinkle(x, y, now, f.id, 10 * worldScale);
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
  // sun sparkles (cactus growing)
  for (const q of sparks) {
    const k = (now - q.t0) / 0.7;
    if (k < 0) continue;
    ctx.save();
    ctx.globalAlpha = 1 - k * k;
    ctx.strokeStyle = q.color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    const r0 = q.size * (0.3 + k * 0.5), r1 = q.size * (0.6 + k);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + k;
      ctx.beginPath();
      ctx.moveTo(q.x + Math.cos(a) * r0, q.y + Math.sin(a) * r0);
      ctx.lineTo(q.x + Math.cos(a) * r1, q.y + Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.restore();
  }
  drawWeather(now, boil);
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
  drawShade(now);
  drawTools(boil);
}
function smooth(a: number, b: number, x: number) {
  return smoothstep(a, b, x);
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

/** Gentle watering from the can or a rain cloud: no messages, no drops of its own. */
function waterQuiet(p: Plant, now: number) {
  if (now - p.wateredAt < 1.5) return;
  p.wateredAt = now;
  if (p.species === 'cactus' || p.anim || p.pendingAt || p.stage >= 5 || growBlock(p)) return;
  p.pendingAt = now + 0.3;
  p.poke = 0.5;
  dirty = true;
}

function water(p: Plant, now: number, px: number, py: number) {
  if (p.anim || p.pendingAt || p.stage >= 5) {
    p.poke = 1;
    return;
  }
  const block = growBlock(p);
  if (block) {
    p.poke = 1;
    toast(block);
    return;
  }
  const [bx, by] = basePos(p);
  const s = p.sprites.find((q) => q);
  const top = s && p.g >= 1.5 ? by + s.oy : by - 30;
  if (p.species === 'cactus') {
    // no water needed: it soaks up the sun instead
    for (let i = 0; i < 5; i++)
      sparks.push({ x: bx + (Math.random() - 0.5) * 40 * worldScale, y: (top + by) / 2 + (Math.random() - 0.5) * (by - top), t0: now + i * 0.06, color: '#e3a530', size: 9 * worldScale });
    p.pendingAt = now + 0.35;
  } else {
    const startY = Math.min(py, top) - 40;
    for (let i = 0; i < 4; i++) {
      drops.push({ x: bx + (i - 1.5) * 7 * worldScale + (Math.random() - 0.5) * 4, y0: startY - Math.random() * 15, y1: by - 4 - Math.random() * 6, t0: now + i * 0.07, dur: 0.38 });
    }
    p.pendingAt = now + 0.45;
  }
  p.poke = 0.6;
  void px;
  if (!hintDone) {
    hintDone = true;
    hint.classList.add('hide');
  }
  dirty = true;
}

// ---------------- tools: watering can, rain cloud, picking, wind ----------------
interface Pluck { x: number; y: number; t0: number; item: Picked; }
const VASE_MAX = 7;
const LONG_PRESS = 0.55;
const PICKABLE: Species[] = ['daisy', 'sunflower', 'bush', 'vine', 'cactus'];
let vase: Picked[] = [];
let vaseStyle = 0;
let bouquets: Bouquet[] = [];
const MAX_BOUQUETS = 12;
let plucks: Pluck[] = [];
const can = { x: 0, y: 0, hx: 0, hy: 0, held: false, tilt: 0, pourAt: 0 };
type DragKind = 'can' | 'cloud' | 'press' | 'swipe';
interface Drag {
  kind: DragKind; id: number; x: number; y: number; x0: number; y0: number; t0: number;
  lt: number; lx: number; ly: number; plant: Plant | null; cloud: Cloud | null; ox: number; oy: number; done: boolean;
}
let drag: Drag | null = null;
let gustScatterAt = 0;
let pickTipShown = false;
const realNow = () => performance.now() / 1000;

const canScale = () => clamp(worldScale * 0.95, 0.8, 1.4);
const canHome = (): [number, number] => [Math.max(46, W * 0.045), H - Math.max(34, H * 0.055)];
const vasePos = (): [number, number] => [W - Math.max(48, W * 0.045), H - Math.max(14, H * 0.025)];
const vaseScale = () => clamp(worldScale * 0.95, 0.8, 1.4);
function canTip(): [number, number] {
  const cs = canScale(), c = Math.cos(can.tilt), s = Math.sin(can.tilt);
  return [can.x + (CAN_TIP[0] * c - CAN_TIP[1] * s) * cs, can.y + (CAN_TIP[0] * s + CAN_TIP[1] * c) * cs];
}
function overCan(x: number, y: number) {
  const cs = canScale();
  return Math.abs(x - can.x - 6 * cs) < 34 * cs && y > can.y - 34 * cs && y < can.y + 20 * cs;
}
function overVase(x: number, y: number) {
  const [vx, vy] = vasePos();
  const vs = vaseScale();
  return Math.abs(x - vx) < 26 * vs && y < vy + 6 && y > vy - (vase.length ? 95 : 42) * vs;
}

// tapping the vase lets you start a new one when you're done collecting
const vasePop = document.getElementById('vase-pop')!;
const vaseNewBtn = document.getElementById('vase-new') as HTMLButtonElement;
function openVasePop() {
  document.getElementById('vase-n')!.textContent = String(vase.length);
  document.getElementById('vase-name')!.textContent = VASES[vaseStyle].name;
  vaseNewBtn.disabled = vase.length === 0;
  vasePop.hidden = false;
  drawFrames(lastBoil < 0 ? 0 : lastBoil);
  (vase.length ? vaseNewBtn : (document.getElementById('vase-keep') as HTMLButtonElement)).focus();
}
function closeVasePop() {
  vasePop.hidden = true;
}
vaseNewBtn.addEventListener('click', () => {
  if (vase.length) {
    bouquets.push({ items: vase, style: vaseStyle });
    if (bouquets.length > MAX_BOUQUETS) bouquets.shift();
    book.setBouquets(bouquets);
  }
  vase = [];
  vaseStyle = (vaseStyle + 1) % VASES.length;
  closeVasePop();
  sound.bloom();
  toast(`a fresh ${VASES[vaseStyle].name}! your bouquet is kept in the book`, 3400);
  dirty = true;
});
document.getElementById('vase-keep')!.addEventListener('click', closeVasePop);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !vasePop.hidden) closeVasePop();
});

function cloudAt(x: number, y: number): Cloud | null {
  for (const c of clouds) if (c.vis > 0.5 && Math.abs(x - c.x) < c.w * 0.5 && Math.abs(y - c.y) < c.w * 0.22) return c;
  return null;
}
const pickable = (p: Plant) => PICKABLE.includes(p.species) && p.stage === 4 && !p.anim && p.wilt < 0;

function tryPick(p: Plant, now: number) {
  if (!plants.includes(p)) return;
  if (!pickable(p)) {
    p.poke = 1;
    if (p.species === 'mushroom' || p.species === 'tree') toast(`a ${SPECIES_INFO[p.species].name.toLowerCase()} can't go in the vase`);
    else toast('only open flowers can be picked');
    return;
  }
  if (vase.length + plucks.length >= VASE_MAX) {
    p.poke = 1;
    toast('your vase is full! tap it to start a new one', 3200);
    return;
  }
  const [bx, by] = basePos(p);
  const pod = p.pod ?? [0, -40];
  plucks.push({ x: bx + pod[0], y: by + pod[1], t0: realNow(), item: { sp: p.species, gn: p.genome, rare: p.rare } });
  puffs.push({ x: bx, y: by, t0: now });
  plants = plants.filter((q) => q !== p);
  if (hovered === p) setHover(null);
  dirty = true;
  if (!pickTipShown) {
    pickTipShown = true;
    toast('picked! it goes in the vase');
  }
}

/** A strong gust lifts unsprouted seeds and carries them downwind. */
function scatterSeeds(now: number) {
  const dir = world.windDir;
  for (const p of [...plants]) {
    if (p.stage !== 0 || p.anim || p.pendingAt || p.g > 0.3 || Math.random() > 0.6) continue;
    const [bx, by] = basePos(p);
    const x = clamp(bx + dir * range(Math.random, 80, 210) * worldScale, W * 0.04, W * 0.96);
    const xn = x / W, depth = clamp(p.depth + range(Math.random, -0.15, 0.15), 0, 1);
    const [tx, ty] = basePos({ xn, depth });
    plants = plants.filter((q) => q !== p);
    flying.push({
      sx: bx, sy: by - 4, tx, ty, xn, depth, t0: now, dur: range(Math.random, 0.9, 1.3), peak: range(Math.random, 60, 120) * Math.sqrt(worldScale),
      spin: dir * range(Math.random, 6, 10), genome: p.genome, gen: p.gen, species: p.species, rare: p.rare, golden: false, state: 'fly', tLand: 0, id: nextId++,
    });
  }
  dirty = true;
}

function gust(strength: number, dir: number) {
  world.gust = Math.min(1, world.gust + strength);
  world.windDir = dir;
  const t = realNow();
  if (world.gust > 0.5 && t > gustScatterAt) {
    gustScatterAt = t + 1.2;
    scatterSeeds(clock());
  }
}

function updateTools(now: number, rdt: number) {
  // the can follows the finger, tilts and pours; let go and it goes home
  if (!can.held) {
    can.x += (can.hx - can.x) * Math.min(1, rdt * 7);
    can.y += (can.hy - can.y) * Math.min(1, rdt * 7);
  }
  can.tilt += ((can.held ? 0.8 : 0) - can.tilt) * Math.min(1, rdt * 8);
  if (can.held && can.tilt > 0.4) {
    const [tx, ty] = canTip();
    const t = realNow();
    if (t > can.pourAt) {
      can.pourAt = t + 0.05;
      const y1 = Math.max(ty + 20, floorAt(tx));
      drops.push({ x: tx + range(Math.random, -3, 3), y0: ty, y1, t0: now, dur: (0.2 + (y1 - ty) / 1100) * SPEED });
    }
    for (const p of plants) {
      const [bx, by] = basePos(p);
      if (Math.abs(bx - tx) < 36 * worldScale && by > ty) waterQuiet(p, now);
    }
  }
  // dragged clouds rain for a while, watering what is below
  for (const c of clouds) {
    if (c.held) c.rainUntil = now + 5 * SPEED;
    c.rk += ((now < c.rainUntil ? 1 : 0) - c.rk) * Math.min(1, rdt * 2);
    if (c.rk < 0.3) continue;
    const n = 70 * c.rk * rdt;
    for (let i = Math.floor(n) + (Math.random() < n % 1 ? 1 : 0); i > 0 && parts.length < 500; i--) {
      const x = c.x + range(Math.random, -0.38, 0.38) * c.w;
      parts.push({ kind: 'rain', x, y: c.y + c.w * 0.1, vx: 0, vy: range(Math.random, 560, 680), rot: 0, vr: 0, floor: floorAt(x), landed: 0, seed: 0, color: '' });
    }
    if (c.rk > 0.6) for (const p of plants) if (Math.abs(basePos(p)[0] - c.x) < c.w * 0.42) waterQuiet(p, now);
  }
  // long press picks a flower
  if (drag?.kind === 'press' && !drag.done && drag.plant && realNow() - drag.t0 > LONG_PRESS) {
    drag.done = true;
    tryPick(drag.plant, now);
  }
  // picked flowers fly to the vase
  const t = realNow();
  for (const q of plucks) {
    if (t - q.t0 < 0.9) continue;
    vase.push(q.item);
    if (vase.length > VASE_MAX) vase.shift();
    if (vase.length === VASE_MAX) toast('the vase is full! tap it when you want a new one', 3600);
    dirty = true;
  }
  plucks = plucks.filter((q) => t - q.t0 < 0.9);
}

function drawTools(boil: number) {
  // vase
  const [vx, vy] = vasePos();
  {
    const key = 'vase' + vaseStyle + '|' + vase.map((v) => v.sp[0] + Math.round(v.gn.petalHue) + (v.rare ?? '')).join(',');
    const s = bank.get(key, boil, vaseScale(), () => vaseGroups(vase, vaseStyle), 77);
    ctx.drawImage(s.canvas, vx + s.ox, vy + s.oy, s.w, s.h);
  }
  // flowers on their way to the vase
  const t = realNow();
  for (const q of plucks) {
    const k = easeInOut(clamp01((t - q.t0) / 0.9));
    const tx = vx, ty = vy - 36 * vaseScale();
    const x = q.x + (tx - q.x) * k, y = q.y + (ty - q.y) * k - Math.sin(k * Math.PI) * 80;
    const key = 'pick|' + q.item.sp + Math.round(q.item.gn.petalHue) + (q.item.rare ?? '');
    const s = bank.get(key, boil, vaseScale() * 0.9, () => pickedGroups(q.item), 78);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(k * 0.6);
    ctx.drawImage(s.canvas, s.ox, s.oy, s.w, s.h);
    ctx.restore();
  }
  // watering can
  const cs = bank.get('can', boil, canScale(), canGroups, 31);
  ctx.save();
  ctx.translate(can.x, can.y);
  ctx.rotate(can.tilt);
  ctx.drawImage(cs.canvas, cs.ox, cs.oy, cs.w, cs.h);
  ctx.restore();
  // long-press ring
  if (drag?.kind === 'press' && !drag.done && drag.plant && pickable(drag.plant)) {
    const k = (t - drag.t0 - 0.12) / (LONG_PRESS - 0.12);
    if (k > 0) {
      ctx.save();
      ctx.strokeStyle = '#b5523b';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(drag.x, drag.y, 24, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, k));
      ctx.stroke();
      ctx.restore();
    }
  }
}

const pt = (e: PointerEvent): [number, number] => {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};
function updateCursor(x: number, y: number) {
  canvas.style.cursor = drag && (drag.kind === 'can' || drag.kind === 'cloud') ? 'grabbing' : overCan(x, y) || (!hovered && cloudAt(x, y)) ? 'grab' : overVase(x, y) ? 'pointer' : '';
}
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (drag) return; // one finger at a time
  sound.wake();
  const [x, y] = pt(e);
  if (!vasePop.hidden) {
    closeVasePop();
    return;
  }
  if (shooBird(x, y)) return;
  if (overVase(x, y) && !overCan(x, y)) {
    openVasePop();
    return;
  }
  const t = realNow();
  const d: Drag = { kind: 'swipe', id: e.pointerId, x, y, x0: x, y0: y, t0: t, lt: t, lx: x, ly: y, plant: null, cloud: null, ox: 0, oy: 0, done: false };
  const c = overCan(x, y) ? null : cloudAt(x, y);
  if (overCan(x, y)) {
    d.kind = 'can';
    can.held = true;
    d.ox = can.x - x;
    d.oy = can.y - y;
  } else if (c) {
    d.kind = 'cloud';
    d.cloud = c;
    c.held = true;
    d.ox = c.x - x;
    d.oy = c.y - y;
  } else {
    const p = hitTest(x, y);
    if (p) {
      d.kind = 'press';
      d.plant = p;
    }
  }
  drag = d;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  updateCursor(x, y);
});
canvas.addEventListener('pointermove', (e) => {
  const [x, y] = pt(e);
  if (!drag || e.pointerId !== drag.id) {
    if (e.pointerType === 'mouse') {
      setHover(hitTest(x, y));
      updateCursor(x, y);
    }
    return;
  }
  const t = realNow();
  const dt = Math.max(1 / 240, t - drag.lt);
  const dx = x - drag.lx, dy = y - drag.ly;
  drag.x = x;
  drag.y = y;
  if (drag.kind === 'press' && Math.hypot(x - drag.x0, y - drag.y0) > 12) drag.kind = 'swipe';
  if (drag.kind === 'can') {
    can.x = clamp(x + drag.ox, 20, W - 20);
    can.y = clamp(y + drag.oy, 50, H - 16);
  } else if (drag.kind === 'cloud' && drag.cloud) {
    const c = drag.cloud;
    c.x = clamp(x + drag.ox, 0, W);
    c.y = clamp(y + drag.oy, 30, groundY(c.x, H) - 80);
  } else if (drag.kind === 'swipe') {
    // a fast drag makes a gust of wind
    const speed = Math.hypot(dx, dy) / dt;
    if (speed > 1300 && Math.abs(dx) > Math.abs(dy) * 0.6) gust((speed - 1300) / 7000, dx > 0 ? 1 : -1);
  }
  drag.lt = t;
  drag.lx = x;
  drag.ly = y;
});
function endDrag(e: PointerEvent, cancelled: boolean) {
  if (!drag || e.pointerId !== drag.id) return;
  if (drag.kind === 'press' && !drag.done && !cancelled && drag.plant) water(drag.plant, clock(), drag.x, drag.y);
  if (drag.kind === 'can') can.held = false;
  if (drag.kind === 'cloud' && drag.cloud) {
    drag.cloud.held = false;
    drag.cloud.rainUntil = clock() + 5 * SPEED;
  }
  drag = null;
  const [x, y] = pt(e);
  updateCursor(x, y);
}
canvas.addEventListener('pointerup', (e) => endDrag(e, false));
canvas.addEventListener('pointercancel', (e) => endDrag(e, true));
canvas.addEventListener('pointerleave', () => {
  if (!drag) setHover(null);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// shaking the phone makes wind too
let lastShake = 0;
window.addEventListener('devicemotion', (e) => {
  const a = e.acceleration;
  if (!a || a.x == null || a.y == null) return;
  const m = Math.hypot(a.x, a.y, a.z ?? 0);
  const t = realNow();
  if (m > 14 && t - lastShake > 0.25) {
    lastShake = t;
    gust(Math.min(0.6, (m - 12) / 20), a.x > 0 ? 1 : -1);
  }
});

// ---------------- UI ----------------
const hint = document.getElementById('hint')!;
const toastEl = document.getElementById('toast')!;
let toastTimer = 0;
function toast(msg: string, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), ms);
}
const elGrown = document.getElementById('s-grown')!;
const elGen = document.getElementById('s-gen')!;
const elSeeds = document.getElementById('s-seeds')!;
const elPlants = document.getElementById('s-plants')!;
const elWorld = document.getElementById('s-world')!;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const resetLabel = resetBtn.querySelector('.content')!;
const frames = Array.from(document.querySelectorAll<SVGSVGElement>('.paper .frame'));
const TONES: Record<string, string> = { blue: '#8fb8d8', pink: '#e6a3b4', yellow: '#f2c64c', green: '#9cc27a' };
const bookBtn = document.getElementById('book-btn') as HTMLButtonElement;
const soundBtn = document.getElementById('sound-btn') as HTMLButtonElement;
const SOUND_KEY = 'crayon-garden-sound';
function setSound(on: boolean) {
  sound.setOn(on);
  soundBtn.setAttribute('aria-pressed', String(on));
  soundBtn.querySelector('.content')!.textContent = on ? 'sound on' : 'sound off';
  try {
    localStorage.setItem(SOUND_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
soundBtn.addEventListener('click', () => {
  setSound(!sound.on);
  if (sound.on) sound.chirp();
});
const book = new Book(
  document.getElementById('book')!,
  document.getElementById('book-grid')!,
  Array.from(document.querySelectorAll<HTMLElement>('.book-n')),
  document.getElementById('book-close')!,
);
bookBtn.addEventListener('click', () => {
  book.open(bookBtn);
  drawFrames(lastBoil < 0 ? 0 : lastBoil);
});
let resetArmed = 0;

function drawFrames(boil: number) {
  for (const [i, svg] of frames.entries()) {
    const r = svg.getBoundingClientRect();
    const w = r.width, h = r.height;
    if (!w || !h) continue;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const rs = rough.svg(svg);
    const owner = svg.parentElement as HTMLElement;
    const armed = owner.id === 'reset' && resetArmed > performance.now();
    const tone = owner.dataset.tone ?? 'blue';
    svg.appendChild(rs.rectangle(4, 4, w - 8, h - 8, {
      seed: hash(i + 1, boil), roughness: 1.5, stroke: '#2e2823', strokeWidth: 2,
      fill: armed ? '#f3c7c0' : '#fbf6e6', fillStyle: 'solid',
    }));
    if (tone !== 'plain')
      svg.appendChild(rs.rectangle(4, 4, w - 8, h - 8, {
        seed: hash(i + 7, boil), roughness: 1.2, stroke: 'none',
        fill: armed ? '#b5523b' : TONES[tone] ?? TONES.blue, fillStyle: 'hachure', hachureGap: 7, fillWeight: 1.2, hachureAngle: -60,
      }));
  }
}

let lastStats = '';
function updateStats() {
  const seeds = plants.filter((p) => p.stage === 0 && !p.anim).length + flying.filter((f) => f.state !== 'fade').length;
  const ws = `${world.season} · day ${((world.day - 1) % SEASON_DAYS) + 1} · ${world.light > 0.5 ? WEATHER_WORD[world.weather] : world.weather === 'sun' ? 'night' : WEATHER_WORD[world.weather] + ' night'}`;
  const s = `${stats.grown}|${stats.maxGen}|${seeds}|${plants.length}|${ws}`;
  if (s === lastStats) return;
  lastStats = s;
  elWorld.textContent = ws;
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
    sparks = [];
    bees = [];
    plucks = [];
    mole = null;
    butterflies = [];
    birds = [];
    snail = null;
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
interface SavedPlant {
  id: number; seed: number; xn: number; depth: number; gen: number; genome: Genome; stage: number; wilt: number;
  species?: Species; rare?: Rare | null; bloomed?: boolean; golden?: boolean;
}
function save() {
  const list: SavedPlant[] = plants.map((p) => {
    let stage = p.anim ? p.anim.to : p.pendingAt ? p.stage + stepOf(p.species, p.stage) : p.stage;
    if (stage >= 5 && (!p.burst || p.species === 'tree')) stage = 4; // seeds not released yet: keep the flower
    return {
      id: p.id, seed: p.seed, xn: p.xn, depth: p.depth, gen: p.gen, genome: p.genome, stage, wilt: stage >= 5 ? Math.max(0, p.wilt) : -1,
      species: p.species, rare: p.rare, bloomed: p.bloomed || stage >= 4, golden: p.golden,
    };
  });
  // seeds still in the air are saved as if they landed
  for (const f of flying) {
    if (f.state === 'fade' || list.length >= MAX_PLANTS) continue;
    if (!canSprout(f.tx, f.ty)) continue;
    list.push({ id: f.id, seed: hash(f.id, f.gen), xn: f.xn, depth: f.depth, gen: f.gen, genome: f.genome, stage: 0, wilt: -1, species: f.species, rare: f.rare, golden: f.golden });
  }
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 2, plants: list, stats: { ...stats, maxGen: Math.max(stats.maxGen, ...list.map((p) => p.gen)) }, nextId, hintDone, book: book.found, world: world.toJSON(), vase, vaseStyle, bouquets, tipIndex }));
  } catch {
    /* storage unavailable: keep playing without saving */
  }
  dirty = false;
}

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY) ?? localStorage.getItem(OLD_SAVE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || (d.v !== 1 && d.v !== 2) || !Array.isArray(d.plants)) return false;
    const r = mulberry32(12345);
    plants = d.plants.slice(0, MAX_PLANTS).map((s: SavedPlant) => {
      const species: Species = SPECIES.includes(s.species as Species) ? (s.species as Species) : 'daisy';
      const step = stepOf(species, 0);
      const stage = clamp(Math.round((+s.stage || 0) / step) * step, 0, 5);
      return makePlant({
        id: s.id, seed: s.seed | 0 || 1, xn: clamp(+s.xn || 0.5, 0, 1), depth: clamp(+s.depth || 0, 0, 1), gen: s.gen | 0 || 1,
        genome: sanitize(s.genome ?? {}, species, r), species, rare: s.rare ?? null, bloomed: !!s.bloomed, golden: !!s.golden,
        stage, wilt: stage >= 5 ? clamp(+s.wilt || 0, 0, 0.99) : -1,
      });
    });
    stats = { grown: d.stats?.grown | 0, maxGen: Math.max(1, d.stats?.maxGen | 0) };
    nextId = Math.max(d.nextId | 0, ...plants.map((p) => p.id + 1), 1);
    hintDone = !!d.hintDone;
    book.load(d.book);
    world.load(d.world);
    tipIndex = Math.max(0, d.tipIndex | 0);
    if (Array.isArray(d.vase))
      vase = d.vase
        .filter((v: Picked) => v && SPECIES.includes(v.sp) && v.gn)
        .slice(-VASE_MAX)
        .map((v: Picked) => ({ sp: v.sp, gn: sanitize(v.gn, v.sp, r), rare: v.rare ?? null }));
    vaseStyle = Math.abs(d.vaseStyle | 0) % VASES.length;
    if (Array.isArray(d.bouquets))
      bouquets = d.bouquets
        .filter((b: Bouquet) => b && Array.isArray(b.items))
        .slice(-MAX_BOUQUETS)
        .map((b: Bouquet) => ({
          style: Math.abs(b.style | 0) % VASES.length,
          items: b.items.filter((v) => v && SPECIES.includes(v.sp) && v.gn).slice(0, VASE_MAX).map((v) => ({ sp: v.sp, gn: sanitize(v.gn, v.sp, r), rare: v.rare ?? null })),
        }));
    book.setBouquets(bouquets);
    return plants.length > 0;
  } catch {
    return false;
  }
}

// ---------------- debug hook (?debug) ----------------
if (params.has('debug')) {
  (window as unknown as Record<string, unknown>).__garden = {
    plants: () => plants,
    bees: () => bees,
    clouds: () => clouds,
    fauna: () => ({ butterflies, birds, snail, mole }),
    rainbow() {
      rainbow = { t0: clock(), dur: 28, x: 0.5 };
    },
    star() {
      const x0 = W * 0.3, y0 = H * 0.1;
      shooting = { x0, y0, x1: x0 + W * 0.25, y1: y0 + W * 0.11, t0: clock(), gift: true };
    },
    mole() {
      moleAt = 0;
    },
    bird() {
      birdAt = 0;
    },
    snail() {
      snailAt = 0;
    },
    vase: () => vase,
    world,
    /** jump to a time of day (0 sunrise .. 0.6 sunset .. 1) */
    time(f: number) {
      world.t = Math.floor(world.t / DAY) * DAY + f * DAY;
    },
    weather(w: Weather) {
      world.weather = w;
      world.until = world.t + 60;
    },
    season(i: number) {
      const f = world.dayF;
      world.t = (i * SEASON_DAYS + 1 + f) * DAY;
    },
    clear() {
      plants = [];
      flying = [];
    },
    spawn(species: Species, stage = 4, xn = 0.5, depth = 0.4, rare: Rare | null = null) {
      const seed = (Math.random() * 1e9) | 0;
      const p = makePlant({ seed, xn, depth, gen: 1, genome: randomGenome(mulberry32(seed), species), species, rare, stage });
      p.nextAuto = Infinity;
      plants.push(p);
      return p;
    },
  };
}

// ---------------- boot ----------------
resize();
if (!load()) plants = [starterSeed()];
if (hintDone) hint.classList.add('hide');
try {
  if (localStorage.getItem(SOUND_KEY) === '1') setSound(true); // plays after the first tap
} catch {
  /* ignore */
}
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

let last = clock();
let lastBoil = -1;
const perf: number[] | null = params.has("debug") ? [] : null;
if (perf) (window as unknown as { __perf: number[] }).__perf = perf;
function frame(ms: number) {
  const now = (ms / 1000) * SPEED;
  const dt = Math.min(0.05 * SPEED, Math.max(0, now - last));
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
