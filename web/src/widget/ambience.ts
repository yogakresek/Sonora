// What every full-screen ambience (Suasana) shares: Star Mode, Piringan Hitam, and whatever comes
// next. Each one only draws its own scene; this gives it
//   - the top bar that appears when the mouse moves (its name, "Lirik − / +", Keluar),
//   - the clickable-areas report to the host (everything else lets clicks through to the desktop),
//   - the per-song lyric shift, remembered between plays,
//   - the sky painted from the album cover, crossfading from song to song.

import { send } from '../bridge';
import { hexToRgb, type WidgetContext } from './types';

// ------------------------------------------------------------------ per-song lyric shift
//
// LRCLIB timings are written by people and some songs are simply early or late, so the user can
// nudge a song from the top bar. (Measuring the shift automatically was tried and rejected: on
// real, drum-heavy songs the voice onsets didn't agree with themselves.)

const SHIFT_STORE = 'sonora.star.songShift'; // name kept from Star Mode so earlier nudges survive
try { localStorage.removeItem('sonora.star.sync'); } catch { /* an old experiment's leftovers */ }

function loadShifts(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SHIFT_STORE) ?? '{}') ?? {}; } catch { return {}; }
}

export function songShift(song: string): number {
  return loadShifts()[song] ?? 0;
}

export function saveSongShift(song: string, ms: number): void {
  const all = loadShifts();
  if (ms === 0) delete all[song]; else all[song] = ms;
  const keys = Object.keys(all);
  if (keys.length > 500) delete all[keys[0]];
  try { localStorage.setItem(SHIFT_STORE, JSON.stringify(all)); } catch { /* storage full or off: fine */ }
}

// ------------------------------------------------------------------ the shell: top bar + click areas

export interface AmbienceShell {
  /** The pointer moved over the screen: show the bar for a while. */
  wake(): void;
  /** Tell the host which parts take clicks (the bar, plus whatever `areas` returns). Cheap; call when they move. */
  report(): void;
  /** Show this song's shift in the bar. */
  paintShift(ms: number): void;
}

export function createAmbienceShell(
  ctx: WidgetContext,
  o: { name: string; icon: string; onShift: (stepMs: number) => void; areas: () => Element[]; extraRects?: () => number[][] },
): AmbienceShell {
  let bar: HTMLElement | null = null;
  let timer = 0;
  let shown = false;
  let lastReport = '';

  if (!ctx.preview) {
    bar = document.createElement('div');
    bar.className = 'star__bar';
    bar.dataset.nodrag = '';
    bar.innerHTML = `
      <span class="star__bar-label">${o.icon}<span>${o.name}</span></span>
      <span class="star__sync" title="Geser waktu lirik untuk lagu ini saja (diingat)">
        <span class="star__sync-label">Lirik</span>
        <button type="button" data-shift="-100" aria-label="Lirik lebih cepat 0,1 detik">−</button>
        <span class="star__sync-value"></span>
        <button type="button" data-shift="100" aria-label="Lirik lebih lambat 0,1 detik">+</button>
      </span>
      <button type="button" class="star__exit" aria-label="Keluar dari ${o.name}">${X_ICON}<span>Keluar</span></button>`;
    ctx.stage.append(bar);
    bar.querySelector('.star__exit')!.addEventListener('click', () => send({ type: 'ambience', id: null }));
    bar.querySelector('.star__sync')!.addEventListener('click', (e) => {
      const step = Number((e.target as HTMLElement).closest<HTMLElement>('[data-shift]')?.dataset.shift ?? 0);
      if (step) { o.onShift(step); show(); }
    });
    setTimeout(() => show(5000), 600); // at the start, so the way out is clear
  }

  function report(): void {
    if (ctx.preview) return;
    const dpr = window.devicePixelRatio || 1;
    const rects: number[][] = [];
    const add = (el: Element, pad: number) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push([(r.left - pad) * dpr, (r.top - pad) * dpr, (r.width + pad * 2) * dpr, (r.height + pad * 2) * dpr]);
    };
    for (const el of o.areas()) if (!(el as HTMLElement).hidden) add(el, 4);
    if (shown && bar) add(bar, 4);
    rects.push(...(o.extraRects?.() ?? []));
    const key = JSON.stringify(rects.map((r) => r.map(Math.round)));
    if (key === lastReport) return; // nothing moved
    lastReport = key;
    send({ type: 'hit-areas', rects });
  }

  function show(ms = 2500): void {
    if (!bar) return;
    clearTimeout(timer);
    if (!shown) {
      shown = true;
      bar.classList.add('is-shown');
      report();
      setTimeout(report, 320); // again once it has slid into place
    }
    timer = window.setTimeout(hide, ms);
  }

  function hide(): void {
    if (!bar || !shown) return;
    if (bar.querySelector('.is-hover')) { timer = window.setTimeout(hide, 1200); return; } // still pointing at it
    shown = false;
    bar.classList.remove('is-shown');
    report();
  }

  return {
    wake: () => show(),
    report,
    paintShift(ms: number): void {
      const el = bar?.querySelector<HTMLElement>('.star__sync-value');
      if (!el) return;
      el.textContent = ms === 0 ? '0,0 dtk' : `${ms > 0 ? '+' : '−'}${(Math.abs(ms) / 1000).toFixed(1).replace('.', ',')} dtk`;
      el.classList.toggle('is-set', ms !== 0);
    },
  };
}

