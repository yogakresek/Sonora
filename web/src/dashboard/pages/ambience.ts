// Suasana: the full-screen ambiences, one at a time. A gallery of live previews to pick from, and
// the chosen one's settings underneath. Adding an ambience = a card here + its scene + a host entry.

import { send } from '../../bridge';
import { STAR_DEFAULTS, VINYL_DEFAULTS, withDefaults, type StarOptions, type VinylOptions } from '../../widget/types';
import { mountPreview, type Preview } from '../preview';
import { on, setWidgetOptions, store } from '../store';
import { button, group, h, icon, pageHeader, row, slider, toggle } from '../ui';

interface Mode { id: 'star' | 'vinyl'; name: string; hint: string }

const MODES: Mode[] = [
  { id: 'star', name: 'Star Mode', hint: 'Setiap kata jadi bintang, setiap baris jadi rasi baru' },
  { id: 'vinyl', name: 'Piringan Hitam', hint: 'Piringan berputar, lirik melengkung di alurnya' },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function ambiencePage(container: HTMLElement): () => void {
  const cleanups: (() => void)[] = [];
  const previews: Preview[] = [];
  let selected: Mode['id'] = (store.ambience.active as Mode['id'] | null) ?? 'star';

  const optsOf = <T extends object>(id: string, defaults: T): T => withDefaults(defaults, store.ambience.options[id]);
  const save = (id: string, o: object) => {
    setWidgetOptions(id, o as Record<string, unknown>);
    previews.forEach((p) => p.refresh());
  };

  // ---------------------------------------------------------------- header

  const offBtn = button('Matikan suasana', () => send({ type: 'ambience', id: null }), 'default', icon.power);

  // ---------------------------------------------------------------- gallery

  const gallery = h('div', { class: 'moods' });
  const cards = new Map<string, HTMLElement>();
  for (const m of MODES) {
    const stage = h('div', { class: 'mood__stage star-stage' });
    const action = h('div', { class: 'mood__action' });
    const card = h('article', { class: 'mood', attrs: { tabindex: '0', role: 'button', 'aria-label': `Pilih ${m.name}` }, on: { click: () => select(m.id) } },
      stage,
      h('div', { class: 'mood__foot' },
        h('div', { class: 'mood__text' }, h('div', { class: 'mood__name', text: m.name }), h('div', { class: 'mood__hint', text: m.hint })),
        action));
    gallery.append(card);
    cards.set(m.id, card);
    previews.push(mountPreview(stage, m.id, () => store.ambience.options[m.id] ?? {}, 30));
  }
  gallery.append(h('div', { class: 'mood mood--soon' }, h('span', { class: 'mood__plus', text: '+' }), h('span', { text: 'Suasana berikutnya menyusul' })));

  function paintGallery(): void {
    const active = store.ambience.active;
    offBtn.hidden = !active;
    for (const m of MODES) {
      const card = cards.get(m.id)!;
      card.classList.toggle('is-selected', m.id === selected);
      card.classList.toggle('is-active', m.id === active);
      const action = card.querySelector('.mood__action')!;
      action.innerHTML = '';
      if (m.id === active) {
        action.append(h('span', { class: 'mood__badge', text: 'Menyala' }));
      } else {
        const b = button('Nyalakan', () => send({ type: 'ambience', id: m.id }), 'primary');
        b.addEventListener('click', (e) => e.stopPropagation());
        action.append(b);
      }
    }
  }

  // ---------------------------------------------------------------- settings of the selected one

  const settings = h('div', {});
  function paintSettings(): void {
    settings.innerHTML = '';
    if (selected === 'star') {
      let o = optsOf<StarOptions>('star', STAR_DEFAULTS);
      const set = (p: Partial<StarOptions>) => { o = { ...o, ...p }; save('star', o); };
      settings.append(group('Pengaturan Star Mode',
        row('Langit dari album', 'Latar dari warna cover, jadi setiap lagu punya langitnya sendiri. Matikan untuk memakai wallpaper yang digelapkan.', toggle(o.backdrop, (v) => set({ backdrop: v })), icon.music),
        row('Kegelapan langit', 'Seberapa gelap langitnya.', slider({ min: 0.4, max: 0.95, step: 0.05, value: o.dim, format: pct, onInput: (v) => set({ dim: v }) }), icon.eye),
        row('Ukuran kata', 'Besar tulisan kata yang sedang dinyanyikan.', slider({ min: 0.8, max: 1.3, step: 0.05, value: o.size, format: pct, onInput: (v) => set({ size: v }) }), icon.lyrics),
        row('Info lagu', 'Cover, judul, durasi, dan tombol sebelumnya / putar / berikutnya di pojok kiri bawah.', toggle(o.info, (v) => set({ info: v })), icon.play),
        row('Bintang berkelip', 'Bintang kecil di latar berkelip pelan (selalu diam di Mode santai).', toggle(o.twinkle, (v) => set({ twinkle: v })), icon.spark)));
    } else {
      let o = optsOf<VinylOptions>('vinyl', VINYL_DEFAULTS);
      const set = (p: Partial<VinylOptions>) => { o = { ...o, ...p }; save('vinyl', o); };
      settings.append(group('Pengaturan Piringan Hitam',
        row('Piringan ikut warna cover', 'Piringan berwarna dari cover lagu. Matikan untuk piringan hitam klasik.', toggle(o.colored, (v) => set({ colored: v })), icon.vinyl),
        row('Ruang dari album', 'Cahaya ruangan dari warna cover. Matikan untuk memakai wallpaper yang digelapkan.', toggle(o.backdrop, (v) => set({ backdrop: v })), icon.music),
        row('Kegelapan ruang', 'Seberapa gelap ruangan di sekitar piringan.', slider({ min: 0.4, max: 0.95, step: 0.05, value: o.dim, format: pct, onInput: (v) => set({ dim: v }) }), icon.eye),
        row('Ukuran lirik', 'Besar tulisan lirik di alur piringan.', slider({ min: 0.8, max: 1.3, step: 0.05, value: o.size, format: pct, onInput: (v) => set({ size: v }) }), icon.lyrics),
        row('Info lagu', 'Judul, artis, album, dan waktu di pojok kiri atas.', toggle(o.info, (v) => set({ info: v })), icon.play)),
        h('p', { class: 'mood__tip', html: `${icon.info}<span>Geser tonearm untuk pindah ke menit lain, klik label piringan untuk jeda. Gerakkan mouse untuk memunculkan tombol Keluar.</span>` }));
    }
  }

  function select(id: Mode['id']): void {
    selected = id;
    paintGallery();
    paintSettings();
  }

  paintGallery();
  paintSettings();
  cleanups.push(on('widgets', () => {
    // Turning one on (here, in the tray, or from the scene's Keluar) follows the selection along.
    if (store.ambience.active && store.ambience.active !== selected) { selected = store.ambience.active as Mode['id']; paintSettings(); }
    paintGallery();
  }));
  const refresh = () => previews.forEach((p) => p.refresh());
  cleanups.push(on('track', refresh), on('lyrics', refresh), on('prefs', refresh));

  container.append(
    pageHeader('Suasana', 'Satu suasana memenuhi layar. Widget minggir sementara dan kembali seperti semula saat suasana dimatikan.', offBtn),
    gallery,
    settings,
  );

  return () => {
    cleanups.forEach((c) => c());
    previews.forEach((p) => p.destroy());
  };
}
