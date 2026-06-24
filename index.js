require('dotenv').config();
const { Telegraf } = require('telegraf');
const { google }   = require('googleapis');
const express      = require('express');

// ═══════════════════════════════════════════════════════════
//  BOT KAWAL LINTAS - v4.0 (Professional Edition)
//  Node.js for Railway | Admin via Sheet MASTER kolom C
// ═══════════════════════════════════════════════════════════

const BOT_TOKEN    = process.env.BOT_TOKEN;
const SHEET_ID     = process.env.SHEET_ID;
const SHEET_KAWAL  = 'KAWAL LINTAS';
const SHEET_MASTER = 'MASTER';
const SHEET_TABLE  = 'TABLE';
const PORT         = process.env.PORT || 3000;
const WEBHOOK_URL  = process.env.WEBHOOK_URL || '';

// Divider standar untuk pesan bot
const DIV  = '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501';

// ═══════════════════════════════════════════════════════════
//  GOOGLE SHEETS AUTH
// ═══════════════════════════════════════════════════════════
let credentials = {};
try {
  credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
} catch (e) {
  console.error('[ERROR] GOOGLE_CREDENTIALS tidak valid!');
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

function cacheClear(pattern) {
  let count = 0;
  for (const key of _cache.keys()) {
    if (!pattern || key.startsWith(pattern)) {
      _cache.delete(key);
      count++;
    }
  }
  return count;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache.entries()) {
    if (now > v.exp) _cache.delete(k);
  }
}, 300_000);

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
    console.error('[getSheetValues] ERROR:', e.message);
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

function shortDate(val) {
  const full = formatDate(val);
  // Kembalikan hanya DD/MM HH:MM
  return full.length >= 16 ? full.substring(0, 5) + ' ' + full.substring(11, 16) : full;
}

// ═══════════════════════════════════════════════════════════
//  BUSINESS LOGIC — MASTER SHEET
//  Baris 1 : "PENGAWAL" (header gabungan, diabaikan)
//  Baris 2 : ID TELEGRAM | NAMA | ROLE (header kolom, diabaikan)
//  Baris 3+ : data → col A=ID, B=Nama, C=Role (USER/ADMIN)
// ═══════════════════════════════════════════════════════════
const MASTER_DATA_START = 2; // index 0-based → mulai baris ke-3

// Cache MASTER 3 menit agar perubahan cepat terdeteksi
const CACHE_MASTER_TTL = 180;
// Cache ADMIN status 2 menit
const CACHE_ADMIN_TTL  = 120;

async function getNama(userId) {
  const key = 'nm_' + userId;
  const hit = cacheGet(key);
  if (hit) return hit;
  try {
    const data  = await getSheetValues(SHEET_MASTER);
    const idStr = String(userId).trim();
    for (let i = MASTER_DATA_START; i < data.length; i++) {
      if (String(data[i][0]).trim() === idStr && data[i][1]) {
        const nama = String(data[i][1]).trim().toUpperCase();
        cachePut(key, nama, CACHE_MASTER_TTL);
        return nama;
      }
    }
  } catch (e) { console.error('[getNama]', e.message); }
  return null;
}

async function isAdmin(userId) {
  const key = 'adm_' + userId;
  const hit = cacheGet(key);
  if (hit !== null) return hit === 'true';
  try {
    const data  = await getSheetValues(SHEET_MASTER);
    const idStr = String(userId).trim();
    for (let i = MASTER_DATA_START; i < data.length; i++) {
      if (String(data[i][0]).trim() === idStr) {
        const role   = String(data[i][2] || '').trim().toUpperCase();
        const result = role === 'ADMIN';
        cachePut(key, String(result), CACHE_ADMIN_TTL);
        return result;
      }
    }
  } catch (e) { console.error('[isAdmin]', e.message); }
  cachePut('adm_' + userId, 'false', CACHE_ADMIN_TTL);
  return false;
}

// Ambil semua user dari MASTER (untuk laporan admin)
async function getAllMasterUsers() {
  const cacheKey = 'all_users';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const data  = await getSheetValues(SHEET_MASTER);
    const users = [];
    for (let i = MASTER_DATA_START; i < data.length; i++) {
      if (data[i][1]) {
        users.push({
          id:   String(data[i][0] || '').trim(),
          nama: String(data[i][1]).trim().toUpperCase(),
          role: String(data[i][2] || 'USER').trim().toUpperCase(),
        });
      }
    }
    cachePut(cacheKey, users, CACHE_MASTER_TTL);
    return users;
  } catch (e) { console.error('[getAllMasterUsers]', e.message); return []; }
}

