require('dotenv').config();
const { Telegraf } = require('telegraf');
const { google }   = require('googleapis');
const express      = require('express');

// ═══════════════════════════════════════════════════════════
//  BOT KAWAL LINTAS - v3.0 (Node.js Edition)
//  Converted from Google Apps Script → Node.js for Railway
//  Admin dikelola dari Sheet MASTER kolom C (role = ADMIN)
// ═══════════════════════════════════════════════════════════

const BOT_TOKEN    = process.env.BOT_TOKEN;
const SHEET_ID     = process.env.SHEET_ID;
const SHEET_KAWAL  = 'KAWAL LINTAS';
const SHEET_MASTER = 'MASTER';
const SHEET_TABLE  = 'TABLE';   // Sheet rekap kalender (TOKE di kol A, PLAT di kol B)
const PORT         = process.env.PORT || 3000;
const WEBHOOK_URL  = process.env.WEBHOOK_URL || '';

// ═══════════════════════════════════════════════════════════
//  GOOGLE SHEETS AUTH (Service Account)
// ═══════════════════════════════════════════════════════════
let credentials = {};
try {
  credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
} catch (e) {
  console.error('GOOGLE_CREDENTIALS tidak valid!');
}

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheetsApi = google.sheets({ version: 'v4', auth });

// ═══════════════════════════════════════════════════════════
//  IN-MEMORY CACHE
// ═══════════════════════════════════════════════════════════
const _cache = new Map();
function cacheGet(key) {
  const item = _cache.get(key);
  if (!item) return null;
  if (Date.now() > item.exp) { _cache.delete(key); return null; }
  return item.val;
}
function cachePut(key, val, ttlSeconds) {
  _cache.set(key, { val, exp: Date.now() + ttlSeconds * 1000 });
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache.entries()) {
    if (now > v.exp) _cache.delete(k);
  }
}, 600_000);

// ═══════════════════════════════════════════════════════════
//  GOOGLE SHEETS HELPERS
// ═══════════════════════════════════════════════════════════
async function getSheetValues(sheetName) {
  try {
    const res = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName,
    });
    return res.data.values || [];
  } catch (e) {
    console.error('getSheetValues ERROR:', e.message);
    return [];
  }
}

async function appendRow(sheetName, values) {
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [values] },
  });
}

async function updateCell(sheetName, rowNumber, colLetter, value) {
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!${colLetter}${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[value]] },
  });
}

// ═══════════════════════════════════════════════════════════
//  DATE HELPERS (WITA = Asia/Makassar)
// ═══════════════════════════════════════════════════════════
function getDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Makassar',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find(p => p.type === type)?.value || '00';
  return { day: get('day'), month: get('month'), year: get('year'), hour: get('hour'), minute: get('minute') };
}

function nowWITA() {
  const p = getDateParts();
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

function getHariWITA() {
  const p = getDateParts();
  return `${p.day}/${p.month}/${p.year}`;
}

function formatDate(val) {
  if (!val) return '-';
  if (typeof val === 'string' && /^\d{2}\/\d{2}\/\d{4}/.test(val)) {
    return val.substring(0, 16);
  }
  try {
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      const p = getDateParts(d);
      return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
    }
  } catch (e) {}
  return String(val);
}

// ═══════════════════════════════════════════════════════════
//  BUSINESS LOGIC HELPERS
// ═══════════════════════════════════════════════════════════
// ─── MASTER sheet struktur ─────────────────────────────────
//  Baris 1 : "PENGAWAL"        ← header kelompok (diabaikan)
//  Baris 2 : ID TELEGRAM | NAMA | ROLE  ← header kolom (diabaikan)
//  Baris 3+ : data aktual
//  Kolom A = ID Telegram, Kolom B = Nama, Kolom C = Role (USER/ADMIN)
// ───────────────────────────────────────────────────────────
const MASTER_DATA_START = 2; // index 0-based, data mulai baris ke-3

