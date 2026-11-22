import { on, onTick, setPrefs, store } from '../store';
import { esc, group, h, icon, pageHeader, row, slider } from '../ui';

export function audioPage(container: HTMLElement): () => void {
  const cleanups: (() => void)[] = [];

  const status = h('div', { class: 'status-card' });
  function showStatus(): void {
    const a = store.audio;
    const t = store.track;
    const state = a?.state ?? 'stopped';
    const label = { running: 'Mendengarkan', stopped: 'Siaga', 'no-device': 'Tidak ada output audio', error: 'Bermasalah' }[state];
    status.innerHTML = `
      <div class="status-card__main">
        <span class="pulse-dot pulse-dot--${state}"></span>
        <div>
          <div class="status-card__title">${label}</div>
          <div class="status-card__sub">${state === 'running'
            ? `${esc(a!.device ?? '')} · ${(a!.sampleRate / 1000).toFixed(1)} kHz · ${a!.channels} kanal`
            : esc(a?.error ?? 'Sonora menangkap suara apa pun yang sedang diputar PC: Spotify, browser, atau game.')}</div>
        </div>
      </div>
      <div class="status-card__side">${t ? `Sumber lagu: <b>${esc(t.appName)}</b>` : 'Belum ada sumber lagu'}</div>`;
  }
  showStatus();
  cleanups.push(on('audio', showStatus), on('track', showStatus));

  // Diagnostics.
  const canvas = h('canvas', { class: 'diag__canvas' });
  const stats = h('div', { class: 'diag__stats' });
  const g = canvas.getContext('2d')!;
  let kickFlash = 0, lastKicks = 0, statTimer = 0;
  cleanups.push(onTick((f, dt, now) => {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), hgt = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; }
    g.clearRect(0, 0, w, hgt);
    const n = f.bands.length, gap = Math.max(1, (w / n) * 0.28), bw = w / n - gap;
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#8b5cf6');
    grad.addColorStop(0.55, '#d946ef');
    grad.addColorStop(1, '#22d3ee');
    g.fillStyle = grad;
    for (let i = 0; i < n; i++) {
      const bh = Math.max(dpr, f.bands[i] * (hgt - 4 * dpr));
      g.beginPath();
      g.roundRect(i * (bw + gap), hgt - bh, bw, bh, Math.min(bw / 2, 3 * dpr));
      g.fill();
    }
    if (f.kickCount !== lastKicks) { lastKicks = f.kickCount; kickFlash = 1; }
    else kickFlash = Math.max(0, kickFlash - dt * 5);
    stats.style.setProperty('--kick', kickFlash.toFixed(2));
    if (now - statTimer > 250) {
      statTimer = now;
      stats.innerHTML = `
        <div class="stat"><span>Tempo</span><b>${f.bpm > 0 ? `${Math.round(f.bpm)}<small> BPM</small>` : '—'}</b></div>
        <div class="stat"><span>Ketukan</span><b><i class="kick"></i>${f.kickCount}</b></div>
        <div class="stat"><span>Kekerasan</span><b>${f.silent ? 'hening' : `${f.loudnessDb.toFixed(0)}<small> dB</small>`}</b></div>
        <div class="stat"><span>Kecerahan</span><b>${f.silent ? '—' : `${Math.round(f.centroid * 100)}<small>%</small>`}</b></div>`;
    }
  }));

  container.append(
    pageHeader('Audio', 'Bagaimana Sonora mendengar musikmu.'),
    status,
    group('Respons',
      row('Sensitivitas', 'Naikkan untuk musik yang pelan; turunkan kalau semua bar mentok di atas.',
        slider({ min: 0.3, max: 2.5, step: 0.05, value: store.prefs.sensitivity, format: (v) => `${v.toFixed(2)}×`, onInput: (v) => setPrefs({ sensitivity: v }) }),
        icon.audio),
      row('Kehalusan', 'Rendah: lincah dan tajam. Tinggi: tenang dan mengalir.',
        slider({ min: 0, max: 0.95, step: 0.01, value: store.prefs.smoothing, format: (v) => v.toFixed(2), onInput: (v) => setPrefs({ smoothing: v }) }),
        icon.speed)),
    group('Diagnostik', h('div', { class: 'diag' }, canvas, stats)));

  return () => cleanups.forEach((c) => c());
}