// ═══════════════════════════════════════════════════════════
//  BUSINESS LOGIC — TABLE SHEET
//  Baris 1 : Header (TOKE | PLAT | tgl...) — diabaikan
//  Baris 2+: col A=TOKE (merged cell), col B=PLAT
// ═══════════════════════════════════════════════════════════
const CACHE_TABLE_TTL = 1800; // 30 menit (data jarang berubah)

async function getTokeByPlat(plat) {
  const platUp   = plat.toUpperCase().replace(/\s+/g, ' ').trim();
  const cacheKey = 'tbl_' + platUp;
  const cached   = cacheGet(cacheKey);
  if (cached) return cached === '__NULL__' ? null : cached;

  try {
    const data = await getSheetValues(SHEET_TABLE);
    let currentToke = '';
    for (let i = 1; i < data.length; i++) {
      const colA = String(data[i][0] || '').trim();
      const colB = String(data[i][1] || '').trim().toUpperCase().replace(/\s+/g, ' ');
      if (colA) currentToke = colA.toUpperCase();
      if (colB === platUp) {
        cachePut(cacheKey, currentToke, CACHE_TABLE_TTL);
        return currentToke;
      }
    }
  } catch (e) { console.error('[getTokeByPlat]', e.message); }

  cachePut(cacheKey, '__NULL__', 300);
  return null;
}

function normalizePlat(text) {
  return text.trim().toUpperCase().replace(/\s+/g, ' ');
}

function isLikelyPlat(text) {
  return /^[A-Z]{1,3}\s+\d{1,4}\s+[A-Z]{1,3}$/i.test(text.trim());
}

// ═══════════════════════════════════════════════════════════
//  BOT SETUP
// ═══════════════════════════════════════════════════════════
const bot = new Telegraf(BOT_TOKEN);

// Deduplikasi update
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

// ───────────────────────────────────────────────────────────
// /start
// ───────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const nama   = await getNama(userId);
  if (!nama) {
    return ctx.reply(
      '\uD83D\uDEAB AKSES DITOLAK\n' + DIV + '\n\n' +
      '\uD83C\uDD94 ID Anda: ' + userId + '\n\n' +
      'Anda belum terdaftar di sistem.\n' +
      'Hubungi admin untuk didaftarkan.'
    );
  }
  const admin = await isAdmin(userId);
  const badge = admin ? ' \uD83D\uDD11 [ADMIN]' : ' \uD83D\uDC64 [PENGAWAL]';
  ctx.reply(
    '\uD83D\uDE97 BOT KAWAL LINTAS\n' + DIV + '\n\n' +
    'Selamat datang, *' + nama + '*' + badge + '!\n\n' +
    '\uD83D\uDCCB *Cara Pakai:*\n' +
    'Kirim nomor plat kendaraan:\n\n' +
    '   BL 1234 AB\n\n' +
    'Bot akan otomatis:\n' +
    '\u2022 Mencari Toke dari daftar\n' +
    '\u2022 Mengisi tanggal & pengawal\n' +
    (admin
      ? '\u2022 Set status \u2705 LUNAS (Admin)\n\n'
      : '\u2022 Set status \u23F3 BELUM LUNAS\n\n'
    ) +
    'Ketik /help untuk panduan lengkap.'
  );
});

// ───────────────────────────────────────────────────────────
// /help
// ───────────────────────────────────────────────────────────
bot.help(async (ctx) => {
  const userId = ctx.from.id;
  const admin  = await isAdmin(userId);

  let t = '\uD83D\uDCCB PANDUAN BOT KAWAL LINTAS\n' + DIV + '\n\n';
  t += '\uD83D\uDE97 *Input Plat Kendaraan:*\n';
  t += '   Kirim nomor plat saja:\n';
  t += '   BL 1234 AB\n\n';
  t += '\uD83D\uDCDE *Perintah Umum:*\n';
  t += '/start   \u2014 Sambutan & info akun\n';
  t += '/laporan \u2014 Rekap milik saya\n';
  t += '/help    \u2014 Panduan ini\n';

  if (admin) {
    t += '\n\uD83D\uDD11 *Perintah Admin:*\n';
    t += '/laporan            \u2014 Ringkasan semua pengawal\n';
    t += '/laporan [NAMA]     \u2014 Detail rekap pengawal\n';
    t += '/detail [NAMA]      \u2014 Detail lunas & belum lunas\n';
    t += '/lunas_semua [NAMA] \u2014 Lunasin semua milik pengawal\n';
    t += '/cekplat [PLAT]     \u2014 Riwayat lengkap suatu plat\n';
    t += '/rekap_semua        \u2014 Semua data belum lunas\n';
    t += '/lunas [no]         \u2014 Tandai baris jadi LUNAS\n';
    t += '/refresh            \u2014 Refresh cache (update data)\n';
  }

  t += '\n' + DIV + '\n';
  t += '\u2139\uFE0F Cache diperbarui setiap 3 menit.\n';
  if (admin) t += 'Gunakan /refresh untuk paksa update data.';

  ctx.reply(t);
});

