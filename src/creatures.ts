import { Group, Shape, Pt, INK, ellipsePts, leafPts } from './crayon';

/*
 * Little living things, drawn in the same crayon style as the plants.
 * Each function returns one animation frame; frames are cached by the SpriteBank and swapped
 * a few times a second, which together with the boil gives the wobbly hand-drawn motion.
 * All creatures face right; the renderer mirrors them.
 */

const wing = (cx: number, cy: number, rx: number, ry: number, rot: number): Shape => ({
  kind: 'poly', pts: ellipsePts(cx, cy, rx, ry, rot, 10), fill: '#cfe3f0', base: '#ffffff', fa: 0.7, gap: 2.4, weight: 1, stroke: '#5b7d99', sw: 1.2,
});

export function beeGroups(frame: number): Group[] {
  const up = frame % 2 === 0;
  const body = ellipsePts(0, 0, 8, 5.6, 0, 14);
  return [
    { shapes: [wing(-1, -6, 5, 3, up ? -0.9 : -0.3), wing(2, -6, 4.4, 2.6, up ? -0.4 : 0.15)] },
    {
      shapes: [
        { kind: 'poly', pts: body, fill: '#f2c64c', fa: 0.6, gap: 1.6, weight: 1.3, stroke: INK, sw: 1.6 },
        { kind: 'curve', pts: [[-2.5, -5.2], [-1.8, 0], [-2.5, 5.2]], stroke: INK, sw: 2.2, rough: 0.4 },
        { kind: 'curve', pts: [[1.8, -5.4], [2.4, 0], [1.8, 5.4]], stroke: INK, sw: 2.2, rough: 0.4 },
        { kind: 'poly', pts: ellipsePts(8.5, -0.5, 3.4, 3.2, 0, 9), fill: INK, fa: 0.8, gap: 1 },
        { kind: 'line', pts: [[-8, 0.5], [-11, 1]], stroke: INK, sw: 1.4, rough: 0.2 },
        { kind: 'curve', pts: [[10, -3], [12, -6.5], [13.5, -7]], stroke: INK, sw: 1, rough: 0.2 },
      ],
    },
  ];
}

export function butterflyGroups(frame: number, color: string): Group[] {
  // 0 open, 1 half, 2 closed
  const k = [1, 0.55, 0.15][frame % 3];
  const w = (sx: number, sy: number, rx: number, ry: number, rot: number): Shape => ({
    kind: 'poly', pts: ellipsePts(sx, sy, rx, ry * k, rot, 12), fill: color, fa: 0.5, gap: 1.8, weight: 1.3, stroke: INK, sw: 1.4,
  });
  return [
    { shapes: [w(-3, -6 * k, 7, 9, -0.5), w(-3, 4 * k, 5, 6, 0.6)] },
    {
      shapes: [
        { kind: 'poly', pts: ellipsePts(0, 0, 6, 1.8, 0, 10), fill: INK, fa: 0.8, gap: 1 },
        { kind: 'curve', pts: [[5, -1], [8, -5], [9, -6]], stroke: INK, sw: 1, rough: 0.2 },
        { kind: 'curve', pts: [[5, -1], [9, -3.5], [10.5, -4]], stroke: INK, sw: 1, rough: 0.2 },
        ...(k > 0.3 ? [{ kind: 'poly', pts: ellipsePts(-3, -7 * k, 2, 2 * k, 0, 7), fill: '#ffffff', fa: 0.8, gap: 1 } as Shape] : []),
      ],
    },
  ];
}

export function snailGroups(frame: number): Group[] {
  const stretch = frame % 2 ? 1.5 : 0;
  const shell: Pt[] = [];
  for (let i = 0; i <= 26; i++) {
    const a = (i / 26) * Math.PI * 4.2;
    const r = 1 + (i / 26) * 8.5;
    shell.push([-1 + Math.cos(a) * r, -9 + Math.sin(a) * r]);
  }
  return [
    {
      shapes: [
        { kind: 'poly', pts: [[-12 - stretch, 0], [-6, -3], [10, -3], [14 + stretch, -6], [16 + stretch, -2], [12 + stretch, 0]], fill: '#c8b39a', fa: 0.6, gap: 1.6, stroke: INK, sw: 1.5 },
        { kind: 'curve', pts: [[12 + stretch, -5], [13 + stretch, -10], [14 + stretch, -12]], stroke: INK, sw: 1.2, rough: 0.2 },
        { kind: 'curve', pts: [[14.5 + stretch, -5], [17 + stretch, -9], [18 + stretch, -11]], stroke: INK, sw: 1.2, rough: 0.2 },
      ],
    },
    {
      shapes: [
        { kind: 'poly', pts: ellipsePts(-1, -9, 9.5, 9, 0, 14), fill: '#b5763f', fa: 0.55, gap: 1.8, weight: 1.3, stroke: INK, sw: 1.7 },
        { kind: 'curve', pts: shell.slice(4), stroke: '#6b4529', sw: 1.4, rough: 0.4 },
      ],
    },
  ];
}

