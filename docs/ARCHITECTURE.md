# Sonora — Rancangan Arsitektur (draft v0.1)

> "Sonora" hanya nama sementara. Aplikasi ini widget desktop Windows yang hidup mengikuti musik:
> visualizer, lirik, now-playing, dan wallpaper yang bergerak. Semuanya gratis dan open source (MIT).
>
> **Aturan clean-room:** fitur aplikasi referensi dipakai sebagai *daftar kebutuhan* saja. Semua kode, shader,
> desain visual, ikon, dan teks ditulis sendiri. Tidak ada satu baris pun yang disalin dari aplikasi referensi.

---

## 1. Tujuan dan pembeda dari aplikasi referensi

| aplikasi referensi | Sonora |
|---|---|
| Electron: 1 proses Chromium per widget, RAM berat | 1 proses native + WebView2 bersama; widget desktop digabung per monitor |
| 4 helper .exe terpisah yang bicara lewat stdout | Audio, media, dan sistem langsung di proses inti (tanpa pipe) |
| Visualizer dominan Canvas2D | WebGL2 (shader); jalur WebGPU disiapkan |
| Scene tertutup | **Plugin API**: siapa saja bisa menulis widget/scene dalam 1 folder |
| FFT + deteksi kick sederhana | Analisis lengkap: band, onset, BPM, loudness (LUFS), mood |
| Pro berbayar + server lisensi | Gratis, tanpa akun, tanpa server kami |

Target performa: < 120 MB RAM total dengan 3 widget aktif, < 3% CPU, 0 fps saat tertutup atau sedang main game.

---

## 2. Gambaran besar

```
┌──────────────────────────── Proses inti (Host) ────────────────────────────┐
│                                                                            │
│  AudioEngine ── WASAPI loopback → ring buffer → FFT/analisis → AudioFrame   │
│  MediaService ─ SMTC (judul, artis, cover, posisi, kontrol)  → TrackState   │
│  ContentService ─ lirik (LRCLIB), cover HD (iTunes/Deezer), cuaca (Open-Meteo)
│  SystemService ─ CPU/GPU/RAM/net/disk, deteksi game & fullscreen, idle     │
│  DesktopService ─ WorkerW/Progman, layer, klik-tembus, multi-monitor       │
│  SettingsStore ─ JSON + skema versi; Profiles; StatsDB (SQLite)            │
│  Scheduler ──── fps budget, occlusion, power mode                          │
│                                                                            │
│            Bus (pub/sub) ──► Bridge ke WebView2 (SharedBuffer + JSON)      │
└──────────────┬───────────────────┬───────────────────┬─────────────────────┘
               │                   │                   │
     ┌─────────▼────────┐ ┌────────▼────────┐ ┌────────▼────────┐ ┌──────────────┐
     │ L0 Wallpaper     │ │ L1 Widget layer │ │ L2 Overlay      │ │ Dashboard    │
     │ di belakang ikon │ │ di atas wallpaper│ │ topmost, klik   │ │ (jendela     │
     │ 1 per monitor    │ │ 1 per monitor   │ │ tembus          │ │  pengaturan) │
     │ Environments,    │ │ semua widget    │ │ Screen glow,    │ │              │
     │ Living wallpaper,│ │ kotak (Orb,     │ │ Cursor trail    │ │              │
     │ Span, Waves,     │ │ Vinyl, Lirik…)  │ │                 │ │              │
     │ Album backdrop   │ │                 │ │                 │ │              │
     └──────────────────┘ └─────────────────┘ └─────────────────┘ └──────────────┘
                 Fullscreen Stage dan Screen saver = jendela L3 sementara
```

### Tiga layer jendela (pembeda terbesar)
- **L0 Wallpaper:** satu jendela per monitor, di-`SetParent` ke WorkerW di belakang ikon desktop. Hanya satu
  "wallpaper hidup" aktif dalam satu waktu. Tidak menerima input.
