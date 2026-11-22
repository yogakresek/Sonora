# Sonora (nama sementara)

Widget musik untuk desktop Windows: visualizer, lirik tersinkron, dan wallpaper hidup. Gratis dan open source.
Rancangan lengkapnya ada di [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Status:** M4 — widget **Antrean** (lagu berikutnya dari Spotify Web API, opsional; klik untuk memutar), gaya lirik **Kinetik** (tiap kata punya font, ukuran, dan animasinya sendiri), dan **Mode santai**. Sebelumnya: dashboard bergaya Windows 11, 5 gaya Visualizer, 5 gaya Lirik. Arah desain ada di [docs/DESIGN.md](docs/DESIGN.md).

## Kebutuhan
- Windows 10 19041+ / Windows 11
- .NET 10 SDK
- Node.js 20+

## Build & jalankan
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
host/Sonora.Host/   proses inti .NET (tray, jendela, nanti audio/media/desktop)
web/                frontend TypeScript + Vite (dashboard, nanti widget)
tests/              unit test (analyzer audio)
docs/               rancangan
```

Semua data aplikasi disimpan di `%LOCALAPPDATA%\Sonora\`.