// ------------------------------------------------------------------ the album sky
//
// The cover, blurred into soft colour and darkened, fills the screen; every song gets its own sky,
// crossfading from the last. Painted once per song (the costly full-screen part), then copied.

const CROSSFADE_MS = 1400;

export interface SkyLook {
  /** false = no album sky: just darken the wallpaper. */
  album: boolean;
  /** 0.4..0.95 */
  dim: number;
  /** Bright colours of the cover (hex). */
  palette: string[];
}

export class AlbumSky {
  private readonly now = document.createElement('canvas');
  private readonly prev = document.createElement('canvas');
  private readonly tiny = document.createElement('canvas');
  private readonly small = document.createElement('canvas');
  private key = '';
  private crossFrom = -1e9;
  private coverUrl = '';
  private coverReady = '';
  /** The loaded cover image (also handy for the scenes themselves). */
  cover: HTMLImageElement | null = null;

  loadCover(url: string | null): void {
    if ((url ?? '') === this.coverUrl) return;
    this.coverUrl = url ?? '';
    this.coverReady = '';
    if (!url) { this.cover = null; return; }
    const img = new Image();
    img.onload = () => { if (this.coverUrl === url) { this.cover = img; this.coverReady = url; } };
    img.onerror = () => { if (this.coverUrl === url) { this.cover = null; this.coverReady = 'none'; } };
    img.src = url;
  }

  /** True while crossfading from the last song's sky. */
  crossing(t: number): boolean {
    return t - this.crossFrom < CROSSFADE_MS;
  }

  /** Repaints if the song, colours, darkness or size changed. Returns true if it did. */
  ensure(W: number, H: number, t: number, look: SkyLook): boolean {
    // Wait (briefly) for a new cover before switching, so the sky changes once, not twice.
    const source = !look.album ? 'wallpaper'
      : this.coverUrl && this.coverReady !== this.coverUrl && this.coverReady !== 'none' ? null
      : this.coverReady || 'palette';
    if (source === null) return false;
    const want = `${source}|${look.palette.join()}|${look.dim}|${W}x${H}`;
    if (want === this.key) return false;
    const resized = this.now.width !== W || this.now.height !== H;
    if (this.key && !resized) {
      this.prev.width = W; this.prev.height = H;
      const p = this.prev.getContext('2d')!;
      p.clearRect(0, 0, W, H);
      p.drawImage(this.now, 0, 0);
      this.crossFrom = t;
    }
    this.key = want;
    if (resized) { this.now.width = W; this.now.height = H; }
    this.paint(W, H, source, look);
    return true;
  }

  /** Draws the sky (and the fading previous one) onto g. */
  draw(g: CanvasRenderingContext2D, t: number): void {
    g.drawImage(this.now, 0, 0);
    if (this.crossing(t)) {
      g.globalAlpha = 1 - easeInOut((t - this.crossFrom) / CROSSFADE_MS);
      g.drawImage(this.prev, 0, 0);
      g.globalAlpha = 1;
    }
  }