- **L1 Widget:** ✅ *diputuskan setelah spike M2* — **satu jendela kecil per widget**, seukuran widget.
  - Jendelanya `WS_EX_NOREDIRECTIONBITMAP`, sehingga transparan per-piksel tanpa latar hitam. Ia tetap ber-style popup,
    tapi induknya dipindah lewat `SetParent` ke jendela pemilik ikon desktop (Progman di 24H2+, WorkerW di versi lama),
    di atas lapisan ikon.
  - Efeknya: widget selalu di belakang semua aplikasi, tidak muncul di Alt-Tab maupun taskbar, tetap ada setelah
    Win+D, dan tetap bisa menerima klik.
  - Rancangan awal "satu jendela selebar monitor" dibatalkan. Hasil spike: area jendela anak Progman menyembunyikan
    ikon desktop di bawahnya, jadi jendela selebar layar akan menyembunyikan semua ikon.
  - Supaya banyak widget tetap hemat, semua halaman berbagi satu renderer (`--process-per-site`).
  - Widget yang dikunci memakai `WS_EX_TRANSPARENT|WS_EX_LAYERED` (klik tembus). Ini sudah diuji dan tetap transparan.
  - Saat Explorer restart, widget dibangun ulang begitu pesan `TaskbarCreated` diterima.
  - Gerak dan resize: halaman hanya memberi sinyal mulai, tiap frame, dan selesai. Host membaca posisi kursor asli,
    sehingga presisi di semua DPI dan monitor.
  - Render dibatasi 60 fps (data audio juga 60 Hz) dan turun ke sekitar 12 fps saat diam. Terukur dengan 2 widget dan
    musik berjalan: total sekitar 1,7% CPU dan 333 MB.- **L2 Overlay:** jendela topmost, selalu klik-tembus, tidak menerima fokus. Otomatis mundur saat ada game
  atau video fullscreen.

---

## 3. Pilihan teknologi — ✅ DIPUTUSKAN: A (.NET 10 + WebView2)

Di PC kamu saat ini terpasang Node 24, git, dan .NET *runtime* (belum SDK). Rust belum ada.

| | **A. .NET 10 + WebView2** (rekomendasi) | B. Tauri 2 (Rust) + WebView2 |
|---|---|---|
| Yang perlu dipasang | .NET 10 SDK (~250 MB) | Rust + VS Build Tools C++ (~5 GB) |
| WASAPI, SMTC, Win32 | Sangat matang (WinRT langsung, NAudio) | Bisa (windows-rs), lebih banyak kode manual |
| RAM proses inti | ~40 MB | ~10 MB |
| Kecepatan kita membangun | Cepat | Sedang |
| Installer + auto-update | Velopack (MIT, GitHub Releases) | Bawaan Tauri |

Rekomendasinya **A**. Aplikasi ini hanya untuk Windows, dan API terpentingnya (SMTC, WASAPI, WorkerW) paling
mulus diakses dari C#. Selisih RAM-nya kecil dibandingkan WebView2-nya sendiri.

**Frontend (sama untuk A/B):** TypeScript + Vite.
- Render widget: WebGL2 dengan micro-engine buatan sendiri (tanpa three.js agar ringan). three.js hanya
  dipakai untuk scene 3D berat bila memang perlu.
- Dashboard: Svelte 5.

---

## 4. Modul inti (Host)

### 4.1 AudioEngine
- WASAPI loopback pada default render device; ikut berpindah saat device berganti. Downmix ke mono dan
  disimpan stereo terpisah untuk scope X-Y.
- Implementasi: NAudio 3 `WasapiRecorderBuilder`. NAudio 3 juga mendukung **process loopback**, jadi nanti bisa ada opsi
  "tangkap Spotify saja" agar suara Discord atau notifikasi tidak ikut tervisualisasi.
- Engine hanya berjalan selama ada yang menampilkannya (sistem lease). Dashboard yang ditutup benar-benar dibuang,
  sehingga proses WebView2 ikut berhenti (terukur: host 23 MB, 0,03% CPU).
- Pipeline per hop (1024 sampel @48 kHz ≈ 21 ms; dikirim ±60 Hz):
  - FFT 4096 Hann → 128 band log, plus 1/3-oktaf untuk meter
  - Smoothing attack/release per band; AGC (sensitivitas otomatis)
  - Onset/kick: spectral flux pada band 40–150 Hz, threshold adaptif
  - BPM: autokorelasi onset dengan jendela 8 detik
  - Loudness: RMS, peak, short-term LUFS
  - Fitur mood: spectral centroid, flatness, kepadatan onset, BPM, dynamic range → vektor `energy`,
    `valence-ish`, `brightness`, `genre-hint` (acoustic / heavy / electronic / ambient)
  - Deteksi "perubahan gigi" (drop/breakdown): lompatan energi jangka menengah
- Output `AudioFrame`: `bands[128]`, `wave[1024]`, `waveL/R`, `rms`, `peak`, `kick`, `beatPhase`,
  `bpm`, `mood{}`, `silent`.

### 4.2 MediaService
- `GlobalSystemMediaTransportControlsSessionManager`: memilih sesi aktif, membaca judul, artis, album,
  thumbnail, status, timeline, serta kontrol play/pause/next/prev.
