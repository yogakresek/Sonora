// Runtime shared by every desktop widget: talks to the host, owns the audio reader, handles
// moving/resizing/locking, and drives the widget's frame loop.

import './widget.css';
import { AudioReader } from '../audio';
import { onMessage, send } from '../bridge';
import { createQueue } from './queue';
import { createVisualizer } from './visualizer';
import { createLyrics } from './lyrics';
import { createStar } from './star';
import { createVinyl } from './vinyl';
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

const state: WidgetState = { track: null, lyrics: null, locked: false, options: {}, lyricsOffsetMs: 0, calm: false, queue: null };
let keepAspect = false;

const ctx: WidgetContext = { root, stage, state };
const widget: WidgetModule =
  id === 'lyrics' ? createLyrics(ctx) : id === 'queue' ? createQueue(ctx) : id === 'star' ? createStar(ctx)
  : id === 'vinyl' ? createVinyl(ctx) : createVisualizer(ctx);
/** Full-screen ambiences (Suasana): never dragged or resized; their scene handles the pointer. */
const ambience = id === 'star' || id === 'vinyl';
const audio = new AudioReader();

// ------------------------------------------------------------------ host messages

onMessage((msg) => {
  switch (msg.type) {
    case 'widget-init':
      state.locked = msg.locked;
      state.options = msg.options ?? {};
      state.lyricsOffsetMs = msg.lyricsOffsetMs;
      keepAspect = msg.keepAspect;
      state.calm = !!msg.calm;
      setFps(msg.fps);
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
    case 'queue':
      state.queue = msg.queue;
      break;
    case 'widget-options':
      state.options = msg.options ?? {};
      break;
    case 'prefs':
      state.lyricsOffsetMs = msg.lyricsOffsetMs;
      state.calm = !!msg.calm;
      setFps(msg.fps);
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
let sliding: HTMLElement | null = null;

function elementAt(x: number, y: number): Element | null {
  const dpr = window.devicePixelRatio || 1;
  return document.elementFromPoint(x / dpr, y / dpr);
}

// Clickable: a button marked data-nodrag itself, or any button inside a data-nodrag area.
// (Only the second form used to count, so the queue's song rows were dragged instead of clicked.)
const CLICKABLE = 'button[data-nodrag]:not(:disabled), [data-nodrag] button:not(:disabled)';

/**
 * Sliders ([data-slider], e.g. the song's progress) get "slide" events while the button is held:
 * detail = { phase: 'start' | 'move' | 'end', fraction: 0..1 along the bar's width }.
 */
function slide(el: HTMLElement, phase: 'start' | 'move' | 'end', x: number): void {
  const dpr = window.devicePixelRatio || 1;
  // Measure along the bar itself ([data-slider-track]), not the labels beside it.
  const r = (el.querySelector('[data-slider-track]') ?? el).getBoundingClientRect();
  const fraction = r.width > 0 ? Math.min(1, Math.max(0, (x / dpr - r.left) / r.width)) : 0;
  el.dispatchEvent(new CustomEvent('slide', { detail: { phase, fraction } }));
}

function setHovered(el: HTMLElement | null): void {
  if (el === hovered) return;
  hovered?.classList.remove('is-hover');
  hovered = el;
  hovered?.classList.add('is-hover');
}

function onPointer(kind: string, x: number, y: number, clicks: number): void {
  widget.pointer?.(kind, x, y);
  if (state.locked) return;
  if (sliding) {
    // The press belongs to the slider until release, wherever the pointer goes.
    if (kind === 'move') slide(sliding, 'move', x);
    if (kind === 'up') {
      slide(sliding, 'end', x);
      sliding.classList.remove('is-active');
      sliding = null;
      root.classList.remove('w--sliding');
    }
    wake();
    return;
  }
  const target = kind === 'leave' ? null : elementAt(x, y);
  const button = target?.closest<HTMLElement>(CLICKABLE) ?? null;
  const slider = button ? null : target?.closest<HTMLElement>('[data-slider]:not([aria-disabled="true"])') ?? null;

  switch (kind) {
    case 'enter':
    case 'move':
      root.classList.add('w--hover');
      setHovered(button ?? slider);
      break;
    case 'leave':
      root.classList.remove('w--hover');
      setHovered(null);
      break;
    case 'down':
      if (ambience && !button && !slider) return; // the scene itself isn't dragged or double-clicked
      if (clicks >= 2 && !button) {
        send({ type: 'open-dashboard' });
        return;
      }
      if (button) {
        pressed = button;
        button.classList.add('is-active');
      } else if (slider) {
        sliding = slider;
        slider.classList.add('is-active');
        root.classList.add('w--sliding');
        slide(slider, 'start', x);
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
let MIN_FRAME_MS = 1000 / 60 - 2; // small slack so a 60 Hz screen never skips a frame
function setFps(fps: number | undefined): void {
  MIN_FRAME_MS = 1000 / Math.max(15, Math.min(60, fps || 60)) - 2;
}
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

// Say hello until the host answers with widget-init: a hello lost while the page and host were
// still connecting would otherwise leave the widget empty until it is re-created.
let initialised = false;
let helloTries = 0;
function hello(): void {
  if (initialised) return;
  send({ type: 'hello' });
  if (++helloTries < 20) setTimeout(hello, 1000);
}
onMessage((msg) => { if (msg.type === 'widget-init') initialised = true; });
hello();