/** frame: 0/1 flying (wings up/down), 2 standing, 3 pecking */
export function birdGroups(frame: number, color: string): Group[] {
  const fly = frame < 2;
  const head: Pt = frame === 3 ? [8, 2] : [8, -6];
  const out: Shape[] = [
    { kind: 'poly', pts: ellipsePts(0, -2, 9, 6, frame === 3 ? 0.35 : 0, 14), fill: color, fa: 0.55, gap: 1.8, weight: 1.3, stroke: INK, sw: 1.6 },
    { kind: 'poly', pts: ellipsePts(head[0], head[1], 4.6, 4.3, 0, 10), fill: color, fa: 0.55, gap: 1.6, stroke: INK, sw: 1.5 },
    { kind: 'poly', pts: [[head[0] + 4, head[1] - 1], [head[0] + 8.5, head[1] + 0.8], [head[0] + 4, head[1] + 1.8]], fill: '#e3a530', fa: 0.8, gap: 1, stroke: INK, sw: 1.1 },
    { kind: 'poly', pts: ellipsePts(head[0] + 1.5, head[1] - 1.2, 0.9, 0.9, 0, 6), fill: INK, fa: 1, gap: 1 },
    { kind: 'poly', pts: [[-8, -4], [-15, -7], [-14, -1], [-8, 0]], fill: color, fa: 0.5, gap: 1.6, stroke: INK, sw: 1.4 },
  ];
  if (fly) {
    const up = frame === 0;
    out.push({ kind: 'poly', pts: leafPts(-1, -4, up ? -0.5 : -2.6, 13, 4.5, 0.8, 0, 7), fill: color, fa: 0.5, gap: 1.6, stroke: INK, sw: 1.5 });
  } else {
    out.push({ kind: 'poly', pts: leafPts(-4, -3, -1.75, 10, 3.6, 0.8, 0, 6), fill: color, fa: 0.5, gap: 1.6, stroke: INK, sw: 1.4 });
    out.push({ kind: 'line', pts: [[-1, 3.5], [-2, 9]], stroke: '#c0752a', sw: 1.4, rough: 0.2 });
    out.push({ kind: 'line', pts: [[2, 3.5], [2.5, 9]], stroke: '#c0752a', sw: 1.4, rough: 0.2 });
  }
  return [{ shapes: out }];
}

export function moleGroups(): Group[] {
  return [
    {
      shapes: [
        { kind: 'poly', pts: ellipsePts(0, -8, 11, 10, 0, 14), fill: '#6d5d55', fa: 0.6, gap: 1.8, weight: 1.4, stroke: INK, sw: 1.8 },
        { kind: 'poly', pts: ellipsePts(0, -5, 3.2, 2.6, 0, 8), fill: '#e6a3b4', fa: 0.8, gap: 1.2, stroke: INK, sw: 1.3 },
        { kind: 'line', pts: [[-4.5, -11], [-3, -10.5]], stroke: INK, sw: 1.8, rough: 0.2 },
        { kind: 'line', pts: [[4.5, -11], [3, -10.5]], stroke: INK, sw: 1.8, rough: 0.2 },
        { kind: 'line', pts: [[-3.5, -4.5], [-9, -6]], stroke: INK, sw: 0.9, rough: 0.2 },
        { kind: 'line', pts: [[3.5, -4.5], [9, -6]], stroke: INK, sw: 0.9, rough: 0.2 },
        { kind: 'poly', pts: ellipsePts(-9, 0, 4, 2.4, -0.3, 8), fill: '#e6a3b4', fa: 0.7, gap: 1.2, stroke: INK, sw: 1.3 },
        { kind: 'poly', pts: ellipsePts(9, 0, 4, 2.4, 0.3, 8), fill: '#e6a3b4', fa: 0.7, gap: 1.2, stroke: INK, sw: 1.3 },
      ],
    },
  ];
}

export function moundGroups(): Group[] {
  const pts: Pt[] = [[-16, 2], [-10, -4], [-3, -6.5], [4, -6], [11, -3.5], [16, 2]];
  return [{ shapes: [{ kind: 'poly', pts, fill: '#8f6240', fa: 0.55, gap: 2, stroke: '#6b4529', sw: 1.8 }] }];
}
