// ═══════════════════════════════════════════════════════════
//  BOT KAWAL LINTAS - v3.0
//  Simple, Fast, Reliable
// ═══════════════════════════════════════════════════════════
var BOT_TOKEN    = "8831757624:AAGrbIIVklEcXMBcI3LYpY_vClt-dqn-QMM";
var SHEET_ID     = "1VDxLP2962kFAKdkINUHj4hHtdGJswbCAbEWrgu5ge0w";
var ADMIN_IDS    = [688909275];
var SHEET_KAWAL  = "KAWAL LINTAS";
var SHEET_MASTER = "MASTER";

// ═══════════════════════════════════════════════════════════
//  WEBHOOK HANDLER - Entry point utama
// ═══════════════════════════════════════════════════════════
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var msg  = data.message || data.edited_message;
    if (!msg || !msg.text) return resp200();

    var chatId   = String(msg.chat.id);
    var userId   = Number(msg.from.id);
    var text     = msg.text.trim();
    var updateId = String(data.update_id);

    // Anti-duplikat: simpan update_id di cache 5 menit
    var cache = CacheService.getScriptCache();
    if (cache.get("uid_" + updateId)) return resp200();
    cache.put("uid_" + updateId, "1", 300);

    // Parse command dan argumen
    var cleaned = text.replace(/^(\/\w+)@\w+/, "$1");
    var parts   = cleaned.split(/\s+/);
    var cmd     = parts[0].toLowerCase();
    var args    = cleaned.substring(parts[0].length).trim();

    // Routing
    switch (cmd) {
      case "/start":       handleStart(chatId, userId);          break;
      case "/help":        handleHelp(chatId, userId);           break;
      case "/laporan":     handleLaporan(chatId, userId, args);  break;
      case "/rekap_semua": handleRekapSemua(chatId, userId);     break;
      case "/lunas":       handleLunas(chatId, userId, args);    break;
      default:
        if (cmd.charAt(0) !== "/") handleRekap(chatId, userId, text);
    }

  } catch (err) {
    Logger.log("doPost ERROR: " + err.message + "\n" + err.stack);
  }
  return resp200();
}

function resp200() {
  return ContentService.createTextOutput("OK");
}

// ═══════════════════════════════════════════════════════════
//  HANDLERS
// ═══════════════════════════════════════════════════════════

function handleStart(chatId, userId) {
  var nama = getNama(userId);
  if (!nama) {
    send(chatId, "Akses Ditolak\n\nID Anda " + userId + " belum terdaftar.\nHubungi admin untuk didaftarkan.");
    return;
  }
  send(chatId,
    "BOT KAWAL LINTAS\n" +
    "=======================\n\n" +
    "Halo " + esc(nama) + "!\n\n" +
    "Kirim rekap dengan format:\n\n" +
    "PLAT : BL 1234 AB\n" +
    "STATUS MOBIL : PANCUNG\n" +
    "TOKE : NAMA TOKE\n\n" +
    "Ketik /help untuk panduan lengkap."
  );
}

function handleHelp(chatId, userId) {
  var isAdmin = ADMIN_IDS.indexOf(userId) !== -1;
  var t = "PANDUAN BOT KAWAL LINTAS\n";
  t += "=======================\n\n";
  t += "Kirim Rekap:\n";
  t += "PLAT : BL 1234 AB\n";
  t += "STATUS MOBIL : PANCUNG\n";
  t += "TOKE : PIPIN\n\n";
  t += "Perintah:\n";
  t += "/laporan - Lihat rekap Anda\n";
  t += "/help - Panduan ini\n";
  if (isAdmin) {
    t += "\nMenu Admin:\n";
    t += "/laporan NAMA - Rekap pengawal\n";
    t += "/rekap_semua - Semua belum lunas\n";
    t += "/lunas 5 - Tandai baris LUNAS\n";
  }
  send(chatId, t);
}

