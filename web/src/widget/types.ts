import type { AudioFrame } from '../audio';
import type { Lyrics, QueueState, Track } from '../bridge';

export const DEFAULT_PALETTE = ['#a855f7', '#22d3ee', '#f472b6'];

/** Hand-picked palettes for when the cover's own colours aren't wanted. */
export const PRESETS: Record<string, { name: string; colors: string[] }> = {
  aurora: { name: 'Aurora', colors: ['#a78bfa', '#22d3ee', '#34d399'] },
  sunset: { name: 'Senja', colors: ['#fb7185', '#f59e0b', '#f472b6'] },
  ocean: { name: 'Laut', colors: ['#38bdf8', '#6366f1', '#2dd4bf'] },
  neon: { name: 'Neon', colors: ['#f0abfc', '#a3e635', '#22d3ee'] },
  mono: { name: 'Mono', colors: ['#f4f4f5', '#a1a1aa', '#e4e4e7'] },
};

// ------------------------------------------------------------------ options

export type VisualizerStyle = 'halo' | 'pulse' | 'bars' | 'vinyl' | 'minimal';

export interface VisualizerOptions {
  style: VisualizerStyle;
  /** 'cover', a key of PRESETS, or 'custom'. */
  colors: string;
  custom: string[];
  /** 0.5..1.5: how many spokes/bars. */
  density: number;
  glow: boolean;
  beat: boolean;
  showTitle: boolean;
}

export const VISUALIZER_DEFAULTS: VisualizerOptions = {
  style: 'halo',
  colors: 'cover',
  custom: ['#8b5cf6', '#22d3ee', '#f472b6'],
  density: 1,
  glow: true,
  beat: true,
  showTitle: false,
};

export const VISUALIZER_STYLES: { id: VisualizerStyle; name: string; hint: string }[] = [
  { id: 'halo', name: 'Halo', hint: 'Jari-jari cahaya di sekeliling cover' },
  { id: 'pulse', name: 'Pulse', hint: 'Gelombang lembut yang bernapas' },
  { id: 'bars', name: 'Bars', hint: 'Bar klasik di bawah cover' },
  { id: 'vinyl', name: 'Vinyl', hint: 'Piringan hitam yang berputar' },
  { id: 'minimal', name: 'Minimal', hint: 'Cover bercahaya dan judul lagu' },
];

export type LyricsStyle = 'karaoke' | 'focus' | 'flow' | 'card' | 'kinetic';

export interface LyricsOptions {
  style: LyricsStyle;
  /** 0.7..1.4 text scale. */
  size: number;
  weight: 600 | 700 | 800;
  align: 'left' | 'center' | 'right';
  glow: boolean;
  beat: boolean;
  colors: string;
  custom: string[];
}

export const LYRICS_DEFAULTS: LyricsOptions = {
  style: 'karaoke',
  size: 1,
  weight: 800,
  align: 'center',
  glow: true,
  beat: true,
  colors: 'cover',
  custom: ['#8b5cf6', '#22d3ee', '#f472b6'],
};

export const LYRICS_STYLES: { id: LyricsStyle; name: string; hint: string }[] = [
  { id: 'karaoke', name: 'Karaoke', hint: 'Tiga baris, kata menyala satu per satu' },
  { id: 'focus', name: 'Fokus', hint: 'Satu baris besar di tengah' },
  { id: 'flow', name: 'Mengalir', hint: 'Daftar lirik yang bergulir halus' },
  { id: 'card', name: 'Kartu', hint: 'Panel gelap, terbaca di wallpaper terang' },
  { id: 'kinetic', name: 'Kinetik', hint: 'Kata muncul satu per satu, tiap kata bergaya sendiri' },
];

export type QueueStyle = 'arc' | 'list';

export interface QueueOptions {
  style: QueueStyle;
  colors: string;
  custom: string[];
  /** How many upcoming songs to show. */
  count: number;
  showHistory: boolean;
}

export const QUEUE_DEFAULTS: QueueOptions = {
  style: 'arc',
  colors: 'cover',
  custom: ['#8b5cf6', '#22d3ee', '#f472b6'],
  count: 5,
  showHistory: true,
};

export const QUEUE_STYLES: { id: QueueStyle; name: string; hint: string }[] = [
  { id: 'arc', name: 'Lengkung', hint: 'Cover besar, lagu berikutnya melengkung di sampingnya' },
  { id: 'list', name: 'Daftar', hint: 'Kartu rapi: sedang diputar, lalu antrean' },
];

export function withDefaults<T extends object>(defaults: T, options: Record<string, unknown> | null | undefined): T {
  const out = { ...defaults } as Record<string, unknown>;
  if (options) {
    for (const key of Object.keys(defaults)) {
      const v = options[key];
      if (v !== undefined && v !== null && typeof v === typeof (defaults as Record<string, unknown>)[key]) out[key] = v;
    }
  }
  return out as T;
}

// ------------------------------------------------------------------ widgets

export interface WidgetState {
  track: Track | null;
  lyrics: Lyrics | null;
  locked: boolean;
  options: Record<string, unknown>;
  lyricsOffsetMs: number;
  /** Mode santai: no beat pulsing or flashing, softer and slower motion. */
  calm: boolean;
  queue: QueueState | null;
}

export interface WidgetModule {
  /** Track, lyrics or options changed. */
  update(state: WidgetState): void;
  /** Draw one frame. Return true while something is still moving, so the loop keeps full speed. */
  frame(audio: AudioFrame, dt: number, now: number): boolean;
  destroy?(): void;
}

export interface WidgetContext {
  root: HTMLElement;
  stage: HTMLElement;
  state: WidgetState;
  /** Drawn inside the dashboard rather than on the desktop: no buttons. */
  preview?: boolean;
}

/** The palette a widget should use, given its colour option and the current track. */
export function resolvePalette(colors: string, custom: string[], track: Track | null): string[] {
  if (colors === 'custom' && custom.length >= 3) return custom;
  if (colors in PRESETS) return PRESETS[colors].colors;
  return track?.palette && track.palette.length > 0 ? track.palette : DEFAULT_PALETTE;
}

export function paletteOf(track: Track | null): string[] {
  return resolvePalette('cover', [], track);
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
