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
}

export interface LyricLine { t: number; text: string }

export interface Lyrics {
  /** title + '\n' + artist of the track they belong to. */
  key: string;
  status: 'loading' | 'synced' | 'plain' | 'none' | 'error';
  lines: LyricLine[];
  plain: string | null;
}

export interface WidgetItem { id: string; name: string; description: string; enabled: boolean; locked: boolean }

export type HostMessage =
  | { type: 'hello'; app: string; version: string; dataDir: string; runtime: string; webview: string }
  | { type: 'audio-status'; status: AudioStatus }
  | { type: 'track'; track: Track | null }
  | { type: 'lyrics'; lyrics: Lyrics | null }
  | { type: 'widgets'; items: WidgetItem[]; hidden: boolean }
  | { type: 'widget-init'; id: string; locked: boolean; keepAspect: boolean; options: Record<string, unknown>; lyricsOffsetMs: number }
  | { type: 'widget-state'; locked: boolean }
  | { type: 'pointer'; kind: 'enter' | 'move' | 'leave' | 'down' | 'up'; x: number; y: number; clicks: number };

export type WebMessage =
  | { type: 'hello' }
  | { type: 'open-data-dir' }
  | { type: 'media'; command: 'toggle' | 'next' | 'previous' }
  | { type: 'widget-set'; id: string; enabled?: boolean; locked?: boolean }
  | { type: 'widget-reset'; id: string }
  | { type: 'widgets-hidden'; hidden: boolean }
  | { type: 'drag-start' | 'open-dashboard' }
  | { type: 'resize-start'; keepAspect: boolean }
  | { type: 'options'; options: Record<string, unknown> };

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

const webview: WebViewBridge | undefined = (window as unknown as { chrome?: { webview?: WebViewBridge } })
  .chrome?.webview;

/** True when running inside the app (false in a normal browser during development). */
export const inHost = webview !== undefined;

export function send(message: WebMessage): void {
  webview?.postMessage(message);
}

export function onMessage(handler: (message: HostMessage) => void): void {
  webview?.addEventListener('message', (e) => handler(e.data as HostMessage));
}

/** The host hands over the audio frame buffer after each `hello`. */
export function onSharedBuffer(handler: (buffer: ArrayBuffer, meta: SharedBufferMeta) => void): void {
  webview?.addEventListener('sharedbufferreceived', (e) => handler(e.getBuffer(), e.additionalData));
}

export function releaseBuffer(buffer: ArrayBuffer): void {
  webview?.releaseBuffer(buffer);
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
