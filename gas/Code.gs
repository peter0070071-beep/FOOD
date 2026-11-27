/**
 * Maison Doré 金鑄鍋貼｜線上訂單 × Google Sheet（Google Apps Script）
 *
 * 功能
 *  - doPost：網站送出訂單 → 驗證、以「菜單」工作表的價格重新計價、寫入「訂單」「訂單明細」、寄通知信
 *  - doGet：?action=menu 回傳品項上架狀態與價格；?action=status&no=訂單編號&phone=手機 查詢訂單狀態
 *  - 試算表選單「Maison Doré」：初始化工作表、安裝排程、寄今日報表、測試訂單
 *  - 店員把「狀態」改成 可取餐／配送中／已取消 時，自動寄信通知顧客
 *  - 每晚 22:00 寄送當日營收報表並記錄到「每日報表」
 *
 * 安裝步驟請見 gas/README.md
 */

const CFG = {
  BRAND: 'Maison Doré 金鑄鍋貼',
  TZ: 'Asia/Taipei',
  FREE_SHIP: 1500,           // 宅配滿額免運
  SHIP_FEE: 80,              // 宅配運費
  NOTIFY_EMAIL: '',          // 店家通知信箱；留空 = 部署這支程式的帳號
  SEND_CUSTOMER_EMAIL: true, // 是否寄確認信給顧客
  MAX_ORDERS_PER_PHONE_10MIN: 5,
  REPORT_HOUR: 22,
  STATUSES: ['新訂單', '製作中', '可取餐', '配送中', '已完成', '已取消']
};

const SH = { ORDERS: '訂單', ITEMS: '訂單明細', MENU: '菜單', STORES: '門市', REPORT: '每日報表' };
const ORDER_HEAD = ['訂單編號', '建立時間', '狀態', '用餐方式', '門市', '姓名', '手機', 'Email', '宅配地址', '備註', '品項摘要', '小計', '運費', '總額', '來源', '請求ID'];
const COL = Object.fromEntries(ORDER_HEAD.map((h, i) => [h, i + 1]));
const ITEM_HEAD = ['訂單編號', '品項ID', '品名', '單價', '數量', '小計'];
const MENU_HEAD = ['品項ID', '品名', '單價', '上架'];
const STORE_HEAD = ['門市名稱', '通知Email'];
const REPORT_HEAD = ['日期', '訂單數', '營收', '內用', '外帶', '宅配', '熱銷前三'];
const MODES = { dinein: '內用', takeout: '外帶', delivery: '宅配' };

// 初始菜單（與網站一致；之後以試算表為準，改價或下架直接改「菜單」工作表）
const SEED_MENU = [
  ['p01', '黃金巴黎鍋貼（8 顆）', 160], ['p02', '松露牛肝菌鍋貼（6 顆）', 260], ['p03', '普羅旺斯香草鍋貼（8 顆）', 190],
  ['p04', '紅酒焦糖洋蔥牛肉鍋貼（6 顆）', 220], ['p05', '凡爾賽辣味鍋貼（8 顆）', 180], ['p06', '宮廷白菜豬肉水餃（10 顆）', 150],
  ['p07', '龍蝦奶油水餃（8 顆）', 280], ['p08', '紅油抄手（8 顆）', 170], ['p09', '三色蔬食水餃（10 顆）', 160],
  ['p10', '勃根地酸辣湯', 90], ['p11', '松露玉米濃湯', 110], ['p12', '玫瑰荔枝氣泡飲', 100], ['p13', '伯爵茶拿鐵', 95],
  ['p14', '蒜香拍黃瓜', 80], ['p15', '醉香滷味拼盤', 120], ['p16', '涼拌小黃瓜洋蔥', 80],
  ['g01', '普羅旺斯薰衣草鍋貼禮盒（50 入）', 1280], ['g02', '家庭號經典鍋貼（80 入）', 1680], ['g03', '皇家饗宴綜合禮盒（40 入）', 1980]
];
const SEED_STORES = [['旗艦店・大安', ''], ['信義店', ''], ['南港店', '']];

/* ============================== Web API ============================== */

