import type { Genome } from './genome';
import { Species, Rare, SPECIES, RARES, variantName } from './species';
import { buildStructure, drawPlant, ENV0, Picked, vaseGroups, VASES } from './plant';
import { boundsOf, renderSprite, INK } from './crayon';

export interface Found {
  genome: Genome;
  seed: number;
}

const VARIANTS: (Rare | null)[] = [null, ...RARES];
const keyOf = (sp: Species, rare: Rare | null) => `${sp}|${rare ?? 'plain'}`;
export const BOOK_TOTAL = SPECIES.length * VARIANTS.length;
export interface Bouquet { items: Picked[]; style: number; }

/** The collection book: one crayon sketch per species/variant discovered, "?" for the rest. */
export class Book {
  found: Record<string, Found> = {};
  private cells: { sp: Species; rare: Rare | null; fig: HTMLElement; canvas: HTMLCanvasElement; drawn: string }[] = [];
  private queue: number[] = [];
  private returnFocus: HTMLElement | null = null;
  private bouquets: Bouquet[] = [];
  private shelfDrawn = '';

  constructor(
    private root: HTMLElement,
    private grid: HTMLElement,
    private countEls: HTMLElement[],
    private closeBtn: HTMLElement,
  ) {
    for (const sp of SPECIES)
      for (const rare of VARIANTS) {
        const fig = document.createElement('figure');
        fig.className = 'cell';
        const canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        const cap = document.createElement('figcaption');
        fig.append(canvas, cap);
        grid.appendChild(fig);
        this.cells.push({ sp, rare, fig, canvas, drawn: '' });
      }
    closeBtn.addEventListener('click', () => this.close());
    root.addEventListener('pointerdown', (e) => {
      if (e.target === root) this.close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    });
    this.updateCount();
  }

  get isOpen() {
    return !this.root.hidden;
  }
  get count() {
    return Object.keys(this.found).length;
  }

  has(sp: Species, rare: Rare | null) {
    return !!this.found[keyOf(sp, rare)];
  }

  /** Returns true when this is a new entry. */
  discover(sp: Species, rare: Rare | null, genome: Genome, seed: number): boolean {
    const k = keyOf(sp, rare);
    if (this.found[k]) return false;
    this.found[k] = { genome: { ...genome }, seed };
    this.updateCount();
    if (this.isOpen) this.refresh();
    return true;
  }

  load(data: unknown) {
    this.found = {};
    if (data && typeof data === 'object')
      for (const [k, v] of Object.entries(data as Record<string, Found>)) if (v && v.genome && typeof v.seed === 'number') this.found[k] = v;
    this.updateCount();
  }

  reset() {
    this.found = {};
    this.updateCount();
    for (const c of this.cells) c.drawn = '';
  }

  /** Finished vases, shown on a shelf at the bottom of the book. */
  setBouquets(list: Bouquet[]) {
    this.bouquets = list;
    if (this.isOpen) this.drawShelf();
  }

  private drawShelf() {
    const key = this.bouquets.map((b) => b.style + ':' + b.items.length).join(',');
    if (key === this.shelfDrawn) return;
    this.shelfDrawn = key;
    const shelf = document.getElementById('book-vases')!;
    if (!this.bouquets.length) return;
    shelf.textContent = '';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const b of this.bouquets) {
      const c = document.createElement('canvas');
      c.width = 84 * dpr;
      c.height = 100 * dpr;
      c.setAttribute('role', 'img');
      c.setAttribute('aria-label', `${VASES[b.style % VASES.length].name} with ${b.items.length} flowers`);
      const groups = vaseGroups(b.items, b.style);
      const [x0, y0, x1, y1] = boundsOf(groups, 6);
      const fit = Math.min(80 / (x1 - x0), 96 / (y1 - y0));
      const s = renderSprite(groups, fit, dpr, 7 + b.style, 0, 6);
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.drawImage(s.canvas, (84 - s.w) / 2, 98 - s.h, s.w, s.h);
      shelf.appendChild(c);
    }
  }

  open(from?: HTMLElement) {
    this.returnFocus = from ?? null;
    this.root.hidden = false;
    this.refresh();
    this.drawShelf();
    this.closeBtn.focus();
  }

  close() {
    this.root.hidden = true;
    this.returnFocus?.focus();
  }

  private updateCount() {
    for (const el of this.countEls) el.textContent = String(this.count);
    document.querySelectorAll('.book-total').forEach((el) => (el.textContent = String(BOOK_TOTAL)));
  }

  private refresh() {
    this.queue = [];
    this.cells.forEach((c, i) => {
      const f = this.found[keyOf(c.sp, c.rare)];
      const state = f ? 'y' + f.seed : 'n';
      c.fig.classList.toggle('unknown', !f);
      c.fig.querySelector('figcaption')!.textContent = f ? variantName(c.sp, c.rare) : '?';
      c.fig.setAttribute('aria-label', f ? variantName(c.sp, c.rare) : 'not found yet');
      if (c.drawn !== state) this.queue.push(i);
    });
    this.pump();
  }

  /** Draw one sketch per frame so opening the book stays smooth. */
  private pump = () => {
    if (!this.isOpen) return;
    const i = this.queue.shift();
    if (i === undefined) return;
    const c = this.cells[i];
    const f = this.found[keyOf(c.sp, c.rare)];
    sketch(c.canvas, c.sp, c.rare, f);
    c.drawn = f ? 'y' + f.seed : 'n';
    requestAnimationFrame(this.pump);
  };
}

const CW = 96, CH = 104;

function sketch(canvas: HTMLCanvasElement, sp: Species, rare: Rare | null, f: Found | undefined) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = CW * dpr;
  canvas.height = CH * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, CW, CH);
  if (!f) {
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.ellipse(CW / 2, CH / 2, 30, 32, 0.1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = INK;
    ctx.font = "700 44px Gaegu, 'Patrick Hand', cursive";
    ctx.textAlign = 'center';
    ctx.fillText('?', CW / 2, CH / 2 + 14);
    ctx.globalAlpha = 1;
    return;
  }
  const env = { ...ENV0, spring: sp === 'tree' ? 1 : 0 };
  const d = drawPlant({ sp, main: buildStructure(f.genome, f.seed, sp), gn: f.genome, seed: f.seed, g: 4, wilt: 0, rare, env });
  const [x0, y0, x1, y1] = boundsOf(d.groups, 6);
  // giants fill the frame; everything else is drawn a little smaller next to them
  const fit = Math.min((CW - 6) / (x1 - x0), (CH - 6) / (y1 - y0)) * (rare === 'giant' ? 1 : 0.86);
  const s = renderSprite(d.groups, fit, dpr, f.seed, 0, 6);
  const x = (CW - s.w) / 2, y = CH - 3 - s.h;
  if (rare === 'glow' && d.pod) {
    const gx = x - s.ox + d.pod[0] * fit, gy = y - s.oy + d.pod[1] * fit;
    const g = ctx.createRadialGradient(gx, gy, 2, gx, gy, 30);
    g.addColorStop(0, 'rgba(255,236,150,0.95)');
    g.addColorStop(1, 'rgba(255,236,150,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CW, CH);
  }
  ctx.drawImage(s.canvas, x, y, s.w, s.h);
}
