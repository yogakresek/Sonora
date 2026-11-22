// Lyrics: the line being sung, large, with the one before and after it faded.
// LRCLIB gives a time per line; words inside a line light up on an estimate that spreads the
// line's time over its words by length, which reads naturally for most songs.

import type { AudioFrame } from '../audio';
import { trackKey, trackPosition, type LyricLine, type Track } from '../bridge';
import { paletteOf, type WidgetContext, type WidgetModule, type WidgetState } from './types';

interface Word { el: HTMLElement; at: number; sung: boolean }

const HINTS: Record<string, string> = {
  idle: 'Putar lagu untuk menampilkan lirik',
  loading: 'Mencari lirik…',
  none: 'Lirik lagu ini tidak ditemukan',
  plain: 'Lirik lagu ini belum punya waktu per baris',
  error: 'Gagal memuat lirik (cek koneksi)',
};

export function createLyrics(ctx: WidgetContext): WidgetModule {
  const box = document.createElement('div');
  box.className = 'lyr';
  box.innerHTML = `
    <div class="lyr__line lyr__line--side lyr__line--prev"></div>
    <div class="lyr__line lyr__line--cur"></div>
    <div class="lyr__line lyr__line--side lyr__line--next"></div>`;
  const prevEl = box.querySelector<HTMLElement>('.lyr__line--prev')!;
  const curEl = box.querySelector<HTMLElement>('.lyr__line--cur')!;
  const nextEl = box.querySelector<HTMLElement>('.lyr__line--next')!;
  const hint = document.createElement('div');
  hint.className = 'lyr__hint';
  ctx.stage.append(box, hint);

  let track: Track | null = null;
  let lines: LyricLine[] = [];
  let offset = 0;
  let index = -2;
  let showingDots = false;
  let words: Word[] = [];
  let dots: HTMLElement | null = null;

  // Text scales with the box.
  new ResizeObserver(() => {
    const w = ctx.root.clientWidth, h = ctx.root.clientHeight;
    box.style.fontSize = `${Math.max(12, Math.min(h / 4.4, w / 11.5))}px`;
  }).observe(ctx.root);

  function clear(): void {
    prevEl.textContent = curEl.textContent = nextEl.textContent = '';
    words = [];
    dots = null;
    index = -2;
  }

  function makeDots(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'lyr__dots';
    el.innerHTML = '<i></i><i></i><i></i>';
    return el;
  }

  function render(idx: number, pos: number): void {
    const cur = idx >= 0 ? lines[idx] : null;
    const next = lines[idx + 1] ?? null;
    prevEl.textContent = idx > 0 ? lines[idx - 1].text : '';
    nextEl.textContent = next?.text ?? '';
    curEl.textContent = '';
    words = [];
    dots = null;

    // Before the first line (or on an empty line): a short instrumental marker.
    const waitFirst = !cur && next && next.t - pos > 2500;
    if ((cur && cur.text.trim() === '') || waitFirst) {
      dots = makeDots();
      curEl.append(dots);
    } else if (cur) {
      const parts = cur.text.split(/(\s+)/);
      const tokens = parts.filter((p) => p.trim().length > 0);
      const chars = tokens.reduce((n, t) => n + t.length + 1, 0);
      const until = next ? next.t : cur.t + 5000;
      const span = Math.min(until - cur.t, Math.max(1200, chars * 85)) * 0.9;
      let acc = 0;
      for (const part of parts) {
        if (part.trim().length === 0) {
          curEl.append(part);
          continue;
        }
        const el = document.createElement('span');
        el.className = 'lyr__word';
        el.textContent = part;
        words.push({ el, at: cur.t + (acc / chars) * span, sung: false });
        acc += part.length + 1;
        curEl.append(el);
      }
    }

    box.classList.remove('lyr--shift');
    void box.offsetWidth; // restart the animation
    box.classList.add('lyr--shift');
  }

  function findIndex(pos: number): number {
    // Lines are sorted; start from where we were, since time mostly moves forward.
    let i = Math.max(-1, Math.min(index, lines.length - 1));
    if (i >= 0 && lines[i].t > pos) i = -1;
    while (i + 1 < lines.length && lines[i + 1].t <= pos) i++;
    return i;
  }

  return {
    update(state: WidgetState): void {
      const trackChanged = track?.title !== state.track?.title || track?.artist !== state.track?.artist;
      track = state.track;
      offset = state.lyricsOffsetMs;
      box.style.setProperty('--glow', paletteOf(track)[0]);

      const l = state.lyrics;
      const valid = track && l && l.key === trackKey(track);
      const next = valid && l.status === 'synced' ? l.lines : [];
      if (next !== lines || trackChanged) {
        lines = next;
        clear();
      }
      hint.textContent = !track ? HINTS.idle : !valid ? HINTS.loading : l.status === 'synced' ? '' : HINTS[l.status] ?? '';
    },

    frame(f: AudioFrame): boolean {
      if (!track || lines.length === 0) {
        if (index !== -2) clear();
        return false;
      }

      const pos = trackPosition(track) - offset;
      const idx = findIndex(pos);
      const wantDots = idx < 0 && lines[0].t - pos > 2500;
      if (idx !== index || wantDots !== showingDots) {
        index = idx;
        showingDots = wantDots;
        render(idx, pos);
      }

      for (const w of words) {
        const sung = pos >= w.at;
        if (sung !== w.sung) {
          w.sung = sung;
          w.el.classList.toggle('lyr__word--sung', sung);
        }
      }

      curEl.style.transform = `scale(${1 + 0.03 * f.kick})`;
      dots?.style.setProperty('--k', f.kick.toFixed(3));
      return track.playing;
    },
  };
}
