// The lyrics widget, in four styles sharing one timing engine.
//   karaoke – the sung line large, the lines before and after faded
//   focus   – only the sung line, very large
//   flow    – the whole song as a list that glides along, far lines dimmer and softer
//   card    – a dark panel with the cover, readable on any wallpaper
// LRCLIB times each line; inside a line, words light up on an estimate that spreads the line's
// time over its words by length.

import type { AudioFrame } from '../audio';
import { trackKey, trackPosition, type LyricLine, type Track } from '../bridge';
import {
  LYRICS_DEFAULTS, resolvePalette, withDefaults,
  type LyricsOptions, type LyricsStyle, type WidgetContext, type WidgetModule, type WidgetState,
} from './types';

interface Word { el: HTMLElement; at: number; sung: boolean }

const HINTS: Record<string, string> = {
  idle: 'Putar lagu untuk menampilkan lirik',
  loading: 'Mencari lirik…',
  none: 'Lirik lagu ini tidak ditemukan',
  plain: 'Lirik lagu ini belum punya waktu per baris',
  error: 'Gagal memuat lirik (cek koneksi)',
};

const GAP_MS = 2500; // a pause longer than this before the first line shows the dots

export function createLyrics(ctx: WidgetContext): WidgetModule {
  const box = document.createElement('div');
  const hint = document.createElement('div');
  hint.className = 'lyr__hint';
  ctx.stage.append(box, hint);

  let opts: LyricsOptions = LYRICS_DEFAULTS;
  let builtStyle: LyricsStyle | null = null;
  let track: Track | null = null;
  let lines: LyricLine[] = [];
  let offset = 0;
  let calm = false;
  let index = -2;
  let dotsShown = false;
  let words: Word[] = [];
  let dots: HTMLElement | null = null;
  let active: HTMLElement | null = null;

  // Elements of the current style.
  let prevEl: HTMLElement | null = null;
  let curEl: HTMLElement | null = null;
  let nextEl: HTMLElement | null = null;
  let listEl: HTMLElement | null = null;
  let lineEls: HTMLElement[] = [];
  let coverEl: HTMLImageElement | null = null;
  let titleEl: HTMLElement | null = null;

  // ---------------------------------------------------------------- layout

  function resize(): void {
    const w = ctx.root.clientWidth, h = ctx.root.clientHeight;
    const base = Math.max(10, Math.min(h / 4.4, w / 11.5)) * opts.size;
    box.style.fontSize = `${base}px`;
    if (listEl) centerActive(false);
  }
  new ResizeObserver(resize).observe(ctx.root);

  function build(): void {
    builtStyle = opts.style;
    box.className = `lyr lyr--${opts.style}`;
    prevEl = curEl = nextEl = listEl = titleEl = null;
    coverEl = null;
    lineEls = [];
    words = [];
    dots = null;
    active = null;
    index = -2;

    const line = (cls: string) => `<div class="lyr__line ${cls}"></div>`;
    switch (opts.style) {
      case 'focus':
        box.innerHTML = line('lyr__line--cur');
        break;
      case 'kinetic':
        box.innerHTML = line('lyr__line--cur lyr__kin');
        break;
      case 'flow':
        box.innerHTML = '<div class="lyr__list"></div>';
        listEl = box.querySelector('.lyr__list');
        fillList();
        break;
      case 'card':
        box.innerHTML = `
          <div class="lyr__card">
            <div class="lyr__meta"><img class="lyr__cover" alt=""><div class="lyr__title"></div></div>
            ${line('lyr__line--cur')}
            ${line('lyr__line--side lyr__line--next')}
          </div>`;
        coverEl = box.querySelector('.lyr__cover');
        titleEl = box.querySelector('.lyr__title');
        break;
      default:
        box.innerHTML = line('lyr__line--side lyr__line--prev') + line('lyr__line--cur') + line('lyr__line--side lyr__line--next');
    }
    prevEl = box.querySelector('.lyr__line--prev');
    curEl = box.querySelector('.lyr__line--cur');
    nextEl = box.querySelector('.lyr__line--next');
    applyLook();
    resize();
  }

  function applyLook(): void {
    box.classList.toggle('lyr--glow', opts.glow);
    box.classList.toggle('lyr--calm', calm);
    box.dataset.align = opts.align;
    box.style.fontWeight = String(opts.weight);
    box.style.setProperty('--glow', resolvePalette(opts.colors, opts.custom, track)[0]);
    box.classList.toggle('lyr--empty', !track || lines.length === 0);
    if (coverEl) {
      if (track?.cover) coverEl.src = track.cover;
      coverEl.hidden = !track?.cover;
    }
    if (titleEl) titleEl.innerHTML = track ? `<b>${esc(track.title)}</b><span>${esc(track.artist)}</span>` : '';
  }

  function fillList(): void {
    if (!listEl) return;
    listEl.innerHTML = '';
    lineEls = lines.map((l) => {
      const el = document.createElement('div');
      el.className = 'lyr__line';
      el.textContent = l.text.trim() === '' ? '♪' : l.text;
      listEl!.append(el);
      return el;
    });
    active = null;
    listEl.style.transform = 'translateY(0)';
  }

  // ---------------------------------------------------------------- words

  /** Replaces el's text with word spans timed across the line; returns them. */
  function fillWords(el: HTMLElement, i: number): Word[] {
    const cur = lines[i];
    const next = lines[i + 1];
    el.textContent = '';
    const parts = cur.text.split(/(\s+)/);
    const chars = parts.filter((p) => p.trim()).reduce((n, t) => n + t.length + 1, 0) || 1;
    const until = next ? next.t : cur.t + 5000;
    const span = Math.min(until - cur.t, Math.max(1200, chars * 85)) * 0.9;
    const out: Word[] = [];
    let acc = 0;
    for (const part of parts) {
      if (!part.trim()) { el.append(part); continue; }
      const w = document.createElement('span');
      w.className = 'lyr__word';
      w.textContent = part;
      if (opts.style === 'kinetic') decorate(w, part, out.length, i, parts.filter((p) => p.trim()).length);
      out.push({ el: w, at: cur.t + (acc / chars) * span, sung: false });
      acc += part.length + 1;
      el.append(w);
    }
    return out;
  }

  function makeDots(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'lyr__dots';
    el.innerHTML = '<i></i><i></i><i></i>';
    return el;
  }

  // ---------------------------------------------------------------- render a line change

  function render(idx: number, pos: number): void {
    words = [];
    dots = null;
    const cur = idx >= 0 ? lines[idx] : null;
    const next = lines[idx + 1] ?? null;
    const instrumental = (cur && cur.text.trim() === '') || (!cur && next && next.t - pos > GAP_MS);

    if (listEl) {
      if (active) active.textContent = lines[lineEls.indexOf(active)]?.text || '♪';
      lineEls.forEach((el, i) => {
        const d = idx < 0 ? i + 1 : Math.abs(i - idx);
        el.style.setProperty('--d', String(Math.min(d, 6)));
        el.classList.toggle('is-active', i === idx);
      });
      active = idx >= 0 ? lineEls[idx] : null;
      if (active && cur && cur.text.trim() !== '') words = fillWords(active, idx);
      centerActive(true);
      return;
    }

    if (prevEl) prevEl.textContent = idx > 0 ? lines[idx - 1].text : '';
    if (nextEl) nextEl.textContent = next?.text ?? '';
    if (curEl) {
      curEl.textContent = '';
      if (instrumental) {
        dots = makeDots();
        curEl.append(dots);
      } else if (cur) {
        words = fillWords(curEl, idx);
      }
    }
    box.classList.remove('lyr--shift');
    void box.offsetWidth; // restart the line-change animation
    box.classList.add('lyr--shift');
  }

  function centerActive(animate: boolean): void {
    if (!listEl) return;
    const target = active ?? lineEls[0];
    if (!target) return;
    const y = target.offsetTop + target.offsetHeight / 2 - box.clientHeight / 2;
    listEl.style.transition = animate ? '' : 'none';
    listEl.style.transform = `translateY(${-y}px)`;
  }

  function findIndex(pos: number): number {
    let i = Math.max(-1, Math.min(index, lines.length - 1));
    if (i >= 0 && lines[i].t > pos) i = -1;
    while (i + 1 < lines.length && lines[i + 1].t <= pos) i++;
    return i;
  }

  return {
    update(state: WidgetState): void {
      const prevOpts = opts;
      opts = withDefaults(LYRICS_DEFAULTS, state.options);
      const trackChanged = track?.title !== state.track?.title || track?.artist !== state.track?.artist;
      track = state.track;
      offset = state.lyricsOffsetMs;
      calm = state.calm;

      const l = state.lyrics;
      const valid = !!(track && l && l.key === trackKey(track));
      const nextLines = valid && l!.status === 'synced' ? l!.lines : [];
      const linesChanged = nextLines !== lines || trackChanged;
      lines = nextLines;

      if (builtStyle !== opts.style) build();
      else if (linesChanged) {
        index = -2;
        if (listEl) fillList();
      }
      if (prevOpts.size !== opts.size) resize();
      applyLook();

      hint.textContent = !track ? HINTS.idle : !valid ? HINTS.loading : l!.status === 'synced' ? '' : HINTS[l!.status] ?? '';
    },

    frame(f: AudioFrame): boolean {
      if (!track || lines.length === 0) {
        if (index !== -2) {
          index = -2;
          if (curEl) curEl.textContent = '';
          if (prevEl) prevEl.textContent = '';
          if (nextEl) nextEl.textContent = '';
        }
        return false;
      }

      const pos = trackPosition(track) - offset;
      const idx = findIndex(pos);
      const wantDots = idx < 0 && lines[0].t - pos > GAP_MS;
      if (idx !== index || wantDots !== dotsShown) {
        index = idx;
        dotsShown = wantDots;
        render(idx, pos);
      }

      for (const w of words) {
        const sung = pos >= w.at;
        if (sung !== w.sung) {
          w.sung = sung;
          w.el.classList.toggle('lyr__word--sung', sung);
        }
      }

      const k = opts.beat && !calm ? f.kick : 0;
      const pulsing = (listEl ? active : curEl);
      if (pulsing) pulsing.style.scale = String(1 + 0.03 * k);
      dots?.style.setProperty('--k', calm ? '0' : f.kick.toFixed(3));
      return track.playing;
    },
  };
}

