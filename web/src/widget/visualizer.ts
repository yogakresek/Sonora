// The visualizer widget: the current cover drawn five ways, all driven by the same spectrum.
//   halo    – spokes of light around a round cover (lows at the top, mirrored to the highs)
//   pulse   – three soft, breathing outlines around a round cover
//   bars    – a square cover above a row of bars with a faint reflection
//   vinyl   – a spinning record with the cover as its label, ringed by spectrum ticks
//   minimal – a glowing square cover with the title underneath

import type { AudioFrame } from '../audio';
import { send, trackPosition, type Track } from '../bridge';
import {
  VISUALIZER_DEFAULTS, fitCanvas, hexToRgb, resolvePalette, withDefaults,
  type VisualizerOptions, type WidgetContext, type WidgetModule, type WidgetState,
} from './types';

const MAX_POINTS = 200;
const FIRST_BAND = 3;
const BAND_SPAN = 96; // of 128; the very top octave rarely carries much

export function createVisualizer(ctx: WidgetContext): WidgetModule {
  const canvas = document.createElement('canvas');
  canvas.className = 'vis__canvas';
  ctx.stage.append(canvas);
  const g = canvas.getContext('2d')!;

  // The song's progress: a slim line that can stay on screen, and (desktop only) a panel on hover
  // with a seek bar you can press and drag to any minute, plus previous / play / next.
  const mini = document.createElement('div');
  mini.className = 'vis__mini';
  mini.innerHTML = '<span class="vis__time"></span><div class="vis__track"><i class="vis__fill"></i></div><span class="vis__time"></span>';
  ctx.stage.append(mini);

  let controls: HTMLElement | null = null;
  let seek: HTMLElement | null = null;
  if (!ctx.preview) {
    controls = document.createElement('div');
    controls.className = 'vis__controls';
    controls.dataset.nodrag = '';
    controls.innerHTML = `
      <div class="vis__seek" data-slider role="slider" aria-label="Posisi lagu">
        <span class="vis__time"></span>
        <div class="vis__track" data-slider-track><i class="vis__fill"></i><b class="vis__knob"></b></div>
        <span class="vis__time"></span>
      </div>
      <div class="vis__buttons">
        <button type="button" data-cmd="previous" aria-label="Sebelumnya">${ICON_PREV}</button>
        <button type="button" data-cmd="toggle" aria-label="Putar/jeda">${ICON_PLAY}</button>
        <button type="button" data-cmd="next" aria-label="Berikutnya">${ICON_NEXT}</button>
      </div>`;
    ctx.stage.append(controls);
    controls.addEventListener('click', (e) => {
      const cmd = (e.target as HTMLElement).closest('button')?.dataset.cmd;
      if (cmd === 'toggle' || cmd === 'next' || cmd === 'previous') send({ type: 'media', command: cmd });
    });
    seek = controls.querySelector<HTMLElement>('.vis__seek');
    seek!.addEventListener('slide', (e) => {
      const { phase, fraction } = (e as CustomEvent<{ phase: string; fraction: number }>).detail;
      if (!track || !track.canSeek || track.durationMs <= 0) return;
      const ms = fraction * track.durationMs;
      if (phase !== 'end') {
        dragMs = ms;
      } else {
        dragMs = null;
        // Show the new spot at once; the player confirms it within a moment.
        held = { ms, at: Date.now(), key: `${track.title}\n${track.artist}` };
        send({ type: 'seek', ms: Math.round(ms) });
      }
      drawProgress();
    });
  }
  const btn = (cmd: string) => controls?.querySelector<HTMLButtonElement>(`[data-cmd="${cmd}"]`) ?? null;

  /** While dragging: where the knob is. */
  let dragMs: number | null = null;
  /** Right after a seek: the chosen spot, until the player's own report has surely caught up. */
  let held: { ms: number; at: number; key: string } | null = null;
  let shownSecond = -1;

  function positionNow(): number {
    if (!track) return 0;
    if (dragMs !== null) return dragMs;
    if (held && held.key === `${track.title}\n${track.artist}` && Date.now() - held.at < 1500) {
      return Math.min(track.durationMs, held.ms + (track.playing ? Date.now() - held.at : 0));
    }
    held = null;
    return trackPosition(track);
  }

  function drawProgress(): void {
    const dur = track?.durationMs ?? 0;
    const pos = positionNow();
    const p = dur > 0 ? Math.min(1, pos / dur) : 0;
    for (const el of [mini, seek]) {
      if (!el) continue;
      el.style.setProperty('--p', p.toFixed(4));
    }
    // Text only changes once a second (or on every move while dragging).
    const second = Math.floor(pos / 1000);
    if (second !== shownSecond || dragMs !== null) {
      shownSecond = second;
      for (const el of [mini, seek]) {
        if (!el) continue;
        const [a, b] = el.querySelectorAll<HTMLElement>('.vis__time');
        a.textContent = clock(pos);
        b.textContent = clock(dur);
      }
    }
  }

  let opts: VisualizerOptions = VISUALIZER_DEFAULTS;
  let track: Track | null = null;
  let palette: [number, number, number][] = [];
  let paletteKey = '';
  const colorCache = new Map<number, string[]>();

  const values = new Float32Array(MAX_POINTS);
  let coverUrl: string | null = null;
  let current: HTMLImageElement | null = null;
  let previous: HTMLImageElement | null = null;
  let fade = 1;
  let rotation = 0;
  let spin = 0;
  let pulse = 0;
  let level = 0;
  let time = 0;
  let calm = false;

  // ---------------------------------------------------------------- colours

  function setPalette(colors: string[]): void {
    const key = colors.join();
    if (key === paletteKey) return;
    paletteKey = key;
    palette = colors.map(hexToRgb);
    colorCache.clear();
  }

  /** n colours walking round the palette and back to the start, so a ring has no seam. */
  function ringColors(n: number): string[] {
    let list = colorCache.get(n);
    if (list) return list;
    list = [];
    for (let i = 0; i < n; i++) list.push(rgb(mix(i / n)));
    colorCache.set(n, list);
    return list;
  }

  function mix(u: number): [number, number, number] {
    const p = palette;
    const x = (((u % 1) + 1) % 1) * p.length;
    const a = p[Math.floor(x) % p.length], b = p[(Math.floor(x) + 1) % p.length];
    const t = x - Math.floor(x);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  const rgb = (c: number[], a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  // ---------------------------------------------------------------- cover image

  function loadCover(url: string | null): void {
    if (url === coverUrl) return;
    coverUrl = url;
    if (!url) {
      previous = current;
      current = null;
      fade = 0;
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (coverUrl !== url) return;
      previous = current;
      current = img;
      fade = 0;
    };
    img.src = url;
  }

  function drawImageSquare(img: HTMLImageElement, x: number, y: number, size: number, alpha: number): void {
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    g.globalAlpha = alpha;
    g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, x, y, size, size);
    g.globalAlpha = 1;
  }

  function drawPlaceholder(x: number, y: number, size: number, alpha: number): void {
    const grad = g.createLinearGradient(x, y, x + size, y + size);
    grad.addColorStop(0, rgb(palette[0], 0.9));
    grad.addColorStop(1, rgb(palette[1] ?? palette[0], 0.55));
    g.globalAlpha = alpha;
    g.fillStyle = grad;
    g.fillRect(x, y, size, size);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = `${Math.round(size * 0.34)}px "Segoe UI Symbol", "Segoe UI", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('♪', x + size / 2, y + size / 2 + size * 0.02);
    g.globalAlpha = 1;
  }

  /** The cover (cross-fading on change) inside whatever clip path is current. */
  function drawCoverInto(x: number, y: number, size: number): void {
    if (fade < 1) {
      if (previous) drawImageSquare(previous, x, y, size, 1);
      else drawPlaceholder(x, y, size, 1);
    }
    if (current) drawImageSquare(current, x, y, size, fade);
    else drawPlaceholder(x, y, size, fade);
  }

  function coverDisc(cx: number, cy: number, r: number): void {
    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.clip();
    drawCoverInto(cx - r, cy - r, r * 2);
    g.restore();
  }

  function coverSquare(x: number, y: number, size: number, radius: number): void {
    g.save();
    g.beginPath();
    g.roundRect(x, y, size, size, radius);
    g.clip();
    drawCoverInto(x, y, size);
    g.restore();
  }

  // ---------------------------------------------------------------- spectrum

  /** Fills values[0..n) from the bands: mirrored (lows in the middle of the ring) or left-to-right. */
  function sample(f: AudioFrame, n: number, mirrored: boolean, dt: number): boolean {
    // Calm mode: bars glide instead of jumping.
    const rise = Math.min(1, dt * (calm ? 8 : 28));
    const fall = Math.exp(-dt * (calm ? 3 : 7));
    let moving = false;
    const half = n / 2;
    for (let i = 0; i < n; i++) {
      const k = mirrored ? (i < half ? i / (half - 1 || 1) : (n - 1 - i) / (half - 1 || 1)) : i / (n - 1 || 1);
      const pos = FIRST_BAND + Math.min(1, k) * BAND_SPAN;
      const b0 = Math.floor(pos), t = pos - b0;
      const v = f.bands[b0] * (1 - t) + f.bands[Math.min(b0 + 1, f.bands.length - 1)] * t;
      const cur = values[i];
      values[i] = v > cur ? cur + (v - cur) * rise : Math.max(v, cur * fall);
      if (values[i] > 0.004) moving = true;
    }
    return moving;
  }

  const count = (base: number, min: number, max: number) =>
    Math.max(min, Math.min(max, Math.round(base * opts.density)));

  // ---------------------------------------------------------------- styles

  function halo(f: AudioFrame, cx: number, cy: number, S: number, dt: number, dpr: number): boolean {
    const n = count(120, 48, 180);
    const moving = sample(f, n, true, dt);
    const beat = opts.beat ? pulse : 0;
    const coverR = S * 0.255 * (1 + 0.035 * beat);
    const baseR = S * 0.285, maxLen = S * 0.19;
    const lw = Math.max(1.2 * dpr, ((2 * Math.PI * baseR) / n) * 0.42);
    const colors = ringColors(n);

    haloLight(cx, cy, coverR * 0.8, baseR + maxLen * 1.25, 0.2 + 0.3 * beat);

    g.lineCap = 'round';
    g.globalCompositeOperation = 'lighter';
    for (let pass = opts.glow ? 0 : 1; pass < 2; pass++) {
      g.lineWidth = pass === 0 ? lw * 2.8 : lw;
      g.globalAlpha = pass === 0 ? 0.22 + 0.2 * beat : 0.95;
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2 + rotation;
        const len = S * 0.006 + values[i] * maxLen * (1 + 0.18 * beat);
        const cos = Math.cos(a), sin = Math.sin(a);
        g.strokeStyle = colors[i];
        g.beginPath();
        g.moveTo(cx + cos * baseR, cy + sin * baseR);
        g.lineTo(cx + cos * (baseR + len), cy + sin * (baseR + len));
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';

    coverDisc(cx, cy, coverR);
    ring(cx, cy, coverR, 0.16 + 0.2 * beat, dpr);
    return moving;
  }

  function pulseStyle(f: AudioFrame, cx: number, cy: number, S: number, dt: number, dpr: number): boolean {
    const n = count(72, 32, 128);
    const moving = sample(f, n, true, dt);
    const beat = opts.beat ? pulse : 0;
    const coverR = S * 0.25 * (1 + 0.03 * beat);
    const baseR = S * 0.27, maxLen = S * 0.2;

    haloLight(cx, cy, coverR, baseR + maxLen * 1.2, 0.16 + 0.25 * beat);

    g.globalCompositeOperation = 'lighter';
    for (let k = 2; k >= 0; k--) {
      const c = palette[k % palette.length];
      const scale = 1 - k * 0.22;
      const rot = rotation * (1 + k * 0.6) + k * 0.7;
      const pts: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2 + rot;
        const wobble = Math.sin(time * (1.1 + k * 0.3) + i * 0.45 + k) * S * 0.004;
        const r = baseR + values[(i + k * 5) % n] * maxLen * scale * (1 + 0.15 * beat) + wobble;
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      smoothLoop(pts);
      if (opts.glow) {
        g.fillStyle = rgb(c, 0.13);
        g.fill();
      }
      g.lineWidth = Math.max(1.2 * dpr, S * 0.006);
      g.strokeStyle = rgb(c, 0.9);
      g.stroke();
    }
    g.globalCompositeOperation = 'source-over';

    coverDisc(cx, cy, coverR);
    ring(cx, cy, coverR, 0.18, dpr);
    return moving;
  }

  function bars(f: AudioFrame, cx: number, cy: number, S: number, dt: number, dpr: number): boolean {
    const n = count(36, 16, 64);
    const moving = sample(f, n, false, dt);
    const beat = opts.beat ? pulse : 0;
    const size = S * 0.5 * (1 + 0.02 * beat);
    const coverY = cy - S * 0.44;
    const radius = size * 0.08;

    if (opts.glow) {
      g.save();
      g.shadowColor = rgb(palette[0], 0.55 + 0.3 * beat);
      g.shadowBlur = S * (0.06 + 0.06 * beat);
      g.fillStyle = rgb(palette[0], 0.6);
      g.beginPath();
      g.roundRect(cx - size / 2, coverY, size, size, radius);
      g.fill();
      g.restore();
    }
    coverSquare(cx - size / 2, coverY, size, radius);

    const width = S * 0.84, base = cy + S * 0.31, maxH = S * 0.2;
    const step = width / n, bw = Math.max(1.5 * dpr, step * 0.58);
    const colors = ringColors(n * 2); // first half: a single sweep across the palette
    for (let i = 0; i < n; i++) {
      const h = Math.max(S * 0.008, values[i] * maxH * (1 + 0.12 * beat));
      const x = cx - width / 2 + i * step + (step - bw) / 2;
      g.fillStyle = colors[i];
      g.beginPath();
      g.roundRect(x, base - h, bw, h, bw / 2);
      g.fill();
      // Reflection.
      const rh = h * 0.35;
      const grad = g.createLinearGradient(0, base + S * 0.012, 0, base + S * 0.012 + rh);
      grad.addColorStop(0, colors[i].replace(',1)', ',0.28)'));
      grad.addColorStop(1, colors[i].replace(',1)', ',0)'));
      g.fillStyle = grad;
      g.fillRect(x, base + S * 0.012, bw, rh);
    }
    return moving;
  }

  function vinyl(f: AudioFrame, cx: number, cy: number, S: number, dt: number, dpr: number): boolean {
    const n = count(96, 48, 160);
    const moving = sample(f, n, true, dt);
    const beat = opts.beat ? pulse : 0;
    const R = S * 0.4 * (1 + 0.012 * beat);
    if (track?.playing) spin += dt * Math.PI * 2 * (calm ? 0.25 : 0.42); // a lazy 25 rpm reads better than 33⅓

    // Spectrum ticks round the rim.
    const colors = ringColors(n);
    g.lineCap = 'round';
    g.globalCompositeOperation = 'lighter';
    for (let pass = opts.glow ? 0 : 1; pass < 2; pass++) {
      g.lineWidth = pass === 0 ? Math.max(2, S * 0.012) : Math.max(1.2 * dpr, S * 0.005);
      g.globalAlpha = pass === 0 ? 0.25 : 0.95;
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        const r0 = R + S * 0.022, len = S * 0.004 + values[i] * S * 0.075;
        g.strokeStyle = colors[i];
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        g.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';

    // The record.
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fillStyle = '#0c0c10';
    g.fill();
    g.lineWidth = Math.max(1, dpr * 0.75);
    for (let r = R * 0.42; r < R * 0.97; r += R * 0.028) {
      g.strokeStyle = `rgba(255,255,255,${0.035 + 0.02 * Math.sin(r)})`;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();
    }
    // Light catching the grooves: fixed while the record turns underneath.
    const sheen = g.createConicGradient(-Math.PI / 4, cx, cy);
    sheen.addColorStop(0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.08, `rgba(255,255,255,${0.07 + 0.08 * level})`);
    sheen.addColorStop(0.16, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.58, `rgba(255,255,255,${0.05 + 0.06 * level})`);
    sheen.addColorStop(0.66, 'rgba(255,255,255,0)');
    g.fillStyle = sheen;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fill();

    // Label, turning with the record.
    const labelR = R * 0.36;
    g.save();
    g.translate(cx, cy);
    g.rotate(spin);
    coverDisc(0, 0, labelR);
    g.restore();
    g.beginPath();
    g.arc(cx, cy, Math.max(2, R * 0.025), 0, Math.PI * 2);
    g.fillStyle = '#0c0c10';
    g.fill();
    ring(cx, cy, R, 0.08, dpr);
    return moving || !!track?.playing;
  }

  function minimal(cx: number, cy: number, S: number): boolean {
    const beat = opts.beat ? pulse : 0;
    const size = S * 0.66 * (1 + 0.02 * beat);
    const x = cx - size / 2, y = cy - size / 2, radius = size * 0.07;
    if (opts.glow) {
      g.save();
      g.shadowColor = rgb(palette[0], 0.5 + 0.4 * Math.max(beat, level));
      g.shadowBlur = S * (0.07 + 0.12 * Math.max(beat, level));
      g.fillStyle = rgb(palette[0], 0.7);
      g.beginPath();
      g.roundRect(x, y, size, size, radius);
      g.fill();
      g.restore();
    }
    coverSquare(x, y, size, radius);
    g.strokeStyle = 'rgba(255,255,255,0.1)';
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect(x + 0.5, y + 0.5, size - 1, size - 1, radius);
    g.stroke();
    return level > 0.01 || beat > 0.01;
  }

  // ---------------------------------------------------------------- shared drawing

  function haloLight(cx: number, cy: number, r0: number, r1: number, alpha: number): void {
    if (!opts.glow) return;
    const grad = g.createRadialGradient(cx, cy, r0, cx, cy, r1);
    grad.addColorStop(0, rgb(palette[0], alpha));
    grad.addColorStop(1, rgb(palette[0], 0));
    g.fillStyle = grad;
    g.fillRect(cx - r1, cy - r1, r1 * 2, r1 * 2);
  }

  function ring(cx: number, cy: number, r: number, alpha: number, dpr: number): void {
    g.strokeStyle = `rgba(255,255,255,${alpha})`;
    g.lineWidth = Math.max(1, dpr * 1.25);
    g.beginPath();
    g.arc(cx, cy, r + g.lineWidth / 2, 0, Math.PI * 2);
    g.stroke();
  }

  /** A closed curve through the points, smoothed with quadratic segments between midpoints. */
  function smoothLoop(pts: [number, number][]): void {
    const n = pts.length;
    g.beginPath();
    const mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const start = mid(pts[n - 1], pts[0]);
    g.moveTo(start[0], start[1]);
    for (let i = 0; i < n; i++) {
      const m = mid(pts[i], pts[(i + 1) % n]);
      g.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]);
    }
    g.closePath();
  }

  function title(W: number, top: number, height: number, S: number, dpr: number): void {
    const name = track?.title || 'Tidak ada yang diputar';
    const artist = track ? track.artist : 'Putar lagu untuk memulai';
    const size = Math.max(11 * dpr, Math.min(30 * dpr, S * 0.062));
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = 8 * dpr;
    g.fillStyle = '#fff';
    g.font = `700 ${size}px "Segoe UI Variable Display", "Segoe UI", sans-serif`;
    g.fillText(fit(name, W * 0.9), W / 2, top + height * 0.48);
    g.fillStyle = 'rgba(255,255,255,0.68)';
    g.font = `500 ${size * 0.78}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
    g.fillText(fit(artist, W * 0.9), W / 2, top + height * 0.48 + size * 1.15);
    g.shadowBlur = 0;
    g.shadowColor = 'transparent';
  }

  function fit(text: string, max: number): string {
    if (g.measureText(text).width <= max) return text;
    let s = text;
    while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s + '…';
  }

  setPalette(resolvePalette('cover', [], null));

  return {
    update(state: WidgetState): void {
      opts = withDefaults(VISUALIZER_DEFAULTS, state.options);
      calm = state.calm;
      track = state.track;
      setPalette(resolvePalette(opts.colors, opts.custom, track));
      loadCover(track?.cover ?? null);
      if (controls) {
        btn('previous')!.disabled = !track?.canPrevious;
        btn('next')!.disabled = !track?.canNext;
        btn('toggle')!.disabled = !track?.canToggle;
        btn('toggle')!.innerHTML = track?.playing ? ICON_PAUSE : ICON_PLAY;
      }
      const hasTime = !!track && track.durationMs > 0;
      mini.hidden = !opts.progress || !hasTime;
      seek?.classList.toggle('vis__seek--off', !hasTime);
      seek?.setAttribute('aria-disabled', String(!hasTime || !track?.canSeek));
      shownSecond = -1;
      drawProgress();
    },

    frame(f: AudioFrame, dt: number): boolean {
      const dpr = fitCanvas(canvas);
      const W = canvas.width, H = canvas.height;
      time += dt;
      // Calm mode: no beat pulse at all, a slow-moving glow, a slow steady turn.
      pulse = calm ? 0 : Math.max(f.kick, pulse * Math.exp(-dt * 6));
      const ease = Math.exp(-dt * (calm ? 0.8 : 4));
      level = level * ease + Math.min(1, f.rms * 4) * (1 - ease);
      rotation += dt * (calm ? 0.03 : 0.05 + 0.25 * f.mid);
      if (fade < 1) fade = Math.min(1, fade + dt * 2.5);

      g.clearRect(0, 0, W, H);

      const withTitle = opts.showTitle || opts.style === 'minimal';
      // Keep the bottom strip free for the time line, so it never covers the title or the art.
      const lineH = mini.hidden ? 0 : Math.min(W, H) * 0.085;
      const avail = H - lineH;
      const textH = withTitle ? Math.min(W, avail) * 0.2 : 0;
      const S = Math.min(W, avail - textH);
      const cx = W / 2, cy = (avail - textH) / 2;

      let moving: boolean;
      switch (opts.style) {
        case 'pulse': moving = pulseStyle(f, cx, cy, S, dt, dpr); break;
        case 'bars': moving = bars(f, cx, cy, S, dt, dpr); break;
        case 'vinyl': moving = vinyl(f, cx, cy, S, dt, dpr); break;
        case 'minimal': moving = minimal(cx, cy, S); break;
        default: moving = halo(f, cx, cy, S, dt, dpr);
      }
      if (withTitle) title(W, avail - textH, textH, Math.min(W, avail), dpr);
      drawProgress();

      return moving || fade < 1 || pulse > 0.01;
    },
  };
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Small line icons (24×24, stroke = currentColor).
const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">${d}</svg>`;
const ICON_PLAY = svg('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>');
const ICON_PAUSE = svg('<rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/>');
const ICON_PREV = svg('<rect x="5" y="5" width="2.5" height="14" rx="1"/><path d="M19 6.2v11.6a1 1 0 0 1-1.55.83L9.3 12.83a1 1 0 0 1 0-1.66l8.15-5.8A1 1 0 0 1 19 6.2z"/>');
const ICON_NEXT = svg('<rect x="16.5" y="5" width="2.5" height="14" rx="1"/><path d="M5 6.2v11.6a1 1 0 0 0 1.55.83l8.15-5.8a1 1 0 0 0 0-1.66L6.55 5.37A1 1 0 0 0 5 6.2z"/>');
