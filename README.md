# Sonora (nama sementara)

Widget musik untuk desktop Windows: visualizer, lirik tersinkron, dan wallpaper hidup. Gratis dan open source.
Rancangan lengkapnya ada di [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### ⬇ [Unduh Sonora untuk Windows](https://github.com/yogakresek/Sonora/releases/latest/download/Sonora-win-Setup.exe)
Gratis, tanpa akun. Semua versi tersedia di halaman [Releases](https://github.com/yogakresek/Sonora/releases).

**Status kode:** 0.6.6. Isinya:
- **Suasana:** satu suasana layar penuh menggantikan widget sampai dimatikan. Waktu lirik bisa digeser per lagu.
  - **Star Mode:** lirik membentuk rasi bintang dengan langit dari warna album, plus kartu lagu interaktif.
  - **Piringan Hitam:** piringan "terbit" dari bawah layar dengan label cover yang berputar 33⅓ rpm. Lirik melengkung di alur dan mengalir ke jarum. Tonearm S-arm bisa digeser untuk pindah menit, dan warna piringan mengikuti cover.
- **Visualizer:** garis waktu lagu yang bisa digeser ke menit mana pun, tanpa perlu Premium.
- **Antrean Spotify:** lagu berikutnya dan sebelumnya bisa diklik.
- **Lirik:** 5 gaya (termasuk Kinetik yang menunggu suara penyanyi), menyesuaikan ukuran supaya muat, dan sinkron dengan lagu.
- **Lainnya:** 5 gaya Visualizer, Mode santai, dashboard bergaya Windows 11, installer, dan uninstall sekali klik.

Installer di tautan unduhan adalah rilis terbaru di halaman Releases. Arah desain ada di [docs/DESIGN.md](docs/DESIGN.md).

## Kebutuhan
- Windows 10 19041+ / Windows 11
- .NET 10 SDK
- Node.js 20+

## Pasang
Jalankan `Sonora-win-Setup.exe`. Pemasangannya per pengguna, tanpa hak admin. Installer membuat shortcut Desktop dan Start Menu, mendaftarkan Sonora di *Settings → Apps*, dan memasang .NET 10 Desktop Runtime serta WebView2 kalau belum ada.

| Apa | Di mana |
|---|---|
| Program | `%LOCALAPPDATA%\Sonora` |
| Data: pengaturan, cache, log, login Spotify | `%LOCALAPPDATA%\SonoraData` |

**Uninstall sekali klik:** lewat *Settings → Apps → Sonora → Uninstall*, atau *Dashboard → Pengaturan → Hapus Sonora sepenuhnya*. Keduanya menghapus program, data, shortcut, entri startup, dan entri Apps. Tidak ada yang tertinggal.

## Membuat installer
```powershell
dotnet tool install -g vpk
```
```powershell
.\tools\pack.ps1
```
Hasilnya ada di `artifacts\release\Sonora-win-Setup.exe`. Versinya diambil dari `<Version>` di `host/Sonora.Host/Sonora.Host.csproj`.

## Build & jalankan (pengembangan)
```powershell
cd web; npm install; npm run build; cd ..
dotnet run --project host/Sonora.Host
```

### Mode pengembangan (hot reload UI)
```powershell
cd web; npm run dev
```
Di terminal lain:
```powershell
$env:SONORA_DEV_URL = "http://localhost:5173"; dotnet run --project host/Sonora.Host
```

## Tes
```powershell
dotnet test
```

## Struktur
```
host/Sonora.Host/   proses inti .NET: tray, audio (WASAPI), media (Windows), lirik, Spotify, widget desktop
web/                frontend TypeScript + Vite: dashboard, widget (visualizer, lirik, antrean), dan suasana (Star Mode, Piringan Hitam)
tests/              unit test: analyzer audio, jam pemutaran, area klik
docs/               rancangan
```

Data aplikasi disimpan di `%LOCALAPPDATA%\SonoraData`.