function handleRekap(chatId, userId, text) {
  var parsed = parseRekap(text);
  if (!parsed) return;

  var nama = getNama(userId);
  if (!nama) {
    send(chatId, "Akses Ditolak\n\nID Anda " + userId + " belum terdaftar.\nHubungi admin untuk didaftarkan.");
    return;
  }

  var sheet = getSheet(SHEET_KAWAL);
  var tgl   = Utilities.formatDate(new Date(), "Asia/Makassar", "dd/MM/yyyy HH:mm");
  var hari  = tgl.split(" ")[0];

  // Cek duplikat di 200 baris terakhir
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var numRows  = Math.min(200, lastRow - 1);
    var startRow = lastRow - numRows + 1;
    var rows = sheet.getRange(startRow, 1, numRows, 4).getValues();
    for (var i = 0; i < rows.length; i++) {
      var rowHari = String(rows[i][0]).split(" ")[0];
      if (rowHari === hari &&
          String(rows[i][1]).toUpperCase() === parsed.plat &&
          String(rows[i][3]).toUpperCase() === parsed.toke.toUpperCase()) {
        send(chatId,
          "Data Sudah Ada!\n\n" +
          "Rekap plat " + esc(parsed.plat) + " dan toke " + esc(parsed.toke) + "\n" +
          "sudah dicatat hari ini (baris " + (startRow + i) + ").\n\n" +
          "Ubah salah satu data jika ingin menambah."
        );
        return;
      }
    }
  }

  sheet.appendRow([tgl, parsed.plat, parsed.statusMobil, parsed.toke, nama, "BELUM LUNAS"]);
  var baris = sheet.getLastRow();
  send(chatId,
    "REKAP BERHASIL DICATAT\n" +
    "=======================\n\n" +
    "Tanggal    : " + tgl + "\n" +
    "Plat       : " + esc(parsed.plat) + "\n" +
    "Status     : " + esc(parsed.statusMobil) + "\n" +
    "Toke       : " + esc(parsed.toke) + "\n" +
    "Pengawal   : " + esc(nama) + "\n" +
    "Pembayaran : BELUM LUNAS\n" +
    "No. Baris  : #" + baris + "\n\n" +
    "Ketik /laporan untuk lihat semua rekap."
  );
}

function handleLunas(chatId, userId, args) {
  if (ADMIN_IDS.indexOf(userId) === -1) {
    send(chatId, "Akses Ditolak\nPerintah ini hanya untuk admin.");
    return;
  }
  var no = parseInt(args);
  if (!args || isNaN(no)) {
    send(chatId, "Format salah.\nGunakan: /lunas 5");
    return;
  }
  var sheet = getSheet(SHEET_KAWAL);
  if (no < 2 || no > sheet.getLastRow()) {
    send(chatId, "Baris #" + no + " tidak valid.");
    return;
  }
  var cell = sheet.getRange(no, 6);
  if (cell.getValue() === "LUNAS") {
    send(chatId, "Baris #" + no + " sudah berstatus LUNAS.");
    return;
  }
  cell.setValue("LUNAS");
  var r = sheet.getRange(no, 1, 1, 6).getValues()[0];
  send(chatId,
    "STATUS DIPERBARUI\n" +
    "=======================\n\n" +
    "Baris     : #" + no + "\n" +
    "Plat      : " + esc(r[1]) + "\n" +
    "Pengawal  : " + esc(r[4]) + "\n" +
    "Status    : LUNAS\n\n" +
    "Tanggal   : " + fmtDate(r[0])
  );
}

function handleLaporan(chatId, userId, args) {
  var isAdmin = ADMIN_IDS.indexOf(userId) !== -1;
  var target;
  if (args && args.trim() !== "") {
    if (!isAdmin) {
      send(chatId, "Akses Ditolak\nPerintah ini hanya untuk admin.");
      return;
    }
    target = args.trim().toUpperCase();
  } else {
    var nama = getNama(userId);
    if (!nama) {
      send(chatId, "ID Anda belum terdaftar. Hubungi admin.");
      return;
    }
    target = nama;
  }

  var allData = getSheet(SHEET_KAWAL).getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < allData.length; i++) {
    if (allData[i][0] && String(allData[i][4]).toUpperCase() === target) {
      rows.push({ no: i + 1, d: allData[i] });
    }
  }
  if (!rows.length) {
    send(chatId, "Belum ada rekap untuk " + esc(target) + ".");
    return;
  }

  var lunas = 0;
  for (var j = 0; j < rows.length; j++) {
    if (String(rows[j].d[5]).toUpperCase() === "LUNAS") lunas++;
  }
  var belum = rows.length - lunas;

  var t = "LAPORAN: " + esc(target) + "\n";
  t += "=======================\n";
  t += "Total: " + rows.length + "  Lunas: " + lunas + "  Belum: " + belum + "\n";
  t += "-----------------------\n";
  for (var k = 0; k < rows.length; k++) {
    var r = rows[k];
    var badge = String(r.d[5]).toUpperCase() === "LUNAS" ? "[LUNAS]" : "[BELUM]";
    t += "\n" + badge + " #" + r.no + " - " + fmtDate(r.d[0]) + "\n";
    t += "  Plat: " + esc(r.d[1]) + " (" + esc(r.d[2]) + ")\n";
    t += "  Toke: " + esc(r.d[3]) + "\n";
  }
  if (t.length > 4000) t = t.substring(0, 3900) + "\n\n(terpotong)";
  send(chatId, t);
}