// ───────────────────────────────────────────────────────────
// /refresh — Bersihkan cache (Admin only)
// ───────────────────────────────────────────────────────────
bot.command('refresh', async (ctx) => {
  const userId = ctx.from.id;
  if (!await isAdmin(userId)) {
    return ctx.reply('\uD83D\uDEAB AKSES DITOLAK\nPerintah ini hanya untuk Admin.');
  }
  const count = cacheClear(); // clear semua cache
  ctx.reply(
    '\u267B\uFE0F CACHE DIPERBARUI\n' + DIV + '\n\n' +
    '\uD83D\uDDD1\uFE0F ' + count + ' entri cache dihapus.\n\n' +
    'Data MASTER, TABLE & KAWAL LINTAS\n' +
    'akan dibaca ulang dari Sheet.\n\n' +
    '\u2705 Siap! Perubahan data sudah aktif.'
  );
});

// ───────────────────────────────────────────────────────────
// /laporan — Admin: ringkasan semua user | User: detail sendiri
// ───────────────────────────────────────────────────────────
bot.command('laporan', async (ctx) => {
  const userId  = ctx.from.id;
  const admin   = await isAdmin(userId);
  const args    = (ctx.message.text || '').replace(/^\/laporan\S*\s*/i, '').trim();

  // Admin dengan argumen nama → detail user tertentu
  if (args && admin) {
    const target  = args.toUpperCase();
    const allData = await getSheetValues(SHEET_KAWAL);
    const rows    = [];
    for (let i = 1; i < allData.length; i++) {
      if (allData[i][0] && String(allData[i][3]).toUpperCase() === target) {
        rows.push({ no: i + 1, d: allData[i] });
      }
    }
    if (!rows.length) {
      return ctx.reply('\uD83D\uDD0D Tidak ada rekap untuk *' + target + '*.');
    }
    const lunas = rows.filter(r => String(r.d[4]).toUpperCase() === 'LUNAS').length;
    const belum = rows.length - lunas;

    let t = '\uD83D\uDCCB LAPORAN: ' + target + '\n' + DIV + '\n';
    t += '\uD83D\uDCE6 Total : ' + rows.length + '  \u2705 ' + lunas + '  \u23F3 ' + belum + '\n';
    t += DIV + '\n';
    for (const r of rows) {
      const ok = String(r.d[4]).toUpperCase() === 'LUNAS';
      t += (ok ? '\u2705' : '\u23F3') + ' #' + r.no + '  ';
      t += '\uD83D\uDE97 ' + (r.d[1] || '-') + '  \uD83D\uDC65 ' + (r.d[2] || '-') + '\n';
      t += '    \uD83D\uDCC5 ' + shortDate(r.d[0]);
      if (!ok) t += '  \u2192 /lunas ' + r.no;
      t += '\n';
    }
    if (belum > 0) {
      t += '\n' + DIV + '\n';
      t += '\uD83D\uDCA1 Lunasin semua sekaligus:\n';
      t += '/lunas_semua ' + target;
    }
    if (t.length > 4000) t = t.substring(0, 3900) + '\n\n(terpotong...)';
    return ctx.reply(t);
  }

  // Admin tanpa argumen → ringkasan SEMUA user
  if (admin && !args) {
    const users   = await getAllMasterUsers();
    const allData = await getSheetValues(SHEET_KAWAL);
    const hari    = getHariWITA();

    // Hitung per user
    const stats = {};
    for (const u of users) {
      stats[u.nama] = { total: 0, lunas: 0, hariIni: 0 };
    }
    for (let i = 1; i < allData.length; i++) {
      const row    = allData[i];
      if (!row[0]) continue;
      const kawal  = String(row[3] || '').toUpperCase();
      const status = String(row[4] || '').toUpperCase();
      const rowHari = String(row[0]).split(' ')[0];
      if (!stats[kawal]) stats[kawal] = { total: 0, lunas: 0, hariIni: 0 };
      stats[kawal].total++;
      if (status === 'LUNAS') stats[kawal].lunas++;
      if (rowHari === hari) stats[kawal].hariIni++;
    }

    let totalAll = 0, lunasAll = 0;
    let t = '\uD83D\uDCCA RINGKASAN SEMUA PENGAWAL\n' + DIV + '\n';
    t += '\uD83D\uDCC5 ' + hari + '\n' + DIV + '\n';

    for (const u of users) {
      const s = stats[u.nama] || { total: 0, lunas: 0, hariIni: 0 };
      const belum = s.total - s.lunas;
      const badge = u.role === 'ADMIN' ? ' \uD83D\uDD11' : '';
      t += '\n\uD83D\uDC64 ' + u.nama + badge + '\n';
      if (s.total === 0) {
        t += '   \uD83D\uDCED Belum ada rekap\n';
      } else {
        t += '   \uD83D\uDCE6 ' + s.total + ' rekap  \u2705 ' + s.lunas + ' lunas  \u23F3 ' + belum + ' belum\n';
        if (s.hariIni > 0) t += '   \uD83D\uDD25 Hari ini: ' + s.hariIni + ' rekap\n';
      }
      totalAll += s.total;
      lunasAll += s.lunas;
    }

    t += '\n' + DIV + '\n';
    t += '\uD83D\uDCCA Total: ' + totalAll + '  \u2705 ' + lunasAll + ' lunas  \u23F3 ' + (totalAll - lunasAll) + ' belum\n';
    t += '\nGunakan /laporan [NAMA] untuk detail.';
    if (t.length > 4000) t = t.substring(0, 3900) + '\n\n(terpotong...)';
    return ctx.reply(t);
  }

  // User biasa → laporan sendiri
  const nama = await getNama(userId);
  if (!nama) return ctx.reply('\uD83D\uDEAB ID Anda belum terdaftar. Hubungi admin.');

  const allData = await getSheetValues(SHEET_KAWAL);
  const rows    = [];
  for (let i = 1; i < allData.length; i++) {
    if (allData[i][0] && String(allData[i][3]).toUpperCase() === nama) {
      rows.push({ no: i + 1, d: allData[i] });
    }
  }
  if (!rows.length) {
    return ctx.reply('\uD83D\uDCED Belum ada rekap untuk *' + nama + '*.\n\nKirim nomor plat untuk mulai mencatat!');
  }
  const lunas = rows.filter(r => String(r.d[4]).toUpperCase() === 'LUNAS').length;
  const belum = rows.length - lunas;

  let t = '\uD83D\uDCCB LAPORAN: ' + nama + '\n' + DIV + '\n';
  t += '\uD83D\uDCE6 Total : ' + rows.length + '\n';
  t += '\u2705 Lunas : ' + lunas + '\n';
  t += '\u23F3 Belum : ' + belum + '\n';
  t += DIV + '\n';
  for (const r of rows) {
    const ok = String(r.d[4]).toUpperCase() === 'LUNAS';
    t += (ok ? '\u2705' : '\u23F3') + ' #' + r.no + '  \uD83D\uDE97 ' + (r.d[1] || '-') + '\n';
    t += '   \uD83D\uDC65 ' + (r.d[2] || '-') + '  \uD83D\uDCC5 ' + shortDate(r.d[0]) + '\n';
  }
  if (t.length > 4000) t = t.substring(0, 3900) + '\n\n(terpotong...)';
  ctx.reply(t);
});

