// Shared layout for a widget's page: big live preview, style tiles, colours, widget-specific
// sections, and placement.

import { send } from '../../bridge';
import { PRESETS, resolvePalette, withDefaults } from '../../widget/types';
import { mountPreview, type Preview } from '../preview';
import { on, setWidgetOptions, store, widget } from '../store';
import { button, group, h, icon, pageHeader, row, toggle } from '../ui';

export interface PageContext<T> {
  readonly opts: T;
  set(patch: Partial<T>): void;
}

interface Config<T extends { style: string; colors: string; custom: string[] }> {
  id: string;
  title: string;
  subtitle: string;
  defaults: T;
  styles: { id: string; name: string; hint: string }[];
  sections: (ctx: PageContext<T>) => HTMLElement[];
}

export function widgetPage<T extends { style: string; colors: string; custom: string[] }>(container: HTMLElement, cfg: Config<T>): () => void {
  const cleanups: (() => void)[] = [];
  const previews: Preview[] = [];
  let opts = withDefaults(cfg.defaults, widget(cfg.id)?.options);

  const ctx: PageContext<T> = {
    get opts() { return opts; },
    set(patch) {
      opts = { ...opts, ...patch };
      setWidgetOptions(cfg.id, opts as unknown as Record<string, unknown>);
      previews.forEach((p) => p.refresh());
      paintTiles();
      paintSwatches();
    },
  };

  // ---------------------------------------------------------------- header + preview

  const item = () => widget(cfg.id);
  const shown = toggle(item()?.enabled ?? false, (v) => send({ type: 'widget-set', id: cfg.id, enabled: v }));
  const stage = h('div', { class: 'showcase__stage desk' });
  const showcase = h('section', { class: 'showcase' }, stage,
    h('div', { class: 'showcase__note', html: `${icon.info}<span>Perubahan langsung tampil di desktop. Geser dan ubah ukuran widget langsung di sana.</span>` }));
  previews.push(mountPreview(stage, cfg.id, () => opts as unknown as Record<string, unknown>));

  // ---------------------------------------------------------------- style tiles

  const tiles = h('div', { class: 'tiles' });
  const tileEls: HTMLElement[] = [];
  for (const s of cfg.styles) {
    const tStage = h('div', { class: 'tile__stage desk desk--small' });
    const tile = h('button', { class: 'tile', attrs: { type: 'button' }, on: { click: () => ctx.set({ style: s.id } as Partial<T>) } },
      tStage,
      h('div', { class: 'tile__text' }, h('div', { class: 'tile__name', text: s.name }), h('div', { class: 'tile__hint', text: s.hint })));
    tile.dataset.style = s.id;
    tiles.append(tile);
    tileEls.push(tile);
    previews.push(mountPreview(tStage, cfg.id, () => ({ ...opts, style: s.id }) as unknown as Record<string, unknown>, 30));
  }
  function paintTiles(): void {
    for (const t of tileEls) t.setAttribute('aria-pressed', String(t.dataset.style === opts.style));
  }
  paintTiles();

  // ---------------------------------------------------------------- colours

  const swatches = h('div', { class: 'swatches' });
  const customRow = h('div', { class: 'custom-colors' });
  const choices: { id: string; name: string; colors: () => string[] }[] = [
    { id: 'cover', name: 'Ikuti cover', colors: () => resolvePalette('cover', [], store.track) },
    ...Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name, colors: () => p.colors })),
    { id: 'custom', name: 'Kustom', colors: () => opts.custom },
  ];
  function paintSwatches(): void {
    swatches.innerHTML = '';
    for (const c of choices) {
      const dots = c.colors().slice(0, 3).map((col) => `<i style="background:${col}"></i>`).join('');
      const b = h('button', { class: 'swatch', attrs: { type: 'button', 'aria-pressed': String(opts.colors === c.id) }, on: { click: () => ctx.set({ colors: c.id } as Partial<T>) } },
        h('span', { class: 'swatch__dots', html: dots }), h('span', { class: 'swatch__name', text: c.name }));
      swatches.append(b);
    }
    customRow.hidden = opts.colors !== 'custom';
  }
  for (let i = 0; i < 3; i++) {
    const input = h('input', { class: 'color-input', attrs: { type: 'color', 'aria-label': `Warna ${i + 1}` } });
    input.value = opts.custom[i] ?? '#8b5cf6';
    input.addEventListener('input', () => {
      const custom = [...opts.custom];
      custom[i] = input.value;
      ctx.set({ custom } as Partial<T>);
    });
    customRow.append(input);
  }
  paintSwatches();
  cleanups.push(on('track', () => { paintSwatches(); previews.forEach((p) => p.refresh()); }));
  cleanups.push(on('lyrics', () => previews.forEach((p) => p.refresh())));
  cleanups.push(on('prefs', () => previews.forEach((p) => p.refresh())));
  cleanups.push(on('queue', () => previews.forEach((p) => p.refresh())));

  // ---------------------------------------------------------------- placement

  const lock = toggle(item()?.locked ?? false, (v) => send({ type: 'widget-set', id: cfg.id, locked: v }));
  const placement = group('Posisi',
    row('Kunci posisi', 'Widget tidak bisa digeser, dan klik tembus ke ikon desktop di bawahnya.', lock, icon.lock),
    row('Kembalikan ke posisi awal', 'Berguna kalau widget tersembunyi di luar layar.', button('Reset', () => send({ type: 'widget-reset', id: cfg.id }), 'default', icon.reset), icon.reset));

  cleanups.push(on('widgets', () => {
    const w = item();
    if (!w) return;
    shown.set(w.enabled);
    lock.set(w.locked);
  }));

  container.append(
    pageHeader(cfg.title, cfg.subtitle, h('span', { class: 'header-toggle' }, 'Tampilkan di desktop', shown)),
    showcase,
    group('Gaya', tiles),
    group('Warna', h('div', { class: 'colors' }, swatches, customRow)),
    ...cfg.sections(ctx),
    placement);

  return () => {
    cleanups.forEach((c) => c());
    previews.forEach((p) => p.destroy());
  };
}
