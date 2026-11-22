// Dashboard state: what the host has told us, plus a single frame ticker for every live preview.

import { AudioReader, type AudioFrame } from '../audio';
import { onMessage, send, type AudioStatus, type HostMessage, type Lyrics, type QueueState, type Track, type WidgetItem } from '../bridge';

export interface AppInfo { app: string; version: string; dataDir: string; runtime: string; webview: string; mica: boolean; installed: boolean }
export interface Prefs { fps: number; lyricsOffsetMs: number; sensitivity: number; smoothing: number; startWithWindows: boolean; calm: boolean }

export const store = {
  app: null as AppInfo | null,
  audio: null as AudioStatus | null,
  track: null as Track | null,
  lyrics: null as Lyrics | null,
  queue: null as QueueState | null,
  spotifyRedirectUri: '',
  widgets: [] as WidgetItem[],
  hidden: false,
  prefs: { fps: 60, lyricsOffsetMs: 0, sensitivity: 1, smoothing: 0.72, startWithWindows: false, calm: false } as Prefs,
};

export type Topic = 'app' | 'audio' | 'track' | 'lyrics' | 'widgets' | 'prefs' | 'queue';
const subscribers = new Map<Topic, Set<() => void>>();

/** Calls fn whenever the topic changes; returns an unsubscribe function. */
export function on(topic: Topic, fn: () => void): () => void {
  let set = subscribers.get(topic);
  if (!set) subscribers.set(topic, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

function emit(topic: Topic): void {
  subscribers.get(topic)?.forEach((fn) => fn());
}

onMessage((msg: HostMessage) => {
  switch (msg.type) {
    case 'hello':
      store.app = { app: msg.app, version: msg.version, dataDir: msg.dataDir, runtime: msg.runtime, webview: msg.webview, mica: !!msg.mica, installed: !!msg.installed };
      emit('app');
      break;
    case 'audio-status': store.audio = msg.status; emit('audio'); break;
    case 'track': store.track = msg.track; emit('track'); break;
    case 'lyrics': store.lyrics = msg.lyrics; emit('lyrics'); break;
    case 'queue':
      store.queue = msg.queue;
      if (msg.redirectUri) store.spotifyRedirectUri = msg.redirectUri;
      emit('queue');
      break;
    case 'widgets':
      store.widgets = msg.items;
      store.hidden = msg.hidden;
      emit('widgets');
      break;
    case 'prefs':
      store.prefs = { ...store.prefs, ...msg } as Prefs;
      emit('prefs');
      break;
  }
});

export function widget(id: string): WidgetItem | undefined {
  return store.widgets.find((w) => w.id === id);
}

/** Saves a widget's options locally and on the host (debounced, so sliders stay light). */
const pending = new Map<string, number>();
export function setWidgetOptions(id: string, options: Record<string, unknown>): void {
  const item = widget(id);
  if (item) item.options = options;
  clearTimeout(pending.get(id));
  pending.set(id, window.setTimeout(() => send({ type: 'widget-options', id, options }), 90));
}

let prefsTimer = 0;
export function setPrefs(patch: Partial<Prefs>): void {
  store.prefs = { ...store.prefs, ...patch };
  clearTimeout(prefsTimer);
  prefsTimer = window.setTimeout(() => send({ type: 'prefs', ...patch }), 90);
}

// ------------------------------------------------------------------ frame ticker

export const audio = new AudioReader();
type Tick = (f: AudioFrame, dt: number, now: number) => void;
const ticks = new Set<Tick>();

export function onTick(fn: Tick): () => void {
  ticks.add(fn);
  return () => ticks.delete(fn);
}

let last = 0;
function loop(now: number): void {
  if (now - last >= 1000 / 60 - 2) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    audio.read();
    for (const fn of ticks) fn(audio.frame, dt, now);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
