// Piringan Hitam: a record rising from the bottom of the screen, spinning at a true 33⅓ rpm, with
// the lyrics curving along its grooves.
//
// The tonearm tells the time: like a real record, the song runs from the outer edge inwards, so
// the needle travels from the rim towards the label over the length of the song. The line being
// sung always sits on the groove under the needle; lines already sung lie on the outer grooves,
// the next ones on the inner grooves, and everything slides inwards as the song goes on. Drag the
// arm to move through the song (the needle lifts, a bubble shows the time, the lyrics follow);
// click the label to pause (the platter slows to a stop).
//
// Realism: the label is the song's cover and visibly turns; the vinyl is tinted from the cover;
// the light's reflections stay still while the record turns under them, as real reflections do;
// the arm lifts, travels and lowers on song changes and seeks; spin-up and spin-down take time.
//
// Cost: the room, the disc, its grooves and its reflections are painted once into a buffer; each
// frame only copies that and draws the turning label, the lyrics and the arm.

import type { AudioFrame } from '../audio';
import { send, trackKey, trackPosition, type LyricLine, type Track } from '../bridge';
import { VINYL_DEFAULTS, fitCanvas, hexToRgb, resolvePalette, withDefaults, type VinylOptions, type WidgetContext, type WidgetModule, type WidgetState } from './types';
import { BUSY_RATE, VocalOnsets, WordGate, estimateWords } from './word-gate';
import { AlbumSky, ICON_NEXT, ICON_PAUSE, ICON_PLAY, ICON_PREV, ICON_VINYL, clock, createAmbienceShell, lineAt, saveSongShift, songShift } from './ambience';

const RPM = 100 / 3;                         // 33⅓
const OMEGA = (RPM / 60) * Math.PI * 2;      // rad/s at full speed
const SERIF = '"Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif';

interface Geometry {
  W: number; H: number;
  cx: number; cy: number;   // record centre (just below the screen)
  R: number;                // record radius
  rLabel: number;           // paper label
  rIn: number; rOut: number; // last and first groove = where the needle ends and starts
  rRest: number;            // the arm's rest, just off the record
  px: number; py: number;   // arm pivot
  L: number;                // pivot → needle tip
  k: number;                // scale: 1 at a 1200 px record
}

interface Glyph { ch: string; w: number; word: number }

