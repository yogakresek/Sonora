// Queue widget: what's playing and what comes next. Click a queued song to jump to it.
//   arc  – a "time wheel": the cover on the left with a progress ring; the song playing now sits
//          level with the cover's centre, upcoming songs flow down and recent ones up, following
//          the cover's curve and growing smaller and fainter the further they are from now
//   list – a tidy card: now playing with progress, then the queue
// Without a Spotify connection it shows the songs played before (from Windows' media controls)
// and a short note on how to see the queue.

import type { AudioFrame } from '../audio';
import { send, trackPosition, type QueueItem, type Track } from '../bridge';
import { QUEUE_DEFAULTS, resolvePalette, withDefaults, type QueueOptions, type WidgetContext, type WidgetModule, type WidgetState } from './types';

const NOTES: Record<string, string> = {
  'no-client': 'Sambungkan Spotify di dashboard untuk melihat lagu berikutnya',
  disconnected: 'Sambungkan Spotify di dashboard untuk melihat lagu berikutnya',
  connecting: 'Menunggu login Spotify di browser…',
  empty: 'Antrean kosong. Putar playlist atau album di Spotify',
  error: 'Antrean tidak bisa dimuat',
};

const RING = 2 * Math.PI * 48; // circumference of the progress ring (r = 48 in a 100×100 viewBox)