// ------------------------------------------------------------------ kinetic typography

/** Fonts that ship with Windows 10/11, so nothing has to be downloaded. */
const KINETIC_FONTS: { family: string; weight: number; italic?: boolean; upper?: boolean; spacing?: string }[] = [
  { family: '"Segoe UI Variable Display", "Segoe UI"', weight: 900 },
  { family: '"Segoe UI Variable Display", "Segoe UI"', weight: 300, spacing: '-0.02em' },
  { family: 'Georgia, serif', weight: 700, italic: true },
  { family: 'Bahnschrift, "Segoe UI"', weight: 700, upper: true, spacing: '0.02em' },
  { family: 'Impact, "Arial Black", sans-serif', weight: 400, upper: true, spacing: '0.03em' },
  { family: 'Consolas, "Cascadia Code", monospace', weight: 700 },
  { family: '"Segoe Script", cursive', weight: 700 },
  { family: '"Palatino Linotype", "Book Antiqua", serif', weight: 400, italic: true },
  { family: '"Ink Free", "Segoe Print", cursive', weight: 400 },
];
const KINETIC_ANIMS = ['pop', 'rise', 'drop', 'blur', 'stretch'];

/** Gives a word its own look: font, size, tilt, colour and entrance. Stable for the same word in the same line. */
function decorate(el: HTMLElement, word: string, i: number, line: number, count: number): void {
  const rand = rng(hash(`${word}:${i}:${line}`));
  const pick = rand() < 0.3 ? 0 : 1 + Math.floor(rand() * (KINETIC_FONTS.length - 1));
  const font = KINETIC_FONTS[pick];
  const len = word.replace(/[^\p{L}\p{N}]/gu, '').length;
  let size = len <= 2 ? 0.68 + rand() * 0.18 : len >= 6 ? 1.08 + rand() * 0.42 : 0.84 + rand() * 0.34;
  if (i === count - 1) size += 0.14; // the line lands on its last word
  el.classList.add('kin', `kin--${KINETIC_ANIMS[Math.floor(rand() * KINETIC_ANIMS.length)]}`);
  if (rand() < 0.28) el.classList.add('kin--accent');
  el.style.fontFamily = font.family;
  el.style.fontWeight = String(font.weight);
  el.style.fontStyle = font.italic ? 'italic' : 'normal';
  el.style.fontSize = `${size.toFixed(2)}em`;
  if (font.spacing) el.style.letterSpacing = font.spacing;
  if (font.upper || rand() < 0.12) el.style.textTransform = 'uppercase';
  el.style.setProperty('--rot', rand() < 0.35 ? `${(rand() * 10 - 5).toFixed(1)}deg` : '0deg');
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
