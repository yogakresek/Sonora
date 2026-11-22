// Queue widget: what's playing and what comes next. Click a queued song to jump to it.
//   arc  – a large round cover, the songs curving along its edge
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
  empty: 'Antrean kosong. Tambahkan lagu di Spotify',
  error: 'Antrean tidak bisa dimuat',
};

export function createQueue(ctx: WidgetContext): WidgetModule {
  const root = document.createElement('div');
  ctx.stage.append(root);

  let opts: QueueOptions = QUEUE_DEFAULTS;
  let track: Track | null = null;
  let calm = false;
  let key = '';
  let bar: HTMLElement | null = null;
  let disc: HTMLElement | null = null;
  let glow = 0;

  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-index], [data-now]');
    if (!el) return;
    if (el.dataset.now !== undefined) send({ type: 'media', command: 'toggle' });
    else send({ type: 'queue-play', index: Number(el.dataset.index) });
  });

  // Text scales with the box.
  new ResizeObserver(() => {
    const w = ctx.root.clientWidth, h = ctx.root.clientHeight;
    root.style.fontSize = `${Math.max(9, Math.min(w / 22, h / 21))}px`;
    if (opts.style === 'arc') layoutArc();
  }).observe(ctx.root);

  function render(state: WidgetState): void {
    const q = state.queue;
    const upcoming = q?.status === 'ok' ? q.items.slice(0, opts.count) : [];
    const history = opts.showHistory ? (q?.history ?? []).slice(0, upcoming.length > 0 ? 2 : 4) : [];
    const note = q && q.status !== 'ok' ? (q.status === 'error' && q.error ? q.error : NOTES[q.status]) : !q ? NOTES.disconnected : '';
    const palette = resolvePalette(opts.colors, opts.custom, track);

    root.className = `q q--${opts.style}${calm ? ' q--calm' : ''}`;
    root.style.setProperty('--q-accent', palette[0]);
    root.style.setProperty('--q-accent-2', palette[1] ?? palette[0]);

    const now = track
      ? `<button type="button" class="q__item q__item--now" data-now data-nodrag>
           ${thumb(track.cover)}
           <span class="q__text"><span class="q__label">${track.playing ? 'Sedang diputar' : 'Dijeda'}</span><b>${esc(track.title)}</b><span>${esc(track.artist)}</span></span>
         </button>`
      : `<div class="q__item q__item--now q__item--idle">${thumb(null)}<span class="q__text"><span class="q__label">Sonora</span><b>Tidak ada yang diputar</b><span>Putar lagu di Spotify</span></span></div>`;
    const next = upcoming.map((it, i) =>
      `<button type="button" class="q__item" data-index="${i}" data-nodrag style="--i:${i + 1}">${thumb(it.cover)}<span class="q__text"><b>${esc(it.title)}</b><span>${esc(it.artist)}</span></span>${opts.style === 'list' ? `<span class="q__time">${fmt(it.durationMs)}</span>` : ''}</button>`).join('');
    const past = history.map((it, i) =>
      `<div class="q__item q__item--past" style="--i:${upcoming.length + i + 1}">${thumb(it.cover)}<span class="q__text"><b>${esc(it.title)}</b><span>${esc(it.artist)}</span></span></div>`).join('');

    if (opts.style === 'arc') {
      root.innerHTML = `
        <div class="q__disc">${track?.cover ? `<img src="${esc(track.cover)}" alt="">` : '<span>♪</span>'}</div>
        <div class="q__arc">${now}${next}${note ? `<div class="q__note" style="--i:${upcoming.length + 1}">${esc(note)}</div>` : ''}${past}</div>`;
      disc = root.querySelector('.q__disc');
      layoutArc();
    } else {
      root.innerHTML = `
        <div class="q__card">
          ${now}
          <div class="q__progress"><i></i></div>
          ${upcoming.length ? '<div class="q__heading">Berikutnya</div>' : ''}${next}
          ${note ? `<div class="q__note">${esc(note)}</div>` : ''}
          ${past ? '<div class="q__heading">Sebelumnya</div>' + past : ''}
        </div>`;
      disc = null;
    }
    bar = root.querySelector('.q__progress i');
  }

  /** Places the arc's rows along a circle around the disc. */
  function layoutArc(): void {
    const arc = root.querySelector<HTMLElement>('.q__arc');
    const d = root.querySelector<HTMLElement>('.q__disc');
    if (!arc || !d) return;
    const W = ctx.root.clientWidth, H = ctx.root.clientHeight;
    const size = Math.min(H * 0.7, W * 0.62);
    const cx = size * 0.5 + W * 0.02, cy = H / 2;
    d.style.width = d.style.height = `${size}px`;
    d.style.left = `${cx - size / 2}px`;
    d.style.top = `${cy - size / 2}px`;

    // Rows are evenly spaced top to bottom; each sits just outside the disc's edge at its height,
    // which bends the column into an arc without rows crowding at the ends.
    const rows = [...arc.children] as HTMLElement[];
    const n = rows.length;
    const em = parseFloat(getComputedStyle(root).fontSize) || 14;
    const r = size / 2 + Math.max(10, size * 0.06);
    const step = Math.min(em * 3.5, (H * 0.92) / Math.max(1, n));
    rows.forEach((row, i) => {
      const dy = (i - (n - 1) / 2) * step + (i === 0 ? -em * 0.2 : 0);
      const inside = Math.min(1, Math.abs(dy) / r);
      const x = cx + Math.sqrt(Math.max(0, r * r - dy * dy)) - (inside > 0.95 ? r * 0.15 : 0);
      const deg = (Math.asin(Math.max(-1, Math.min(1, dy / r))) * 180) / Math.PI;
      row.style.left = `${x}px`;
      row.style.top = `${cy + dy}px`;
      row.style.maxWidth = `${Math.max(em * 6, W - x - em * 0.6)}px`;
      row.style.setProperty('--tilt', calm ? '0deg' : `${deg * 0.3}deg`);
      row.style.setProperty('--fade', String(Math.max(0.4, 1 - Math.abs(deg) / 130)));
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
        q?.items.slice(0, opts.count).map((i) => i.title + i.artist), q?.history.slice(0, 4).map((i) => i.title)]);
      if (next !== key) {
        key = next;
        render(state);
      }
    },

    frame(f: AudioFrame, dt: number): boolean {
      if (bar && track) {
        const p = track.durationMs > 0 ? trackPosition(track) / track.durationMs : 0;
        bar.style.transform = `scaleX(${p})`;
      }
      if (disc) {
        const target = calm ? 0.35 : 0.3 + 0.7 * f.kick;
        glow += (target - glow) * Math.min(1, dt * (calm ? 1.5 : 10));
        disc.style.setProperty('--glow', glow.toFixed(3));
      }
      return !!track?.playing;
    },
  };
}

function thumb(url: string | null): string {
  return `<span class="q__thumb">${url ? `<img src="${esc(url)}" alt="">` : '♪'}</span>`;
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
