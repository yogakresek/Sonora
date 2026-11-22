// Cover + visualizer: the album art as a disc, ringed by spectrum spokes in the cover's colours.
// Lows sit at the top and mirror down both sides to the highs at the bottom; every kick swells
// the disc and brightens the halo.

import type { AudioFrame } from '../audio';
import { send } from '../bridge';
import { fitCanvas, hexToRgb, paletteOf, type WidgetContext, type WidgetModule, type WidgetState } from './types';

const SPOKES = 120;
const FIRST_BAND = 3;
const BAND_SPAN = 96; // of 128: the very top octave rarely carries much

export function createCover(ctx: WidgetContext): WidgetModule {
  const canvas = document.createElement('canvas');
  canvas.className = 'cover__canvas';
  ctx.stage.append(canvas);
  const g = canvas.getContext('2d')!;

  const controls = document.createElement('div');
  controls.className = 'cover__controls';
  controls.dataset.nodrag = '';
  controls.innerHTML = `
    <button type="button" data-cmd="previous" aria-label="Sebelumnya">⏮</button>
    <button type="button" data-cmd="toggle" aria-label="Putar/jeda">▶</button>
    <button type="button" data-cmd="next" aria-label="Berikutnya">⏭</button>`;
  ctx.stage.append(controls);
  controls.addEventListener('click', (e) => {
    const cmd = (e.target as HTMLElement).closest('button')?.dataset.cmd;
    if (cmd === 'toggle' || cmd === 'next' || cmd === 'previous') send({ type: 'media', command: cmd });
  });
  const btn = (cmd: string) => controls.querySelector<HTMLButtonElement>(`[data-cmd="${cmd}"]`)!;

  const values = new Float32Array(SPOKES);
  let spokeColors: string[] = [];
  let haloRgb: [number, number, number] = [168, 85, 247];
  let paletteKey = '';

  let coverUrl: string | null = null;
  let current: HTMLImageElement | null = null;
  let previous: HTMLImageElement | null = null;
  let fade = 1;
  let rotation = 0;
  let pulse = 0;

  function recolor(palette: string[]): void {
    const key = palette.join();
    if (key === paletteKey) return;
    paletteKey = key;
    const rgb = palette.map(hexToRgb);
    haloRgb = rgb[0];
    spokeColors = [];
    for (let i = 0; i < SPOKES; i++) {
      // Walk the palette round the ring and back to the start, so there is no seam.
      const u = (i / SPOKES) * rgb.length;
      const a = rgb[Math.floor(u) % rgb.length];
      const b = rgb[(Math.floor(u) + 1) % rgb.length];
      const t = u - Math.floor(u);
      const c = a.map((v, k) => Math.round(v + (b[k] - v) * t));
      spokeColors.push(`rgb(${c[0]},${c[1]},${c[2]})`);
    }
  }

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

  function drawImageCover(img: HTMLImageElement, cx: number, cy: number, r: number, alpha: number): void {
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - s) / 2, sy = (img.naturalHeight - s) / 2;
    g.globalAlpha = alpha;
    g.drawImage(img, sx, sy, s, s, cx - r, cy - r, r * 2, r * 2);
    g.globalAlpha = 1;
  }

  function drawPlaceholder(cx: number, cy: number, r: number, alpha: number): void {
    const [hr, hg, hb] = haloRgb;
    const grad = g.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    grad.addColorStop(0, `rgba(${hr},${hg},${hb},0.55)`);
    grad.addColorStop(1, 'rgba(18,18,30,0.92)');
    g.globalAlpha = alpha;
    g.fillStyle = grad;
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.font = `${Math.round(r * 0.7)}px "Segoe UI Symbol", "Segoe UI", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('♪', cx, cy + r * 0.04);
    g.globalAlpha = 1;
  }

  recolor(paletteOf(null));

  return {
    update(state: WidgetState): void {
      const t = state.track;
      recolor(paletteOf(t));
      loadCover(t?.cover ?? null);
      btn('previous').disabled = !t?.canPrevious;
      btn('next').disabled = !t?.canNext;
      btn('toggle').disabled = !t?.canToggle;
      btn('toggle').textContent = t?.playing ? '⏸' : '▶';
    },

    frame(f: AudioFrame, dt: number): boolean {
      const dpr = fitCanvas(canvas);
      const W = canvas.width, H = canvas.height;
      const S = Math.min(W, H);
      const cx = W / 2, cy = H / 2;

      // Spokes follow the bands: quick to rise, settling back over ~150 ms.
      const half = SPOKES / 2;
      const rise = Math.min(1, dt * 28);
      const fall = Math.exp(-dt * 7);
      let moving = false;
      for (let i = 0; i < SPOKES; i++) {
        const k = i < half ? i : SPOKES - 1 - i;
        const pos = FIRST_BAND + (k / (half - 1)) * BAND_SPAN;
        const b0 = Math.floor(pos), t = pos - b0;
        const v = f.bands[b0] * (1 - t) + f.bands[Math.min(b0 + 1, f.bands.length - 1)] * t;
        const cur = values[i];
        values[i] = v > cur ? cur + (v - cur) * rise : Math.max(v, cur * fall);
        if (values[i] > 0.004) moving = true;
      }

      pulse = Math.max(f.kick, pulse * Math.exp(-dt * 6));
      rotation += dt * (0.05 + 0.25 * f.mid);
      if (fade < 1) fade = Math.min(1, fade + dt * 2.5);

      const coverR = S * 0.255 * (1 + 0.035 * pulse);
      const baseR = S * 0.285;
      const maxLen = S * 0.19;
      const lw = Math.max(1.2 * dpr, ((2 * Math.PI * baseR) / SPOKES) * 0.42);

      g.clearRect(0, 0, W, H);

      // Halo behind everything.
      const [hr, hg, hb] = haloRgb;
      const halo = g.createRadialGradient(cx, cy, coverR * 0.8, cx, cy, baseR + maxLen * 1.25);
      halo.addColorStop(0, `rgba(${hr},${hg},${hb},${0.22 + 0.3 * pulse})`);
      halo.addColorStop(1, `rgba(${hr},${hg},${hb},0)`);
      g.fillStyle = halo;
      g.fillRect(0, 0, W, H);

      // Spokes: a soft wide pass for glow, then the crisp line.
      g.lineCap = 'round';
      g.globalCompositeOperation = 'lighter';
      for (let pass = 0; pass < 2; pass++) {
        g.lineWidth = pass === 0 ? lw * 2.8 : lw;
        g.globalAlpha = pass === 0 ? 0.22 + 0.2 * pulse : 0.95;
        for (let i = 0; i < SPOKES; i++) {
          const a = -Math.PI / 2 + (i / SPOKES) * Math.PI * 2 + rotation;
          const len = S * 0.006 + values[i] * maxLen * (1 + 0.18 * pulse);
          const cos = Math.cos(a), sin = Math.sin(a);
          g.strokeStyle = spokeColors[i];
          g.beginPath();
          g.moveTo(cx + cos * baseR, cy + sin * baseR);
          g.lineTo(cx + cos * (baseR + len), cy + sin * (baseR + len));
          g.stroke();
        }
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';

      // The disc: cross-fade between covers.
      g.save();
      g.beginPath();
      g.arc(cx, cy, coverR, 0, Math.PI * 2);
      g.clip();
      if (fade < 1) {
        if (previous) drawImageCover(previous, cx, cy, coverR, 1);
        else drawPlaceholder(cx, cy, coverR, 1);
      }
      if (current) drawImageCover(current, cx, cy, coverR, fade);
      else drawPlaceholder(cx, cy, coverR, fade);
      g.restore();

      g.strokeStyle = `rgba(255,255,255,${0.16 + 0.2 * pulse})`;
      g.lineWidth = Math.max(1, dpr * 1.5);
      g.beginPath();
      g.arc(cx, cy, coverR + g.lineWidth / 2, 0, Math.PI * 2);
      g.stroke();

      return moving || fade < 1 || pulse > 0.01;
    },
  };
}
