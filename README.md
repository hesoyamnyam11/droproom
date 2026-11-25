# DropRoom - Transfer File & Teks Langsung Antar Perangkat

Aplikasi web untuk mengirim file resolusi asli dan teks secara langsung antar dua perangkat (HP ke Laptop atau sebaliknya) melalui jalur terenkripsi WebRTC DataChannel, dengan Python FastAPI sebagai server signaling aman.

## Fitur Utama
- Jalur langsung antar perangkat (WebRTC P2P): byte file tidak pernah disimpan di server.
- Tanpa login dan tanpa install aplikasi: cukup scan QR Code atau ketik kode 6 karakter.
- Opsi Sekali Unduh Langsung Hapus untuk file sensitif.
- Tombol Tutup & Hapus Ruangan Sekarang untuk membersihkan memori di kedua perangkat sekaligus.
- Hapus otomatis ruangan setelah 10 menit.
- Mode Terang dan Mode Gelap.
- Ruang teks dan link live dengan tombol salin satu klik.

## Cara Menjalankan di Laptop (Windows PowerShell)

1. Buka folder `droproom` di VS Code.
2. Buat dan aktifkan virtual environment:
   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```
3. Pasang paket Python:
   ```powershell
   python -m pip install -r requirements.txt
   ```
4. Jalankan server agar bisa diakses dari Laptop maupun HP di Wi-Fi yang sama:
   ```powershell
   python -m uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
   ```

## Cara Tes di Dua Perangkat

### Opsi A: Satu Wi-Fi yang Sama (Lokal)
1. Cek IP lokal laptop di PowerShell dengan perintah `ipconfig` (cari alamat IPv4, misalnya `192.168.1.10`).
2. Buka di browser laptop: `http://192.168.1.10:8000` (jangan `127.0.0.1` agar QR Code berisi IP yang bisa dibuka HP).
3. Klik Buat Ruangan, lalu scan QR Code menggunakan kamera HP.

### Opsi B: Jaringan Berbeda (Misalnya HP Paket Data 4G/5G + Laptop Wi-Fi)
Karena IP lokal laptop tidak bisa dijangkau dari internet luar, kamu punya dua cara gratis:

1. Cara cepat dari laptop (Cloudflare Quick Tunnel, tanpa daftar akun):
   - Unduh `cloudflared` atau jalankan di PowerShell terpisah saat server FastAPI aktif:
     ```powershell
     winget install --id Cloudflare.cloudflared
     cloudflared tunnel --url http://127.0.0.1:8000
     ```
   - Buka tautan `https://....trycloudflare.com` yang muncul di laptop, klik Buat Ruangan, lalu scan QR dari HP (meski HP pakai 4G/5G).
2. Cara permanen (Deploy Gratis ke Render):
   - Unggah folder ini ke GitHub, lalu hubungkan ke Render.com (file `render.yaml` sudah disiapkan). Setelah aktif, siapa pun bisa mengakses dari jaringan mana saja.
