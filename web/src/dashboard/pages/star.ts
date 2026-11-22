// Star Mode: its own room. Turning it on hides the widgets (their settings stay) and fills the
// screen with the lyrics as constellations until it is turned off.

import { send } from '../../bridge';
import { STAR_DEFAULTS, withDefaults, type StarOptions } from '../../widget/types';
import { mountPreview } from '../preview';
import { on, setWidgetOptions, store } from '../store';
import { group, h, icon, pageHeader, row, slider, toggle } from '../ui';

export function starPage(container: HTMLElement): () => void {
  const cleanups: (() => void)[] = [];
  let opts = withDefaults(STAR_DEFAULTS, store.star.options);

  const set = (patch: Partial<StarOptions>) => {
    opts = { ...opts, ...patch };
    setWidgetOptions('star', opts as unknown as Record<string, unknown>);
    preview.refresh();
  };

  const power = toggle(store.star.on, (v) => send({ type: 'star-mode', on: v }));
  const stage = h('div', { class: 'showcase__stage star-stage' });
  const preview = mountPreview(stage, 'star', () => opts as unknown as Record<string, unknown>);
  const state = h('div', { class: 'showcase__note' });
  function paintState(): void {
    state.innerHTML = `${icon.info}<span>${store.star.on
      ? 'Star Mode menyala: widget lain sedang disembunyikan dan akan kembali seperti semula saat Star Mode dimatikan.'
      : 'Saat menyala, wallpaper digelapkan menjadi langit malam dan semua widget disembunyikan sementara. Tetap menyala untuk semua lagu sampai kamu mematikannya.'}</span>`;
  }
  paintState();

  cleanups.push(on('widgets', () => { power.set(store.star.on); paintState(); }));
  const refresh = () => preview.refresh();
  cleanups.push(on('track', refresh), on('lyrics', refresh), on('prefs', refresh));

  container.append(
    pageHeader('Star Mode', 'Lirik membentuk rasi bintang: setiap kata jadi bintang, setiap baris jadi rasi baru.',
      h('span', { class: 'header-toggle' }, 'Aktifkan Star Mode', power)),
    h('section', { class: 'showcase' }, stage, state),
    group('Tampilan',
      row('Langit dari album', 'Latar dibuat dari warna cover album, jadi setiap lagu punya langitnya sendiri. Matikan untuk memakai wallpaper yang digelapkan.',
        toggle(opts.backdrop, (v) => set({ backdrop: v })), icon.music),
      row('Kegelapan langit', 'Seberapa gelap langitnya.',
        slider({ min: 0.4, max: 0.95, step: 0.05, value: opts.dim, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => set({ dim: v }) }), icon.eye),
      row('Ukuran kata', 'Besar tulisan kata yang sedang dinyanyikan.',
        slider({ min: 0.8, max: 1.3, step: 0.05, value: opts.size, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => set({ size: v }) }), icon.lyrics),
      row('Info lagu', 'Cover, judul, durasi, dan tombol sebelumnya / putar / berikutnya di pojok kiri bawah.',
        toggle(opts.info, (v) => set({ info: v })), icon.play),
      row('Bintang berkelip', 'Bintang kecil di latar berkelip pelan (selalu diam di Mode santai).',
        toggle(opts.twinkle, (v) => set({ twinkle: v })), icon.spark)),
  );

  return () => {
    cleanups.forEach((c) => c());
    preview.destroy();
  };
}
