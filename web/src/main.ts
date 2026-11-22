import './style.css';
import { inHost, onMessage, send } from './bridge';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <main class="shell">
    <header class="brand">
      <div class="logo" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
      <div>
        <h1>Sonora</h1>
        <p class="muted">Widget musik untuk desktop — tahap M0</p>
      </div>
    </header>

    <section class="card">
      <h2>Status</h2>
      <dl class="facts">
        <dt>Host</dt><dd id="host">${inHost ? 'menghubungkan…' : 'tidak terhubung (mode browser)'}</dd>
        <dt>Versi</dt><dd id="version">—</dd>
        <dt>Runtime</dt><dd id="runtime">—</dd>
        <dt>WebView2</dt><dd id="webview">—</dd>
        <dt>Folder data</dt><dd><code id="dataDir">—</code></dd>
      </dl>
      <button id="openData" type="button" disabled>Buka folder data</button>
    </section>

    <p class="muted small">Menutup jendela ini tidak menghentikan aplikasi. Keluar lewat ikon tray.</p>
  </main>
`;

const $ = (id: string) => document.getElementById(id)!;

onMessage((msg) => {
  if (msg.type === 'hello') {
    $('host').textContent = `terhubung — ${msg.app}`;
    $('version').textContent = msg.version;
    $('runtime').textContent = msg.runtime;
    $('webview').textContent = msg.webview;
    $('dataDir').textContent = msg.dataDir;
    ($('openData') as HTMLButtonElement).disabled = false;
  }
});

$('openData').addEventListener('click', () => send({ type: 'open-data-dir' }));

send({ type: 'hello' });
