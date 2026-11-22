// Live previews: the real widget modules, running inside the dashboard on the dashboard's audio.
// Without a song (or without synced lyrics) they play a short demo so there is always something to see.

import type { Lyrics, Track } from '../bridge';
import { createLyrics } from '../widget/lyrics';
import type { WidgetContext, WidgetModule, WidgetState } from '../widget/types';
import { createVisualizer } from '../widget/visualizer';
import { createQueue, DEMO_QUEUE } from '../widget/queue';
import { onTick, store } from './store';

const DEMO_LINES = [
  'Lampu kota menyala pelan',
  'Kau putar lagu yang sama',
  'Setiap ketukan jadi cahaya',
  'Menari di layar kita',
  '',
  'Biar malam ikut bernyanyi',
  'Sampai pagi datang lagi',
];
const DEMO_STEP = 2600;
const DEMO_START = Date.now();

function demoTrack(): Track {
  const duration = DEMO_LINES.length * DEMO_STEP + 1200;
  const elapsed = (Date.now() - DEMO_START) % duration;
  return {
    title: 'Contoh lagu', artist: 'Sonora', album: '', appId: 'demo', appName: 'Demo',
    cover: null, playing: true, positionMs: elapsed, durationMs: duration, updatedAt: Date.now(),
    canToggle: false, canNext: false, canPrevious: false, palette: null,
  };
}

function demoLyrics(t: Track): Lyrics {
  return { key: `${t.title}\n${t.artist}`, status: 'synced', lines: DEMO_LINES.map((text, i) => ({ t: 400 + i * DEMO_STEP, text })), plain: null };
}

/** True when a lyrics preview would have nothing real to show. */
function needsDemoLyrics(): boolean {
  const t = store.track, l = store.lyrics;
  return !t || !l || l.status !== 'synced' || l.key !== `${t.title}\n${t.artist}`;
}

export interface Preview { refresh(): void; destroy(): void }

export function mountPreview(host: HTMLElement, kind: string, options: () => Record<string, unknown>, fps = 60): Preview {
  host.classList.add('preview');
  const root = document.createElement('div');
  root.className = 'preview__root';
  const stage = document.createElement('div');
  stage.className = 'preview__stage';
  root.append(stage);
  host.append(root);

  const state: WidgetState = { track: null, lyrics: null, locked: true, options: {}, lyricsOffsetMs: 0, calm: false, queue: null };
  const ctx: WidgetContext = { root, stage, state, preview: true };
  const module: WidgetModule = kind === 'lyrics' ? createLyrics(ctx) : kind === 'queue' ? createQueue(ctx) : createVisualizer(ctx);

  let demo = false;
  function refresh(): void {
    demo = kind === 'lyrics' ? needsDemoLyrics() : !store.track;
    const track = demo && kind === 'lyrics' ? demoTrack() : store.track;
    state.track = track;
    state.lyrics = demo && kind === 'lyrics' && track ? demoLyrics(track) : store.lyrics;
    state.options = options();
    state.lyricsOffsetMs = store.prefs.lyricsOffsetMs;
    state.calm = store.prefs.calm;
    // Before Spotify is connected, previews show made-up songs so the design is visible.
    const q = store.queue;
    state.queue = q?.status === 'ok' ? q : { status: 'ok', items: DEMO_QUEUE, history: q?.history ?? [], error: null, clientId: null };
    module.update(state);
  }
  refresh();

  // The demo loops by being handed a fresh position every couple of seconds.
  const demoTimer = window.setInterval(() => { if (demo) refresh(); }, 2000);

  let lastDraw = 0;
  const minMs = 1000 / fps - 2;
  const stop = onTick((f, _dt, now) => {
    if (now - lastDraw < minMs) return;
    const dt = Math.min(0.1, (now - lastDraw) / 1000);
    lastDraw = now;
    module.frame(f, dt, now);
  });

  return {
    refresh,
    destroy() {
      stop();
      clearInterval(demoTimer);
      module.destroy?.();
      root.remove();
    },
  };
}