- **Auto-link tanpa login:** begitu Spotify (atau app lain yang terdaftar di SMTC) mulai memutar, widget langsung
  terhubung lewat event `SessionsChanged` / `CurrentSessionChanged`. Saat Spotify ditutup, widget memudar ke mode idle.
- **Prioritas sumber** (opsi): Spotify > lainnya, agar video YouTube di background tidak "merebut" widget.
  Pengguna juga bisa mengunci ke satu app.
- Posisi lagu diinterpolasi di sisi klien. Riwayat 6 lagu terakhir disimpan untuk Vinyl/CD/Cassette.
- CoverPalette: k-means pada cover → 5 warna + warna dominan/aksen. Dipakai untuk **Mood sync**.

### 4.3 ContentService (semua gratis, tanpa akun)
- Lirik: LRCLIB (`/api/get`, fallback `/api/search`). Cache di disk. Offset per lagu dan global disimpan.
- Cover HD: iTunes Search, fallback Deezer. Cache di disk.
- Cuaca: Open-Meteo (geocoding + forecast), refresh 20 menit.

### 4.4 SystemService
- CPU, RAM, jaringan (PDH/`GetSystemTimes`); GPU lewat counter "GPU Engine" (angka yang sama dengan Task Manager).
- Disk: `GetDiskFreeSpaceEx`, drive lokal saja, cek tiap 60 detik.
- Game/fullscreen: `SHQueryUserNotificationState` + cek jendela foreground yang menutupi monitor.
- Occlusion: tiap layer tahu kapan tertutup jendela lain, lalu fps-nya dijadikan 0.
- Idle → screen saver.

### 4.5 DesktopService
- Spawn WorkerW (`0x052C` ke Progman), dengan dukungan layout lama dan baru Windows 11 (24H2+).
- Multi-monitor dan DPI per monitor; event perubahan layar dan wallpaper.
- Klik-tembus dinamis untuk L1, toolwindow, tidak masuk Alt-Tab, bertahan dari Win+D.

### 4.6 Settings, Profiles, Stats
- `settings.json` dengan skema versi dan migrasi otomatis. Satu objek per widget:
  `{enabled, rect{monitor,x,y,w,h}, locked, opacity, style, colors, ...}`.
- Profiles: snapshot layout lengkap. Pemicu: jam tertentu, atau aplikasi tertentu sedang terbuka
  (berlaku selama app itu terbuka, lalu kembali ke profil sebelumnya). Bisa dipilih dari tray.
- StatsDB (SQLite lokal): menit mendengar per hari, streak, top artis minggu ini. Tidak dikirim ke mana pun.

### 4.7 Scheduler (hemat daya)
- Budget fps per layer: 60 / 30 / 20 (diatur pengguna). Turun otomatis ke 20 fps saat sunyi.
- 0 fps saat tertutup jendela lain atau ada game fullscreen (opsional 15 fps).
- Mode baterai: turun satu tingkat.

### 4.8 Bridge Host ↔ WebView2
- AudioFrame lewat `SharedBuffer` WebView2 (memori bersama, nol-copy). Ini jauh lebih efisien daripada JSON 60×/detik.
- State lain (track, settings, cuaca) lewat `postMessage` JSON, hanya saat ada perubahan.

---

## 5. Frontend: engine widget dan Plugin API

```ts
export default defineWidget({
  id: 'orb',
  name: 'Orb',
  layer: 'widget',              // 'wallpaper' | 'widget' | 'overlay' | 'stage'
  defaultSize: [420, 420],
  settings: { spin: slider(0, 2, 1), colors: palette(3), /* … */ },
  create(ctx) {                 // ctx: gl, canvas, rect, theme, host API
    return {
      frame(audio, track, dt) {},  // dipanggil oleh Scheduler
      resize(w, h) {},
      dispose() {},
    };
  },
});
```

- Satu L1 per monitor merender semua widget lewat scissor/viewport di satu canvas WebGL. Widget berbasis DOM
  (lirik, kalender, cuaca) memakai elemen absolut di atas canvas.
- Shared toolkit: post-processing bloom/glow, partikel GPU, fluid solver, palet/gradien, easing, font.
- Plugin pihak ketiga ditaruh di `%APPDATA%/Sonora/plugins/<id>/`. Karena kodenya web, plugin berjalan di
  sandbox WebView, sehingga tidak punya akses langsung ke sistem.

---

## 6. Katalog fitur (semua gratis)

Kolom "Teknik kita" adalah rancangan implementasi kita sendiri.

