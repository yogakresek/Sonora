import { LYRICS_DEFAULTS, LYRICS_STYLES, type LyricsOptions } from '../../widget/types';
import { on, setPrefs, store } from '../store';
import { button, group, h, icon, row, segmented, slider, toggle } from '../ui';
import { widgetPage } from './widget-page';

export function lyricsPage(container: HTMLElement): () => void {
  let unsub = () => {};
  const cleanup = widgetPage<LyricsOptions>(container, {
    id: 'lyrics',
    title: 'Lirik',
    subtitle: 'Lirik yang berjalan seirama lagu, dari LRCLIB (gratis, tanpa akun).',
    defaults: LYRICS_DEFAULTS,
    styles: LYRICS_STYLES,
    sections: (ctx) => {
      const fmtOffset = (v: number) => (v === 0 ? 'Pas' : `${v > 0 ? '+' : ''}${(v / 1000).toFixed(2)} dtk`);
      let offsetSlider = makeOffset();
      function makeOffset(): HTMLElement {
        return slider({ min: -2000, max: 2000, step: 50, value: store.prefs.lyricsOffsetMs, format: fmtOffset, onInput: (v) => setPrefs({ lyricsOffsetMs: v }) });
      }
      const offsetHolder = h('div', { class: 'offset' }, offsetSlider,
        button('Reset', () => {
          setPrefs({ lyricsOffsetMs: 0 });
          const next = makeOffset();
          offsetSlider.replaceWith(next);
          offsetSlider = next;
        }, 'subtle'));
      unsub = on('prefs', () => {
        // Keep the slider in step if the value changed elsewhere.
        const input = offsetSlider.querySelector('input');
        if (input && Number(input.value) !== store.prefs.lyricsOffsetMs && document.activeElement !== input) {
          const next = makeOffset();
          offsetSlider.replaceWith(next);
          offsetSlider = next;
        }
      });

      return [
        group('Teks',
          row('Ukuran', null,
            slider({ min: 0.7, max: 1.4, step: 0.05, value: ctx.opts.size, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => ctx.set({ size: v }) }),
            icon.lyrics),
          row('Ketebalan', null,
            segmented<number>([{ value: 600, label: 'Sedang' }, { value: 700, label: 'Tebal' }, { value: 800, label: 'Ekstra' }], ctx.opts.weight,
              (v) => ctx.set({ weight: v as LyricsOptions['weight'] })),
            icon.lyrics),
          row('Perataan', null,
            segmented<LyricsOptions['align']>([{ value: 'left', label: 'Kiri' }, { value: 'center', label: 'Tengah' }, { value: 'right', label: 'Kanan' }], ctx.opts.align,
              (v) => ctx.set({ align: v })),
            icon.lyrics)),
        group('Efek',
          row('Cahaya pada kata', 'Kata yang sedang dinyanyikan berpendar dengan warna pilihan.', toggle(ctx.opts.glow, (v) => ctx.set({ glow: v })), icon.spark),
          row('Berdenyut mengikuti beat', 'Baris aktif membesar sedikit setiap ketukan.', toggle(ctx.opts.beat, (v) => ctx.set({ beat: v })), icon.audio)),
        group('Sinkronisasi',
          row('Geser waktu lirik', 'Kalau lirik muncul terlalu cepat, geser ke kanan; terlalu lambat, ke kiri.', offsetHolder, icon.clock)),
      ];
    },
  });
  return () => {
    unsub();
    cleanup();
  };
}