function doPost(e) {
  let body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: '資料格式錯誤' }); }
  if (body.website) return json_({ ok: true, orderNo: 'MD-000000-0000', total: 0 });   // 機器人陷阱欄位
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return json_({ ok: false, error: '目前訂單較多，請稍後再試' });
  try { return json_(createOrder_(body, 'web')); }
  catch (err) { console.error(err && err.stack || err); return json_({ ok: false, error: err.userMsg || '系統暫時無法接單，請稍後再試或致電門市' }); }
  finally { lock.releaseLock(); }
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'menu') {
      return json_({ ok: true, items: readMenu_().list.map(m => ({ id: m.id, price: m.price, active: m.active })) });
    }
    if (p.action === 'status') {
      const no = String(p.no || '').trim(), phone = normPhone_(p.phone);
      const row = findOrderRow_(COL['訂單編號'], no);
      if (!row) return json_({ ok: false, error: '查無此訂單' });
      const v = sheet_(SH.ORDERS).getRange(row, 1, 1, ORDER_HEAD.length).getValues()[0];
      if (normPhone_(v[COL['手機'] - 1]) !== phone) return json_({ ok: false, error: '查無此訂單' });
      return json_({ ok: true, orderNo: no, status: v[COL['狀態'] - 1], mode: v[COL['用餐方式'] - 1], total: v[COL['總額'] - 1], createdAt: fmt_(v[COL['建立時間'] - 1], 'yyyy/MM/dd HH:mm') });
    }
    return json_({ ok: true, service: CFG.BRAND + ' order API' });
  } catch (err) { console.error(err); return json_({ ok: false, error: '系統錯誤' }); }
}

/* ============================== 建立訂單 ============================== */

function createOrder_(b, source) {
  const s = v => String(v == null ? '' : v).trim();
  const data = {
    requestId: s(b.clientId).slice(0, 64), mode: s(b.mode), store: s(b.store).slice(0, 40),
    name: s(b.name).slice(0, 40), phone: normPhone_(b.phone), email: s(b.email).slice(0, 120),
    address: s(b.address).slice(0, 160), note: s(b.note).slice(0, 300), items: Array.isArray(b.items) ? b.items.slice(0, 40) : []
  };

  // 重送保護：同一個請求ID只建立一次（網路中斷後自動重送不會重複下單）
  if (data.requestId) {
    const dup = findOrderRow_(COL['請求ID'], data.requestId);
    if (dup) {
      const v = sheet_(SH.ORDERS).getRange(dup, 1, 1, ORDER_HEAD.length).getValues()[0];
      return { ok: true, duplicate: true, orderNo: v[0], subtotal: v[COL['小計'] - 1], fee: v[COL['運費'] - 1], total: v[COL['總額'] - 1], status: v[COL['狀態'] - 1] };
    }
  }

  // 欄位驗證
  const fields = {};
  if (!MODES[data.mode]) fields.mode = '請選擇用餐方式';
  if (!data.name) fields.name = '請輸入姓名';
  if (!/^09\d{8}$/.test(data.phone)) fields.phone = '請輸入正確手機號碼（09 開頭 10 碼）';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) fields.email = '請輸入正確 Email';
  const stores = readStores_();
  if (data.mode === 'delivery') { if (data.address.length < 6) fields.address = '請輸入完整宅配地址'; data.store = ''; }
  else if (!Object.prototype.hasOwnProperty.call(stores, data.store)) fields.store = '請選擇門市';
  if (Object.keys(fields).length) return { ok: false, error: '請修正表單欄位', fields };

  // 以試算表價格重新計價（不採用網頁傳來的價格）
  const menu = readMenu_().map, merged = {};
  data.items.forEach(it => {
    const id = s(it && it.id), q = Math.floor(Number(it && it.qty));
    if (!id || !(q > 0)) return;
    merged[id] = Math.min(99, (merged[id] || 0) + q);
  });
  const ids = Object.keys(merged);
  if (!ids.length) return { ok: false, error: '購物車是空的' };
  const lines = [];
  for (const id of ids) {
    const m = menu[id];
    if (!m) return { ok: false, error: '有品項已不存在，請重新整理頁面' };
    if (!m.active) return { ok: false, error: '「' + m.name + '」目前售完，請移除後再送出', soldOut: [id] };
    lines.push({ id, name: m.name, price: m.price, qty: merged[id], sum: m.price * merged[id] });
  }
  const subtotal = lines.reduce((a, l) => a + l.sum, 0);
  const fee = data.mode === 'delivery' && subtotal < CFG.FREE_SHIP ? CFG.SHIP_FEE : 0;
  const total = subtotal + fee;

  // 簡易防灌單：同一支手機 10 分鐘內上限
  const cache = CacheService.getScriptCache(), rk = 'rl_' + data.phone, cnt = Number(cache.get(rk) || 0);
  if (cnt >= CFG.MAX_ORDERS_PER_PHONE_10MIN) return { ok: false, error: '短時間內下單次數過多，請稍後再試或致電門市' };
  cache.put(rk, String(cnt + 1), 600);

  // 寫入試算表
  const now = new Date(), orderNo = nextOrderNo_(now);
  const summary = lines.map(l => l.name + ' ×' + l.qty).join('、');
  sheet_(SH.ORDERS).appendRow([orderNo, now, CFG.STATUSES[0], MODES[data.mode], data.store, safe_(data.name), "'" + data.phone, safe_(data.email),
    safe_(data.address), safe_(data.note), summary, subtotal, fee, total, source || 'web', data.requestId]);
  const ish = sheet_(SH.ITEMS);
  ish.getRange(ish.getLastRow() + 1, 1, lines.length, ITEM_HEAD.length).setValues(lines.map(l => [orderNo, l.id, l.name, l.price, l.qty, l.sum]));

  const order = Object.assign({}, data, { orderNo, lines, subtotal, fee, total, createdAt: now, modeText: MODES[data.mode] });
  try { notifyStore_(order, stores); } catch (err) { console.error('店家通知失敗', err); }
  if (CFG.SEND_CUSTOMER_EMAIL) { try { mailCustomer_(order); } catch (err) { console.error('顧客確認信失敗', err); } }

  return { ok: true, orderNo, subtotal, fee, total, status: CFG.STATUSES[0] };
}

