 🚗 Bot Kawal Lintas v3.0

Bot Telegram untuk pencatatan rekap pengawalan kendaraan, terhubung ke Google Sheets.

---

## 📋 Cara Kerja Bot

### Input (User/Admin)
Cukup kirim **NOMOR PLAT** saja:
```
BL 1234 AB
```

### Proses Otomatis Bot
1. **Cari Toke** → Bot cari plat di Sheet TABLE, ambil nama Toke
2. **Ambil Pengawal** → Bot ambil nama pengirim dari Sheet MASTER berdasarkan ID Telegram
3. **Tentukan Status** →
   - Pengirim **ADMIN** → STATUS = `LUNAS` (otomatis)
   - Pengirim **USER** → STATUS = `BELUM LUNAS`
4. **Simpan** ke Sheet KAWAL LINTAS: `Tanggal | Plat | Toke | Pengawal | Status`

---

## 📊 Struktur Google Sheets

### Sheet: `TABLE`
| Kolom A | Kolom B | C (tgl 26) | D (tgl 27) | ... |
|---|---|---|---|---|
| BOS KI *(merged)* | BL 8753 AC | | | |
| | BL 8753 KC | | | |
| PIPIN *(merged)* | BK 8583 YO | | | |
| | DK 9647 SH | | | |

> Kolom A (TOKE) menggunakan merged cell. Bot menangani ini secara otomatis.

### Sheet: `MASTER`
| Kolom A | Kolom B | Kolom C |
|---|---|---|
| *(header)* | *(PENGAWAL)* | |
| ID TELEGRAM | NAMA | ROLE |
| 1122307390 | NAMIR | USER |
| 688909275 | REZA | ADMIN |
| 5603013991 | MUKUS | ADMIN |

> Role `ADMIN` → Status otomatis LUNAS saat kirim plat
> Role `USER` (atau kosong) → Status BELUM LUNAS

### Sheet: `KAWAL LINTAS`
| Kolom A | Kolom B | Kolom C | Kolom D | Kolom E |
|---|---|---|---|---|
| TANGGAL | PLAT MOBIL | TOKE | PENGAWAL | STATUS |
| 25/06/2026 14:03 | BL 1234 TT | PIPIN | REZA | LUNAS |

---

## 🛠️ Setup Google Cloud (Service Account)

### 1. Buat Project di Google Cloud
1. Buka [https://console.cloud.google.com](https://console.cloud.google.com)
2. Klik **"New Project"** → beri nama → **Create**

### 2. Aktifkan Google Sheets API
1. **APIs & Services** → **Library**
2. Cari **"Google Sheets API"** → **Enable**

### 3. Buat Service Account
1. **APIs & Services** → **Credentials**
2. **+ CREATE CREDENTIALS** → **Service Account**
3. Isi nama (contoh: `kawal-bot`) → **Create and Continue** → **Done**
4. Klik service account yang baru dibuat
5. Tab **KEYS** → **ADD KEY** → **Create new key** → **JSON** → **Create**
6. File JSON otomatis terdownload

### 4. Share Spreadsheet ke Service Account
1. Buka file JSON, cari `"client_email"` (contoh: `kawalan@kawalan.iam.gserviceaccount.com`)
2. Buka Google Spreadsheet → **Share** → masukkan email service account → **Editor** → **Send**

---

## 🚀 Deploy ke Railway

### 1. Push ke GitHub
```bash
git init
git add .
git commit -m "Bot Kawal Lintas v3.0"
git branch -M main
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main
```

### 2. Deploy di Railway
1. Buka [https://railway.app](https://railway.app) → Login dengan GitHub
2. **New Project** → **Deploy from GitHub repo** → pilih repo ini

### 3. Set Environment Variables di Railway
Masuk ke project → **Variables** → tambahkan:

| Variable | Nilai |
|---|---|
| `BOT_TOKEN` | Token dari @BotFather |
| `SHEET_ID` | ID Google Spreadsheet |
| `WEBHOOK_URL` | URL Railway app (dari Settings → Domains) |
| `GOOGLE_CREDENTIALS` | Isi file `GOOGLE_CREDENTIALS_RAILWAY.txt` |

> ⚠️ `GOOGLE_CREDENTIALS` diisi dengan isi file `GOOGLE_CREDENTIALS_RAILWAY.txt` (satu baris JSON)

### 4. Generate Domain Railway
1. Di Railway → **Settings** → **Networking** → **Generate Domain**
2. Copy URL → set sebagai `WEBHOOK_URL`

---

## 💻 Development Lokal

```bash
# Install dependencies
npm install

# Setup .env
cp .env.example .env
# Edit .env → isi BOT_TOKEN, SHEET_ID, GOOGLE_CREDENTIALS
# Kosongkan WEBHOOK_URL untuk polling mode

# Jalankan
npm run dev
```

---

## 📱 Perintah Bot

| Command | Siapa | Fungsi |
|---|---|---|
| *(nomor plat)* | Semua | Input rekap - cukup kirim plat! |
| `/start` | Semua | Sambutan + info role |
| `/help` | Semua | Panduan penggunaan |
| `/laporan` | Semua | Lihat rekap milik sendiri |
| `/laporan NAMA` | Admin | Lihat rekap pengawal tertentu |
| `/rekap_semua` | Admin | Semua data belum lunas |
| `/lunas 5` | Admin | Tandai baris #5 sebagai LUNAS |

---

## 📁 Struktur File

```
├── index.js                      ← Bot utama (Node.js)
├── package.json                  ← Dependencies
├── railway.toml                  ← Konfigurasi Railway
├── .env.example                  ← Template environment variables
├── .gitignore                    ← File yang tidak di-push ke GitHub
├── README.md                     ← Panduan ini
├── GOOGLE_CREDENTIALS_RAILWAY.txt ← JSON satu baris (jangan di-push!)
├── kawalan-0d2e57f70267.json     ← Service account key (jangan di-push!)
└── KAWAL.GS                      ← Script GAS asli (arsip)
```