async function getNama(userId) {
  const key = 'nm_' + userId;
  const hit = cacheGet(key);
  if (hit) return hit;
  try {
    const data  = await getSheetValues(SHEET_MASTER);
    const idStr = String(userId).trim();
    // Mulai dari MASTER_DATA_START (lewati 2 baris header)
    for (let i = MASTER_DATA_START; i < data.length; i++) {
      if (String(data[i][0]).trim() === idStr && data[i][1]) {
        const nama = String(data[i][1]).trim().toUpperCase();
        cachePut(key, nama, 1800);
        return nama;
      }
    }
  } catch (e) { console.error('getNama ERROR:', e.message); }
  return null;
}

// Cek apakah userId adalah Admin
// Kolom C di sheet MASTER = "ADMIN" → true
// Cache 5 menit agar tidak sering baca sheet
async function isAdmin(userId) {
  const key = 'adm_' + userId;
  const hit = cacheGet(key);
  if (hit !== null) return hit === 'true';
  try {
    const data  = await getSheetValues(SHEET_MASTER);
    const idStr = String(userId).trim();
    // Mulai dari MASTER_DATA_START (lewati 2 baris header)
    for (let i = MASTER_DATA_START; i < data.length; i++) {
      if (String(data[i][0]).trim() === idStr) {
        const role   = String(data[i][2] || '').trim().toUpperCase();
        const result = role === 'ADMIN';
        cachePut(key, String(result), 300);
        return result;
      }
    }
  } catch (e) { console.error('isAdmin ERROR:', e.message); }
  cachePut('adm_' + userId, 'false', 300);
  return false;
}

// ─── KAWAL LINTAS sheet struktur ───────────────────────────
//  Baris 1 : Header (TANGGAL | PLAT MOBIL | TOKE | PENGAWAL | STATUS)
//  Baris 2+ : data
//  Kolom: A=Tanggal, B=Plat Mobil, C=Toke, D=Pengawal, E=Status
//  Index 0-based: 0=Tanggal, 1=Plat, 2=Toke, 3=Pengawal, 4=Status
// ───────────────────────────────────────────────────────────

// ─── TABLE sheet struktur ───────────────────────────────────
//  Baris 1 : Header (TOKE | PLAT | tgl 1 | tgl 2 | ...)
//  Baris 2+ : data
//  Kolom A = TOKE (sel merged → hanya baris pertama yg punya nilai)
//  Kolom B = PLAT
// ─────────────────────────────────────────────────────────────

// Cari nama TOKE dari Sheet TABLE berdasarkan PLAT
// Menangani merged cell kolom A dengan cara menyimpan nilai TOKE terakhir
async function getTokeByPlat(plat) {
  const platUp   = plat.toUpperCase().replace(/\s+/g, ' ').trim();
  const cacheKey = 'tbl_' + platUp;
  const cached   = cacheGet(cacheKey);
  if (cached) return cached === '__NULL__' ? null : cached;

  try {
    const data = await getSheetValues(SHEET_TABLE);
    let currentToke = '';
    // Row 0 = header, mulai dari row 1
    for (let i = 1; i < data.length; i++) {
      const colA = String(data[i][0] || '').trim();
      const colB = String(data[i][1] || '').trim().toUpperCase().replace(/\s+/g, ' ');
      // Perbarui TOKE jika kolom A tidak kosong (menangani merged cell)
      if (colA) currentToke = colA.toUpperCase();
      if (colB === platUp) {
        cachePut(cacheKey, currentToke, 1800); // cache 30 menit
        return currentToke;
      }
    }
  } catch (e) { console.error('getTokeByPlat ERROR:', e.message); }

  cachePut(cacheKey, '__NULL__', 300); // cache 5 menit jika tidak ditemukan
  return null;
}

// Normalisasi plat: trim, uppercase, spasi ganda → tunggal
function normalizePlat(text) {
  return text.trim().toUpperCase().replace(/\s+/g, ' ');
}

// Cek apakah teks terlihat seperti nomor plat Indonesia
// Format: 1-3 huruf + spasi + 1-4 angka + spasi + 1-3 huruf
// Contoh: BL 1234 AB, DK 999 ZZ, B 1234 XY
function isLikelyPlat(text) {
  return /^[A-Z]{1,3}\s+\d{1,4}\s+[A-Z]{1,3}$/i.test(text.trim());
}