// ───────────────────────────────────────────────────────────
// /detail [NAMA] — Detail rekap per pengawal (Admin only)
// ───────────────────────────────────────────────────────────
bot.command('detail', async (ctx) => {
  const userId = ctx.from.id;
  if (!await isAdmin(userId)) {
    return ctx.reply('\uD83D\uDEAB AKSES DITOLAK\nPerintah ini hanya untuk Admin.');
  }
  const args = (ctx.message.text || '').replace(/^\/detail\S*\s*/i, '').trim();
  if (!args) {
    return ctx.reply(
      '\u2139\uFE0F Penggunaan:\n\n/detail NAMIR\n\nUntuk melihat detail rekap pengawal tertentu.'
    );
  }
  const target  = args.toUpperCase();
  const allData = await getSheetValues(SHEET_KAWAL);
  const rows    = [];
  for (let i = 1; i < allData.length; i++) {
    if (allData[i][0] && String(allData[i][3]).toUpperCase() === target) {
      rows.push({ no: i + 1, d: allData[i] });
    }
  }
  if (!rows.length) {
    return ctx.reply('\uD83D\uDD0D Tidak ada data untuk *' + target + '*.');
  }

  const lunas = rows.filter(r => String(r.d[4]).toUpperCase() === 'LUNAS').length;
  const belum = rows.length - lunas;

  let t = '\uD83D\uDD0D DETAIL: ' + target + '\n' + DIV + '\n';
  t += '\uD83D\uDCE6 ' + rows.length + ' rekap  \u2705 ' + lunas + '  \u23F3 ' + belum + '\n';
  t += DIV + '\n';

  // Belum lunas dulu
  const belumRows = rows.filter(r => String(r.d[4]).toUpperCase() !== 'LUNAS');
  const lunasRows = rows.filter(r => String(r.d[4]).toUpperCase() === 'LUNAS');

  if (belumRows.length) {
    t += '\n\u23F3 BELUM LUNAS:\n';
    for (const r of belumRows) {
      t += '  #' + r.no + '  \uD83D\uDE97 ' + (r.d[1] || '-') + '  \uD83D\uDC65 ' + (r.d[2] || '-') + '\n';
      t += '      \uD83D\uDCC5 ' + shortDate(r.d[0]) + '  \u2192 /lunas ' + r.no + '\n';
    }
  }

  if (lunasRows.length) {
    t += '\n\u2705 SUDAH LUNAS:\n';
    for (const r of lunasRows) {
      t += '  #' + r.no + '  \uD83D\uDE97 ' + (r.d[1] || '-') + '  \uD83D\uDC65 ' + (r.d[2] || '-') + '\n';
      t += '      \uD83D\uDCC5 ' + shortDate(r.d[0]) + '\n';
    }
  }

  t += '\n' + DIV;
  if (t.length > 4000) t = t.substring(0, 3900) + '\n\n(terpotong...)';
  ctx.reply(t);
});

