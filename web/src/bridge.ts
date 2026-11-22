// Messages between the web UI and the .NET host (WebView2).

export interface AudioStatus {
  state: 'stopped' | 'running' | 'no-device' | 'error';
  device?: string | null;
  sampleRate: number;
  channels: number;
  error?: string | null;
}

export interface Track {
  title: string;
  artist: string;
  album: string;
  appId: string;
  appName: string;
  cover: string | null;
  playing: boolean;
  /** Position at `updatedAt`. Use `trackPosition()` for "now". */
  positionMs: number;
  durationMs: number;
  /** Unix ms. */
  updatedAt: number;
  canToggle: boolean;
  canNext: boolean;
  canPrevious: boolean;
  /** Bright colours from the cover; null without one. */
  palette: string[] | null;
  /** The player accepts jumping within the song (Spotify does). */
  canSeek?: boolean;
}

export interface LyricLine { t: number; text: string }

export interface Lyrics {
  /** title + '\n' + artist of the track they belong to. */
  key: string;
  status: 'loading' | 'synced' | 'plain' | 'none' | 'error';
  lines: LyricLine[];
  plain: string | null;
}

export interface QueueItem { title: string; artist: string; cover: string | null; durationMs: number }

export interface QueueState {
  status: 'no-client' | 'disconnected' | 'connecting' | 'ok' | 'empty' | 'error';
  items: QueueItem[];
  history: QueueItem[];
  error: string | null;
  clientId: string | null;
}

export interface WidgetItem { id: string; name: string; description: string; enabled: boolean; locked: boolean; options: Record<string, unknown> }

export type HostMessage =
  | { type: 'hello'; app: string; version: string; dataDir: string; runtime: string; webview: string; mica?: boolean; installed?: boolean }
  | { type: 'audio-status'; status: AudioStatus }
  | { type: 'track'; track: Track | null }
  | { type: 'lyrics'; lyrics: Lyrics | null }
  | { type: 'queue'; queue: QueueState; redirectUri?: string }
  | { type: 'widgets'; items: WidgetItem[]; hidden: boolean; star?: { on: boolean; options: Record<string, unknown> } }
  | { type: 'widget-init'; id: string; locked: boolean; keepAspect: boolean; options: Record<string, unknown>; lyricsOffsetMs: number; fps: number; calm?: boolean }
  | { type: 'widget-options'; options: Record<string, unknown> }
  | { type: 'prefs'; fps: number; lyricsOffsetMs: number; sensitivity?: number; smoothing?: number; startWithWindows?: boolean; calm?: boolean }
  | { type: 'widget-state'; locked: boolean }
  | { type: 'pointer'; kind: 'enter' | 'move' | 'leave' | 'down' | 'up'; x: number; y: number; clicks: number };

export type WebMessage =
  | { type: 'hello' }
  | { type: 'open-data-dir' }
  | { type: 'media'; command: 'toggle' | 'next' | 'previous' }
  | { type: 'widget-set'; id: string; enabled?: boolean; locked?: boolean }
  | { type: 'widget-reset'; id: string }
  | { type: 'widgets-hidden'; hidden: boolean }
  | { type: 'star-mode'; on: boolean }
  | { type: 'hit-areas'; rects: number[][] }
  | { type: 'drag-start' | 'open-dashboard' }
  | { type: 'resize-start'; keepAspect: boolean }
  | { type: 'options'; options: Record<string, unknown> }
  | { type: 'widget-options'; id: string; options: Record<string, unknown> }
  | { type: 'queue-play'; index: number }
  | { type: 'queue-back'; index: number }
  | { type: 'seek'; ms: number }
  | { type: 'spotify-connect'; clientId: string }
  | { type: 'spotify-disconnect' }
  | { type: 'open-url'; url: string }
  | { type: 'uninstall' }
  | { type: 'prefs'; fps?: number; lyricsOffsetMs?: number; sensitivity?: number; smoothing?: number; startWithWindows?: boolean; calm?: boolean };

export interface SharedBufferMeta {
  layout: number;
  headerBytes: number;
  bands: number;
  waveLength: number;
  floatCount: number;
}

interface SharedBufferEvent extends Event {
  getBuffer(): ArrayBuffer;
  additionalData: SharedBufferMeta;
}

interface WebViewBridge {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  addEventListener(type: 'sharedbufferreceived', listener: (e: SharedBufferEvent) => void): void;
  releaseBuffer(buffer: ArrayBuffer): void;
}

// WebView2 normally injects `chrome.webview` before any script runs, but a page that loads into a
// renderer shared with other Sonora pages (re-enabling a widget) can run first and see nothing.
// Reading it once at startup left such a page deaf and mute for good: an empty widget that ignored
// every song and style change. So look it up lazily, and until it shows up, keep what the page
// wants to send or listen to and hand it over the moment it does.
type Pending = (w: WebViewBridge) => void;
const pending: Pending[] = [];
let bridge: WebViewBridge | undefined;
let waited = 0;

function lookup(): WebViewBridge | undefined {
  bridge ??= (window as unknown as { chrome?: { webview?: WebViewBridge } }).chrome?.webview;
  return bridge;
}

function whenReady(fn: Pending): void {
  const w = lookup();
  if (w) { fn(w); return; }
  pending.push(fn);
  if (pending.length === 1) poll();
}

function poll(): void {
  const w = lookup();
  if (w) {
    for (const fn of pending.splice(0)) fn(w);
    return;
  }
  // A normal browser (development) never gets a bridge; stop looking after a while.
  if (++waited < 200) setTimeout(poll, 25);
}

/** True when running inside the app (false in a normal browser during development). */
export const inHost = lookup() !== undefined || /\.sonora$/.test(location.hostname);

export function send(message: WebMessage): void {
  whenReady((w) => w.postMessage(message));
}

export function onMessage(handler: (message: HostMessage) => void): void {
  whenReady((w) => w.addEventListener('message', (e) => handler(e.data as HostMessage)));
}

/** The host hands over the audio frame buffer after each `hello`. */
export function onSharedBuffer(handler: (buffer: ArrayBuffer, meta: SharedBufferMeta) => void): void {
  whenReady((w) => w.addEventListener('sharedbufferreceived', (e) => handler(e.getBuffer(), e.additionalData)));
}

export function releaseBuffer(buffer: ArrayBuffer): void {
  lookup()?.releaseBuffer(buffer);
}

/** Matches LyricsState.Key on the host. */
export function trackKey(t: Track): string {
  return `${t.title}\n${t.artist}`;
}

/** Where the track is now, extrapolated from the last report. */
export function trackPosition(track: Track, now = Date.now()): number {
  const pos = track.playing ? track.positionMs + (now - track.updatedAt) : track.positionMs;
  return track.durationMs > 0 ? Math.min(Math.max(pos, 0), track.durationMs) : Math.max(pos, 0);
}
