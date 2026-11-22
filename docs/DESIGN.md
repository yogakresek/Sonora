# Sonora — Arah desain (v1)

## Prinsip
1. **Pratinjau dulu, kontrol kemudian.** Setiap halaman widget dibuka dengan pratinjau hidup yang besar. Semua
   perubahan langsung terlihat di pratinjau sekaligus di desktop. aplikasi referensi menampilkan daftar pengaturan yang panjang;
   kita menampilkan hasilnya lebih dulu.
2. **Default yang sudah bagus.** Warna otomatis mengikuti cover, ukuran pas, dan efek secukupnya. Pengguna tidak
   wajib mengatur apa pun.
3. **Sedikit kontrol, tapi jelas.** Setiap pengaturan punya label pendek dan satu kalimat penjelasan. Pilihan gaya
   ditampilkan sebagai kartu bergambar hidup, bukan dropdown.
4. **Terasa bawaan Windows 11.** Jendela memakai bahan Mica dan title bar gelap, dengan font Segoe UI Variable.
   Sudut membulat 8–16 px dan garis tepi tipis.
5. **Tenang.** Latar netral gelap, dan warna aksen hanya untuk hal yang aktif. Animasi dibuat pendek (150–250 ms)
   tanpa efek memantul.

## Referensi konsep (diadaptasi, tidak disalin)
| Sumber | Yang diambil |
|---|---|
| Windows 11 Settings / Fluent 2 | Sidebar navigasi, kartu pengaturan berbaris, bahan Mica, toggle bergaya Windows |
| Apple Music (lirik) | Lirik mengalir dengan baris aktif yang terang, sementara baris lain redup dan blur halus |
| Raycast / Linear | Tipografi rapat dan tegas, kontras rendah untuk teks sekunder, border 1 px semi-transparan |
| Nothing OS widgets | Bentuk widget sederhana dan geometris, yang bisa tampil berani tanpa terasa ramai |

## Token
| Token | Nilai |
|---|---|
| Latar | Mica (fallback `#0d0d12`) |
| Permukaan | `rgba(255,255,255,0.04)`, saat hover `0.06`, saat aktif `0.08` |
| Garis | `rgba(255,255,255,0.07)` |
| Teks | `#f1f1f5`; sekunder `#a3a3b5`; tersier `#6e6e82` |
| Aksen | `#8b5cf6` → `#22d3ee` (gradien hanya untuk elemen utama) |
| Radius | 8 (kontrol), 12 (kartu), 16 (pratinjau) |
| Spasi | kelipatan 4: 8 / 12 / 16 / 24 / 32 |
| Font | Segoe UI Variable Text 13–14 px; Display 600 untuk judul |

## Struktur dashboard
- **Sidebar:** Beranda · Visualizer · Lirik · Audio · Pengaturan. Di bagian bawahnya ada mini player.
- **Beranda:** kartu "Sedang diputar" dengan latar dari blur cover, ditambah kartu tiap widget (pratinjau hidup,
  toggle, dan tombol Atur).
- **Halaman widget:** pratinjau besar di atas "desktop tiruan", lalu Gaya (kartu hidup), Warna, Detail, dan Posisi.
- **Audio:** status, sensitivitas, kehalusan, serta diagnostik (spektrum).
- **Pengaturan:** mulai bersama Windows, performa (fps), sembunyikan semua widget, folder data, dan versi.

## Gaya widget
**Visualizer:**
- **Halo:** jari-jari di sekeliling cover.
- **Pulse:** gelombang tertutup yang lembut.
- **Bars:** bar mirror di bawah cover persegi.
- **Vinyl:** piringan berputar dengan label dari cover.
- **Minimal:** cover dengan cahaya yang berdenyut, plus judul.

**Lirik:**
- **Karaoke:** tiga baris, kata menyala satu per satu.
- **Fokus:** satu baris besar.
- **Mengalir:** daftar yang bergulir.
- **Kartu:** panel kaca dengan cover kecil, mudah dibaca di wallpaper terang.

**Warna:** ikut cover (default), preset (Aurora, Senja, Laut, Neon, Mono), atau kustom (tiga warna).
