import { smooth, clamp01, lerp } from './util';

/** Length of one day/night cycle, in seconds. */
export const DAY = 180;
/** Days per season. A full year is 4 seasons. */
export const SEASON_DAYS = 3;
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];
export type Weather = 'sun' | 'rain' | 'wind' | 'cloudy' | 'snow';

const CHANCES: Record<Season, [Weather, number][]> = {
  spring: [['sun', 0.35], ['rain', 0.35], ['wind', 0.15], ['cloudy', 0.15]],
  summer: [['sun', 0.55], ['rain', 0.15], ['wind', 0.15], ['cloudy', 0.15]],
  autumn: [['sun', 0.25], ['rain', 0.25], ['wind', 0.3], ['cloudy', 0.2]],
  winter: [['sun', 0.3], ['snow', 0.35], ['wind', 0.15], ['cloudy', 0.2]],
};
export const WEATHER_WORD: Record<Weather, string> = { sun: 'sunny', rain: 'rain', wind: 'windy', cloudy: 'cloudy', snow: 'snow' };

export interface WorldSave { t: number; weather: Weather; until: number; snow: number; }

/**
 * World clock, weather and seasons. Everything visual reads smoothed intensities (0..1) so
 * changes fade in instead of popping.
 */
export class World {
  t = DAY * 0.06; // start just after sunrise on the first day of spring
  weather: Weather = 'sun';
  until = 50; // world time of the next weather change
  rain = 0;
  cloud = 0;
  wind = 0;
  snowing = 0;
  snowCover = 0; // snow lying on the ground
  windDir = 1;
  gust = 0; // extra wind from the player dragging fast / shaking

  /** Advance; returns the previous weather if it changed this frame. */
  update(dt: number, rnd: () => number): Weather | null {
    this.t += dt;
    let changed: Weather | null = null;
    if (this.t >= this.until) {
      changed = this.weather;
      this.weather = this.pick(rnd);
      this.until = this.t + 50 + rnd() * 30;
      if (this.weather === 'wind') this.windDir = rnd() < 0.5 ? -1 : 1;
    }
    const k = Math.min(1, dt / 4); // ~4 s fades
    const w = this.weather;
    this.rain += ((w === 'rain' ? 1 : 0) - this.rain) * k;
    this.snowing += ((w === 'snow' ? 1 : 0) - this.snowing) * k;
    this.cloud += ((w === 'rain' || w === 'snow' ? 1 : w === 'cloudy' ? 0.8 : w === 'wind' ? 0.3 : 0) - this.cloud) * k;
    this.wind += ((w === 'wind' ? 1 : w === 'rain' ? 0.25 : 0) - this.wind) * k;
    this.gust = Math.max(0, this.gust - dt * 0.6);
    const cold = this.season === 'winter' ? 1 : 0;
    this.snowCover = clamp01(this.snowCover + dt * (this.snowing * cold * 0.03 - (1 - cold) * 0.02 - (this.light > 0.5 && w === 'sun' ? 0.004 : 0)));
    return changed;
  }

  private pick(rnd: () => number): Weather {
    const list = CHANCES[this.season].filter(([w]) => w !== this.weather);
    const total = list.reduce((s, [, p]) => s + p, 0);
    let x = rnd() * total;
    for (const [w, p] of list) if ((x -= p) <= 0) return w;
    return list[0][0];
  }

  /** 0..1 through the day: 0 sunrise, ~0.6 sunset, night until 1. */
  get dayF() {
    return (this.t / DAY) % 1;
  }
  get day() {
    return Math.floor(this.t / DAY) + 1;
  }
  /** Daylight 0..1. */
  get light() {
    const f = this.dayF;
    if (f < 0.3) return smooth(-0.04, 0.04, f);
    if (f < 0.8) return 1 - smooth(0.56, 0.64, f);
    return smooth(0.96, 1.04, f);
  }
  get night() {
    return 1 - this.light;
  }
  /** Sunrise/sunset glow 0..1. */
  get warm() {
    const f = this.dayF;
    return clamp01(Math.max(1 - Math.abs(f - 0.6) / 0.07, 1 - Math.min(f, 1 - f) / 0.07));
  }
  private get yearDays() {
    return this.t / DAY;
  }
  get seasonIndex() {
    return Math.floor(this.yearDays / SEASON_DAYS) % 4;
  }
  get season(): Season {
    return SEASONS[this.seasonIndex];
  }
  /** How strongly it is a given season right now, blending over the last half day of each. */
  seasonK(s: Season) {
    const d = this.yearDays % (SEASON_DAYS * 4);
    const i = SEASONS.indexOf(s);
    const start = i * SEASON_DAYS, end = start + SEASON_DAYS;
    const blend = 0.5;
    // handle wrap-around for spring (comes after winter)
    const dd = i === 0 && d > SEASON_DAYS * 3.5 ? d - SEASON_DAYS * 4 : d;
    return smooth(start - blend, start, dd) * (1 - smooth(end - blend, end, dd));
  }
  /** Autumn colour: builds up through autumn. */
  get autumnK() {
    const d = this.yearDays % (SEASON_DAYS * 4);
    return smooth(SEASON_DAYS * 2, SEASON_DAYS * 2.4, d) * (1 - smooth(SEASON_DAYS * 3 - 0.5, SEASON_DAYS * 3, d));
  }

  /** Sun position in CSS px, or null at night. */
  sunPos(W: number, H: number): [number, number] | null {
    let f = this.dayF;
    if (f > 0.9) f -= 1;
    const u = (f + 0.04) / 0.68;
    if (u < 0 || u > 1) return null;
    return [W * lerp(0.05, 0.95, u), arcY(u, H)];
  }
  moonPos(W: number, H: number): [number, number] | null {
    let f = this.dayF;
    if (f < 0.1) f += 1;
    const u = (f - 0.58) / 0.46;
    if (u < 0 || u > 1) return null;
    return [W * lerp(0.08, 0.92, u), arcY(u, H)];
  }

  toJSON(): WorldSave {
    return { t: this.t, weather: this.weather, until: this.until, snow: this.snowCover };
  }
  load(s: Partial<WorldSave> | undefined) {
    if (!s || typeof s.t !== 'number' || !isFinite(s.t)) return;
    this.t = Math.max(0, s.t);
    if (s.weather && s.weather in WEATHER_WORD) this.weather = s.weather;
    this.until = typeof s.until === 'number' && s.until > this.t ? s.until : this.t + 30;
    this.snowCover = clamp01(+(s.snow ?? 0) || 0);
    // start the smoothed values where they would have settled
    const w = this.weather;
    this.rain = w === 'rain' ? 1 : 0;
    this.snowing = w === 'snow' ? 1 : 0;
    this.cloud = w === 'rain' || w === 'snow' ? 1 : w === 'cloudy' ? 0.8 : w === 'wind' ? 0.3 : 0;
    this.wind = w === 'wind' ? 1 : w === 'rain' ? 0.25 : 0;
  }
}

function arcY(u: number, H: number) {
  const horizon = H * 0.62, top = Math.max(H * 0.1, 50);
  return horizon - Math.sin(Math.PI * u) * (horizon - top);
}
