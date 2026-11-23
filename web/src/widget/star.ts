// Star Mode: the lyrics become constellations over a sky made from the song's album cover.
//
// Every word is a star. The word being sung lands hard: its star flashes, the word slams in big
// next to it, and the line to it is drawn in an instant. The word before shrinks to a small label
// right away. One lyric line = one constellation; when the next line starts, the old one is
// swept away quickly and a new one grows elsewhere. Before the first line (and for songs without
// timed lyrics) the title and artist form the sky.
//
// Words appear when the singer sings them (the vocal gate shared with the kinetic lyrics, set
// tighter here), and the shapes are stable: the same song always draws the same constellations.
// Every animation is timed in milliseconds, not per frame, so it stays crisp at any frame rate.
// Mode santai only stills the twinkling and the beat pulse; the timing stays sharp.

import type { AudioFrame } from '../audio';
import { send, trackKey, trackPosition, type LyricLine, type Track } from '../bridge';
import { STAR_DEFAULTS, fitCanvas, hexToRgb, resolvePalette, withDefaults, type StarOptions, type WidgetContext, type WidgetModule, type WidgetState } from './types';
import { BUSY_RATE, VocalOnsets, WordGate, estimateWords } from './word-gate';
import { AlbumSky, ICON_NEXT, ICON_PAUSE, ICON_PLAY, ICON_PREV, ICON_STAR, clock, createAmbienceShell, easeOut, lineAt, saveSongShift, songShift } from './ambience';

interface Star {
  x: number; y: number;  // device px
  text: string;
  at: number;            // estimated start (ms into the song)
  sung: boolean;
  shownAt: number;       // performance.now() when it appeared
  lead: boolean;         // the word being sung right now
  leadEnd: number;       // when it stopped being the lead (0 = never was / still is)
  phase: number;         // twinkle phase
}
interface Edge { a: number; b: number; at: number } // at = when its line started drawing (0 = not yet)
interface Constellation { stars: Star[]; edges: Edge[]; fadeFrom: number | null; seed: string }

const FADE_MS = 650;      // an old constellation is swept away
const DRAW_MS = 150;      // a line shoots to the new star
const POP_MS = 190;       // the new word slams in
const SHRINK_MS = 160;    // the previous word steps back
const FLASH_MS = 520;     // the ring burst around a new star
const SKY_STARS = 170;

