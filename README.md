# Sonora (nama sementara)

Widget musik untuk desktop Windows: visualizer, lirik tersinkron, dan wallpaper hidup. Gratis dan open source.
Rancangan lengkapnya ada di [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Status:** M0 — kerangka aplikasi (tray, dashboard WebView2, bridge host ↔ web).

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

## Struktur
```
host/Sonora.Host/   proses inti .NET (tray, jendela, nanti audio/media/desktop)
web/                frontend TypeScript + Vite (dashboard, nanti widget)
docs/               rancangan
```

Semua data aplikasi disimpan di `%LOCALAPPDATA%\Sonora\`.