export function createVinyl(ctx: WidgetContext): WidgetModule {
  const canvas = document.createElement('canvas');
  canvas.className = 'star__canvas';
  const screen = canvas.getContext('2d')!;
  // The lyrics and the arm are drawn into their own layer, redrawn only when they actually change
  // (the needle crawls a pixel every few tenths of a second); the drawing helpers below draw on `g`,
  // which points at whichever surface is being painted.
  const overlay = document.createElement('canvas');
  const overlayCtx = overlay.getContext('2d')!;
  let overlayKey = '';
  let g = screen;

  // ---------------------------------------------------------------- top-left: song, artist, album, time

  const info = document.createElement('div');
  info.className = 'vinyl__info';
  info.dataset.nodrag = '';
  info.innerHTML = `
    <div class="vinyl__title"></div>
    <div class="vinyl__sub"></div>
    <div class="vinyl__time"></div>
    <div class="vinyl__controls">
      <button type="button" data-cmd="previous" aria-label="Lagu sebelumnya">${ICON_PREV}</button>
      <button type="button" data-cmd="toggle" class="vinyl__play" aria-label="Putar/jeda">${ICON_PLAY}</button>
      <button type="button" data-cmd="next" aria-label="Lagu berikutnya">${ICON_NEXT}</button>
    </div>`;
  const titleEl = info.querySelector<HTMLElement>('.vinyl__title')!;
  const subEl = info.querySelector<HTMLElement>('.vinyl__sub')!;
  const timeEl = info.querySelector<HTMLElement>('.vinyl__time')!;
  const btn = (cmd: string) => info.querySelector<HTMLButtonElement>(`[data-cmd="${cmd}"]`)!;
  ctx.stage.append(canvas, info);
  info.querySelector('.vinyl__controls')!.addEventListener('click', (e) => {
    const cmd = (e.target as HTMLElement).closest('button')?.dataset.cmd;
    if (cmd === 'toggle' || cmd === 'next' || cmd === 'previous') send({ type: 'media', command: cmd });
  });

  // ---------------------------------------------------------------- state

  let opts: VinylOptions = VINYL_DEFAULTS;
  let track: Track | null = null;
  let lines: LyricLine[] = [];
  let lyricsNote = '';
  let offset = 0;
  let palette: string[] = [];
  let accent: [number, number, number] = [210, 170, 120];
  let key = '';
  let index = -2;
  let shift = 0;
  const onsets = new VocalOnsets();
  let gate = new WordGate(220, 500);
  let words: { at: number; sung: boolean }[] = [];
  let lineShown = 0;        // float index of the line on the needle's groove (slides on line changes)

  // Motion
  let angle = 0;            // platter rotation (rad)
  let omega = 0;            // current speed (rad/s)
  let armR = -1;            // radius where the needle is now (−1 = not placed yet)
  let lift = 1;             // 0 = needle down, 1 = lifted
  let dragging = false;
  let dragR = 0;
  let hoverArm = false;
  let labelPress: { x: number; y: number } | null = null;
  let held: { ms: number; at: number; key: string } | null = null;
  let lastFrame = 0;
  let lastReport = 0;
  let dirty = true;
  let awakeUntil = 0;

  const sky = new AlbumSky();
  const base = document.createElement('canvas'); // room + disc + grooves + reflections
  let baseKey = '';
  let geo: Geometry | null = null;
  const widths = new Map<string, number>();

  const shell = createAmbienceShell(ctx, {
    name: 'Piringan Hitam',
    icon: ICON_VINYL,
    areas: () => (opts.info && track ? [info] : []),
    extraRects: () => armRects(),
    onShift: (step) => {
      if (!key) return;
      shift = Math.max(-3000, Math.min(3000, shift + step));
      saveSongShift(key, shift);
      index = -2;
      shell.paintShift(shift);
    },
  });

  function resize(): void {
    const w = ctx.root.clientWidth, h = ctx.root.clientHeight;
    info.style.fontSize = `${Math.max(5, Math.min(w, h) / 50)}px`;
    dirty = true;
    requestAnimationFrame(() => shell.report());
  }
  new ResizeObserver(resize).observe(ctx.root);
  resize();

  // ---------------------------------------------------------------- geometry

  function geometry(W: number, H: number): Geometry {
    const R = Math.min(H * 0.86, W * 0.49);
    const cx = W / 2, cy = H + R * 0.08;
    // The pivot sits by the record's right edge (kept on screen, base and counterweight visible),
    // at about the label's height; the arm's length is chosen so the needle meets the last groove
    // 45° right of the top.
    const k = R / 1200;
    let px = Math.min(cx + R * 1.02, W - 185 * k), py = cy - R * 0.56;
    // The base plate stands beside the record, never on it: raise the pivot until it clears the rim.
    while (Math.hypot(px - cx, py - cy) < R + 112 * k && py > cy - R * 0.95) py -= 8 * k;
    const rIn = R * 0.4;
    const nx = cx + rIn * Math.SQRT1_2, ny = cy - rIn * Math.SQRT1_2;
    return {
      W, H, cx, cy, R, rLabel: R * 0.33, rIn, rOut: R * 0.955, rRest: R * 1.045,
      px, py, L: Math.hypot(px - nx, py - ny), k,
    };
  }

  /** Where the needle is when it sits on radius r (the arm is rigid; it swings around its pivot). */
  function needleAt(r: number): { x: number; y: number } {
    const G = geo!;
    const dx = G.cx - G.px, dy = G.cy - G.py, d = Math.hypot(dx, dy);
    const cos = Math.max(-1, Math.min(1, (d * d + G.L * G.L - r * r) / (2 * d * G.L)));
    const phi = Math.acos(cos), base0 = Math.atan2(dy, dx);
    const a1 = base0 + phi, a2 = base0 - phi;
    const p1 = { x: G.px + G.L * Math.cos(a1), y: G.py + G.L * Math.sin(a1) };
    const p2 = { x: G.px + G.L * Math.cos(a2), y: G.py + G.L * Math.sin(a2) };
    return p1.y < p2.y ? p1 : p2; // the upper solution: over the visible part of the record
  }

  function radiusFor(progress: number): number {
    const G = geo!;
    return G.rOut - (G.rOut - G.rIn) * Math.min(1, Math.max(0, progress));
  }

  function progressFor(r: number): number {
    const G = geo!;
    return Math.min(1, Math.max(0, (G.rOut - r) / (G.rOut - G.rIn)));
  }

  // ---------------------------------------------------------------- the still part: room, disc, light

  function vinylColor(): [number, number, number] {
    const black: [number, number, number] = [11, 11, 13];
    if (!opts.colored || !palette.length) return black;
    // The cover's main colour, deepened like pressed coloured vinyl: nearly black in the shade,
    // the colour showing where the lamp catches it, and dark enough for white lyrics on top.
    // Grey or washed-out covers simply get black vinyl (a "grey record" looks like plastic).
    const [r, gg, b] = hexToRgb(palette[0]);
    const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
    if (max === 0 || (max - min) / max < 0.22) return black;
    const scale = 30 / max;
    return [Math.round(r * scale + 8), Math.round(gg * scale + 8), Math.round(b * scale + 10)];
  }

  function paintBase(G: Geometry, t: number): void {
    const { W, H, cx, cy, R, k } = G;
    if (base.width !== W || base.height !== H) { base.width = W; base.height = H; }
    const b = base.getContext('2d')!;
    b.clearRect(0, 0, W, H);
    sky.draw(b, t);

    // A warm lamp above the record.
    const lamp = b.createRadialGradient(cx - R * 0.25, cy - R * 1.25, 0, cx - R * 0.25, cy - R * 1.25, R * 1.5);
    lamp.addColorStop(0, 'rgba(255, 226, 180, 0.16)');
    lamp.addColorStop(1, 'rgba(255, 226, 180, 0)');
    b.fillStyle = lamp;
    b.fillRect(0, 0, W, H);

    // The record's shadow on the surface below it.
    b.save();
    b.shadowColor = 'rgba(0,0,0,0.65)';
    b.shadowBlur = 60 * k;
    b.shadowOffsetY = 18 * k;
    b.fillStyle = 'rgba(0,0,0,0.6)';
    b.beginPath(); b.arc(cx, cy, R, 0, Math.PI * 2); b.fill();
    b.restore();

    // The disc: vinyl tinted from the cover, a touch translucent.
    const [vr, vg, vb] = vinylColor();
    const disc = b.createRadialGradient(cx, cy, G.rLabel, cx, cy, R);
    disc.addColorStop(0, `rgb(${vr + 6},${vg + 6},${vb + 6})`);
    disc.addColorStop(1, `rgb(${vr},${vg},${vb})`);
    b.fillStyle = disc;
    b.beginPath(); b.arc(cx, cy, R, 0, Math.PI * 2); b.fill();

    // Grooves: fine alternating rings, with a couple of smooth gaps between "tracks".
    const step = Math.max(1.6, 2.4 * k);
    const gaps = [0.62, 0.79].map((f) => R * f);
    b.lineWidth = Math.max(0.6, 0.8 * k);
    let n = 0;
    for (let r = G.rIn; r <= G.rOut; r += step, n++) {
      if (gaps.some((gR) => Math.abs(r - gR) < 5 * k)) continue;
      b.strokeStyle = n % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.22)';
      b.beginPath(); b.arc(cx, cy, r, Math.PI, Math.PI * 2); b.stroke();
    }
    // Dead wax around the label: smoother and a little glossier.
    b.fillStyle = 'rgba(255,255,255,0.025)';
    b.beginPath(); b.arc(cx, cy, G.rIn - 2 * k, 0, Math.PI * 2); b.arc(cx, cy, G.rLabel, 0, Math.PI * 2, true); b.fill();

    // The lamp's reflection: two soft lobes that stay put while the record turns.
    b.save();
    b.beginPath(); b.arc(cx, cy, R - 2 * k, 0, Math.PI * 2); b.arc(cx, cy, G.rLabel + 4 * k, 0, Math.PI * 2, true); b.clip();
    const sheen = b.createConicGradient(-Math.PI / 2, cx, cy);
    const lobe = (at: number, a: number) => {
      sheen.addColorStop(Math.max(0, at - 0.07), 'rgba(255,240,220,0)');
      sheen.addColorStop(at, `rgba(255,240,220,${a})`);
      sheen.addColorStop(Math.min(1, at + 0.07), 'rgba(255,240,220,0)');
    };
    sheen.addColorStop(0, 'rgba(255,240,220,0)');
    lobe(0.875, 0.2);   // upper left, facing the lamp
    lobe(0.375, 0.09);  // its weaker opposite
    sheen.addColorStop(1, 'rgba(255,240,220,0)');
    b.fillStyle = sheen;
    b.fillRect(cx - R, cy - R, R * 2, R * 2);
    // A narrower, brighter streak inside the main lobe: the lamp's own reflection in the grooves.
    const streak = b.createConicGradient(-Math.PI / 2, cx, cy);
    streak.addColorStop(0, 'rgba(255,245,230,0)');
    streak.addColorStop(0.855, 'rgba(255,245,230,0)');
    streak.addColorStop(0.872, 'rgba(255,245,230,0.16)');
    streak.addColorStop(0.889, 'rgba(255,245,230,0)');
    streak.addColorStop(1, 'rgba(255,245,230,0)');
    b.fillStyle = streak;
    b.fillRect(cx - R, cy - R, R * 2, R * 2);
    b.restore();

    // The rim catches the light.
    b.strokeStyle = 'rgba(255,255,255,0.10)';
    b.lineWidth = Math.max(1, 1.5 * k);
    b.beginPath(); b.arc(cx, cy, R - 0.5, Math.PI, Math.PI * 2); b.stroke();
  }

  // ---------------------------------------------------------------- the turning label

  function drawLabel(G: Geometry): void {
    const { cx, cy, rLabel, k } = G;
    g.save();
    g.translate(cx, cy);
    g.rotate(angle);
    g.beginPath(); g.arc(0, 0, rLabel, 0, Math.PI * 2); g.clip();
    const cover = sky.cover;
    if (cover) {
      const s = (rLabel * 2) / Math.min(cover.naturalWidth, cover.naturalHeight);
      g.drawImage(cover, -cover.naturalWidth * s / 2, -cover.naturalHeight * s / 2, cover.naturalWidth * s, cover.naturalHeight * s);
    } else {
      const [ar, ag, ab] = accent;
      g.fillStyle = `rgb(${ar},${ag},${ab})`;
      g.fillRect(-rLabel, -rLabel, rLabel * 2, rLabel * 2);
    }
    // Paper texture: a faint printed ring, so the turning reads even on plain covers.
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 2 * k;
    g.beginPath(); g.arc(0, 0, rLabel * 0.86, -0.4, 1.9); g.stroke();
    g.restore();
    // Label edge and spindle (these don't need turning).
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 3 * k;
    g.beginPath(); g.arc(cx, cy, rLabel, 0, Math.PI * 2); g.stroke();
    const sp = g.createRadialGradient(cx - 3 * k, cy - 3 * k, 0, cx, cy, 11 * k);
    sp.addColorStop(0, '#f2f2f2'); sp.addColorStop(1, '#6d6d72');
    g.fillStyle = sp;
    g.beginPath(); g.arc(cx, cy, 10 * k, 0, Math.PI * 2); g.fill();
  }

  // ---------------------------------------------------------------- lyrics on the grooves

  function glyphs(text: string, font: string): Glyph[] {
    g.font = font;
    const out: Glyph[] = [];
    let word = 0, inWord = false;
    for (const ch of text) {
      const space = /\s/.test(ch);
      if (!space && !inWord && out.length) word++;
      inWord = !space;
      const id = `${font}|${ch}`;
      let w = widths.get(id);
      if (w === undefined) { w = g.measureText(ch).width; widths.set(id, w); }
      out.push({ ch, w, word });
    }
    return out;
  }

  /**
   * Draws text along the circle of radius r, letters upright along the curve. With `end` (an angle
   * from the top, + = right) the line ends there, just short of the needle, so the lyrics run
   * along the groove into the needle and never under the arm; without it the line is centred.
   */
  function arcText(G: Geometry, text: string, r: number, size: number, alpha: number, sungUpTo: number, end?: number): void {
    // How far round this groove is still on screen (above its bottom edge, inside its sides).
    const half = Math.min(
      Math.acos(Math.max(-1, Math.min(1, (G.cy - G.H + 30 * G.k) / r))),
      Math.asin(Math.min(1, (G.W / 2 - 40 * G.k) / r)),
      1.35,
    );
    const room = (end === undefined ? 2 * half : Math.max(0.2, end + half)) * r * 0.97;
    let font = `${size}px ${SERIF}`;
    let gl = glyphs(text, font);
    const sum = (list: Glyph[]) => list.reduce((s, x) => s + x.w, 0);
    let total = sum(gl);
    if (total > room) {
      // Too long for this groove: shrink (down to 62%), then cut with an ellipsis if still needed.
      font = `${size * Math.max(0.62, room / total)}px ${SERIF}`;
      gl = glyphs(text, font);
      total = sum(gl);
      if (total > room) {
        const ell = glyphs('…', font)[0];
        while (gl.length > 1 && total + ell.w > room) total -= gl.pop()!.w;
        gl.push({ ...ell, word: Infinity });
        total += ell.w;
      }
    }
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let acc = end === undefined ? -total / 2 : end * r - total;
    const [ar, ag, ab] = accent;
    for (const x of gl) {
      const a = (acc + x.w / 2) / r;
      acc += x.w;
      if (x.ch === ' ') continue;
      const sung = x.word <= sungUpTo;
      const px = G.cx + r * Math.sin(a), py = G.cy - r * Math.cos(a);
      g.save();
      g.translate(px, py);
      g.rotate(a);
      if (sungUpTo >= 0 && sung) {
        g.shadowColor = `rgba(${ar},${ag},${ab},${0.75 * alpha})`;
        g.shadowBlur = 16 * G.k;
      }
      g.fillStyle = `rgba(255,248,238,${alpha * (sungUpTo < 0 || sung ? 1 : 0.42)})`;
      g.fillText(x.ch, 0, 0);
      g.restore();
    }
  }

  function drawLyrics(G: Geometry, needleR: number): void {
    const big = G.R * 0.043 * opts.size, small = big * 0.6, gap = big * 1.6;
    if (!track) return;
    // Every line ends a little before the needle's angle: the lyrics flow along the groove into
    // the needle. (The arm only ever lies further right than its own tip, so nothing is covered.)
    const n = needleAt(needleR);
    const tip = Math.atan2(n.x - G.cx, G.cy - n.y);
    const endAt = (r: number, size: number) => tip - (34 * G.k + size * 0.5) / r;
    if (!lines.length) {
      // No timed lyrics: the song's name runs along the groove into the needle.
      arcText(G, `${track.title} — ${track.artist}`, needleR, big * 0.8, 0.85, -1, endAt(needleR, big * 0.8));
      if (lyricsNote) arcText(G, lyricsNote, needleR - gap * 0.9, small * 0.85, 0.35, -1, endAt(needleR - gap * 0.9, small));
      return;
    }
    const from = Math.floor(lineShown) - 3, to = Math.ceil(lineShown) + 3;
    for (let i = from; i <= to; i++) {
      const d = lineShown - i;                  // + = already sung (outer), − = still to come (inner)
      const r = needleR + d * gap;
      // Only on the grooved part: no lyrics on the smooth run-out around the label, or past the rim.
      if (r < G.rIn - gap * 0.25 || r > G.R * 0.985) continue;
      const ad = Math.abs(d);
      const near = Math.max(0, 1 - ad);
      const alpha = ad < 0.5 ? 1 : d > 0 ? Math.max(0.07, 0.5 - (ad - 1) * 0.2) : Math.max(0.05, 0.34 - (ad - 1) * 0.13);
      const size = small + (big - small) * near;
      let text: string;
      if (i < 0) text = i === -1 ? `${track.title}` : '';
      else if (i >= lines.length) text = '';
      else text = lines[i].text.trim() || '♪';
      if (!text) continue;
      // The line being sung lights up word by word; the others are drawn plain.
      let sungUpTo = -1;
      if (i === index && i >= 0 && words.length) for (let w = 0; w < words.length; w++) if (words[w].sung) sungUpTo = w;
      arcText(G, text, r, size, alpha, i === index && i >= 0 && words.length ? sungUpTo : -1, endAt(r, size));
    }
  }

  // ---------------------------------------------------------------- the tonearm
  //
  // Built like a classic S-arm deck: a round base plate with a chrome rim and an anti-skate dial,
  // the arm rest and the cue lever beside it, a gimballed bearing, an S-shaped chrome tube, a
  // knurled counterweight with its scale ring, and a headshell with finger lift, cartridge and
  // stylus. Lit from the upper left like the rest of the scene; its shadow drifts off as it lifts.

  /** A chrome cylinder seen from the side, in the current (rotated) frame: x from x0 to x1, radius h. */
  function cylinder(x0: number, x1: number, h: number, round = 0.2): void {
    const gr = g.createLinearGradient(0, -h, 0, h);
    gr.addColorStop(0, '#55555b');
    gr.addColorStop(0.16, '#f4f4f6');
    gr.addColorStop(0.34, '#b4b4ba');
    gr.addColorStop(0.68, '#55555b');
    gr.addColorStop(1, '#232327');
    g.fillStyle = gr;
    g.beginPath(); g.roundRect(x0, -h, x1 - x0, h * 2, h * round); g.fill();
  }

  /** Chrome tubing along a path: dark core, body, and a bright streak towards the lamp. */
  function chrome(path: Path2D, w: number): void {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#26262a'; g.lineWidth = w; g.stroke(path);
    g.strokeStyle = '#86868c'; g.lineWidth = w * 0.8; g.stroke(path);
    g.save();
    g.translate(-w * 0.1, -w * 0.17);
    g.strokeStyle = '#c8c8cd'; g.lineWidth = w * 0.42; g.stroke(path);
    g.translate(-w * 0.04, -w * 0.07);
    g.strokeStyle = 'rgba(255,255,255,0.92)'; g.lineWidth = Math.max(1, w * 0.13); g.stroke(path);
    g.restore();
    g.save();
    g.translate(w * 0.15, w * 0.22);
    g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = Math.max(1, w * 0.12); g.stroke(path);
    g.restore();
  }

  function drawArm(G: Geometry, r: number): void {
    const { px, py, k } = G;
    const n = needleAt(r);
    const dir = Math.atan2(n.y - py, n.x - px);
    const headLen = 118 * k, offsetA = 0.4;                 // the headshell's offset angle
    const hdir = dir + offsetA;
    const hx = n.x - Math.cos(hdir) * headLen, hy = n.y - Math.sin(hdir) * headLen;
    const up = -lift * 7 * k;                              // the arm rises a little when lifted

    // The parked arm's direction (the cue lever sits beside it). There's no deck surface in this
    // scene, so no separate arm-rest post: on its own it would float in the air.
    const rest = needleAt(G.rRest);
    const rd = Math.atan2(rest.y - py, rest.x - px);

    // The S-shaped tube, from the bearing to the headshell collar.
    const sx = px + Math.cos(dir) * 44 * k, sy = py + Math.sin(dir) * 44 * k;
    const ax = hx - sx, ay = hy - sy, alen = Math.hypot(ax, ay) || 1;
    const nxp = -ay / alen, nyp = ax / alen, bend = alen * 0.055;
    const tube = new Path2D();
    tube.moveTo(sx, sy + up);
    tube.bezierCurveTo(sx + ax * 0.32 + nxp * bend, sy + ay * 0.32 + nyp * bend + up,
      sx + ax * 0.7 - nxp * bend, sy + ay * 0.7 - nyp * bend + up, hx, hy + up);

    // ---- shadows (one soft pass; further away while lifted)
    const sh = (18 + 28 * lift) * k;
    g.save();
    g.filter = `blur(${Math.round((7 + 10 * lift) * k)}px)`;
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.beginPath(); g.arc(px + 10 * k, py + 16 * k, 98 * k, 0, Math.PI * 2); g.fill();
    g.translate(sh * 0.6, sh);
    g.lineCap = 'round';
    g.lineWidth = 18 * k; g.stroke(tube);
    g.save(); g.translate(px, py + up); g.rotate(dir + Math.PI); g.fillRect(40 * k, -30 * k, 108 * k, 60 * k); g.restore();
    g.save(); g.translate(hx, hy + up); g.rotate(hdir); g.fillRect(-10 * k, -24 * k, headLen + 8 * k, 48 * k); g.restore();
    g.restore();
    g.filter = 'none';

    // ---- base plate with chrome rim and an anti-skate dial
    const plate = g.createRadialGradient(px - 34 * k, py - 38 * k, 0, px, py, 98 * k);
    plate.addColorStop(0, '#3d3d42'); plate.addColorStop(1, '#161619');
    g.fillStyle = plate;
    g.beginPath(); g.arc(px, py, 96 * k, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#8a8a90'; g.lineWidth = 3 * k;
    g.beginPath(); g.arc(px, py, 95 * k, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 2 * k;
    g.beginPath(); g.arc(px, py, 95 * k, Math.PI * 1.05, Math.PI * 1.55); g.stroke();
    const da = dir + 2.4, dx = px + Math.cos(da) * 66 * k, dy = py + Math.sin(da) * 66 * k;
    g.fillStyle = '#0f0f11';
    g.beginPath(); g.arc(dx, dy, 15 * k, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#9a9aa0'; g.lineWidth = 2 * k; g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1.2 * k;
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI * 0.9 + i * 0.3;
      g.beginPath(); g.moveTo(dx + Math.cos(a) * 9 * k, dy + Math.sin(a) * 9 * k); g.lineTo(dx + Math.cos(a) * 12.5 * k, dy + Math.sin(a) * 12.5 * k); g.stroke();
    }
    g.strokeStyle = '#e8c27a'; g.lineWidth = 2 * k;
    g.beginPath(); g.moveTo(dx, dy); g.lineTo(dx + Math.cos(-1.1) * 9 * k, dy + Math.sin(-1.1) * 9 * k); g.stroke();

    // ---- cue lever: up while the needle is lifted
    const la = rd + 2.05, lx = px + Math.cos(la) * 60 * k, ly = py + Math.sin(la) * 60 * k;
    g.save();
    g.translate(lx, ly);
    g.rotate(la - 0.35 - lift * 0.55);
    g.fillStyle = '#1b1b1e';
    g.beginPath(); g.arc(0, 0, 11 * k, 0, Math.PI * 2); g.fill();
    cylinder(0, 44 * k, 5 * k, 0.5);
    g.fillStyle = '#0d0d0f';
    g.beginPath(); g.arc(46 * k, 0, 8 * k, 0, Math.PI * 2); g.fill();
    g.restore();

    // ---- bearing housing (below the arm)
    const hous = g.createRadialGradient(px - 14 * k, py - 16 * k, 0, px, py, 52 * k);
    hous.addColorStop(0, '#f0f0f2'); hous.addColorStop(0.55, '#8c8c92'); hous.addColorStop(1, '#2c2c30');
    g.fillStyle = hous;
    g.beginPath(); g.arc(px, py, 50 * k, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#101012';
    g.beginPath(); g.arc(px, py, 39 * k, 0, Math.PI * 2); g.fill();

    // ---- counterweight (behind the pivot), on its stub
    g.save();
    g.translate(px, py + up);
    g.rotate(dir + Math.PI);
    cylinder(20 * k, 150 * k, 7 * k, 0.5);              // stub
    cylinder(56 * k, 142 * k, 30 * k, 0.12);            // the weight
    g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 1.4 * k;
    for (let x = 60; x <= 92; x += 4) { g.beginPath(); g.moveTo(x * k, -29 * k); g.lineTo(x * k, 29 * k); g.stroke(); } // knurling
    g.fillStyle = '#121214';
    g.fillRect(98 * k, -31 * k, 13 * k, 62 * k);         // scale ring
    g.fillStyle = 'rgba(255,255,255,0.8)';
    for (let i = -3; i <= 3; i++) g.fillRect(101 * k, (i * 8 - 0.6) * k, i % 3 === 0 ? 7 * k : 4 * k, 1.2 * k);
    cylinder(142 * k, 150 * k, 24 * k, 0.3);           // end cap
    g.restore();

    // ---- the gimbal yoke and the tube's collar at the bearing
    g.save();
    g.translate(px, py + up);
    g.rotate(dir);
    g.fillStyle = '#1e1e22';
    g.fillRect(-12 * k, -36 * k, 24 * k, 10 * k);
    g.fillRect(-12 * k, 26 * k, 24 * k, 10 * k);
    cylinder(-20 * k, 52 * k, 12 * k, 0.4);
    g.restore();

    // ---- the S tube
    chrome(tube, 15 * k);

    // ---- bearing top cap over the junction
    const cap = g.createRadialGradient(px - 6 * k, py - 8 * k + up, 0, px, py + up, 20 * k);
    cap.addColorStop(0, '#ffffff'); cap.addColorStop(0.5, '#a8a8ae'); cap.addColorStop(1, '#3a3a3f');
    g.fillStyle = cap;
    g.beginPath(); g.arc(px, py + up, 18 * k, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2a2a2e';
    g.beginPath(); g.arc(px, py + up, 4 * k, 0, Math.PI * 2); g.fill();

    // ---- headshell: collar, tapered plate with slots, finger lift, cartridge, stylus
    g.save();
    g.translate(hx, hy + up);
    g.rotate(hdir);
    cylinder(-18 * k, 6 * k, 10 * k, 0.3);
    const plateG = g.createLinearGradient(0, -24 * k, 0, 24 * k);
    plateG.addColorStop(0, '#5a5a60'); plateG.addColorStop(0.25, '#3a3a40'); plateG.addColorStop(1, '#141417');
    g.fillStyle = plateG;
    g.beginPath();
    g.moveTo(4 * k, -14 * k);
    g.lineTo(headLen - 8 * k, -23 * k);
    g.quadraticCurveTo(headLen + 4 * k, -23 * k, headLen + 4 * k, -12 * k);
    g.lineTo(headLen + 4 * k, 12 * k);
    g.quadraticCurveTo(headLen + 4 * k, 23 * k, headLen - 8 * k, 23 * k);
    g.lineTo(4 * k, 14 * k);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 1.2 * k; g.stroke();
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.beginPath(); g.roundRect(headLen * 0.22, -13 * k, headLen * 0.42, 4 * k, 2 * k); g.fill();
    g.beginPath(); g.roundRect(headLen * 0.22, 9 * k, headLen * 0.42, 4 * k, 2 * k); g.fill();
    // Cartridge body with a coloured stripe, two screws, and the stylus at the needle point.
    g.fillStyle = '#0e0e10';
    g.beginPath(); g.roundRect(headLen * 0.42, -15 * k, headLen * 0.5, 30 * k, 4 * k); g.fill();
    g.fillStyle = `rgb(${accent[0]},${accent[1]},${accent[2]})`;
    g.fillRect(headLen * 0.47, -15 * k, 4 * k, 30 * k);
    g.fillStyle = '#c9c9ce';
    g.beginPath(); g.arc(headLen * 0.62, -10 * k, 2.4 * k, 0, Math.PI * 2); g.arc(headLen * 0.62, 10 * k, 2.4 * k, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#d9b46a'; g.lineWidth = 2.2 * k; g.lineCap = 'round';
    g.beginPath(); g.moveTo(headLen * 0.9, 5 * k); g.lineTo(headLen, 0); g.stroke();
    // Finger lift: a bent chrome tab off the side.
    const lift1 = new Path2D();
    lift1.moveTo(headLen * 0.34, -21 * k);
    lift1.quadraticCurveTo(headLen * 0.36, -34 * k, headLen * 0.5, -37 * k);
    g.restore();
    g.save();
    g.translate(hx, hy + up);
    g.rotate(hdir);
    chrome(lift1, 5 * k);
    g.restore();

    // Hover / drag hint: a soft ring around the needle.
    if ((hoverArm || dragging) && !ctx.preview) {
      g.strokeStyle = `rgba(255,255,255,${dragging ? 0.55 : 0.35})`;
      g.lineWidth = 2 * k;
      g.beginPath(); g.arc(n.x, n.y, 30 * k, 0, Math.PI * 2); g.stroke();
    }
  }

  function drawBubble(G: Geometry, r: number, ms: number): void {
    const n = needleAt(r), k = G.k;
    const text = `${clock(ms)} / ${clock(track?.durationMs ?? 0)}`;
    g.font = `600 ${22 * k}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
    const w = g.measureText(text).width + 28 * k, h = 40 * k;
    const x = n.x - w / 2, y = n.y - 92 * k;
    g.fillStyle = 'rgba(16,14,20,0.82)';
    g.beginPath(); g.roundRect(x, y, w, h, h / 2); g.fill();
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, n.x, y + h / 2);
  }

  /** The arm's head and the visible label take clicks; everything else goes to the desktop. */
  function armRects(): number[][] {
    if (!geo || armR < 0) return [];
    const G = geo, n = needleAt(armR), s = 150 * G.k;
    const top = Math.max(0, G.cy - G.rLabel);
    return [
      [n.x - s / 2, n.y - s / 2, s, s],
      [G.cx - G.rLabel, top, G.rLabel * 2, Math.max(0, G.H - top)],
    ];
  }

  // ---------------------------------------------------------------- time

  function songPosition(): number {
    if (!track) return 0;
    if (dragging && geo) return progressFor(dragR) * track.durationMs;
    if (held && held.key === trackKey(track) && Date.now() - held.at < 1500) {
      return Math.min(track.durationMs, held.ms + (track.playing ? Date.now() - held.at : 0));
    }
    held = null;
    return trackPosition(track);
  }

  function paintInfo(): void {
    info.hidden = !opts.info || !track;
    if (!track) return;
    titleEl.textContent = track.title;
    subEl.textContent = [track.artist, track.album].filter(Boolean).join(' — ');
    btn('previous').disabled = !track.canPrevious;
    btn('next').disabled = !track.canNext;
    btn('toggle').disabled = !track.canToggle;
    btn('toggle').innerHTML = track.playing ? ICON_PAUSE : ICON_PLAY;
  }

  // ---------------------------------------------------------------- module

  return {
    pointer(kind: string, x: number, y: number): void {
      if (kind === 'enter' || kind === 'move') {
        shell.wake();
        awakeUntil = performance.now() + 2500;
        info.classList.add('is-awake');
      }
      if (!geo || !track) return;
      const G = geo;
      const n = armR >= 0 ? needleAt(armR) : null;
      const nearArm = !!n && Math.hypot(x - n.x, y - n.y) < 80 * G.k;
      const onLabel = Math.hypot(x - G.cx, y - G.cy) < G.rLabel;
      if (kind === 'move' || kind === 'enter') {
        if (dragging) dragR = Math.min(G.rOut, Math.max(G.rIn, Math.hypot(x - G.cx, y - G.cy)));
        if (hoverArm !== nearArm) { hoverArm = nearArm; dirty = true; }
      } else if (kind === 'down') {
        if (nearArm && track.canSeek && track.durationMs > 0) {
          dragging = true;
          dragR = Math.min(G.rOut, Math.max(G.rIn, Math.hypot(x - G.cx, y - G.cy)));
        } else if (onLabel) {
          labelPress = { x, y };
        }
      } else if (kind === 'up') {
        if (dragging) {
          dragging = false;
          const ms = progressFor(dragR) * track.durationMs;
          held = { ms, at: Date.now(), key: trackKey(track) };
          send({ type: 'seek', ms: Math.round(ms) });
          index = -2;
        } else if (labelPress && onLabel && Math.hypot(x - labelPress.x, y - labelPress.y) < 12 * G.k) {
          send({ type: 'media', command: 'toggle' }); // the platter slows to a stop / spins up
        }
        labelPress = null;
      } else if (kind === 'leave') {
        hoverArm = false;
      }
      dirty = true;
    },

    update(state: WidgetState): void {
      opts = withDefaults(VINYL_DEFAULTS, state.options);
      offset = state.lyricsOffsetMs;
      track = state.track;
      palette = resolvePalette('cover', [], track);
      accent = hexToRgb(palette[0]);
      sky.loadCover(track?.cover ?? null);
      const l = state.lyrics;
      const valid = !!(track && l && l.key === trackKey(track));
      lines = valid && l!.status === 'synced' ? l!.lines : [];
      lyricsNote = !track ? '' : !valid ? 'Mencari lirik…' : l!.status === 'synced' ? '' : 'Lirik bertimer tidak tersedia';
      const k2 = track ? trackKey(track) : '';
      if (k2 !== key) {
        key = k2;
        index = -2;
        words = [];
        shift = ctx.preview ? 0 : songShift(key);
        shell.paintShift(shift);
      }
      paintInfo();
      dirty = true;
      requestAnimationFrame(() => shell.report());
    },

    frame(f: AudioFrame, _dt: number, now: number): boolean {
      const onset = onsets.update(f.bands, now);
      const dt = Math.min(0.1, lastFrame ? (now - lastFrame) / 1000 : 0.016);
      lastFrame = now;
      fitCanvas(canvas);
      const W = canvas.width, H = canvas.height;
      if (!geo || geo.W !== W || geo.H !== H) { geo = geometry(W, H); baseKey = ''; armR = -1; }
      const G = geo;

      // Platter: spins up in about a second, coasts down a little slower, like a real deck.
      const playing = !!track?.playing;
      const target = playing ? OMEGA : 0;
      omega += (target - omega) * Math.min(1, dt * (playing ? 2.6 : 1.5));
      if (Math.abs(omega) < 0.002) omega = 0;
      angle = (angle + omega * dt) % (Math.PI * 2);

      // Time → where the needle should be.
      const dur = track?.durationMs ?? 0;
      const posRaw = songPosition();
      const wantR = dragging ? dragR : track && dur > 0 ? radiusFor(posRaw / dur) : G.rRest;
      if (armR < 0) armR = track ? wantR : G.rRest;
      const far = Math.abs(wantR - armR) > 30 * G.k;
      if (dragging) {
        armR = wantR;
        lift += (1 - lift) * Math.min(1, dt * 14);
      } else if (far) {
        // Song change or a jump: lift, travel, then lower.
        lift += (1 - lift) * Math.min(1, dt * 10);
        if (lift > 0.8) armR += (wantR - armR) * Math.min(1, dt * 3.2);
      } else {
        armR += (wantR - armR) * Math.min(1, dt * 8);
        lift += (0 - lift) * Math.min(1, dt * 5);
      }
      if (lift < 0.003) lift = 0;

      // Lyrics: which line, which words.
      const pos = posRaw - offset - shift;
      if (track && lines.length) {
        const idx = lineAt(lines, pos, index);
        if (idx !== index) {
          // A big jump (seek, new song) moves straight there; a normal next line slides in.
          if (Math.abs(idx - index) > 2 || index === -2) lineShown = idx;
          index = idx;
          words = idx >= 0 && lines[idx].text.trim() ? estimateWords(lines[idx], lines[idx + 1]).map((w) => ({ at: w.at, sung: false })) : [];
          gate = new WordGate(220, 500);
        }
        if (words.length) gate.update(words, pos, onset, onsets.rate > BUSY_RATE);
      } else {
        index = -1;
        lineShown = -1;
      }
      lineShown += (index - lineShown) * Math.min(1, dt * 7);
      if (Math.abs(index - lineShown) < 0.002) lineShown = index;

      const moving = omega > 0 || lift > 0 || far || dragging || Math.abs(index - lineShown) > 0.002 || sky.crossing(now);
      if (!moving && !dirty && now - lastFrame < 1000) return false;
      dirty = false;

      // The still part, repainted only when the room or the record's look changes.
      const skyChanged = sky.ensure(W, H, now, { album: opts.backdrop, dim: opts.dim, palette });
      const look = `${W}x${H}|${vinylColor().join()}|${opts.backdrop}|${opts.dim}`;
      if (skyChanged || sky.crossing(now) || look !== baseKey) { paintBase(G, now); baseKey = look; }

      // Lyrics + arm: repaint their layer only if something in it changed.
      let sung = 0;
      for (const w of words) if (w.sung) sung++;
      const ok = `${W}x${H}|${Math.round(armR * 2)}|${lift.toFixed(2)}|${lineShown.toFixed(3)}|${index}|${sung}|${hoverArm}|${dragging}|${opts.size}|${key}|${lines.length}|${lyricsNote}|${accent.join()}`;
      if (ok !== overlayKey) {
        overlayKey = ok;
        if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }
        g = overlayCtx;
        g.clearRect(0, 0, W, H);
        drawLyrics(G, armR);
        drawArm(G, armR);
        g = screen;
      }

      g.clearRect(0, 0, W, H);
      g.drawImage(base, 0, 0);
      drawLabel(G);
      g.drawImage(overlay, 0, 0);
      if (dragging && track) drawBubble(G, armR, progressFor(dragR) * track.durationMs);

      if (track) timeEl.textContent = `${clock(posRaw)} / ${dur > 0 ? clock(dur) : '–:––'}`;
      if (awakeUntil && now > awakeUntil) { awakeUntil = 0; info.classList.remove('is-awake'); }
      if (now - lastReport > 500) { lastReport = now; shell.report(); }
      return moving;
    },
  };
}
