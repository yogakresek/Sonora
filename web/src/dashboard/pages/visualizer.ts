import { VISUALIZER_DEFAULTS, VISUALIZER_STYLES, type VisualizerOptions } from '../../widget/types';
import { group, icon, row, slider, toggle } from '../ui';
import { widgetPage } from './widget-page';

export function visualizerPage(container: HTMLElement): () => void {
  return widgetPage<VisualizerOptions>(container, {
    id: 'cover',
    title: 'Visualizer',
    subtitle: 'Cover lagu yang sedang diputar, hidup mengikuti musik.',
    defaults: VISUALIZER_DEFAULTS,
    styles: VISUALIZER_STYLES,
    sections: (ctx) => [
      group('Detail',
        row('Kepadatan', 'Jumlah garis atau bar yang digambar.',
          slider({ min: 0.5, max: 1.5, step: 0.05, value: ctx.opts.density, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => ctx.set({ density: v }) }),
          icon.visualizer),
        row('Cahaya', 'Pendar lembut di sekitar visualizer.', toggle(ctx.opts.glow, (v) => ctx.set({ glow: v })), icon.spark),
        row('Berdenyut mengikuti beat', 'Cover membesar sedikit setiap ketukan drum.', toggle(ctx.opts.beat, (v) => ctx.set({ beat: v })), icon.audio),
        row('Tampilkan judul lagu', 'Judul dan artis di bawah visualizer (selalu tampil pada gaya Minimal).',
          toggle(ctx.opts.showTitle, (v) => ctx.set({ showTitle: v })), icon.lyrics)),
    ],
  });
}