function nextOrderNo_(d) {
  const day = fmt_(d, 'yyMMdd'), props = PropertiesService.getScriptProperties(), key = 'seq_' + day;
  const n = Number(props.getProperty(key) || 0) + 1; props.setProperty(key, String(n));
  return 'MD' + day + '-' + ('000' + n).slice(-4);
}

/* ============================== Email ============================== */

function notifyStore_(o, stores) {
  const to = (o.store && stores[o.store]) || CFG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
  if (!to) return;
  MailApp.sendEmail({ to, name: CFG.BRAND, subject: '【新訂單】' + o.orderNo + '｜' + o.modeText + (o.store ? '｜' + o.store : '') + '｜NT$ ' + o.total, htmlBody: orderHtml_(o, true) });
}
function mailCustomer_(o) {
  MailApp.sendEmail({ to: o.email, name: CFG.BRAND, subject: CFG.BRAND + '｜訂單確認 ' + o.orderNo, htmlBody: orderHtml_(o, false) });
}
function orderHtml_(o, forStore) {
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = o.lines.map(l => '<tr><td style="padding:6px 0">' + esc(l.name) + ' × ' + l.qty + '</td><td style="text-align:right">NT$ ' + l.sum.toLocaleString() + '</td></tr>').join('');
  const where = o.mode === 'delivery' ? '宅配地址：' + esc(o.address) : '門市：' + esc(o.store);
  return '<div style="font-family:sans-serif;max-width:560px;color:#2a221c">' +
    '<h2 style="color:#9a7b3c;margin:0 0 8px">' + CFG.BRAND + '</h2>' +
    '<p>' + (forStore ? '收到一筆新訂單。' : esc(o.name) + ' 您好，感謝您的訂購，我們已收到您的訂單。') + '</p>' +
    '<p><b>訂單編號：</b>' + o.orderNo + '<br><b>用餐方式：</b>' + o.modeText + '<br>' + where +
    (forStore ? '<br><b>顧客：</b>' + esc(o.name) + '　' + o.phone + '　' + esc(o.email) : '') +
    (o.note ? '<br><b>備註：</b>' + esc(o.note) : '') + '</p>' +
    '<table style="width:100%;border-collapse:collapse;border-top:1px solid #ddd">' + rows +
    '<tr><td style="padding-top:8px">運費</td><td style="text-align:right">NT$ ' + o.fee + '</td></tr>' +
    '<tr><td style="font-weight:bold;padding-top:4px">總額</td><td style="text-align:right;font-weight:bold">NT$ ' + o.total.toLocaleString() + '</td></tr></table>' +
    (forStore ? '' : '<p style="color:#777;font-size:12px">餐點狀態更新時我們會再寄信通知您。如需修改或取消，請於 10 分鐘內致電門市。</p>') + '</div>';
}

