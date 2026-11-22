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
}

export type HostMessage =
  | { type: 'hello'; app: string; version: string; dataDir: string; runtime: string; webview: string }
  | { type: 'audio-status'; status: AudioStatus }
  | { type: 'track'; track: Track | null };

export type WebMessage =
  | { type: 'hello' }
  | { type: 'open-data-dir' }
  | { type: 'media'; command: 'toggle' | 'next' | 'previous' };

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

/** Where the track is now, extrapolated from the last report. */
export function trackPosition(track: Track, now = Date.now()): number {
  const pos = track.playing ? track.positionMs + (now - track.updatedAt) : track.positionMs;
  return track.durationMs > 0 ? Math.min(Math.max(pos, 0), track.durationMs) : Math.max(pos, 0);
}