// ───────────────────────────────────────────────────────────
// /rekap_semua — Semua data belum lunas (Admin only)
// ───────────────────────────────────────────────────────────
bot.command('rekap_semua', async (ctx) => {
  const userId = ctx.from.id;
  if (!await isAdmin(userId)) {
    return ctx.reply('\uD83D\uDEAB AKSES DITOLAK\nPerintah ini hanya untuk Admin.');
  }
  const allData = await getSheetValues(SHEET_KAWAL);
  const list    = [];
  for (let i = 1; i < allData.length; i++) {
    if (allData[i][0] && String(allData[i][4]).toUpperCase() !== 'LUNAS') {
      list.push({ no: i + 1, d: allData[i] });
    }
  }
  if (!list.length) {
    return ctx.reply(
      '\uD83C\uDF89 SEMUA SUDAH LUNAS!\n' + DIV + '\n\n' +
      'Tidak ada data yang tertunggak.\n' +
      'Kerja bagus! \uD83D\uDCAA'
    );
  }

  let t = '\u23F3 BELUM LUNAS \u2014 ' + list.length + ' data\n' + DIV + '\n';
  for (const r of list) {
    t += '\n\uD83D\uDD16 #' + r.no + ' \u2014 \uD83D\uDC64 ' + (r.d[3] || '-') + '\n';
    t += '\uD83D\uDCC5 ' + shortDate(r.d[0]) + '\n';
    t += '\uD83D\uDE97 ' + (r.d[1] || '-') + '  \uD83D\uDC65 ' + (r.d[2] || '-') + '\n';
    t += '\uD83D\uDC49 /lunas ' + r.no + '\n';
  }
  t += '\n' + DIV + '\n';
  t += '\uD83D\uDCA1 /lunas [no] untuk tandai lunas';
  if (t.length > 4000) t = t.substring(0, 3900) + '\n\n(terpotong...)';
  ctx.reply(t);
});

