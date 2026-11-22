import { send } from '../../bridge';
import { QUEUE_DEFAULTS, QUEUE_STYLES, type QueueOptions } from '../../widget/types';
import { on, store } from '../store';
import { button, esc, group, h, icon, row, slider, toggle } from '../ui';
import { widgetPage } from './widget-page';

const DEV_DASHBOARD = 'https://developer.spotify.com/dashboard';

export function queuePage(container: HTMLElement): () => void {
  let unsub = () => {};
  const cleanup = widgetPage<QueueOptions>(container, {
    id: 'queue',
    title: 'Antrean',
    subtitle: 'Lagu berikutnya, dan satu klik untuk langsung memutarnya.',
    defaults: QUEUE_DEFAULTS,
    styles: QUEUE_STYLES,
    sections: (ctx) => {
      const account = h('div', { class: 'spotify' });
      unsub = on('queue', () => paint(account));
      paint(account);
      return [
        group('Akun Spotify', account),
        group('Detail',
          row('Jumlah lagu berikutnya', null,
            slider({ min: 2, max: 8, step: 1, value: ctx.opts.count, format: (v) => `${v} lagu`, onInput: (v) => ctx.set({ count: v }) }),
            icon.lyrics),
          row('Tampilkan lagu sebelumnya', 'Lagu yang baru saja diputar, tampil redup di bawah antrean.',
            toggle(ctx.opts.showHistory, (v) => ctx.set({ showHistory: v })), icon.clock)),
      ];
    },
  });
  return () => {
    unsub();
    cleanup();
  };
}

/** The Spotify connection card: status when connected, a three-step guide when not. */
function paint(el: HTMLElement): void {
  const q = store.queue;
  const status = q?.status ?? 'no-client';
  const connected = status === 'ok' || status === 'empty';
  // The queue is polled every few seconds; only redraw when what the card shows changed.
  const sig = JSON.stringify([status, connected ? q?.items.length : q?.clientId, q?.error, store.spotifyRedirectUri]);
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  const typing = el.querySelector<HTMLInputElement>('.spotify__input');
  // Don't wipe what the user is typing because a poll came in.
  if (typing && document.activeElement === typing && !connected) return;

  el.innerHTML = '';
  if (connected) {
    el.append(
      h('div', { class: 'spotify__status' },
        h('span', { class: 'pulse-dot pulse-dot--running' }),
        h('div', { class: 'spotify__status-text' },
          h('b', { text: 'Spotify tersambung' }),
          h('span', { text: status === 'empty' ? 'Antrean sedang kosong. Tambahkan lagu di Spotify.' : `${q!.items.length} lagu di antrean. Klik salah satunya di widget untuk memutarnya.` })),
        button('Putuskan', () => send({ type: 'spotify-disconnect' }), 'subtle')));
    return;
  }

  const input = h('input', { class: 'spotify__input', attrs: { type: 'text', placeholder: 'Tempel Client ID di sini', spellcheck: 'false', autocomplete: 'off' } });
  input.value = q?.clientId ?? '';
  const redirect = store.spotifyRedirectUri || 'http://127.0.0.1:43821/callback';
  const copy = button('Salin', () => {
    void navigator.clipboard.writeText(redirect);
    copy.lastChild!.textContent = 'Tersalin';
    setTimeout(() => (copy.lastChild!.textContent = 'Salin'), 1500);
  }, 'default');
  const connect = button(status === 'connecting' ? 'Menunggu login…' : 'Sambungkan', () => send({ type: 'spotify-connect', clientId: input.value }), 'primary');
  connect.disabled = status === 'connecting';

  el.append(
    h('p', { class: 'spotify__intro', html:
      'Windows hanya memberi tahu lagu yang <b>sedang</b> diputar. Untuk melihat antrean, sambungkan akun Spotify sekali saja. ' +
      'Sonora hanya meminta izin <b>membaca</b> antrean. Login dilakukan di situs Spotify, jadi password tidak pernah masuk ke Sonora.' }),
    h('ol', { class: 'steps' },
      h('li', {},
        h('div', { class: 'steps__text', html: 'Buka <b>Spotify for Developers</b>, login, lalu klik <b>Create app</b>. Nama dan deskripsinya bebas, misalnya "Sonora".' }),
        button('Buka situs', () => send({ type: 'open-url', url: DEV_DASHBOARD }), 'default', icon.chevron)),
      h('li', {},
        h('div', { class: 'steps__text', html: `Di kolom <b>Redirect URIs</b>, tempel alamat ini, centang <b>Web API</b>, lalu simpan.<code class="steps__code">${esc(redirect)}</code>` }),
        copy),
      h('li', {},
        h('div', { class: 'steps__text', html: 'Buka app yang baru dibuat, salin <b>Client ID</b>, tempel di bawah, lalu klik Sambungkan. Browser akan terbuka untuk login.' }))),
    h('div', { class: 'spotify__connect' }, input, connect));
  if (status === 'error' && q?.error) el.append(h('div', { class: 'spotify__error', text: q.error }));
  if (status === 'connecting') el.append(h('div', { class: 'spotify__hint', text: 'Selesaikan login di browser yang baru terbuka. Halaman ini akan berubah sendiri.' }));
}