/* 狀態變更通知（需由 installTriggers 安裝為「可安裝的編輯觸發條件」） */
function onStatusEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet();
  if (sh.getName() !== SH.ORDERS || e.range.getColumn() !== COL['狀態'] || e.range.getRow() < 2 || e.range.getNumRows() !== 1) return;
  const status = String(e.value || ''), msgs = { '可取餐': '您的餐點已完成，請至門市取餐。', '配送中': '您的餐點已出發，將盡快送達。', '已取消': '您的訂單已取消，如有疑問請洽門市。' };
  if (!msgs[status]) return;
  const v = sh.getRange(e.range.getRow(), 1, 1, ORDER_HEAD.length).getValues()[0], email = v[COL['Email'] - 1];
  if (!email) return;
  MailApp.sendEmail({ to: email, name: CFG.BRAND, subject: CFG.BRAND + '｜訂單 ' + v[0] + ' ' + status,
    htmlBody: '<div style="font-family:sans-serif;color:#2a221c"><h3 style="color:#9a7b3c">' + CFG.BRAND + '</h3><p>' + v[COL['姓名'] - 1] + ' 您好，' + msgs[status] + '</p><p>訂單編號：' + v[0] + '<br>總額：NT$ ' + v[COL['總額'] - 1] + '</p></div>' });
}

/* ============================== 報表 ============================== */

function dailyReport() {
  const today = fmt_(new Date(), 'yyyy/MM/dd'), osh = sheet_(SH.ORDERS), last = osh.getLastRow();
  const rows = last > 1 ? osh.getRange(2, 1, last - 1, ORDER_HEAD.length).getValues() : [];
  const todays = rows.filter(r => r[0] && fmt_(r[COL['建立時間'] - 1], 'yyyy/MM/dd') === today && r[COL['狀態'] - 1] !== '已取消');
  const nos = new Set(todays.map(r => r[0])), byMode = { '內用': 0, '外帶': 0, '宅配': 0 };
  let revenue = 0; todays.forEach(r => { revenue += Number(r[COL['總額'] - 1]) || 0; byMode[r[COL['用餐方式'] - 1]] = (byMode[r[COL['用餐方式'] - 1]] || 0) + 1; });
  const ish = sheet_(SH.ITEMS), il = ish.getLastRow(), qty = {};
  (il > 1 ? ish.getRange(2, 1, il - 1, ITEM_HEAD.length).getValues() : []).forEach(r => { if (nos.has(r[0])) qty[r[2]] = (qty[r[2]] || 0) + Number(r[4]); });
  const top = Object.entries(qty).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, q]) => n + ' ×' + q).join('、');
  sheet_(SH.REPORT).appendRow([today, todays.length, revenue, byMode['內用'], byMode['外帶'], byMode['宅配'], top]);
  const to = CFG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
  if (to) MailApp.sendEmail({ to, name: CFG.BRAND, subject: CFG.BRAND + '｜' + today + ' 營收報表 NT$ ' + revenue.toLocaleString(),
    htmlBody: '<div style="font-family:sans-serif"><h3>' + today + ' 營收報表</h3><p>訂單數：' + todays.length + '<br>營收：NT$ ' + revenue.toLocaleString() +
      '<br>內用 ' + byMode['內用'] + '／外帶 ' + byMode['外帶'] + '／宅配 ' + byMode['宅配'] + '<br>熱銷：' + (top || '—') + '</p></div>' });
  return { orders: todays.length, revenue };
}