// ───────────────────────────────────────────────────────────
// /lunas [no] — Tandai baris sebagai LUNAS (Admin only)
// ───────────────────────────────────────────────────────────
bot.command('lunas', async (ctx) => {
  const userId = ctx.from.id;
  if (!await isAdmin(userId)) {
    return ctx.reply('\uD83D\uDEAB AKSES DITOLAK\nPerintah ini hanya untuk Admin.');
  }
  const args = (ctx.message.text || '').replace(/^\/lunas\S*\s*/i, '').trim();
  const no   = parseInt(args);
  if (!args || isNaN(no)) {
    return ctx.reply('\u2757 Format salah.\n\nGunakan: /lunas 5\n(angka = nomor baris di Sheet)');
  }
  const allData = await getSheetValues(SHEET_KAWAL);
  if (no < 2 || no > allData.length) {
    return ctx.reply('\u274C Baris #' + no + ' tidak valid.\nBaris tersedia: 2 \u2013 ' + allData.length);
  }
  const rowData = allData[no - 1];
  if (String(rowData[4]).toUpperCase() === 'LUNAS') {
    return ctx.reply('\u2139\uFE0F Baris #' + no + ' sudah berstatus \u2705 LUNAS.\nTidak ada yang perlu diubah.');
  }
  await updateCell(SHEET_KAWAL, no, 'E', 'LUNAS');
  ctx.reply(
    '\u2705 STATUS DIPERBARUI\n' + DIV + '\n\n' +
    '\uD83D\uDD16 Baris    : #' + no + '\n' +
    '\uD83D\uDE97 Plat     : ' + (rowData[1] || '-') + '\n' +
    '\uD83D\uDC65 Toke     : ' + (rowData[2] || '-') + '\n' +
    '\uD83D\uDC64 Pengawal : ' + (rowData[3] || '-') + '\n' +
    '\uD83D\uDCB0 Status   : LUNAS \u2705\n' +
    '\uD83D\uDCC5 Tanggal  : ' + formatDate(rowData[0])
  );
});

// ───────────────────────────────────────────────────────────
// /lunas_semua [NAMA] — Lunasin semua entri belum lunas milik pengawal
// ───────────────────────────────────────────────────────────
bot.command('lunas_semua', async (ctx) => {
  const userId = ctx.from.id;
  if (!await isAdmin(userId)) {
    return ctx.reply('\uD83D\uDEAB AKSES DITOLAK\nPerintah ini hanya untuk Admin.');
  }
  const args = (ctx.message.text || '').replace(/^\/lunas_semua\S*\s*/i, '').trim();
  if (!args) {
    return ctx.reply(
      '\u2139\uFE0F Penggunaan:\n\n/lunas_semua REZA\n\n' +
      'Akan menandai SEMUA rekap milik REZA\nyang belum lunas menjadi LUNAS.'
    );
  }
  const target  = args.toUpperCase();
  const allData = await getSheetValues(SHEET_KAWAL);
  const targets = [];
  for (let i = 1; i < allData.length; i++) {
    if (
      allData[i][0] &&
      String(allData[i][3]).toUpperCase() === target &&
      String(allData[i][4]).toUpperCase() !== 'LUNAS'
    ) {
      targets.push(i + 1); // nomor baris di sheet (1-indexed)
    }
  }
  if (!targets.length) {
    return ctx.reply(
      '\u2705 Tidak ada yang perlu diubah!\n\n' +
      '\uD83D\uDC64 ' + target + ' tidak punya rekap BELUM LUNAS.'
    );
  }
  // Update semua baris secara paralel
  await ctx.reply(
    '\u23F3 Memproses ' + targets.length + ' rekap untuk *' + target + '*...\nMohon tunggu.'
  );
  const updates = targets.map(no => updateCell(SHEET_KAWAL, no, 'E', 'LUNAS'));
  await Promise.all(updates);
  ctx.reply(
    '\u2705 SEMUA LUNAS!\n' + DIV + '\n\n' +
    '\uD83D\uDC64 Pengawal : ' + target + '\n' +
    '\uD83D\uDCB0 Diupdate : ' + targets.length + ' rekap\n' +
    '\uD83D\uDD16 Baris    : #' + targets.join(', #') + '\n\n' +
    '\u2705 Semua status sudah LUNAS!'
  );
});

