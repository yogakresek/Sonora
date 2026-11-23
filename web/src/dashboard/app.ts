// Dashboard shell: sidebar navigation, mini player and a hash router.

import '../widget/modules.css';
import './dashboard.css';
import { send, trackPosition } from '../bridge';
import { audioPage } from './pages/audio';
import { homePage } from './pages/home';
import { lyricsPage } from './pages/lyrics';
import { queuePage } from './pages/queue';
import { settingsPage } from './pages/settings';
import { ambiencePage } from './pages/ambience';
import { visualizerPage } from './pages/visualizer';
import { on, onTick, store } from './store';
import { esc, h, icon } from './ui';

type Page = (container: HTMLElement) => () => void;

const ROUTES: { id: string; label: string; icon: string; page: Page }[] = [
  { id: 'home', label: 'Beranda', icon: icon.home, page: homePage },
  { id: 'visualizer', label: 'Visualizer', icon: icon.visualizer, page: visualizerPage },
  { id: 'lyrics', label: 'Lirik', icon: icon.lyrics, page: lyricsPage },
  { id: 'queue', label: 'Antrean', icon: icon.queue, page: queuePage },
  { id: 'suasana', label: 'Suasana', icon: icon.mood, page: ambiencePage },
  { id: 'audio', label: 'Audio', icon: icon.audio, page: audioPage },
  { id: 'settings', label: 'Pengaturan', icon: icon.settings, page: settingsPage },
];

// ------------------------------------------------------------------ shell

const nav = h('nav', { class: 'nav', attrs: { 'aria-label': 'Navigasi' } });
for (const r of ROUTES) {
  nav.append(h('a', { class: 'nav__item', attrs: { href: `#${r.id}`, 'data-route': r.id } },
    h('span', { class: 'nav__icon', html: r.icon }), h('span', { text: r.label })));
}

const mini = h('div', { class: 'mini' });
const miniBar = h('div', { class: 'mini__bar' });
function showMini(): void {
  const t = store.track;
  mini.classList.toggle('mini--empty', !t);
  mini.innerHTML = t
    ? `<div class="mini__cover">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : icon.music}</div>
       <div class="mini__text"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></div>
       <button class="mini__btn" type="button" aria-label="Putar/jeda" ${t.canToggle ? '' : 'disabled'}>${t.playing ? icon.pause : icon.play}</button>`
    : `<div class="mini__cover">${icon.music}</div><div class="mini__text"><b>Tidak ada lagu</b><span>Putar sesuatu di Spotify</span></div>`;
  mini.append(miniBar);
  mini.querySelector('.mini__btn')?.addEventListener('click', () => send({ type: 'media', command: 'toggle' }));
}
showMini();
on('track', showMini);
onTick(() => {
  const t = store.track;
  miniBar.style.transform = `scaleX(${t && t.durationMs > 0 ? trackPosition(t) / t.durationMs : 0})`;
});

const content = h('main', { class: 'content' });
const scroller = h('div', { class: 'scroller' }, content);

document.getElementById('app')!.append(
  h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }), h('span', { class: 'brand__name', text: 'Sonora' })),
    nav,
    h('div', { class: 'sidebar__spacer' }),
    mini),
  scroller);

on('app', () => document.body.classList.toggle('mica', !!store.app?.mica));

// ------------------------------------------------------------------ router

let cleanup: (() => void) | null = null;
function route(): void {
  const id = location.hash.replace('#', '') || 'home';
  const r = ROUTES.find((x) => x.id === id) ?? ROUTES[0];
  cleanup?.();
  content.innerHTML = '';
  content.className = `content page page--${r.id}`;
  nav.querySelectorAll<HTMLElement>('.nav__item').forEach((a) => a.setAttribute('aria-current', String(a.dataset.route === r.id)));
  cleanup = r.page(content);
  scroller.scrollTop = 0;
}
window.addEventListener('hashchange', route);
// Wait for the host's first state so pages build with real data.
let started = false;
on('widgets', () => { if (!started) { started = true; route(); } });
setTimeout(() => { if (!started) { started = true; route(); } }, 800);

send({ type: 'hello' });
