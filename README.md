# YouTube Video Downloader

Aplikasi web sederhana untuk mengunduh video YouTube yang **Anda miliki atau memang diizinkan untuk diunduh**. Aplikasi ini tidak melewati DRM, paywall, atau pembatasan akses.

## Fitur

- Menerima URL YouTube biasa, Shorts, embed, live yang sudah selesai, dan `youtu.be`.
- Menampilkan judul, thumbnail, durasi, pengunggah, dan resolusi yang tersedia.
- Menggabungkan video dan audio menjadi MP4 menggunakan `yt-dlp` + FFmpeg.
- Membatasi jumlah proses bersamaan dan permintaan API.
- Menghapus file setelah diunduh atau setelah masa berlaku berakhir.
- Tanpa penyimpanan permanen dan tanpa database.

## Menjalankan secara lokal

Persyaratan:

- Node.js 20+
- FFmpeg
- yt-dlp

```bash
npm install
cp .env.example .env
# Pastikan `ffmpeg` dan `yt-dlp` tersedia di PATH
npm start
```

Buka <http://localhost:3000>.

### Instalasi yt-dlp

Linux/macOS:

```bash
python3 -m pip install --user yt-dlp
```

Windows: instal dari <https://github.com/yt-dlp/yt-dlp#installation> dan tambahkan ke PATH.

## Menjalankan dengan Docker

```bash
docker build -t youtube-video-downloader .
docker run --rm -p 3000:3000 youtube-video-downloader
```

## Konfigurasi

Salin `.env.example` menjadi `.env`:

| Variabel | Default | Keterangan |
|---|---:|---|
| `PORT` | `3000` | Port HTTP |
| `FILE_TTL_MINUTES` | `3` | Masa simpan hasil setelah selesai |
| `MAX_CONCURRENT_DOWNLOADS` | `10` | Unduhan aktif bersamaan |
| `MAX_QUEUED_DOWNLOADS` | `20` | Maksimum job menunggu di antrean |
| `MAX_VIDEO_DURATION_SECONDS` | `7200` | Durasi maksimum video |

## API singkat

- `POST /api/info` dengan body `{ "url": "..." }`
- `POST /api/download` dengan body `{ "videoId": "...", "height": 720 }`
- `GET /api/jobs/:jobId` untuk status
- `GET /api/jobs/:jobId/file` untuk mengunduh hasil

## Catatan produksi

Aplikasi ini menyimpan status pekerjaan di memori proses. Untuk banyak instance, gunakan antrean pekerjaan dan Redis. Tambahkan autentikasi, logging terstruktur, batas ukuran/durasi yang sesuai, reverse proxy HTTPS, serta kebijakan privasi sebelum dipublikasikan.

Job berikutnya menunggu di antrean FIFO setelah 10 unduhan aktif. Antrean dibatasi 20 job supaya metadata antrean tidak tumbuh tanpa batas. Berkas hasil dibersihkan setelah 3 menit sejak job selesai; pembersih memeriksa tiap 30 detik dan menunda penghapusan selama file sedang dikirim ke pengguna. Berkas disimpan pada filesystem sementara kontainer, sehingga kapasitas RAM/CPU tetap membatasi jumlah unduhan aktif yang aman.

## Lisensi

Tambahkan lisensi yang sesuai dengan kebutuhan Anda sebelum publikasi. Pastikan penggunaan mematuhi Terms of Service YouTube dan hukum setempat.