/* ============================== 試算表選單與初始化 ============================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Maison Doré')
    .addItem('① 初始化工作表', 'setup')
    .addItem('② 安裝自動通知與每日報表', 'installTriggers')
    .addSeparator()
    .addItem('寄送今日營收報表', 'dailyReport')
    .addItem('建立一筆測試訂單', 'testOrder')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  const mk = (name, head, widths) => {
    let sh = ss.getSheetByName(name); if (!sh) sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#2b211b').setFontColor('#e4d9bd');
    sh.setFrozenRows(1); (widths || []).forEach((w, i) => w && sh.setColumnWidth(i + 1, w)); return sh;
  };
  const o = mk(SH.ORDERS, ORDER_HEAD, [130, 140, 80, 70, 110, 80, 100, 180, 200, 160, 280, 70, 60, 80, 60, 120]);
  o.getRange('B2:B').setNumberFormat('yyyy/mm/dd hh:mm'); o.getRange('G2:G').setNumberFormat('@'); o.getRange('L2:N').setNumberFormat('#,##0');
  o.getRange('C2:C').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(CFG.STATUSES, true).build());
  const colors = { '新訂單': '#fde68a', '製作中': '#bfdbfe', '可取餐': '#bbf7d0', '配送中': '#c7d2fe', '已完成': '#e5e7eb', '已取消': '#fecaca' };
  o.setConditionalFormatRules(Object.entries(colors).map(([t, c]) => SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(t).setBackground(c).setRanges([o.getRange('C2:C')]).build()));
  mk(SH.ITEMS, ITEM_HEAD, [130, 70, 260, 70, 60, 80]);
  const m = mk(SH.MENU, MENU_HEAD, [80, 280, 80, 70]);
  if (m.getLastRow() < 2) m.getRange(2, 1, SEED_MENU.length, 4).setValues(SEED_MENU.map(r => [r[0], r[1], r[2], true]));
  m.getRange(2, 4, Math.max(1, m.getLastRow() - 1), 1).insertCheckboxes();
  const st = mk(SH.STORES, STORE_HEAD, [140, 240]);
  if (st.getLastRow() < 2) st.getRange(2, 1, SEED_STORES.length, 2).setValues(SEED_STORES);
  mk(SH.REPORT, REPORT_HEAD, [100, 70, 90, 60, 60, 60, 320]);
  const blank = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  try { SpreadsheetApp.getUi().alert('完成！已建立：訂單、訂單明細、菜單、門市、每日報表。\n下一步：選單「② 安裝自動通知與每日報表」，再部署為網頁應用程式。'); } catch (e) {}
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => { if (['dailyReport', 'onStatusEdit'].includes(t.getHandlerFunction())) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyReport').timeBased().everyDays(1).atHour(CFG.REPORT_HOUR).inTimezone(CFG.TZ).create();
  ScriptApp.newTrigger('onStatusEdit').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  try { SpreadsheetApp.getUi().alert('已安裝：每天 ' + CFG.REPORT_HOUR + ':00 寄送營收報表；狀態改為 可取餐／配送中／已取消 時自動通知顧客。'); } catch (e) {}
}

function testOrder() {
  const me = Session.getEffectiveUser().getEmail();
  const r = createOrder_({ clientId: 'test-' + Date.now(), mode: 'takeout', store: SEED_STORES[0][0], name: '測試顧客', phone: '0912345678', email: me || 'test@example.com', note: '這是測試訂單', items: [{ id: 'p01', qty: 2 }, { id: 'p10', qty: 1 }] }, 'test');
  try { SpreadsheetApp.getUi().alert(r.ok ? '測試訂單已建立：' + r.orderNo + '（NT$ ' + r.total + '）' : '失敗：' + r.error); } catch (e) {}
  return r;
}

/* ============================== 工具 ============================== */

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) { const e = new Error('missing sheet ' + name); e.userMsg = '訂單系統尚未初始化，請聯絡店家'; throw e; }
  return sh;
}
function readMenu_() {
  const sh = sheet_(SH.MENU), n = sh.getLastRow() - 1, map = {}, list = [];
  if (n > 0) sh.getRange(2, 1, n, 4).getValues().forEach(r => {
    const id = String(r[0]).trim(); if (!id) return;
    const it = { id, name: String(r[1]), price: Number(r[2]) || 0, active: r[3] === true || String(r[3]).toUpperCase() === 'TRUE' };
    map[id] = it; list.push(it);
  });
  return { map, list };
}
function readStores_() {
  const sh = sheet_(SH.STORES), n = sh.getLastRow() - 1, out = {};
  if (n > 0) sh.getRange(2, 1, n, 2).getValues().forEach(r => { const k = String(r[0]).trim(); if (k) out[k] = String(r[1] || '').trim(); });
  return out;
}
function findOrderRow_(col, value) {
  if (!value) return 0;
  const sh = sheet_(SH.ORDERS), n = sh.getLastRow() - 1; if (n < 1) return 0;
  const c = sh.getRange(2, col, n, 1).createTextFinder(String(value)).matchEntireCell(true).findNext();
  return c ? c.getRow() : 0;
}
function normPhone_(p) { return String(p == null ? '' : p).replace(/[^\d]/g, ''); }
function safe_(t) { t = String(t || ''); return /^[=+\-@]/.test(t) ? "'" + t : t; }   // 防止試算表公式注入
function fmt_(d, f) { return Utilities.formatDate(d instanceof Date ? d : new Date(d), CFG.TZ, f); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