// ═══════════════════════════════════════════════════════════
//  BOT SETUP
// ═══════════════════════════════════════════════════════════
const bot = new Telegraf(BOT_TOKEN);

const processedUpdates = new Set();
bot.use((ctx, next) => {
  const updateId = String(ctx.update?.update_id);
  if (processedUpdates.has(updateId)) return;
  processedUpdates.add(updateId);
  if (processedUpdates.size > 5000) {
    const iter = processedUpdates.values();
    for (let i = 0; i < 1000; i++) processedUpdates.delete(iter.next().value);
  }
  return next();
});

// /start
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const nama   = await getNama(userId);
  if (!nama) {
    return ctx.reply(
      'Akses Ditolak\n\n' +
      'ID Anda ' + userId + ' belum terdaftar.\n' +
      'Hubungi admin untuk didaftarkan.'
    );
  }
  const admin = await isAdmin(userId);
  ctx.reply(
    'BOT KAWAL LINTAS\n' +
    '=======================\n\n' +
    'Halo ' + nama + '!' + (admin ? ' [ADMIN]' : '') + '\n\n' +
    'Cara pakai:\n' +
    'Kirim NOMOR PLAT saja, contoh:\n\n' +
    'BL 1234 AB\n\n' +
    'Bot akan otomatis mencari Toke,\n' +
    'mengisi tanggal & pengawal,\n' +
    (admin
      ? 'dan langsung mengisi STATUS = LUNAS.\n'
      : 'dengan status BELUM LUNAS.\n'
    ) +
    '\nKetik /help untuk panduan lengkap.'
  );
});

// /help
bot.help(async (ctx) => {
  const userId = ctx.from.id;
  const admin  = await isAdmin(userId);
  let t = 'PANDUAN BOT KAWAL LINTAS\n=======================\n\n';
  t += 'Cara kirim rekap:\n';
  t += 'Cukup kirim NOMOR PLAT saja:\n\n';
  t += '   BL 1234 AB\n\n';
  t += 'Bot otomatis akan:\n';
  t += '- Mencari Toke dari daftar\n';
  t += '- Mengisi tanggal & pengawal\n';
  if (admin) {
    t += '- Langsung set STATUS = LUNAS\n';
  } else {
    t += '- Set STATUS = BELUM LUNAS\n';
  }
  t += '\nPerintah:\n';
  t += '/laporan - Lihat rekap Anda\n';
  t += '/help - Panduan ini\n';
  if (admin) {
    t += '\nMenu Admin:\n';
    t += '/laporan NAMA - Rekap pengawal tertentu\n';
    t += '/rekap_semua - Semua data belum lunas\n';
    t += '/lunas 5 - Tandai baris #5 jadi LUNAS\n';
  }
  ctx.reply(t);
});

// /laporan
bot.command('laporan', async (ctx) => {
  const userId  = ctx.from.id;
  const admin   = await isAdmin(userId);
  const args    = (ctx.message.text || '').replace(/^\/laporan\S*\s*/i, '').trim();
  let target;
  if (args) {
    if (!admin) return ctx.reply('Akses Ditolak\nPerintah ini hanya untuk admin.');
    target = args.toUpperCase();
  } else {
    const nama = await getNama(userId);
    if (!nama) return ctx.reply('ID Anda belum terdaftar. Hubungi admin.');
    target = nama;
  }
  const allData = await getSheetValues(SHEET_KAWAL);
  const rows    = [];
  // Kolom D (index 3) = PENGAWAL, Kolom E (index 4) = STATUS
  for (let i = 1; i < allData.length; i++) {
    if (allData[i][0] && String(allData[i][3]).toUpperCase() === target) {
      rows.push({ no: i + 1, d: allData[i] });
    }
  }
  if (!rows.length) return ctx.reply('Belum ada rekap untuk ' + target + '.');
  let lunas = 0;
  for (const r of rows) { if (String(r.d[4]).toUpperCase() === 'LUNAS') lunas++; }
  const belum = rows.length - lunas;
  let t = 'LAPORAN: ' + target + '\n=======================\n';
  t += 'Total: ' + rows.length + '  Lunas: ' + lunas + '  Belum: ' + belum + '\n-----------------------\n';
  for (const r of rows) {
    const badge = String(r.d[4]).toUpperCase() === 'LUNAS' ? '[LUNAS]' : '[BELUM]';
    t += '\n' + badge + ' #' + r.no + ' - ' + formatDate(r.d[0]) + '\n';
    t += '  Plat : ' + r.d[1] + '\n';
    t += '  Toke : ' + r.d[2] + '\n';
  }
  if (t.length > 4000) t = t.substring(0, 3900) + '\n\n(terpotong)';
  ctx.reply(t);
});