### Inti
| Fitur | Teknik kita |
|---|---|
| Visualizer (banyak gaya: bar, ring, spoke, wave, dll.) | Shader instanced; densitas, warna, glow, kartu now-playing |
| Jam (digital/analog, berbagai font) | DOM + SVG; pulse saat kick |
| Lirik tersinkron + gaya motion (pulse, stretch, glow, dissolve) | DOM per kata + CSS/WebGL text; offset per lagu |
| Now playing card | Cover, progress, kontrol; mode miring ala menu game |

### Widget kotak (L1)
| Fitur | Teknik kita |
|---|---|
| Orb | Sphere mesh dengan displacement dari band; pole shimmer dari treble |
| Vinyl | Piringan 2D/3D, label = cover, tonearm teranimasi, "song wheel" riwayat |
| CD | Disc dengan iridescence (shader thin-film), mode CD-R tulisan tangan |
| Cassette | Reel berputar sesuai progres lagu; varian portable dan deck dengan VU |
| Neon sign | Path teks → tabung neon (SDF glow); efek chase/equalizer/flicker |
| Waterfall | Ridgeline (garis bertumpuk) dan spectrogram heatmap (texture scroll) |
| Scope | Trace, Circle, X-Y Lissajous (stereo/delay) dengan afterglow fosfor (FBO feedback) |
| Particles | GPU particles (transform feedback): swarm, galaxy, burst |
| Terrain | Grid mesh, baris baru = spektrum, kamera maju; gaya synthwave/low-poly |
| Meters | LED tower dengan peak hold dan VU jarum (fisika pegas) |
| Snow | Partikel dengan angin dari bass dan gust saat kick |
| Murmuration | Boids di GPU (atau Web Worker), ripple saat kick, predator saat drop |
| Fluid | Stable Fluids (Navier-Stokes) WebGL; mode liquid/smoke/particles; diaduk mouse |
| Listening stats | Dari StatsDB |
| Calendar | DOM, hari ini berdenyut |
| Weather | Open-Meteo |
| System monitor | Meters/graphs/rings: CPU, GPU, RAM, net |
| Disk | Bar per drive, merah bila hampir penuh |

### Wallpaper hidup (L0, satu aktif)
| Fitur | Teknik kita |
|---|---|
| Environments | Beberapa "dunia" (float, rain, neon geometry, …) dipilih dari vektor mood; crossfade saat lagu berganti atau berubah gigi |
| Living wallpaper | Segmentasi foreground dan depth dengan model ONNX lokal (sekali per gambar), lalu parallax, bass pulse, sparkle highlight, light bloom |
| Span | Satu kanvas virtual lintas monitor; gelombang dan cincin sinkron melintasi bezel |
| Waves | Pita lebar penuh, memudar otomatis di sekitar widget L1 (mask dari rect widget) |
| Album backdrop | Cover di-blur besar, mengalir pelan (domain warping), terang saat kick |

### Overlay (L2)
| Fitur | Teknik kita |
|---|---|
| Screen glow | Cahaya di tepi layar, spektrum di taskbar, border berdenyut pada jendela aktif |
| Cursor trail | Ribbon/sparks/rings mengikuti kursor (posisi dari host), fade saat diam |

### Lainnya
| Fitur | Teknik kita |
|---|---|
| Mood sync | Palet cover menimpa warna semua widget |
| Profiles | Jadwal dan pemicu aplikasi (lihat 4.6) |
| Fullscreen Stage | Cover + visualizer + kontrol; UI memudar saat mouse diam |
| Screen saver (.scr) | Launcher kecil `/s /c /p` yang memanggil host untuk membuka Stage |
| Hemat daya | Lihat 4.7 |
| Auto-update | GitHub Releases, selalu minta izin dulu |

### Tambahan yang tidak ada di aplikasi referensi
- Plugin API dan galeri scene komunitas
- Deteksi BPM dan beat phase (animasi terkunci ke tempo, bukan sekadar reaksi kick)
- Equalizer-aware sensitivity (AGC otomatis)
- Hotkey global (toggle semua widget, ganti profil)
- Ekspor/impor profil sebagai file
- Bahasa Indonesia dan Inggris sejak awal

---

## 7. Struktur repo

```
sonora/
├─ host/                 # proses inti (.NET 10)
│  ├─ Audio/  Media/  Content/  System/  Desktop/  Settings/  Bridge/
│  └─ Sonora.Host.csproj
├─ saver/                # launcher .scr
├─ web/                  # TypeScript + Vite
│  ├─ engine/            # micro-engine WebGL, scheduler klien, bridge
│  ├─ widgets/<id>/      # satu folder per widget (pakai Plugin API)
│  ├─ layers/            # wallpaper / widget / overlay / stage
│  └─ dashboard/         # Svelte
├─ models/               # ONNX untuk Living wallpaper (lisensi MIT/Apache)
├─ docs/
└─ .github/workflows/    # build + release
```

