import './style.css';
import { AudioReader, type AudioFrame } from './audio';
import { inHost, onMessage, send, trackPosition, type AudioStatus, type Track, type WidgetItem } from './bridge';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <main class="shell">
    <header class="brand">
      <div class="logo" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
      <div>
        <h1>Sonora</h1>
        <p class="muted">Widget musik untuk desktop — tahap M2</p>
      </div>
    </header>

    <section class="card">
      <div class="row">
        <h2>Widget di desktop</h2>
        <label class="switch switch--inline"><input type="checkbox" id="widgetsHidden"><span></span>Sembunyikan semua</label>
      </div>
      <p class="muted small">Geser widget langsung di desktop. Tarik sudut kanan bawah untuk mengubah ukuran. Klik dua kali widget untuk membuka jendela ini.</p>
      <div class="widgets" id="widgetList"></div>
    </section>

    <section class="card np" id="np">
      <div class="np__cover" id="npCover"><span>♪</span></div>
      <div class="np__body">
        <div class="np__app" id="npApp">Tidak ada yang diputar</div>
        <div class="np__title" id="npTitle">Putar lagu di Spotify</div>
        <div class="np__artist" id="npArtist">Sonora akan tersambung otomatis</div>
        <div class="np__progress"><div class="np__bar" id="npBar"></div></div>
        <div class="np__times"><span id="npPos">0:00</span><span id="npDur">0:00</span></div>
        <div class="np__controls">
          <button type="button" id="btnPrev" aria-label="Sebelumnya" disabled>⏮</button>
          <button type="button" id="btnToggle" class="primary" aria-label="Putar/jeda" disabled>▶</button>
          <button type="button" id="btnNext" aria-label="Berikutnya" disabled>⏭</button>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="row">
        <h2>Audio</h2>
        <span class="pill" id="audioState">—</span>
      </div>
      <p class="muted small" id="audioDevice">Menunggu host…</p>

      <canvas class="viz" id="spectrum" height="180"></canvas>
      <canvas class="viz viz--wave" id="wave" height="90"></canvas>

      <div class="stats">
        <div class="stat"><span class="stat__label">BPM</span><span class="stat__value" id="statBpm">—</span></div>
        <div class="stat"><span class="stat__label">Kick</span><span class="kick" id="statKick"></span><span class="stat__value small" id="statKicks">0</span></div>
        <div class="stat"><span class="stat__label">Loudness</span><span class="stat__value" id="statLoud">—</span></div>
        <div class="stat"><span class="stat__label">Brightness</span><span class="stat__value" id="statCentroid">—</span></div>
        <div class="stat stat--wide">
          <span class="stat__label">Low · Mid · High</span>
          <div class="meters"><i id="mLow"></i><i id="mMid"></i><i id="mHigh"></i></div>
        </div>
      </div>
    </section>

    <details class="card">
      <summary>Info aplikasi</summary>
      <dl class="facts">
        <dt>Host</dt><dd id="host">${inHost ? 'menghubungkan…' : 'tidak terhubung (mode browser)'}</dd>
        <dt>Versi</dt><dd id="version">—</dd>
        <dt>Runtime</dt><dd id="runtime">—</dd>
        <dt>WebView2</dt><dd id="webview">—</dd>
        <dt>Folder data</dt><dd><code id="dataDir">—</code></dd>
      </dl>
      <button id="openData" type="button" disabled>Buka folder data</button>
    </details>

    <p class="muted small">Menutup jendela ini tidak menghentikan aplikasi. Keluar lewat ikon tray.</p>
  </main>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ host messages

let track: Track | null = null;

onMessage((msg) => {
  switch (msg.type) {
    case 'hello':
      $('host').textContent = `terhubung — ${msg.app}`;
      $('version').textContent = msg.version;
      $('runtime').textContent = msg.runtime;
      $('webview').textContent = msg.webview;
      $('dataDir').textContent = msg.dataDir;
      $<HTMLButtonElement>('openData').disabled = false;
      break;
    case 'audio-status':
      showAudioStatus(msg.status);
      break;
    case 'track':
      track = msg.track;
      showTrack(track);
      break;
    case 'widgets':
      showWidgets(msg.items, msg.hidden);
      break;
  }
});

$('openData').addEventListener('click', () => send({ type: 'open-data-dir' }));
$('btnPrev').addEventListener('click', () => send({ type: 'media', command: 'previous' }));
$('btnToggle').addEventListener('click', () => send({ type: 'media', command: 'toggle' }));
$('btnNext').addEventListener('click', () => send({ type: 'media', command: 'next' }));

function showWidgets(items: WidgetItem[], hidden: boolean): void {
  $<HTMLInputElement>('widgetsHidden').checked = hidden;
  $('widgetList').innerHTML = items.map((w) => `
    <div class="widget-row" data-id="${w.id}">
      <div class="widget-row__text">
        <div class="widget-row__name">${w.name}</div>
        <div class="muted small">${w.description}</div>
      </div>
      <label class="switch" title="Kunci posisi: widget tidak bisa digeser dan klik tembus ke desktop">
        <input type="checkbox" data-act="locked" ${w.locked ? 'checked' : ''} ${w.enabled ? '' : 'disabled'}><span></span>Kunci
      </label>
      <button type="button" data-act="reset" ${w.enabled ? '' : 'disabled'}>Reset posisi</button>
      <label class="switch">
        <input type="checkbox" data-act="enabled" ${w.enabled ? 'checked' : ''}><span></span>Tampilkan
      </label>
    </div>`).join('');
}