  private paint(W: number, H: number, source: string, look: SkyLook): void {
    const b = this.now.getContext('2d')!;
    b.clearRect(0, 0, W, H);
    if (source === 'wallpaper') {
      b.fillStyle = `rgba(4, 6, 14, ${look.dim})`;
      b.fillRect(0, 0, W, H);
    } else {
      b.fillStyle = '#05060c';
      b.fillRect(0, 0, W, H);
      const cover = this.cover;
      if (cover && source !== 'palette' && source !== 'none') {
        // Shrink the cover to a handful of pixels and blow it up again: a soft wash of its colours.
        const tw = 36, th = Math.max(8, Math.round((36 * H) / W));
        this.tiny.width = tw; this.tiny.height = th;
        const s = Math.max(tw / cover.naturalWidth, th / cover.naturalHeight);
        const iw = cover.naturalWidth * s, ih = cover.naturalHeight * s;
        this.tiny.getContext('2d')!.drawImage(cover, (tw - iw) / 2, (th - ih) / 2, iw, ih);
        this.small.width = 320; this.small.height = Math.round((320 * H) / W);
        const m = this.small.getContext('2d')!;
        m.filter = 'blur(14px) saturate(1.35)';
        m.imageSmoothingQuality = 'high';
        m.drawImage(this.tiny, -40, -40, this.small.width + 80, this.small.height + 80);
        m.filter = 'none';
        b.imageSmoothingQuality = 'high';
        b.drawImage(this.small, 0, 0, W, H);
      }
      // The cover's own bright colours as slow nebulae (and the whole sky when there's no cover).
      const spots: [number, number, number][] = [[0.18, 0.22, 0.75], [0.85, 0.3, 0.65], [0.55, 0.92, 0.8]];
      look.palette.slice(0, 3).forEach((c, i) => {
        const [x, y, r] = spots[i];
        const [cr, cg, cb] = hexToRgb(c);
        const grad = b.createRadialGradient(W * x, H * y, 0, W * x, H * y, Math.max(W, H) * r);
        grad.addColorStop(0, `rgba(${cr},${cg},${cb},${cover ? 0.22 : 0.42})`);
        grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        b.fillStyle = grad;
        b.fillRect(0, 0, W, H);
      });
      // Night falls over it: the darkness slider still applies, a bit lighter so the colour shows.
      b.fillStyle = `rgba(4, 6, 14, ${0.12 + look.dim * 0.62})`;
      b.fillRect(0, 0, W, H);
    }
    const v = b.createRadialGradient(W / 2, H * 0.42, Math.min(W, H) * 0.2, W / 2, H * 0.5, Math.max(W, H) * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, `rgba(0,0,0,${Math.min(0.55, look.dim * 0.5)})`);
    b.fillStyle = v;
    b.fillRect(0, 0, W, H);
  }
}

// ------------------------------------------------------------------ small shared helpers

export function easeOut(t: number): number {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
}

export function easeInOut(t: number): number {
  t = Math.min(1, Math.max(0, t));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Which lyric line is sung at pos, searching on from `from` (cheap while playing forward). */
export function lineAt(lines: { t: number }[], pos: number, from: number): number {
  let i = Math.max(-1, Math.min(from, lines.length - 1));
  if (i >= 0 && lines[i].t > pos) i = -1;
  while (i + 1 < lines.length && lines[i + 1].t <= pos) i++;
  return i;
}

const svg = (d: string, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${d}</svg>`;
export const ICON_PLAY = svg('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>');
export const ICON_PAUSE = svg('<rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/>');
export const ICON_PREV = svg('<rect x="5" y="5" width="2.5" height="14" rx="1"/><path d="M19 6.2v11.6a1 1 0 0 1-1.55.83L9.3 12.83a1 1 0 0 1 0-1.66l8.15-5.8A1 1 0 0 1 19 6.2z"/>', 16);
export const ICON_NEXT = svg('<rect x="16.5" y="5" width="2.5" height="14" rx="1"/><path d="M5 6.2v11.6a1 1 0 0 0 1.55.83l8.15-5.8a1 1 0 0 0 0-1.66L6.55 5.37A1 1 0 0 0 5 6.2z"/>', 16);
export const ICON_STAR = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 2.5l1.9 7.6 7.6 1.9-7.6 1.9L12 21.5l-1.9-7.6L2.5 12l7.6-1.9z"/></svg>';
export const ICON_VINYL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 6.5a5.5 5.5 0 0 1 5.5 5.5" stroke-linecap="round"/></svg>';
const X_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