// /rekap_semua
bot.command('rekap_semua', async (ctx) => {
  const userId = ctx.from.id;
  if (!await isAdmin(userId)) return ctx.reply('Akses Ditolak\nPerintah ini hanya untuk admin.');
  const allData = await getSheetValues(SHEET_KAWAL);
  const list    = [];
  // Kolom E (index 4) = STATUS
  for (let i = 1; i < allData.length; i++) {
    if (allData[i][0] && String(allData[i][4]).toUpperCase() !== 'LUNAS') {
      list.push({ no: i + 1, d: allData[i] });
    }
  }
  if (!list.length) return ctx.reply('Semua rekap sudah LUNAS!\n\nTidak ada data yang tertunggak.');
  let t = 'BELUM LUNAS (' + list.length + ' data)\n=======================\n';
  for (const r of list) {
    // Kolom D (index 3) = PENGAWAL
    t += '\n#' + r.no + ' - ' + (r.d[3] || '-') + '\n';
    t += '  ' + formatDate(r.d[0]) + '\n';
    t += '  Plat : ' + r.d[1] + '\n';
    t += '  Toke : ' + r.d[2] + '\n';
    t += '  Tandai: /lunas ' + r.no + '\n';
  }
  if (t.length > 4000) t = t.substring(0, 3900) + '\n\n(terpotong)';
  ctx.reply(t);
});

// /lunas
bot.command('lunas', async (ctx) => {
  const userId = ctx.from.id;
  if (!await isAdmin(userId)) return ctx.reply('Akses Ditolak\nPerintah ini hanya untuk admin.');
  const args = (ctx.message.text || '').replace(/^\/lunas\S*\s*/i, '').trim();
  const no   = parseInt(args);
  if (!args || isNaN(no)) return ctx.reply('Format salah.\nGunakan: /lunas 5');
  const allData = await getSheetValues(SHEET_KAWAL);
  if (no < 2 || no > allData.length) return ctx.reply('Baris #' + no + ' tidak valid.');
  const rowData = allData[no - 1];
  // Kolom E (index 4) = STATUS → update kolom 'E'
  if (String(rowData[4]).toUpperCase() === 'LUNAS') return ctx.reply('Baris #' + no + ' sudah berstatus LUNAS.');
  await updateCell(SHEET_KAWAL, no, 'E', 'LUNAS');
  let t = 'STATUS DIPERBARUI\n=======================\n\n';
  t += 'Baris     : #' + no + '\n';
  t += 'Plat      : ' + (rowData[1] || '-') + '\n';
  t += 'Toke      : ' + (rowData[2] || '-') + '\n';
  t += 'Pengawal  : ' + (rowData[3] || '-') + '\n';
  t += 'Status    : LUNAS\n\n';
  t += 'Tanggal   : ' + formatDate(rowData[0]);
  ctx.reply(t);
});