export function createStar(ctx: WidgetContext): WidgetModule {
  const canvas = document.createElement('canvas');
  canvas.className = 'star__canvas';
  const g = canvas.getContext('2d')!;

  // ---------------------------------------------------------------- now-playing card (interactive)

  const card = document.createElement('div');
  card.className = 'star__card';
  card.dataset.nodrag = '';
  card.innerHTML = `
    <div class="star__cover"><img alt=""></div>
    <div class="star__meta">
      <b class="star__title"></b>
      <span class="star__artist"></span>
      <div class="star__seek" data-slider role="slider" aria-label="Posisi lagu">
        <span class="star__time"></span>
        <div class="star__track" data-slider-track><i class="star__fill"></i><b class="star__knob"></b></div>
        <span class="star__time"></span>
      </div>
      <div class="star__controls">
        <button type="button" data-cmd="previous" aria-label="Lagu sebelumnya">${ICON_PREV}</button>
        <button type="button" data-cmd="toggle" class="star__play" aria-label="Putar/jeda">${ICON_PLAY}</button>
        <button type="button" data-cmd="next" aria-label="Lagu berikutnya">${ICON_NEXT}</button>
      </div>
      <span class="star__note"></span>
    </div>`;
  const coverImg = card.querySelector('img')!;
  const titleEl = card.querySelector<HTMLElement>('.star__title')!;
  const artistEl = card.querySelector<HTMLElement>('.star__artist')!;
  const seekEl = card.querySelector<HTMLElement>('.star__seek')!;
  const [timeNow, timeEnd] = [...card.querySelectorAll<HTMLElement>('.star__time')];
  const noteEl = card.querySelector<HTMLElement>('.star__note')!;
  const btn = (cmd: string) => card.querySelector<HTMLButtonElement>(`[data-cmd="${cmd}"]`)!;
  ctx.stage.append(canvas, card);

  card.querySelector('.star__controls')!.addEventListener('click', (e) => {
    const cmd = (e.target as HTMLElement).closest('button')?.dataset.cmd;
    if (cmd === 'toggle' || cmd === 'next' || cmd === 'previous') send({ type: 'media', command: cmd });
  });

  // Seeking: press and drag along the line (desktop: via the widget runtime's slider events).
  let dragMs: number | null = null;
  let held: { ms: number; at: number; key: string } | null = null;
  seekEl.addEventListener('slide', (e) => {
    const { phase, fraction } = (e as CustomEvent<{ phase: string; fraction: number }>).detail;
    if (!track || !track.canSeek || track.durationMs <= 0) return;
    const ms = fraction * track.durationMs;
    if (phase !== 'end') dragMs = ms;
    else {
      dragMs = null;
      held = { ms, at: Date.now(), key: trackKey(track) };
      send({ type: 'seek', ms: Math.round(ms) });
    }
    paintProgress();
  });

  function songPosition(): number {
    if (!track) return 0;
    if (dragMs !== null) return dragMs;
    if (held && held.key === trackKey(track) && Date.now() - held.at < 1500) {
      return Math.min(track.durationMs, held.ms + (track.playing ? Date.now() - held.at : 0));
    }
    held = null;
    return trackPosition(track);
  }

  let shownSecond = -1;
  function paintProgress(): void {
    if (!track) return;
    const dur = track.durationMs, pos = songPosition();
    seekEl.style.setProperty('--p', (dur > 0 ? Math.min(1, pos / dur) : 0).toFixed(4));
    const sec = Math.floor(pos / 1000);
    if (sec !== shownSecond || dragMs !== null) {
      shownSecond = sec;
      timeNow.textContent = clock(pos);
      timeEnd.textContent = dur > 0 ? clock(dur) : '';
    }
  }

  // The top bar (Keluar, Lirik − / +) and the clickable areas: shared by every ambience.
  const shell = createAmbienceShell(ctx, {
    name: 'Star Mode',
    icon: ICON_STAR,
    areas: () => [card],
    onShift: (step) => {
      if (!key) return;
      shift = Math.max(-3000, Math.min(3000, shift + step));
      saveSongShift(key, shift);
      index = -2; // redraw the current line at its new moment
      shell.paintShift(shift);
    },
  });

  // ---------------------------------------------------------------- state

  let opts: StarOptions = STAR_DEFAULTS;
  let track: Track | null = null;
  let lines: LyricLine[] = [];
  let offset = 0;
  let calm = false;
  let palette: string[] = [];
  let accent: [number, number, number] = [168, 140, 255];

  let key = '';          // track the sky belongs to
  let index = -2;        // lyric line on screen (-1 = the title constellation)
  let current: Constellation | null = null;
  const fading: Constellation[] = [];
  // A word may come 220 ms early on a sung syllable and waits at most 500 ms past its estimate.
  // Chosen on a recorded drum-heavy song (São Paulo, 377 words): it put the words' median 33 ms
  // from their estimates (180/380 was 130 ms late, 250/650 had wider misses), see word-gate.ts.
  const newGate = () => new WordGate(220, 500);
  let gate = newGate();
  const onsets = new VocalOnsets();
  let shift = 0;         // this song's lyric shift set by the user (ms, + = later)
  let titleTimer = 0;
  let lastDraw = 0;

  function resize(): void {
    const w = ctx.root.clientWidth, h = ctx.root.clientHeight;
    card.style.fontSize = `${Math.max(5, Math.min(w, h) / 70)}px`;
    requestAnimationFrame(() => shell.report());
  }
  new ResizeObserver(resize).observe(ctx.root);
  resize();

  // ---------------------------------------------------------------- layout

  /** Places n stars as a wandering walk inside the sky band, away from `avoid`. */
  function layout(n: number, seed: string, W: number, H: number, avoid: { x: number; y: number } | null): { x: number; y: number }[] {
    const rand = rng(hash(seed));
    const L = Math.min(W, H) * (n > 9 ? 0.1 : n > 5 ? 0.12 : 0.145);
    // The band the sky uses: clear of the edges and of the card in the bottom-left corner.
    const x0 = W * 0.1, x1 = W * 0.9, y0 = H * 0.13, y1 = H * 0.68;
    const inside = (p: { x: number; y: number }) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;

    let start = { x: W / 2, y: H * 0.4 };
    let best = -1;
    for (let k = 0; k < 10; k++) {
      const c = { x: W * (0.22 + 0.56 * rand()), y: H * (0.2 + 0.4 * rand()) };
      const score = avoid ? Math.hypot(c.x - avoid.x, c.y - avoid.y) : rand();
      if (score > best) { best = score; start = c; }
    }

    const pts = [start];
    let angle = rand() * Math.PI * 2;
    for (let i = 1; i < n; i++) {
      const prev = pts[i - 1];
      let pick = prev, pickScore = -Infinity, pickAngle = angle;
      for (let k = 0; k < 24; k++) {
        const spread = 1.1 + k * 0.12;
        const a = angle + (rand() - 0.5) * 2 * Math.min(Math.PI, spread);
        const len = L * (0.75 + 0.5 * rand());
        const c = { x: prev.x + Math.cos(a) * len, y: prev.y + Math.sin(a) * len };
        const room = Math.min(...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y)));
        const score = (inside(c) ? 0 : -1e6) + Math.min(room, L * 1.4);
        if (score > pickScore) { pickScore = score; pick = c; pickAngle = a; }
        if (inside(c) && room > L * 0.8) break;
      }
      pts.push({ x: Math.min(x1, Math.max(x0, pick.x)), y: Math.min(y1, Math.max(y0, pick.y)) });
      angle = pickAngle;
    }
    return pts;
  }

  function build(words: { text: string; at: number }[], seed: string): Constellation {
    const W = canvas.width, H = canvas.height;
    const avoid = current && current.stars.length ? centroid(current.stars) : null;
    const pts = layout(words.length, seed, W, H, avoid);
    const rand = rng(hash(seed + '#'));
    const stars: Star[] = words.map((w, i) => ({ ...pts[i], text: w.text, at: w.at, sung: false, shownAt: 0, lead: false, leadEnd: 0, phase: rand() * 6.28 }));
    const edges: Edge[] = [];
    for (let i = 1; i < stars.length; i++) {
      edges.push({ a: i - 1, b: i, at: 0 });
      if (i >= 3 && rand() < 0.32) {
        let near = -1, d = Infinity;
        for (let j = 0; j < i - 1; j++) {
          const dj = Math.hypot(stars[j].x - stars[i].x, stars[j].y - stars[i].y);
          if (dj < d) { d = dj; near = j; }
        }
        if (near >= 0 && d < Math.min(W, H) * 0.2) edges.push({ a: near, b: i, at: 0 });
      }
    }
    return { stars, edges, fadeFrom: null, seed };
  }

  function retire(now: number): void {
    if (current) {
      for (const s of current.stars) if (s.lead) { s.lead = false; s.leadEnd = now; }
      current.fadeFrom = now;
      fading.push(current);
      while (fading.length > 1) fading.shift(); // one old sky at a time: a clean sweep
    }
    current = null;
  }

  function titleSky(now: number): void {
    retire(now);
    if (!track) return;
    const words = `${track.title} · ${track.artist}`.split(/\s+/).filter((w) => w && w !== '·').slice(0, 10);
    current = build(words.map((text) => ({ text, at: 0 })), `${key}|title`);
    titleTimer = now;
  }

  function reveal(c: Constellation, i: number, now: number): void {
    for (const s of c.stars) if (s.lead) { s.lead = false; s.leadEnd = now; }
    const s = c.stars[i];
    s.sung = true;
    s.lead = true;
    s.shownAt = now;
    for (const e of c.edges) if ((e.b === i && c.stars[e.a].sung) || (e.a === i && c.stars[e.b].sung)) e.at = now;
  }

  // ---------------------------------------------------------------- sky layer (album sky + faint stars)

  const albumSky = new AlbumSky();
  const skyLayer = document.createElement('canvas');
  const sg = skyLayer.getContext('2d')!;
  let skyPainted = -1e9;
  let sky: { x: number; y: number; r: number; a: number; p: number }[] = [];

  function drawSky(W: number, H: number, t: number): void {
    if (skyLayer.width !== W || skyLayer.height !== H) {
      skyLayer.width = W; skyLayer.height = H;
      const rand = rng(7);
      sky = Array.from({ length: SKY_STARS }, () => ({ x: rand() * W, y: rand() * H, r: 0.4 + rand() * 1.1, a: 0.12 + rand() * 0.38, p: rand() * 6.28 }));
      skyPainted = -1e9;
    }
    const changed = albumSky.ensure(W, H, t, { album: opts.backdrop, dim: opts.dim, palette });
    const crossing = albumSky.crossing(t);
    const twinkle = opts.twinkle && !calm;
    if (changed || crossing || (twinkle && t - skyPainted > 100) || skyPainted < 0) {
      skyPainted = t;
      sg.clearRect(0, 0, W, H);
      albumSky.draw(sg, t);
      const dpr = W / Math.max(1, ctx.root.clientWidth);
      sg.fillStyle = '#fff';
      for (const s of sky) {
        sg.globalAlpha = s.a * (twinkle ? 0.65 + 0.35 * Math.sin(t * 0.0011 + s.p) : 0.8);
        sg.beginPath();
        sg.arc(s.x, s.y, s.r * dpr, 0, Math.PI * 2);
        sg.fill();
      }
      sg.globalAlpha = 1;
    }
    g.drawImage(skyLayer, 0, 0);
  }

  // ---------------------------------------------------------------- constellations

  function drawConstellation(c: Constellation, alpha: number, now: number, k: number, kick: number): void {
    const [ar, ag, ab] = accent;

    g.lineWidth = Math.max(1, 1.2 * k);
    g.lineCap = 'round';
    for (const e of c.edges) {
      if (!e.at) continue;
      const a = c.stars[e.a], b = c.stars[e.b];
      const p = easeOut(Math.min(1, (now - e.at) / DRAW_MS));
      g.strokeStyle = `rgba(238, 240, 255, ${0.55 * alpha})`;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(a.x + (b.x - a.x) * p, a.y + (b.y - a.y) * p);
      g.stroke();
    }

    for (const s of c.stars) {
      if (!s.sung) continue;
      const age = now - s.shownAt;
      // How "big" the word is: 1 while sung, dropping fast once the next word takes over.
      const big = s.lead ? 1 : s.leadEnd ? Math.max(0, 1 - (now - s.leadEnd) / SHRINK_MS) : 0;
      // The landing: the word arrives 30% larger and snaps down to size.
      const pop = s.lead ? 1 - easeOut(Math.min(1, age / POP_MS)) : 0;
      const a = alpha * Math.min(1, age / 70);
      const tw = opts.twinkle && !calm ? 0.8 + 0.2 * Math.sin(now * 0.004 + s.phase) : 1;

      // The ring burst when a star is born.
      if (age < FLASH_MS && alpha > 0.5) {
        const f = age / FLASH_MS;
        g.strokeStyle = `rgba(${ar},${ag},${ab},${(1 - f) * (calm ? 0.45 : 0.8) * alpha})`;
        g.lineWidth = Math.max(1, 1.6 * k * (1 - f));
        g.beginPath();
        g.arc(s.x, s.y, (10 + 46 * easeOut(f)) * k, 0, Math.PI * 2);
        g.stroke();
      }

      g.fillStyle = `rgba(255,255,255,${a * tw})`;
      g.beginPath();
      g.arc(s.x, s.y, (2.2 + big * 1.6) * k, 0, Math.PI * 2);
      g.fill();
      if (big > 0.04) sparkle(s.x, s.y, k * (1 + pop * 0.5 + (calm ? 0 : kick * 0.25)), a * big, ar, ag, ab);

      const size = (12.5 + 44 * big) * (1 + pop * 0.3) * k * opts.size;
      g.font = `${big > 0.5 ? 800 : 600} ${size}px "Segoe UI Variable Display", "Segoe UI", sans-serif`;
      g.textBaseline = 'top';
      const w = g.measureText(s.text).width;
      let x = s.x - w / 2;
      x = Math.min(canvas.width - w - 12 * k, Math.max(12 * k, x));
      const y = s.y + (8 + 14 * big) * k;
      if (big > 0.3) {
        g.shadowColor = `rgba(${ar},${ag},${ab},${0.6 * a})`;
        g.shadowBlur = 24 * k * big;
      }
      g.fillStyle = `rgba(255,255,255,${a * (0.74 + 0.26 * big)})`;
      g.fillText(s.text, x, y);
      g.shadowBlur = 0;
      g.shadowColor = 'transparent';
    }
  }

  /** A four-pointed star in a thin ring, like a star chart's bright star. */
  function sparkle(x: number, y: number, k: number, a: number, r: number, gg: number, b: number): void {
    const glow = g.createRadialGradient(x, y, 0, x, y, 36 * k);
    glow.addColorStop(0, `rgba(${r},${gg},${b},${0.5 * a})`);
    glow.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = glow;
    g.beginPath();
    g.arc(x, y, 36 * k, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = `rgba(255,255,255,${a})`;
    const long = 16 * k, thin = 2.3 * k;
    g.beginPath();
    for (let i = 0; i < 4; i++) {
      const ang = (Math.PI / 2) * i;
      const cn = Math.cos(ang + Math.PI / 4), sn = Math.sin(ang + Math.PI / 4);
      const px = x + Math.cos(ang) * long, py = y + Math.sin(ang) * long;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      g.lineTo(x + cn * thin, y + sn * thin);
    }
    g.closePath();
    g.fill();

    g.strokeStyle = `rgba(255,255,255,${0.8 * a})`;
    g.lineWidth = Math.max(1, 1.2 * k);
    g.beginPath();
    g.arc(x, y, 11.5 * k, 0, Math.PI * 2);
    g.stroke();
  }

  // ---------------------------------------------------------------- card

  function paintCard(state: WidgetState): void {
    const wasHidden = card.hidden;
    card.hidden = !opts.info || !track;
    if (wasHidden !== card.hidden) requestAnimationFrame(shell.report);
    if (!track) return;
    if (track.cover) coverImg.src = track.cover;
    coverImg.hidden = !track.cover;
    titleEl.textContent = track.title;
    artistEl.textContent = track.artist;
    btn('previous').disabled = !track.canPrevious;
    btn('next').disabled = !track.canNext;
    btn('toggle').disabled = !track.canToggle;
    btn('toggle').innerHTML = track.playing ? ICON_PAUSE : ICON_PLAY;
    seekEl.setAttribute('aria-disabled', String(!track.canSeek || track.durationMs <= 0));
    const l = state.lyrics;
    const status = l && l.key === trackKey(track) ? l.status : 'loading';
    noteEl.textContent = status === 'synced' || status === 'loading' ? '' : 'Lirik bertimer tidak tersedia';
    card.style.setProperty('--accent', `rgb(${accent.join(',')})`);
    shownSecond = -1;
    paintProgress();
  }

  // ---------------------------------------------------------------- module

  return {
    pointer(kind: string): void {
      if (kind === 'enter' || kind === 'move') shell.wake();
    },

    update(state: WidgetState): void {
      opts = withDefaults(STAR_DEFAULTS, state.options);
      calm = state.calm;
      offset = state.lyricsOffsetMs;
      track = state.track;
      palette = resolvePalette('cover', [], track);
      accent = hexToRgb(palette[0]);
      albumSky.loadCover(track?.cover ?? null);
      const l = state.lyrics;
      lines = track && l && l.key === trackKey(track) && l.status === 'synced' ? l.lines : [];
      const k = track ? trackKey(track) : '';
      if (k !== key) {
        key = k;
        index = -2;
        retire(performance.now());
        shift = ctx.preview ? 0 : songShift(key);
        shell.paintShift(shift);
      } else if (index >= 0 && lines.length === 0) {
        index = -2;
      }
      paintCard(state);
    },

    frame(f: AudioFrame, _dt: number, now: number): boolean {
      const onset = onsets.update(f.bands, now);
      fitCanvas(canvas);
      const W = canvas.width, H = canvas.height;
      // Device px per CSS px, times a scale that keeps the sky the same on any screen size.
      const k = (W / Math.max(1, ctx.root.clientWidth)) * Math.max(0.35, Math.min(ctx.root.clientWidth, ctx.root.clientHeight) / 1000);

      if (track) {
        // The global lyric offset (Lirik page), plus this song's own shift (top bar).
        const pos = trackPosition(track) - offset - shift;
        const idx = lines.length ? lineAt(lines, pos, index) : -1;
        if (idx !== index) {
          index = idx;
          if (idx < 0 || lines[idx].text.trim() === '') {
            if (idx < 0 || !current || current.seed.endsWith('|title')) titleSky(now);
            else retire(now);
          } else {
            retire(now);
            current = build(estimateWords(lines[idx], lines[idx + 1]), `${key}|${idx}`);
            gate = newGate();
          }
        }
        if (current) {
          if (current.seed.endsWith('|title')) {
            const n = Math.min(current.stars.length, Math.floor((now - titleTimer) / 450) + 1);
            for (let i = 0; i < n; i++) if (!current.stars[i].sung) reveal(current, i, now);
          } else {
            for (const i of gate.update(current.stars, pos, onset, onsets.rate > BUSY_RATE)) reveal(current, i, now);
          }
        }
      } else if (current) {
        retire(now);
      }

      // Full speed only while something moves; otherwise the sky just twinkles (or rests).
      const busyFor = (c: Constellation) => c.stars.some((s) => s.sung && (now - s.shownAt < FLASH_MS || (s.leadEnd && now - s.leadEnd < SHRINK_MS)));
      const animating = fading.length > 0 || (current ? busyFor(current) : false) || albumSky.crossing(now);
      const playing = !!track?.playing;
      const interval = animating ? 14 : opts.twinkle && !calm ? 50 : playing ? 100 : 250;
      if (now - lastDraw < interval) return animating || playing;
      lastDraw = now;

      g.clearRect(0, 0, W, H);
      drawSky(W, H, now);
      for (let i = fading.length - 1; i >= 0; i--) {
        const c = fading[i];
        const t = (now - c.fadeFrom!) / FADE_MS;
        if (t >= 1) { fading.splice(i, 1); continue; }
        // Swept away: fades fast while shrinking slightly into itself.
        const { x, y } = centroid(c.stars);
        const s = 1 - 0.08 * easeOut(t);
        g.save();
        g.translate(x, y);
        g.scale(s, s);
        g.translate(-x, -y);
        drawConstellation(c, 0.8 * (1 - easeOut(t)), now, k, 0);
        g.restore();
      }
      if (current) drawConstellation(current, 1, now, k, f.kick);

      paintProgress();
      return animating || playing;
    },
  };
}

// ------------------------------------------------------------------ helpers

function centroid(stars: Star[]): { x: number; y: number } {
  const x = stars.reduce((s, p) => s + p.x, 0) / stars.length;
  const y = stars.reduce((s, p) => s + p.y, 0) / stars.length;
  return { x, y };
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

