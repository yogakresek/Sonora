import { send, trackPosition } from '../../bridge';
import { mountPreview, type Preview } from '../preview';
import { on, onTick, setPrefs, store, widget } from '../store';
import { esc, fmtTime, h, icon, toggle } from '../ui';

export function homePage(container: HTMLElement): () => void {
  const cleanups: (() => void)[] = [];
  const previews: Preview[] = [];

  const hour = new Date().getHours();
  const greeting = hour < 11 ? 'Selamat pagi' : hour < 15 ? 'Selamat siang' : hour < 19 ? 'Selamat sore' : 'Selamat malam';

  // ---------------------------------------------------------------- now playing hero

  const heroBg = h('div', { class: 'hero__bg' });
  const heroCover = h('div', { class: 'hero__cover' });
  const heroApp = h('div', { class: 'hero__app' });
  const heroTitle = h('div', { class: 'hero__title' });
  const heroArtist = h('div', { class: 'hero__artist' });
  const bar = h('div', { class: 'progress__bar' });
  const pos = h('span'), dur = h('span');
  const toggleBtn = h('button', { class: 'ctl ctl--main', attrs: { type: 'button', 'aria-label': 'Putar/jeda' }, on: { click: () => send({ type: 'media', command: 'toggle' }) } });
  const prevBtn = h('button', { class: 'ctl', html: icon.prev, attrs: { type: 'button', 'aria-label': 'Sebelumnya' }, on: { click: () => send({ type: 'media', command: 'previous' }) } });
  const nextBtn = h('button', { class: 'ctl', html: icon.next, attrs: { type: 'button', 'aria-label': 'Berikutnya' }, on: { click: () => send({ type: 'media', command: 'next' }) } });

  const hero = h('section', { class: 'hero' },
    heroBg,
    h('div', { class: 'hero__body' },
      heroCover,
      h('div', { class: 'hero__info' },
        heroApp, heroTitle, heroArtist,
        h('div', { class: 'progress' }, h('div', { class: 'progress__track' }, bar), h('div', { class: 'progress__times' }, pos, dur)),
        h('div', { class: 'hero__controls' }, prevBtn, toggleBtn, nextBtn))));

  function showTrack(): void {
    const t = store.track;
    hero.classList.toggle('hero--empty', !t);
    if (!t) {
      heroBg.style.backgroundImage = '';
      heroCover.innerHTML = `<span class="hero__placeholder">${icon.music}</span>`;
      heroApp.textContent = 'Menunggu musik';
      heroTitle.textContent = 'Putar lagu di Spotify';
      heroArtist.textContent = 'Sonora tersambung otomatis, tanpa login.';
      [toggleBtn, prevBtn, nextBtn].forEach((b) => (b.disabled = true));
      toggleBtn.innerHTML = icon.play;
      return;
    }
    heroBg.style.backgroundImage = t.cover ? `url("${t.cover}")` : '';
    heroCover.innerHTML = t.cover ? `<img src="${esc(t.cover)}" alt="">` : `<span class="hero__placeholder">${icon.music}</span>`;
    heroApp.innerHTML = `<span class="dot ${t.playing ? 'dot--live' : ''}"></span>${esc(t.appName)} · ${t.playing ? 'Sedang diputar' : 'Dijeda'}`;
    heroTitle.textContent = t.title || 'Tanpa judul';
    heroArtist.textContent = [t.artist, t.album].filter(Boolean).join(' — ');
    prevBtn.disabled = !t.canPrevious;
    nextBtn.disabled = !t.canNext;
    toggleBtn.disabled = !t.canToggle;
    toggleBtn.innerHTML = t.playing ? icon.pause : icon.play;
    const pal = t.palette ?? [];
    hero.style.setProperty('--accent-1', pal[0] ?? '');
  }
  showTrack();
  cleanups.push(on('track', showTrack));
  cleanups.push(onTick(() => {
    const t = store.track;
    const p = t ? trackPosition(t) : 0;
    bar.style.transform = `scaleX(${t && t.durationMs > 0 ? p / t.durationMs : 0})`;
    pos.textContent = fmtTime(p);
    dur.textContent = fmtTime(t?.durationMs ?? 0);
  }));

  // ---------------------------------------------------------------- widget cards

  const grid = h('div', { class: 'cards' });
  function buildCards(): void {
    previews.splice(0).forEach((p) => p.destroy());
    grid.innerHTML = '';
    for (const w of store.widgets) {
      const stage = h('div', { class: 'card__stage desk' });
      const sw = toggle(w.enabled, (v) => send({ type: 'widget-set', id: w.id, enabled: v }));
      const card = h('article', { class: `card ${w.enabled ? '' : 'card--off'}` },
        stage,
        h('div', { class: 'card__foot' },
          h('div', { class: 'card__text' },
            h('div', { class: 'card__name', text: w.name }),
            h('div', { class: 'card__desc', text: w.description })),
          sw),
        h('a', { class: 'card__link', attrs: { href: `#${w.id === 'cover' ? 'visualizer' : w.id}` } }, 'Atur tampilan', h('span', { html: icon.chevron })));
      grid.append(card);
      previews.push(mountPreview(stage, w.id, () => widget(w.id)?.options ?? {}, 45));
    }
  }
  buildCards();
  // Toggling a widget only changes its switch and dimming; rebuild only if the set of widgets changed.
  let ids = store.widgets.map((w) => w.id).join();
  cleanups.push(on('widgets', () => {
    const next = store.widgets.map((w) => w.id).join();
    if (next !== ids) { ids = next; buildCards(); return; }
    store.widgets.forEach((w, i) => {
      const card = grid.children[i] as HTMLElement | undefined;
      card?.classList.toggle('card--off', !w.enabled);
      (card?.querySelector('.toggle') as ReturnType<typeof toggle> | null)?.set?.(w.enabled);
      previews[i]?.refresh();
    });
  }));
  cleanups.push(on('track', () => previews.forEach((p) => p.refresh())));
  cleanups.push(on('lyrics', () => previews.forEach((p) => p.refresh())));
  cleanups.push(on('queue', () => previews.forEach((p) => p.refresh())));

  // ---------------------------------------------------------------- status chips

  const chips = h('div', { class: 'chips' });
  function showStatus(): void {
    const a = store.audio, t = store.track, l = store.lyrics;
    const chip = (ok: boolean | null, label: string) =>
      `<span class="chip ${ok === true ? 'chip--ok' : ok === false ? 'chip--warn' : ''}"><span class="dot"></span>${label}</span>`;
    chips.innerHTML =
      chip(a?.state === 'running' ? true : a?.state === 'error' || a?.state === 'no-device' ? false : null,
        a?.state === 'running' ? `Audio: ${esc(a.device ?? '')}` : a?.state === 'stopped' ? 'Audio siaga' : 'Audio bermasalah') +
      chip(t ? true : null, t ? `Sumber: ${esc(t.appName)}` : 'Belum ada sumber') +
      chip(l?.status === 'synced' ? true : l?.status === 'none' || l?.status === 'error' ? false : null,
        l?.status === 'synced' ? 'Lirik tersinkron' : l?.status === 'loading' ? 'Mencari lirik…' : l?.status === 'plain' ? 'Lirik tanpa waktu' : t ? 'Lirik tidak tersedia' : 'Lirik siaga');
  }
  showStatus();
  for (const topic of ['audio', 'track', 'lyrics'] as const) cleanups.push(on(topic, showStatus));

  // While Star Mode is on, the widgets are put away: say so here, or their switches look broken.
  const starNote = h('div', { class: 'star-note' });
  function showStarNote(): void {
    starNote.hidden = !store.star.on;
    if (!store.star.on) return;
    starNote.innerHTML = `<span class="star-note__icon">${icon.star}</span>
      <span class="star-note__text"><b>Star Mode sedang menyala</b><span>Widget di bawah disembunyikan sementara dan kembali seperti semula saat Star Mode dimatikan.</span></span>`;
    starNote.append(h('button', { class: 'btn btn--default', attrs: { type: 'button' }, on: { click: () => send({ type: 'star-mode', on: false }) } }, 'Matikan Star Mode'));
  }
  showStarNote();
  cleanups.push(on('widgets', showStarNote));

  const calm = toggle(store.prefs.calm, (v) => setPrefs({ calm: v }));
  cleanups.push(on('prefs', () => calm.set(store.prefs.calm)));

  container.append(
    h('header', { class: 'page__header' },
      h('div', {}, h('h1', { text: greeting }), h('p', { class: 'page__sub', text: 'Musikmu, langsung di desktop.' })),
      h('span', { class: 'header-toggle', title: 'Tanpa denyut dan kedip mengikuti beat; semua gerakan dibuat pelan' },
        h('span', { class: 'header-toggle__icon', html: icon.calm }), 'Mode santai', calm)),
    hero,
    chips,
    h('h2', { class: 'section-title', text: 'Widget di desktop' }),
    starNote,
    grid);

  return () => {
    cleanups.forEach((c) => c());
    previews.forEach((p) => p.destroy());
  };
}