function handleRekapSemua(chatId, userId) {
  if (ADMIN_IDS.indexOf(userId) === -1) {
    send(chatId, "Akses Ditolak\nPerintah ini hanya untuk admin.");
    return;
  }

  var allData = getSheet(SHEET_KAWAL).getDataRange().getValues();
  var list = [];
  for (var i = 1; i < allData.length; i++) {
    if (allData[i][0] && String(allData[i][5]).toUpperCase() !== "LUNAS") {
      list.push({ no: i + 1, d: allData[i] });
    }
  }
  if (!list.length) {
    send(chatId, "Semua rekap sudah LUNAS!\n\nTidak ada data yang tertunggak.");
    return;
  }

  var t = "BELUM LUNAS (" + list.length + " data)\n";
  t += "=======================\n";
  for (var j = 0; j < list.length; j++) {
    var r = list[j];
    t += "\n#" + r.no + " - " + esc(r.d[4]) + "\n";
    t += "  " + fmtDate(r.d[0]) + "\n";
    t += "  Plat: " + esc(r.d[1]) + " (" + esc(r.d[2]) + ")\n";
    t += "  Toke: " + esc(r.d[3]) + "\n";
    t += "  Tandai: /lunas " + r.no + "\n";
  }
  if (t.length > 4000) t = t.substring(0, 3900) + "\n\n(terpotong)";
  send(chatId, t);
}

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════

function getSheet(name) {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(name);
}

function getNama(userId) {
  var cache = CacheService.getScriptCache();
  var key   = "nm_" + userId;
  var hit   = cache.get(key);
  if (hit) return hit;

  try {
    var data  = getSheet(SHEET_MASTER).getDataRange().getValues();
    var idStr = String(userId).trim();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() === idStr && data[i][1]) {
        var nama = String(data[i][1]).trim().toUpperCase();
        cache.put(key, nama, 1800);
        return nama;
      }
    }
  } catch(e) { Logger.log("getNama ERROR: " + e.message); }
  return null;
}

function parseRekap(text) {
  try {
    var map   = {};
    var lines = text.replace(/\r/g, "").split(/[\n\/]/);
    for (var i = 0; i < lines.length; i++) {
      var idx = lines[i].indexOf(":");
      if (idx < 1) continue;
      var k = lines[i].substring(0, idx).trim().toUpperCase();
      var v = lines[i].substring(idx + 1).trim();
      if (k && v) map[k] = v;
    }
    var plat = map["PLAT"];
    var stm  = map["STATUS MOBIL"] || map["STATUS"];
    var toke = map["TOKE"];
    if (!plat || !stm || !toke) return null;
    return { plat: plat.toUpperCase(), statusMobil: stm.toUpperCase(), toke: toke };
  } catch (e) { return null; }
}

function fmtDate(val) {
  if (!val) return "-";
  if (val instanceof Date) return Utilities.formatDate(val, "Asia/Makassar", "dd/MM/yyyy HH:mm");
  var s = String(val);
  if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) return s.substring(0, 16);
  try {
    var d = new Date(s);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, "Asia/Makassar", "dd/MM/yyyy HH:mm");
  } catch(e) {}
  return s;
}

function esc(text) {
  if (!text) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function send(chatId, text) {
  var res = UrlFetchApp.fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      chat_id: chatId,
      text: text,
      disable_web_page_preview: true
    }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) {
    Logger.log("send() GAGAL " + code + ": " + res.getContentText().substring(0, 300));
  }
}

// ═══════════════════════════════════════════════════════════
//  SETUP - WAJIB dijalankan PERTAMA KALI dari Apps Script editor
//  Fungsi ini akan: otorisasi + set webhook + kirim tes ke admin
// ═══════════════════════════════════════════════════════════
function setup() {
  // 1. Tes akses Spreadsheet
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    Logger.log("OK Spreadsheet: " + ss.getName());
  } catch(e) {
    Logger.log("GAGAL akses Spreadsheet: " + e.message);
    return;
  }

  // 2. Ambil URL deployment aktif
  var deployUrl = ScriptApp.getService().getUrl();
  Logger.log("Webhook URL: " + deployUrl);

  // 3. Reset webhook ke URL baru
  UrlFetchApp.fetch(
    "https://api.telegram.org/bot" + BOT_TOKEN + "/deleteWebhook?drop_pending_updates=true",
    { muteHttpExceptions: true }
  );
  Utilities.sleep(2000);
  var res = UrlFetchApp.fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/setWebhook", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      url: deployUrl,
      drop_pending_updates: true,
      allowed_updates: ["message"]
    }),
    muteHttpExceptions: true
  });
  Logger.log("Webhook result: " + res.getContentText());

  // 4. Kirim notifikasi ke admin
  send(String(ADMIN_IDS[0]), "Bot v3.0 berhasil di-setup!\n\nWebhook aktif. Coba /help");
  Logger.log("Setup selesai!");
}