$('widgetList').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const id = input.closest<HTMLElement>('.widget-row')?.dataset.id;
  if (!id) return;
  if (input.dataset.act === 'enabled') send({ type: 'widget-set', id, enabled: input.checked });
  if (input.dataset.act === 'locked') send({ type: 'widget-set', id, locked: input.checked });
});
$('widgetList').addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act="reset"]');
  const id = button?.closest<HTMLElement>('.widget-row')?.dataset.id;
  if (id) send({ type: 'widget-reset', id });
});
$('widgetsHidden').addEventListener('change', (e) =>
  send({ type: 'widgets-hidden', hidden: (e.target as HTMLInputElement).checked }));

function showAudioStatus(s: AudioStatus): void {
  const labels: Record<AudioStatus['state'], string> = {
    running: 'aktif', stopped: 'berhenti', 'no-device': 'tidak ada output', error: 'error',
  };
  const pill = $('audioState');
  pill.textContent = labels[s.state] ?? s.state;
  pill.dataset.state = s.state;
  $('audioDevice').textContent = s.state === 'running'
    ? `${s.device} · ${s.sampleRate / 1000} kHz · ${s.channels} ch`
    : s.error ?? s.device ?? 'Audio berjalan saat jendela ini terlihat.';
}

function showTrack(t: Track | null): void {
  const cover = $('npCover');
  if (!t) {
    $('npApp').textContent = 'Tidak ada yang diputar';
    $('npTitle').textContent = 'Putar lagu di Spotify';
    $('npArtist').textContent = 'Sonora akan tersambung otomatis';
    cover.innerHTML = '<span>♪</span>';
    for (const id of ['btnPrev', 'btnToggle', 'btnNext']) $<HTMLButtonElement>(id).disabled = true;
    return;
  }
  $('npApp').textContent = `${t.appName} · ${t.playing ? 'diputar' : 'dijeda'}`;
  $('npTitle').textContent = t.title || 'Tanpa judul';
  $('npArtist').textContent = [t.artist, t.album].filter(Boolean).join(' — ');
  if (t.cover) {
    const img = cover.querySelector('img');
    if (img?.getAttribute('src') !== t.cover) cover.innerHTML = `<img src="${t.cover}" alt="">`;
  } else {
    cover.innerHTML = '<span>♪</span>';
  }
  $<HTMLButtonElement>('btnPrev').disabled = !t.canPrevious;
  $<HTMLButtonElement>('btnNext').disabled = !t.canNext;
  const toggle = $<HTMLButtonElement>('btnToggle');
  toggle.disabled = !t.canToggle;
  toggle.textContent = t.playing ? '⏸' : '▶';
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ drawing

const audio = new AudioReader();
const spectrum = $<HTMLCanvasElement>('spectrum');
const wave = $<HTMLCanvasElement>('wave');
let lastKickCount = 0;
let kickFlash = 0;

function fit(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas.getContext('2d')!;
}

function drawSpectrum(f: AudioFrame): void {
  const g = fit(spectrum);
  const { width: w, height: h } = spectrum;
  g.clearRect(0, 0, w, h);

  const n = f.bands.length;
  const gap = Math.max(1, w / n * 0.25);
  const bw = w / n - gap;
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#7c3aed');
  grad.addColorStop(0.5, '#c026d3');
  grad.addColorStop(1, '#22d3ee');
  g.fillStyle = grad;
  g.globalAlpha = 0.6 + 0.4 * f.kick;
  for (let i = 0; i < n; i++) {
    const v = f.bands[i];
    const bh = Math.max(1, v * (h - 2));
    g.fillRect(i * (bw + gap), h - bh, bw, bh);
  }
  g.globalAlpha = 1;
}

function drawWave(f: AudioFrame): void {
  const g = fit(wave);
  const { width: w, height: h } = wave;
  g.clearRect(0, 0, w, h);

  const peak = Math.max(0.05, f.peak);
  const lines: [Float32Array, string][] = [[f.waveL, 'rgba(124,58,237,0.8)'], [f.waveR, 'rgba(34,211,238,0.8)']];
  g.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 1.25);
  for (const [samples, color] of lines) {
    g.strokeStyle = color;
    g.beginPath();
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h / 2 - (samples[i] / peak) * (h * 0.45);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
}

function drawStats(f: AudioFrame, dt: number): void {
  if (f.kickCount !== lastKickCount) {
    lastKickCount = f.kickCount;
    kickFlash = 1;
  } else {
    kickFlash = Math.max(0, kickFlash - dt * 6);
  }
  $('statKick').style.opacity = String(0.15 + 0.85 * kickFlash);
  $('statKick').style.transform = `scale(${1 + kickFlash * 0.5})`;
  $('statKicks').textContent = String(f.kickCount);

  $('statBpm').textContent = f.bpm > 0 ? `${Math.round(f.bpm)}${f.bpmConfidence < 0.3 ? '?' : ''}` : '—';
  $('statLoud').textContent = f.silent ? 'hening' : `${f.loudnessDb.toFixed(0)} dB`;
  $('statCentroid').textContent = f.silent ? '—' : `${Math.round(f.centroid * 100)}%`;
  $('mLow').style.transform = `scaleY(${f.low})`;
  $('mMid').style.transform = `scaleY(${f.mid})`;
  $('mHigh').style.transform = `scaleY(${f.high})`;
}

function drawProgress(): void {
  if (!track) {
    $('npBar').style.transform = 'scaleX(0)';
    $('npPos').textContent = '0:00';
    $('npDur').textContent = '0:00';
    return;
  }
  const pos = trackPosition(track);
  $('npBar').style.transform = `scaleX(${track.durationMs > 0 ? pos / track.durationMs : 0})`;
  $('npPos').textContent = fmt(pos);
  $('npDur').textContent = fmt(track.durationMs);
}

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (audio.read()) {
    const f = audio.frame;
    drawSpectrum(f);
    drawWave(f);
    drawStats(f, dt);
  }
  drawProgress();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

send({ type: 'hello' });