---

## 8. Tahapan

| Tahap | Isi | Hasil yang bisa dicoba |
|---|---|---|
| M0 | Setup toolchain, skeleton host + WebView2, tray | Ikon tray, jendela kosong |
| M1 | AudioEngine + MediaService + bridge SharedBuffer | Panel debug menampilkan spektrum dan lagu |
| M2 | DesktopService L1 + engine widget + 3 visualizer + jam | Widget hidup di desktop, bisa di-drag dan resize |
| M3 | Lirik + now playing + dashboard dasar + settings | Paket fitur "gratis" aplikasi referensi tercapai |
| M4 | Widget kotak gelombang 1: Orb, Scope, Meters, Waterfall, Particles, Snow | |
| M5 | L0 wallpaper: Album backdrop, Waves, Span, Environments | |
| M6 | Vinyl, CD, Cassette, Neon, Terrain, Murmuration, Fluid | |
| M7 | Living wallpaper (ONNX), Screen glow, Cursor trail | |
| M8 | Stats, Calendar, Weather, System, Disk, Profiles, Mood sync | |
| M9 | Stage, Screen saver, hemat daya, installer, auto-update, rilis 1.0 | |

---

## 9. Risiko yang sudah diketahui
- **Layout WorkerW berubah di Windows 11 24H2+.** Perlu dua jalur deteksi dan uji di build kamu (26300).
- **Transparansi WebView2 + klik-tembus dinamis.** Akan diuji lebih dulu di M2. Bila gagal, kita pakai mode
  satu-jendela-per-widget.
- **Sesi SMTC.** Beberapa app (mis. browser tertentu) tidak melaporkan timeline dengan rapi, sehingga lirik
  memakai interpolasi plus koreksi.
- **Model segmentasi.** Ukurannya ±5–25 MB; diunduh saat fitur pertama kali dipakai agar installer tetap kecil.

---

## 10. Instalasi, transparansi, dan uninstall sekali klik

Prinsipnya: aplikasi ini harus **mudah dipasang, jelas apa yang dikerjakannya, dan bersih total saat dihapus**.

### Jejak di sistem (semuanya di satu tempat)
| Apa | Di mana | Dibersihkan saat uninstall |
|---|---|---|
| Program | `%LOCALAPPDATA%\Sonora\` | ✅ |
| Settings, profil, cache lirik/cover, StatsDB, model ONNX, log | `%LOCALAPPDATA%\Sonora\data\` | ✅ (opsi "simpan pengaturan" bila ingin pasang lagi) |
| Start bersama Windows | `HKCU\...\Run\Sonora` (1 nilai registry) | ✅ |
| Screen saver (hanya bila diaktifkan) | `HKCU\Control Panel\Desktop\SCRNSAVE.EXE` | ✅ dikembalikan ke nilai sebelumnya |
| Entri "Apps & features" | `HKCU\...\Uninstall\Sonora` | ✅ |
| Shortcut Start Menu / Desktop | per-user | ✅ |

**Yang tidak dilakukan:** tidak ada service, driver, scheduled task, atau proses latar setelah aplikasi ditutup.
Tidak butuh hak admin, wallpaper asli tidak diubah (layer kita hanya menimpa sementara), dan tidak ada
telemetri. WebView2 Runtime adalah komponen bawaan Windows 11, jadi tidak ikut dihapus.

### Cara uninstall (sama hasilnya)
1. Settings Windows → Apps → Sonora → **Uninstall**, atau
2. Di dalam app: **Pengaturan → Sistem → Hapus Sonora sepenuhnya**, atau
3. Klik kanan ikon tray → Keluar & hapus.

Urutan uninstall: hentikan semua jendela → refresh desktop (WorkerW dikembalikan) → kembalikan registry yang
pernah diubah → hapus folder program dan data → hapus entri uninstall. Selesai tanpa restart dan tanpa sisa.

### Transparansi beban
- Panel **"Beban aplikasi"** di dashboard: CPU, GPU, RAM milik Sonora sendiri, real-time, per widget.
- Tombol **Mode ringan**: 30 fps, efek bloom mati, hanya widget yang tampil.
- Jeda otomatis saat game fullscreen, saat tertutup jendela, dan saat tidak ada musik (lihat 4.7).

### Installer
Velopack: installer per-user (~setup.exe), update delta kecil dari GitHub Releases, dengan hook
`--veloapp-uninstall` yang menjalankan pembersihan di atas.