// ───────────────────────────────────────────────────────────
// /cekplat [PLAT] — Riwayat lengkap suatu plat (Admin only)
// ───────────────────────────────────────────────────────────
bot.command('cekplat', async (ctx) => {
  const userId = ctx.from.id;
  if (!await isAdmin(userId)) {
    return ctx.reply('\uD83D\uDEAB AKSES DITOLAK\nPerintah ini hanya untuk Admin.');
  }
  const args = (ctx.message.text || '').replace(/^\/cekplat\S*\s*/i, '').trim();
  if (!args) {
    return ctx.reply(
      '\u2139\uFE0F Penggunaan:\n\n/cekplat BL 1234 AB\n\n' +
      'Untuk melihat riwayat rekap plat tersebut.'
    );
  }
  const platTarget = normalizePlat(args);
  const allData    = await getSheetValues(SHEET_KAWAL);
  const rows       = [];
  for (let i = 1; i < allData.length; i++) {
    if (allData[i][0] && normalizePlat(String(allData[i][1])) === platTarget) {
      rows.push({ no: i + 1, d: allData[i] });
    }
  }
  if (!rows.length) {
    return ctx.reply(
      '\uD83D\uDD0D PLAT TIDAK DITEMUKAN\n' + DIV + '\n\n' +
      '\uD83D\uDE97 ' + platTarget + '\n\n' +
      'Tidak ada riwayat rekap untuk plat ini.'
    );
  }
  const lunas = rows.filter(r => String(r.d[4]).toUpperCase() === 'LUNAS').length;
  const belum = rows.length - lunas;

  // Cek Toke dari TABLE
  const toke = await getTokeByPlat(platTarget);

  let t = '\uD83D\uDE97 RIWAYAT PLAT: ' + platTarget + '\n' + DIV + '\n';
  t += '\uD83D\uDC65 Toke     : ' + (toke || '-') + '\n';
  t += '\uD83D\uDCE6 Total    : ' + rows.length + ' rekap\n';
  t += '\u2705 Lunas   : ' + lunas + '  \u23F3 Belum: ' + belum + '\n';
  t += DIV + '\n';
  for (const r of rows) {
    const ok = String(r.d[4]).toUpperCase() === 'LUNAS';
    t += '\n' + (ok ? '\u2705' : '\u23F3') + ' #' + r.no + '\n';
    t += '\uD83D\uDCC5 ' + formatDate(r.d[0]) + '\n';
    t += '\uD83D\uDC64 Pengawal : ' + (r.d[3] || '-') + '\n';
    t += '\uD83D\uDCB0 Status   : ' + (ok ? 'LUNAS' : 'BELUM LUNAS');
    if (!ok) t += '  \u2192 /lunas ' + r.no;
    t += '\n';
  }
  t += '\n' + DIV;
  if (t.length > 4000) t = t.substring(0, 3900) + '\n\n(terpotong...)';
  ctx.reply(t);
});

