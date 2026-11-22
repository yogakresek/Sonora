import type { AudioFrame } from '../audio';
import type { Lyrics, Track } from '../bridge';

export const DEFAULT_PALETTE = ['#a855f7', '#22d3ee', '#f472b6'];

export interface WidgetState {
  track: Track | null;
  lyrics: Lyrics | null;
  locked: boolean;
  options: Record<string, unknown>;
  lyricsOffsetMs: number;
}

export interface WidgetModule {
  /** Track, lyrics or options changed. */
  update(state: WidgetState): void;
  /** Draw one frame. Return true while something is still moving, so the loop keeps full speed. */
  frame(audio: AudioFrame, dt: number, now: number): boolean;
}

export interface WidgetContext {
  root: HTMLElement;
  stage: HTMLElement;
  state: WidgetState;
}

export function paletteOf(track: Track | null): string[] {
  return track?.palette && track.palette.length > 0 ? track.palette : DEFAULT_PALETTE;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Sizes a canvas to its CSS box at device resolution; returns the scale. */
export function fitCanvas(canvas: HTMLCanvasElement): number {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}
