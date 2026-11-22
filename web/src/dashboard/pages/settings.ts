import { send } from '../../bridge';
import { on, setPrefs, store } from '../store';
import { button, esc, group, h, icon, pageHeader, row, segmented, toggle } from '../ui';

export function settingsPage(container: HTMLElement): () => void {
  const cleanups: (() => void)[] = [];

  const startup = toggle(store.prefs.startWithWindows, (v) => setPrefs({ startWithWindows: v }));
  const hidden = toggle(store.hidden, (v) => send({ type: 'widgets-hidden', hidden: v }));
  const calm = toggle(store.prefs.calm, (v) => setPrefs({ calm: v }));
  cleanups.push(on('prefs', () => { startup.set(store.prefs.startWithWindows); calm.set(store.prefs.calm); }));
  cleanups.push(on('widgets', () => hidden.set(store.hidden)));

  const about = h('div', { class: 'about' });
  function showAbout(): void {
    const a = store.app;
    about.innerHTML = a ? `
      <div class="about__brand"><span class="logo logo--lg"></span><div><b>${esc(a.app)}</b><span>Versi ${esc(a.version)}</span></div></div>
      <dl>
        <dt>Runtime</dt><dd>${esc(a.runtime)}</dd>
        <dt>WebView2</dt><dd>${esc(a.webview)}</dd>
        <dt>Lirik</dt><dd>LRCLIB, perpustakaan lirik komunitas</dd>
        <dt>Data</dt><dd><code>${esc(a.dataDir)}</code></dd>
      </dl>` : '';
  }
  showAbout();
  cleanups.push(on('app', showAbout));

  container.append(
    pageHeader('Pengaturan', 'Perilaku aplikasi dan penggunaan sumber daya.'),
    group('Tampilan',
      row('Mode santai', 'Tanpa denyut dan kedip mengikuti beat. Cover tidak membesar-mengecil, lirik berganti dengan memudar, dan semua gerakan dibuat pelan.', calm, icon.calm)),
    group('Umum',
      row('Mulai bersama Windows', 'Widget langsung muncul di desktop setelah komputer menyala.', startup, icon.power),
      row('Sembunyikan semua widget', 'Menyembunyikan tanpa mengubah pilihan widget mana yang aktif.', hidden, icon.eye)),
    group('Performa',
      row('Kelancaran animasi', '30 fps memakai sekitar separuh daya grafis. Saat musik berhenti, widget otomatis melambat.',
        segmented<number>([{ value: 60, label: 'Halus · 60' }, { value: 30, label: 'Hemat · 30' }], store.prefs.fps >= 45 ? 60 : 30, (v) => setPrefs({ fps: v })),
        icon.speed)),
    group('Data',
      row('Folder data', 'Pengaturan, cache lirik dan cover, serta log. Semuanya ada di satu folder ini.',
        button('Buka folder', () => send({ type: 'open-data-dir' }), 'default', icon.folder), icon.folder)),
    group('Tentang', about));

  return () => cleanups.forEach((c) => c());
}