// ═══════════════════════════════════════════════════════════
//  TEKS BIASA → Input Plat (logika utama)
//  User/Admin kirim nomor plat → bot auto isi semua field
// ═══════════════════════════════════════════════════════════
bot.on('text', async (ctx) => {
  const raw = (ctx.message.text || '').trim();
  if (raw.startsWith('/')) return; // abaikan command tidak dikenal

  const plat = normalizePlat(raw);

  // Hanya proses jika terlihat seperti nomor plat
  if (!isLikelyPlat(plat)) return;

  const userId = ctx.from.id;

  // 1. Cek apakah pengirim terdaftar di MASTER
  const nama = await getNama(userId);
  if (!nama) {
    return ctx.reply(
      'Akses Ditolak\n\n' +
      'ID Anda ' + userId + ' belum terdaftar.\n' +
      'Hubungi admin untuk didaftarkan.'
    );
  }

  // 2. Cari Toke dari Sheet TABLE berdasarkan PLAT
  const toke = await getTokeByPlat(plat);
  if (!toke) {
    return ctx.reply(
      'Plat Tidak Ditemukan\n\n' +
      'Plat ' + plat + ' tidak ada di daftar TABLE.\n' +
      'Periksa kembali nomor plat Anda.'
    );
  }

  // 3. Cek duplikat hari ini (plat yang sama di hari yang sama)
  const allData  = await getSheetValues(SHEET_KAWAL);
  const hari     = getHariWITA();
  const startIdx = Math.max(1, allData.length - 200);
  for (let i = startIdx; i < allData.length; i++) {
    const rowHari = String(allData[i][0]).split(' ')[0];
    if (rowHari === hari && String(allData[i][1]).toUpperCase() === plat) {
      return ctx.reply(
        'Data Sudah Ada!\n\n' +
        'Plat ' + plat + ' sudah dicatat hari ini\n' +
        '(baris #' + (i + 1) + ')\n\n' +
        'Toke     : ' + (allData[i][2] || '-') + '\n' +
        'Pengawal : ' + (allData[i][3] || '-') + '\n' +
        'Status   : ' + (allData[i][4] || '-')
      );
    }
  }

  // 4. Tentukan STATUS berdasarkan role pengirim
  //    ADMIN → LUNAS otomatis
  //    USER  → BELUM LUNAS
  const admin  = await isAdmin(userId);
  const status = admin ? 'LUNAS' : 'BELUM LUNAS';

  // 5. Simpan ke Sheet KAWAL LINTAS
  //    Kolom: TANGGAL | PLAT MOBIL | TOKE | PENGAWAL | STATUS
  const tgl = nowWITA();
  await appendRow(SHEET_KAWAL, [tgl, plat, toke, nama, status]);

  const afterData = await getSheetValues(SHEET_KAWAL);
  const baris     = afterData.length;

  ctx.reply(
    'REKAP BERHASIL DICATAT\n' +
    '=======================\n\n' +
    'Tanggal    : ' + tgl + '\n' +
    'Plat       : ' + plat + '\n' +
    'Toke       : ' + toke + '\n' +
    'Pengawal   : ' + nama + '\n' +
    'Status     : ' + status + '\n' +
    'No. Baris  : #' + baris + '\n\n' +
    (admin
      ? 'Status langsung LUNAS karena Anda Admin.'
      : 'Ketik /laporan untuk lihat semua rekap.'
    )
  );
});

// ═══════════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════════
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', bot: 'Kawal Lintas v3.0', mode: WEBHOOK_URL ? 'webhook' : 'polling' });
});

if (WEBHOOK_URL) {
  const webhookPath = '/webhook/' + BOT_TOKEN;
  app.use(bot.webhookCallback(webhookPath));
  bot.telegram.setWebhook(`${WEBHOOK_URL}${webhookPath}`)
    .then(() => console.log('Webhook aktif:', `${WEBHOOK_URL}${webhookPath}`))
    .catch(e => console.error('Webhook gagal:', e.message));
  app.listen(PORT, () => console.log(`Bot berjalan di port ${PORT} (webhook)`));
} else {
  app.listen(PORT, () => console.log(`Health server berjalan di port ${PORT}`));
  bot.launch()
    .then(() => console.log('Bot berjalan (polling mode)'))
    .catch(e => console.error('Bot gagal start:', e.message));
}

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