export function createQueue(ctx: WidgetContext): WidgetModule {
  const root = document.createElement('div');
  ctx.stage.append(root);

  let opts: QueueOptions = QUEUE_DEFAULTS;
  let track: Track | null = null;
  let calm = false;
  let key = '';
  let bar: HTMLElement | null = null;
  let ring: SVGCircleElement | null = null;
  let disc: HTMLElement | null = null;
  let glow = 0;

  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-index], [data-now]');
    if (!el) return;
    if (el.dataset.now !== undefined) send({ type: 'media', command: 'toggle' });
    else send({ type: 'queue-play', index: Number(el.dataset.index) });
  });

  new ResizeObserver(() => {
    const w = ctx.root.clientWidth, h = ctx.root.clientHeight;
    root.style.fontSize = `${Math.max(9, Math.min(w / 24, h / 17))}px`;
    if (opts.style === 'arc') layoutArc();
  }).observe(ctx.root);

  // ---------------------------------------------------------------- markup

  function row(item: QueueItem | Track, cls: string, attrs: string, label?: string, time?: number): string {
    const tag = attrs.includes('data-') ? 'button' : 'div';
    return `<${tag} ${tag === 'button' ? 'type="button" data-nodrag' : ''} class="q__row ${cls}" ${attrs}>
      ${thumb(item.cover)}
      <span class="q__text">${label ? `<span class="q__label">${label}</span>` : ''}<b>${esc(item.title)}</b><span>${esc(item.artist)}</span></span>
      ${time ? `<span class="q__time">${fmt(time)}</span>` : ''}
    </${tag}>`;
  }

  function render(state: WidgetState): void {
    const q = state.queue;
    const upcoming = q?.status === 'ok' ? q.items.slice(0, opts.count) : [];
    const history = opts.showHistory ? (q?.history ?? []).slice(0, opts.style === 'arc' ? 2 : 3) : [];
    const note = q && q.status !== 'ok' ? (q.status === 'error' && q.error ? q.error : NOTES[q.status]) : !q ? NOTES.disconnected : '';
    const palette = resolvePalette(opts.colors, opts.custom, track);

    root.className = `q q--${opts.style}${calm ? ' q--calm' : ''}`;
    root.style.setProperty('--q-accent', palette[0]);
    root.style.setProperty('--q-accent-2', palette[1] ?? palette[0]);

    const nowLabel = track ? (track.playing ? 'Sedang diputar' : 'Dijeda') : 'Sonora';
    const now = track
      ? row(track, 'q__row--now', 'data-now', nowLabel)
      : `<div class="q__row q__row--now q__row--idle">${thumb(null)}<span class="q__text"><span class="q__label">Sonora</span><b>Tidak ada yang diputar</b><span>Putar lagu di Spotify</span></span></div>`;
    const next = upcoming.map((it, i) => row(it, '', `data-index="${i}"`, undefined, opts.style === 'list' ? it.durationMs : 0));
    const noteHtml = note ? `<div class="q__note">${esc(note)}</div>` : '';

    if (opts.style === 'arc') {
      // Order on the wheel: oldest at the top, now in the middle, next below.
      const past = history.slice().reverse().map((it) => row(it, 'q__row--past', ''));
      root.innerHTML = `
        <div class="q__disc">
          <div class="q__art">${track?.cover ? `<img src="${esc(track.cover)}" alt="">` : '<span>♪</span>'}</div>
          <svg class="q__ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="q__ring-track" cx="50" cy="50" r="48"/><circle class="q__ring-fill" cx="50" cy="50" r="48" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/></svg>
        </div>
        <div class="q__wheel" data-center="${past.length}">${past.join('')}${now}${next.join('')}${noteHtml}</div>`;
      disc = root.querySelector('.q__disc');
      ring = root.querySelector('.q__ring-fill');
      bar = null;
      layoutArc();
    } else {
      const past = history.map((it) => row(it, 'q__row--past', ''));
      root.innerHTML = `
        <div class="q__card">
          ${now}
          <div class="q__progress"><i></i></div>
          <div class="q__scroll">
            ${next.length ? `<div class="q__heading">Berikutnya</div>${next.join('')}` : ''}
            ${noteHtml}
            ${past.length ? `<div class="q__heading">Sebelumnya</div>${past.join('')}` : ''}
          </div>
        </div>`;
      disc = null;
      ring = null;
      bar = root.querySelector('.q__progress i');
    }
  }

  // ---------------------------------------------------------------- the wheel

  /** Positions the wheel's rows: evenly spaced by their real heights, bending around the cover. */
  function layoutArc(): void {
    const wheel = root.querySelector<HTMLElement>('.q__wheel');
    const d = root.querySelector<HTMLElement>('.q__disc');
    if (!wheel || !d) return;
    const W = ctx.root.clientWidth, H = ctx.root.clientHeight;
    const em = parseFloat(getComputedStyle(root).fontSize) || 14;
    const size = Math.min(H * 0.8, W * 0.46);
    const cx = size / 2 + em * 0.6, cy = H / 2;
    d.style.width = d.style.height = `${size}px`;
    d.style.left = `${cx - size / 2}px`;
    d.style.top = `${cy - size / 2}px`;

    const rows = [...wheel.children] as HTMLElement[];
    const center = Number(wheel.dataset.center) || 0;
    const r = size / 2 + em * 0.9;
    const gap = em * 0.35;

    // Scale and fade by distance from "now".
    const scaleOf = (dist: number) => (dist === 0 ? 1 : Math.max(0.72, 0.9 - (dist - 1) * 0.06));
    const fadeOf = (dist: number, past: boolean) => (dist === 0 ? 1 : Math.max(0.28, (past ? 0.55 : 0.92) - (dist - 1) * 0.14));

    // Heights first (unscaled), then walk outwards from the centre so rows never overlap.
    const heights = rows.map((el) => el.offsetHeight || em * 2.8);
    const ys: number[] = new Array(rows.length);
    ys[center] = cy;
    for (let i = center + 1; i < rows.length; i++) {
      ys[i] = ys[i - 1] + (heights[i - 1] * scaleOf(i - 1 - center) + heights[i] * scaleOf(i - center)) / 2 + gap;
    }
    for (let i = center - 1; i >= 0; i--) {
      ys[i] = ys[i + 1] - (heights[i + 1] * scaleOf(center - i - 1) + heights[i] * scaleOf(center - i)) / 2 - gap;
    }

    rows.forEach((el, i) => {
      const dist = Math.abs(i - center);
      const s = scaleOf(dist);
      const dy = ys[i] - cy;
      // Follow the cover's edge while the row is beside it; straight down beyond it.
      const x = cx + Math.sqrt(Math.max(0, r * r - Math.min(r * r, dy * dy))) * (Math.abs(dy) < r ? 1 : 0) + (Math.abs(dy) >= r ? em * 0.4 : 0);
      const visible = ys[i] - (heights[i] * s) / 2 >= -2 && ys[i] + (heights[i] * s) / 2 <= H + 2;
      el.style.left = `${x}px`;
      el.style.top = `${ys[i]}px`;
      el.style.maxWidth = `${Math.max(em * 6, (W - x - em * 0.5) / s)}px`;
      el.style.setProperty('--s', s.toFixed(3));
      el.style.setProperty('--o', visible ? fadeOf(dist, i < center).toFixed(3) : '0');
      el.style.pointerEvents = visible ? '' : 'none';
      el.style.setProperty('--delay', `${Math.min(dist, 6) * 40}ms`);
    });
  }

  return {
    update(state: WidgetState): void {
      opts = withDefaults(QUEUE_DEFAULTS, state.options);
      track = state.track;
      calm = state.calm;
      // Rebuild only when something visible changed (keeps hover state stable).
      const q = state.queue;
      const next = JSON.stringify([opts, calm, track?.title, track?.artist, track?.cover, track?.playing, q?.status, q?.error,
        q?.items.slice(0, opts.count).map((i) => i.title + i.artist + i.cover), q?.history.slice(0, 3).map((i) => i.title)]);
      if (next !== key) {
        key = next;
        render(state);
      }
    },

    frame(f: AudioFrame, dt: number): boolean {
      const p = track && track.durationMs > 0 ? Math.min(1, trackPosition(track) / track.durationMs) : 0;
      if (bar) bar.style.transform = `scaleX(${p})`;
      if (ring) ring.style.strokeDashoffset = String(RING * (1 - p));
      if (disc) {
        const target = calm ? 0.3 : 0.25 + 0.6 * f.kick;
        glow += (target - glow) * Math.min(1, dt * (calm ? 1.5 : 8));
        disc.style.setProperty('--glow', glow.toFixed(3));
      }
      return !!track?.playing;
    },
  };
}

function thumb(url: string | null): string {
  return `<span class="q__thumb">${url ? `<img src="${esc(url)}" alt="">` : '<i>♪</i>'}</span>`;
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '';
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Example songs for dashboard previews before Spotify is connected (titles made up). */
export const DEMO_QUEUE: QueueItem[] = [
  { title: 'Langit Oranye', artist: 'Contoh', cover: null, durationMs: 201000 },
  { title: 'Jalan Pulang', artist: 'Contoh', cover: null, durationMs: 188000 },
  { title: 'Kopi Tengah Malam', artist: 'Contoh', cover: null, durationMs: 232000 },
  { title: 'Ombak Pelan', artist: 'Contoh', cover: null, durationMs: 176000 },
  { title: 'Neon Biru', artist: 'Contoh', cover: null, durationMs: 214000 },
];