// ═══════════════════════════════════════════════════════════
//  HANDLER UTAMA — Input Plat Kendaraan
//  User/Admin kirim nomor plat → bot auto isi semua field
// ═══════════════════════════════════════════════════════════
bot.on('text', async (ctx) => {
  const raw = (ctx.message.text || '').trim();
  if (raw.startsWith('/')) return;

  const plat = normalizePlat(raw);
  if (!isLikelyPlat(plat)) return;

  const userId = ctx.from.id;

  // 1. Cek registrasi
  const nama = await getNama(userId);
  if (!nama) {
    return ctx.reply(
      '\uD83D\uDEAB AKSES DITOLAK\n' + DIV + '\n\n' +
      '\uD83C\uDD94 ID: ' + userId + '\n\n' +
      'Anda belum terdaftar di sistem.\n' +
      'Hubungi admin untuk didaftarkan.'
    );
  }

  // 2. Cari Toke dari Sheet TABLE
  const toke = await getTokeByPlat(plat);
  if (!toke) {
    return ctx.reply(
      '\u274C PLAT TIDAK DITEMUKAN\n' + DIV + '\n\n' +
      '\uD83D\uDE97 ' + plat + '\n\n' +
      'Plat ini tidak ada di daftar TABLE.\n' +
      'Periksa kembali nomor plat Anda.\n\n' +
      '\uD83D\uDCA1 Contoh format: BL 1234 AB'
    );
  }

  // 3. Cek duplikat hari ini
  const allData  = await getSheetValues(SHEET_KAWAL);
  const hari     = getHariWITA();
  const startIdx = Math.max(1, allData.length - 200);
  for (let i = startIdx; i < allData.length; i++) {
    const rowHari = String(allData[i][0]).split(' ')[0];
    if (rowHari === hari && String(allData[i][1]).toUpperCase() === plat) {
      const existStatus = String(allData[i][4] || '-').toUpperCase();
      return ctx.reply(
        '\u26A0\uFE0F DATA SUDAH ADA HARI INI!\n' + DIV + '\n\n' +
        '\uD83D\uDE97 ' + plat + '  (baris #' + (i + 1) + ')\n' +
        '\uD83D\uDC65 Toke     : ' + (allData[i][2] || '-') + '\n' +
        '\uD83D\uDC64 Pengawal : ' + (allData[i][3] || '-') + '\n' +
        '\uD83D\uDCB0 Status   : ' + (existStatus === 'LUNAS' ? '\u2705 LUNAS' : '\u23F3 BELUM LUNAS') + '\n\n' +
        '\uD83D\uDCA1 Ubah plat/toke jika ingin entri baru.'
      );
    }
  }

  // 4. Tentukan status berdasarkan role
  const admin  = await isAdmin(userId);
  const status = admin ? 'LUNAS' : 'BELUM LUNAS';

  // 5. Simpan ke Sheet KAWAL LINTAS
  const tgl = nowWITA();
  await appendRow(SHEET_KAWAL, [tgl, plat, toke, nama, status]);

  const afterData = await getSheetValues(SHEET_KAWAL);
  const baris     = afterData.length;

  ctx.reply(
    '\u2705 REKAP BERHASIL DICATAT!\n' + DIV + '\n\n' +
    '\uD83D\uDCC5 ' + tgl + '\n' +
    '\uD83D\uDE97 Plat     : ' + plat + '\n' +
    '\uD83D\uDC65 Toke     : ' + toke + '\n' +
    '\uD83D\uDC64 Pengawal : ' + nama + '\n' +
    '\uD83D\uDCB0 Status   : ' + (admin ? 'LUNAS \u2705' : 'BELUM LUNAS \u23F3') + '\n' +
    '\uD83D\uDD16 Baris    : #' + baris + '\n' +
    DIV + '\n' +
    (admin
      ? '\uD83D\uDD11 Status langsung LUNAS (Admin)'
      : '\uD83D\uDCA1 /laporan untuk lihat semua rekap'
    )
  );
});

// ═══════════════════════════════════════════════════════════
//  EXPRESS SERVER
// ═══════════════════════════════════════════════════════════
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    bot: 'Kawal Lintas v4.0',
    mode: WEBHOOK_URL ? 'webhook' : 'polling',
    cache: _cache.size + ' entries',
  });
});

// Debug endpoint (sementara)
app.get('/debug/sheet', async (req, res) => {
  try {
    const credRaw  = process.env.GOOGLE_CREDENTIALS || '';
    let credParsed = {}; let credError = null;
    try { credParsed = JSON.parse(credRaw); } catch(e) { credError = e.message; }
    const masterData = await getSheetValues(SHEET_MASTER);
    const tableData  = await getSheetValues(SHEET_TABLE);
    res.json({
      credentials: {
        present: !!credRaw, length: credRaw.length,
        parseError: credError, type: credParsed.type || 'N/A',
        client_email: credParsed.client_email || 'N/A',
      },
      master: { rowCount: masterData.length, rows: masterData.slice(0, 8) },
      table:  { rowCount: tableData.length,  rows: tableData.slice(0, 5) },
      sheetId: SHEET_ID,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

if (WEBHOOK_URL) {
  const webhookPath = '/webhook/' + BOT_TOKEN;
  app.use(bot.webhookCallback(webhookPath));
  bot.telegram.setWebhook(`${WEBHOOK_URL}${webhookPath}`)
    .then(() => console.log('[BOT] Webhook aktif:', `${WEBHOOK_URL}${webhookPath}`))
    .catch(e => console.error('[BOT] Webhook gagal:', e.message));
  app.listen(PORT, () => console.log(`[SERVER] Berjalan di port ${PORT} (webhook)`));
} else {
  app.listen(PORT, () => console.log(`[SERVER] Health check di port ${PORT}`));
  bot.launch()
    .then(() => console.log('[BOT] Berjalan (polling mode)'))
    .catch(e => console.error('[BOT] Gagal start:', e.message));
}

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
