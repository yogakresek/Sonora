// Runtime shared by every desktop widget: talks to the host, owns the audio reader, handles
// moving/resizing/locking, and drives the widget's frame loop.

import './widget.css';
import { AudioReader } from '../audio';
import { onMessage, send } from '../bridge';
import { createCover } from './cover';
import { createLyrics } from './lyrics';
import type { WidgetContext, WidgetModule, WidgetState } from './types';

const id = new URLSearchParams(location.search).get('id') ?? 'cover';
const root = document.getElementById('root')!;
root.className = `w w--${id}`;
root.innerHTML = `
  <div class="w__stage"></div>
  <div class="w__frame" aria-hidden="true"></div>
  <div class="w__grip" title="Ubah ukuran" aria-hidden="true"></div>
`;
const stage = root.querySelector<HTMLElement>('.w__stage')!;

const state: WidgetState = { track: null, lyrics: null, locked: false, options: {}, lyricsOffsetMs: 0 };
let keepAspect = false;

const ctx: WidgetContext = { root, stage, state };
const widget: WidgetModule = id === 'lyrics' ? createLyrics(ctx) : createCover(ctx);
const audio = new AudioReader();

// ------------------------------------------------------------------ host messages

onMessage((msg) => {
  switch (msg.type) {
    case 'widget-init':
      state.locked = msg.locked;
      state.options = msg.options ?? {};
      state.lyricsOffsetMs = msg.lyricsOffsetMs;
      keepAspect = msg.keepAspect;
      break;
    case 'widget-state':
      state.locked = msg.locked;
      break;
    case 'track':
      state.track = msg.track;
      break;
    case 'lyrics':
      state.lyrics = msg.lyrics;
      break;
    case 'pointer':
      onPointer(msg.kind, msg.x, msg.y, msg.clicks);
      return;
    default:
      return;
  }
  root.classList.toggle('locked', state.locked);
  widget.update(state);
  wake();
});

// ------------------------------------------------------------------ pointer (driven by the host)
//
// Desktop widgets don't receive the mouse themselves: the host watches it and sends "pointer"
// messages in physical pixels relative to the widget. A press is answered with drag-start,
// resize-start, or nothing (when it lands on a button, which is then clicked on release).

let gesture: 'drag' | 'resize' | null = null;
let pressed: HTMLElement | null = null;
let hovered: HTMLElement | null = null;

function elementAt(x: number, y: number): Element | null {
  const dpr = window.devicePixelRatio || 1;
  return document.elementFromPoint(x / dpr, y / dpr);
}

function setHovered(el: HTMLElement | null): void {
  if (el === hovered) return;
  hovered?.classList.remove('is-hover');
  hovered = el;
  hovered?.classList.add('is-hover');
}

function onPointer(kind: string, x: number, y: number, clicks: number): void {
  if (state.locked) return;
  const target = kind === 'leave' ? null : elementAt(x, y);
  const button = target?.closest<HTMLElement>('[data-nodrag] button:not(:disabled)') ?? null;

  switch (kind) {
    case 'enter':
    case 'move':
      root.classList.add('w--hover');
      setHovered(button);
      break;
    case 'leave':
      root.classList.remove('w--hover');
      setHovered(null);
      break;
    case 'down':
      if (clicks >= 2 && !button) {
        send({ type: 'open-dashboard' });
        return;
      }
      if (button) {
        pressed = button;
        button.classList.add('is-active');
      } else if (target?.closest('.w__grip')) {
        gesture = 'resize';
        send({ type: 'resize-start', keepAspect });
      } else {
        gesture = 'drag';
        send({ type: 'drag-start' });
      }
      root.classList.toggle('w--moving', gesture !== null);
      break;
    case 'up':
      if (pressed) {
        pressed.classList.remove('is-active');
        if (button === pressed) pressed.click();
        pressed = null;
      }
      gesture = null;
      root.classList.remove('w--moving');
      break;
  }
  wake();
}

root.addEventListener('contextmenu', (e) => e.preventDefault());

// ------------------------------------------------------------------ frame loop

// Full speed while music plays or something animates; ~12 fps when everything is still.
let lastDraw = 0;
const MIN_FRAME_MS = 1000 / 60 - 2; // small slack so a 60 Hz screen never skips a frame
const IDLE_FRAME_MS = 80;
let busy = true;

function wake(): void {
  busy = true;
}

function loop(now: number): void {
  audio.read();
  const f = audio.frame;
  const active = busy || !f.silent || gesture !== null;
  // Audio frames arrive at 60 Hz, so drawing faster on a 144 Hz screen only costs GPU time.
  const interval = active ? MIN_FRAME_MS : IDLE_FRAME_MS;
  if (now - lastDraw >= interval) {
    busy = widget.frame(f, Math.min(0.1, (now - lastDraw) / 1000), now);
    lastDraw = now;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

new ResizeObserver(() => wake()).observe(root);

send({ type: 'hello' });
