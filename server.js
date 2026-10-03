'use strict';
/* ==========================================================================
   EmdadX Attendance — برنامج إدارة الحضور والانصراف
   Zero-dependency: Node.js 22+ (node:http + node:sqlite + node:crypto)
   ========================================================================== */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
// hide the "SQLite is experimental" notice (keep every other warning)
const _emit = process.emitWarning;
process.emitWarning = function (w, ...rest) { if (String(w && w.message || w).includes('SQLite')) return; return _emit.call(process, w, ...rest); };
const { DatabaseSync } = require('node:sqlite');

const VERSION = '1.4.0';
const PORT = Number(process.env.PORT) || 8686;
const HOST = process.env.HOST || '0.0.0.0';
const APP_PATH = (process.env.APP_PATH || '').replace(/\/+$/, '');
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'attendance.db');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ------------------------------------------------------------------ DB --- */
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, name TEXT,
  pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'hr', active INTEGER DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT, manager TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'morning',
  start_time TEXT NOT NULL, end_time TEXT NOT NULL, grace_min INTEGER DEFAULT 15, created_at TEXT);
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, lat REAL, lng REAL,
  radius INTEGER DEFAULT 250, address TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  phone TEXT, job TEXT, dept_id INTEGER, shift_id INTEGER, site_id INTEGER,
  rest_days TEXT DEFAULT '5', pin TEXT, device_id TEXT, active INTEGER DEFAULT 1,
  hired_at TEXT, notes TEXT, demo INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS roster (
  emp_id INTEGER NOT NULL, date TEXT NOT NULL, shift_id INTEGER, is_rest INTEGER DEFAULT 0,
  PRIMARY KEY (emp_id, date));
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id INTEGER NOT NULL, date TEXT NOT NULL,
  in_at TEXT, out_at TEXT,
  in_lat REAL, in_lng REAL, in_acc REAL, in_addr TEXT, in_dist REAL,
  out_lat REAL, out_lng REAL, out_acc REAL, out_addr TEXT, out_dist REAL,
  source TEXT DEFAULT 'mobile', notes TEXT, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_att_emp ON attendance(emp_id, date);
CREATE TABLE IF NOT EXISTS leaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id INTEGER NOT NULL, type TEXT NOT NULL,
  from_date TEXT NOT NULL, to_date TEXT NOT NULL, from_time TEXT, to_time TEXT, reason TEXT,
  status TEXT DEFAULT 'pending', reply TEXT, requested_by TEXT, decided_by TEXT,
  decided_at TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_leaves_emp ON leaves(emp_id, from_date);
CREATE TABLE IF NOT EXISTS holidays (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT UNIQUE NOT NULL, name TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_id INTEGER NOT NULL, created_at TEXT, last_seen TEXT);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, who TEXT, action TEXT, details TEXT);
CREATE TABLE IF NOT EXISTS centers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, area TEXT, address TEXT, contact TEXT, phone TEXT,
  lat REAL, lng REAL, radius INTEGER DEFAULT 300, notes TEXT, active INTEGER DEFAULT 1, demo INTEGER DEFAULT 0,
  created_by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id INTEGER NOT NULL, date TEXT NOT NULL, at TEXT NOT NULL,
  center_id INTEGER, center_name TEXT, work_type TEXT, device TEXT, details TEXT, result TEXT DEFAULT 'done',
  receiver_name TEXT, receiver_role TEXT, receiver_phone TEXT, arrived_at TEXT,
  lat REAL, lng REAL, acc REAL, dist REAL, addr TEXT, photo TEXT, photo_size INTEGER,
  reviewed INTEGER DEFAULT 0, reviewed_by TEXT, admin_note TEXT, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(date);
CREATE INDEX IF NOT EXISTS idx_visits_emp ON visits(emp_id, date);
CREATE INDEX IF NOT EXISTS idx_visits_center ON visits(center_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id INTEGER NOT NULL, sender TEXT NOT NULL, user_id INTEGER, user_name TEXT,
  body TEXT NOT NULL, broadcast INTEGER DEFAULT 0, created_at TEXT, read_at TEXT);
CREATE INDEX IF NOT EXISTS idx_msg_emp ON messages(emp_id, id);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id INTEGER NOT NULL, at TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
  acc REAL, battery INTEGER, kind TEXT DEFAULT 'ping');
CREATE INDEX IF NOT EXISTS idx_loc_emp ON locations(emp_id, at);
CREATE INDEX IF NOT EXISTS idx_loc_at ON locations(at);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, center_id INTEGER NOT NULL, name TEXT NOT NULL, brand TEXT, model TEXT, serial TEXT,
  installed_at TEXT, pm_months INTEGER DEFAULT 3, last_pm TEXT, next_pm TEXT, notes TEXT, active INTEGER DEFAULT 1, demo INTEGER DEFAULT 0, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_dev_center ON devices(center_id);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, center_id INTEGER, center_name TEXT, device_id INTEGER, title TEXT NOT NULL, details TEXT,
  priority TEXT DEFAULT 'normal', emp_id INTEGER, due_at TEXT, status TEXT DEFAULT 'new',
  accepted_at TEXT, onway_at TEXT, arrived_at TEXT, done_at TEXT, closed_at TEXT, visit_id INTEGER,
  arrive_lat REAL, arrive_lng REAL, arrive_dist REAL, emp_note TEXT, created_by TEXT, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_tasks_emp ON tasks(emp_id, status);
CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT, unit TEXT DEFAULT 'قطعة', price REAL DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS part_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, emp_id INTEGER NOT NULL, qty REAL NOT NULL, kind TEXT NOT NULL,
  visit_id INTEGER, note TEXT, by_name TEXT, at TEXT);
CREATE INDEX IF NOT EXISTS idx_pmv ON part_moves(emp_id, part_id);
CREATE TABLE IF NOT EXISTS advances (
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id INTEGER NOT NULL, amount REAL NOT NULL, date TEXT NOT NULL, months INTEGER DEFAULT 1,
  start_month TEXT NOT NULL, note TEXT, by_name TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS payroll_adj (
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id INTEGER NOT NULL, month TEXT NOT NULL, kind TEXT NOT NULL, amount REAL NOT NULL, note TEXT, by_name TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id INTEGER NOT NULL, center_id INTEGER, center_name TEXT, date TEXT NOT NULL, time TEXT, note TEXT,
  remind_min INTEGER DEFAULT 30, series TEXT, status TEXT DEFAULT 'planned', visit_id INTEGER, notified_at TEXT, created_by TEXT, demo INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS ix_plans_date ON plans(date, emp_id);
CREATE TABLE IF NOT EXISTS kb (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, model TEXT, problem TEXT NOT NULL, solution TEXT NOT NULL, emp_id INTEGER, author TEXT,
  center_id INTEGER, center_name TEXT, visit_id INTEGER, votes INTEGER DEFAULT 0, views INTEGER DEFAULT 0, demo INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS kb_votes (kb_id INTEGER NOT NULL, who TEXT NOT NULL, at TEXT, PRIMARY KEY (kb_id, who));
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id INTEGER NOT NULL, kind TEXT DEFAULT 'msg', title TEXT, message TEXT, stars INTEGER DEFAULT 0, amount REAL DEFAULT 0,
  style TEXT DEFAULT 'confetti', adj_id INTEGER, by_name TEXT, created_at TEXT, seen_at TEXT, demo INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref_id INTEGER NOT NULL, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL,
  auth TEXT NOT NULL, ua TEXT, created_at TEXT, last_ok TEXT, fails INTEGER DEFAULT 0);
`);

// safe schema upgrades for future versions
for (const sql of [
  "ALTER TABLE employees ADD COLUMN email TEXT",
  "ALTER TABLE attendance ADD COLUMN in_photo TEXT",
  "ALTER TABLE attendance ADD COLUMN out_photo TEXT",
  "ALTER TABLE employees ADD COLUMN photo TEXT",
  "ALTER TABLE employees ADD COLUMN chat_enabled INTEGER DEFAULT 1",
  "ALTER TABLE employees ADD COLUMN track_enabled INTEGER DEFAULT 1",
  "ALTER TABLE users ADD COLUMN weak_pass INTEGER DEFAULT 0",
  "ALTER TABLE employees ADD COLUMN salary REAL DEFAULT 0",
  "ALTER TABLE visits ADD COLUMN signature TEXT",
  "ALTER TABLE visits ADD COLUMN device_id INTEGER",
  "ALTER TABLE visits ADD COLUMN task_id INTEGER",
  "ALTER TABLE visits ADD COLUMN rate_token TEXT",
  "ALTER TABLE visits ADD COLUMN rating INTEGER",
  "ALTER TABLE visits ADD COLUMN rating_note TEXT",
  "ALTER TABLE visits ADD COLUMN rated_at TEXT",
  "ALTER TABLE visits ADD COLUMN client_at TEXT",
  "ALTER TABLE visits ADD COLUMN parts_used TEXT",
  "ALTER TABLE visits ADD COLUMN fault_code TEXT",
  "ALTER TABLE visits ADD COLUMN fault_model TEXT",
  "ALTER TABLE visits ADD COLUMN fault_desc TEXT",
  "ALTER TABLE visits ADD COLUMN plan_id INTEGER",
  "ALTER TABLE tasks ADD COLUMN source TEXT",
  "ALTER TABLE tasks ADD COLUMN reporter_name TEXT",
  "ALTER TABLE tasks ADD COLUMN reporter_phone TEXT",
  "ALTER TABLE tasks ADD COLUMN track_token TEXT",
  "ALTER TABLE tasks ADD COLUMN photo TEXT",
]) { try { db.exec(sql); } catch { /* already exists */ } }

const stmtCache = new Map();
function stmt(sql) { let s = stmtCache.get(sql); if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); } return s; }
const nz = v => v === undefined ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : v);
const all = (sql, ...p) => stmt(sql).all(...p.map(nz));
const one = (sql, ...p) => stmt(sql).get(...p.map(nz));
const run = (sql, ...p) => stmt(sql).run(...p.map(nz));
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

/* ------------------------------------------------------------ Settings --- */
const DEFAULT_SETTINGS = {
  company_name: 'إمدادكس',
  company_sub: 'إدارة الحضور والانصراف',
  timezone: 'Africa/Cairo',
  geofence_mode: 'warn',      // off | warn | block
  require_location: '1',
  bind_device: '0',
  default_rest_days: '5',
  open_hours: '16',           // max hours a check-in stays open for check-out
  geocode: '1',
  week_start: '6',            // Saturday
  work_types: 'صيانة دورية\nإصلاح عطل\nتركيب وتشغيل جهاز\nمعايرة وفحص\nتوريد خامات\nتدريب فني\nأخرى',
  photo_quality: 'low',       // low | medium | high
  photo_camera_only: '1',
  photo_required: '1',
  punch_selfie: '0',
  auto_backup: '1',
  chat_enabled: '1',          // employees can message the management
  track_enabled: '1',         // live location while checked in
  track_interval: '15',       // minutes between location updates
  signature_required: '0',    // receiver signature on every visit
  company_logo: '',           // uploaded logo (relative path inside uploads)
  punch_mode: 'gps',          // gps | qr_or_gps | qr
  daily_summary: '1',         // push a daily summary to the management
  daily_summary_time: '20:00',
  nudge_enabled: '1',         // remind an employee when his location stopped updating
  payroll_days: '30',         // salary / days = day rate
  late_factor: '1',           // late minutes x minute-rate x factor
  late_free_min: '0',         // free late minutes per month
  absent_factor: '1',
  ot_enabled: '1',
  ot_factor: '1.5',
  currency: 'ج.م',
  push_contact: 'mailto:admin@emdadx.app',
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", k, v);
let SETTINGS = {};
function loadSettings() { SETTINGS = { ...DEFAULT_SETTINGS }; for (const r of all('SELECT key, value FROM settings')) SETTINGS[r.key] = r.value; }
loadSettings();

/* ---------------------------------------------------------------- Time --- */
const fmtCache = new Map();
function tzFormatter() {
  const tz = SETTINGS.timezone || 'Africa/Cairo';
  let f = fmtCache.get(tz);
  if (!f) {
    const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
    try { f = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: tz }); }
    catch { f = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'Africa/Cairo' }); }
    fmtCache.set(tz, f);
  }
  return f;
}
function nowLocal(d = new Date()) {
  const p = {};
  for (const x of tzFormatter().formatToParts(d)) p[x.type] = x.value;
  const hour = p.hour === '24' ? '00' : p.hour;
  const date = `${p.year}-${p.month}-${p.day}`, time = `${hour}:${p.minute}:${p.second}`;
  return { date, time, ts: `${date} ${time}` };
}
const pad = n => String(n).padStart(2, '0');
const normTime = t => (t && t.length === 5 ? t + ':00' : t);
const absMin = (date, time) => Date.parse(`${date}T${normTime(time || '00:00:00')}Z`) / 60000;
const tsMin = ts => absMin(ts.slice(0, 10), ts.slice(11));
const minToTs = m => { const d = new Date(Math.round(m) * 60000).toISOString(); return d.slice(0, 10) + ' ' + d.slice(11, 19); };
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const weekday = d => new Date(d + 'T00:00:00Z').getUTCDay();
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s);
function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 864e5); }

/* ------------------------------------------------------------- Helpers --- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

function hashSecret(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(p), salt, 32).toString('hex');
}
function checkSecret(p, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const x = crypto.scryptSync(String(p), salt, 32), y = Buffer.from(h, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const WEAK = ['admin', '1234', '12345', '123456', '1234567', '12345678', 'password', '0000', '1111', 'qwerty'];
const isWeakPass = (p, user) => { p = String(p || ''); return p.length < 6 || WEAK.includes(p.toLowerCase()) || p.toLowerCase() === String(user || '').toLowerCase(); };
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
const num = v => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? null : Number(v);
const str = (v, max = 300) => (v === null || v === undefined) ? null : String(v).trim().slice(0, max) || null;
function audit(who, action, details) {
  try { run('INSERT INTO audit (at, who, action, details) VALUES (?, ?, ?, ?)', nowLocal().ts, who, action, typeof details === 'string' ? details : JSON.stringify(details)); } catch {}
}

/* -------------------------------------------------------------- Photos --- */
const PHOTO_RE = /^data:image\/(jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/;
const PHOTO_PATH_RE = /^(\d{4}-\d{2}\/[a-f0-9]{24}\.(jpg|webp|png)|demo\/demo-\d+\.svg)$/;
function checkSign(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) fail(400, 'التوقيع غير صالح');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 200 || buf.length > 200 * 1024 || buf.readUInt32BE(0) !== 0x89504E47) fail(400, 'التوقيع غير صالح');
  return { buf, ext: '.png' };
}
function checkPhoto(dataUrl) {
  const m = PHOTO_RE.exec(String(dataUrl || ''));
  if (!m) fail(400, 'الصورة لازم تكون JPG');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 400) fail(400, 'الصورة مش واضحة.. صوّر تاني');
  if (buf.length > 450 * 1024) fail(400, 'حجم الصورة كبير.. صوّر تاني');
  const isJpg = buf[0] === 0xFF && buf[1] === 0xD8;
  const isWebp = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  if (!isJpg && !isWebp) fail(400, 'ملف الصورة غير صالح');
  return { buf, ext: isJpg ? '.jpg' : '.webp' };
}
function savePhoto(chk) {
  const month = nowLocal().date.slice(0, 7);
  const dir = path.join(UPLOAD_DIR, month); fs.mkdirSync(dir, { recursive: true });
  const name = crypto.randomBytes(12).toString('hex') + chk.ext;
  fs.writeFileSync(path.join(dir, name), chk.buf);
  return { rel: month + '/' + name, size: chk.buf.length };
}
const photoFile = rel => (rel && PHOTO_PATH_RE.test(rel)) ? path.join(UPLOAD_DIR, rel) : null;
function deletePhoto(rel) { if (!rel || rel.startsWith('demo/')) return; const f = photoFile(rel); if (f) fs.rm(f, { force: true }, () => {}); }
function photosOfEmp(id) {
  return [...all('SELECT photo AS p FROM employees WHERE id = ? AND photo IS NOT NULL', id), ...all('SELECT photo AS p FROM visits WHERE emp_id = ? AND photo IS NOT NULL', id), ...all('SELECT in_photo AS p FROM attendance WHERE emp_id = ? AND in_photo IS NOT NULL', id), ...all('SELECT out_photo AS p FROM attendance WHERE emp_id = ? AND out_photo IS NOT NULL', id)].map(r => r.p);
}

/* ------------------------------------------------------- Domain consts --- */
const FULL_DAY_LEAVES = ['annual', 'casual', 'sick', 'unpaid', 'mission'];
const PERM_LEAVES = ['late_perm', 'early_perm', 'exit_perm'];
const LEAVE_TYPES = [...FULL_DAY_LEAVES, ...PERM_LEAVES, 'att_fix'];   // att_fix = request to correct a check-in/out
const SHIFT_KINDS = ['morning', 'evening', 'night'];

/* ------------------------------------------------------ Attendance core --- */
function loadCtx(from, to) {
  const shifts = new Map(all('SELECT * FROM shifts').map(s => [s.id, s]));
  const depts = new Map(all('SELECT * FROM departments').map(d => [d.id, d]));
  const sites = new Map(all('SELECT * FROM sites').map(s => [s.id, s]));
  const roster = new Map(all('SELECT * FROM roster WHERE date BETWEEN ? AND ?', from, to).map(r => [r.emp_id + '|' + r.date, r]));
  const holidays = new Map(all('SELECT * FROM holidays WHERE date BETWEEN ? AND ?', from, to).map(h => [h.date, h.name || 'إجازة رسمية']));
  const leaves = new Map();
  for (const l of all("SELECT * FROM leaves WHERE status = 'approved' AND from_date <= ? AND to_date >= ?", to, from)) {
    if (!leaves.has(l.emp_id)) leaves.set(l.emp_id, []);
    leaves.get(l.emp_id).push(l);
  }
  const att = new Map();
  for (const a of all('SELECT * FROM attendance WHERE date BETWEEN ? AND ? ORDER BY in_at', from, to)) {
    const k = a.emp_id + '|' + a.date;
    if (!att.has(k)) att.set(k, a);
  }
  return { shifts, depts, sites, roster, holidays, leaves, att };
}

function scheduleFor(emp, date, ctx) {
  const r = ctx.roster.get(emp.id + '|' + date);
  let shift = null, rest = false;
  if (r) { if (r.is_rest) rest = true; else shift = ctx.shifts.get(r.shift_id) || null; }
  else {
    const rd = String(emp.rest_days || '').split(',').filter(x => x !== '').map(Number);
    if (rd.includes(weekday(date))) rest = true;
    else shift = ctx.shifts.get(emp.shift_id) || null;
  }
  return { shift, rest, override: !!r, holiday: ctx.holidays.get(date) || null };
}

function shiftWindow(shift, date) {
  const s = absMin(date, shift.start_time);
  let e = absMin(date, shift.end_time);
  if (e <= s) e += 1440;
  return { s, e };
}

function computeDay(emp, date, ctx, now) {
  const today = now.date, nowM = tsMin(now.ts);
  const sch = scheduleFor(emp, date, ctx);
  const a = ctx.att.get(emp.id + '|' + date) || null;
  const lv = (ctx.leaves.get(emp.id) || []).filter(l => l.from_date <= date && l.to_date >= date);
  const fullLeave = lv.find(l => FULL_DAY_LEAVES.includes(l.type));
  const lateP = lv.find(l => l.type === 'late_perm');
  const earlyP = lv.find(l => l.type === 'early_perm');
  const exitP = lv.find(l => l.type === 'exit_perm');
  const dept = ctx.depts.get(emp.dept_id);
  const site = ctx.sites.get(emp.site_id);
  const sh = sch.shift;
  const row = {
    emp_id: emp.id, code: emp.code, name: emp.name, job: emp.job, dept_id: emp.dept_id,
    dept: dept ? dept.name : null, dept_color: dept ? dept.color : null, date, weekday: weekday(date),
    shift_id: sh ? sh.id : null, shift_name: sh ? sh.name : null, shift_kind: sh ? sh.kind : null,
    shift_start: sh ? sh.start_time : null, shift_end: sh ? sh.end_time : null, grace: sh ? sh.grace_min : null,
    rest: sch.rest, holiday: sch.holiday, override: sch.override,
    att_id: a ? a.id : null, in_at: a ? a.in_at : null, out_at: a ? a.out_at : null,
    in_lat: a ? a.in_lat : null, in_lng: a ? a.in_lng : null, in_addr: a ? a.in_addr : null, in_dist: a ? a.in_dist : null,
    out_lat: a ? a.out_lat : null, out_lng: a ? a.out_lng : null, out_addr: a ? a.out_addr : null, out_dist: a ? a.out_dist : null,
    source: a ? a.source : null, notes: a ? a.notes : null, in_photo: a ? a.in_photo : null, out_photo: a ? a.out_photo : null,
    site_radius: site ? site.radius : null, site_name: site ? site.name : null,
    status: null, late: 0, early: 0, worked: null, overtime: 0, leave_type: fullLeave ? fullLeave.type : null,
    perms: lv.filter(l => PERM_LEAVES.includes(l.type)).map(l => l.type), flags: [],
  };
  if (a && a.in_at) {
    const inM = tsMin(a.in_at);
    const outM = a.out_at ? tsMin(a.out_at) : null;
    if (outM !== null) row.worked = Math.max(0, Math.round(outM - inM));
    else if (date === today || nowM - inM < Number(SETTINGS.open_hours || 16) * 60) { row.worked = Math.max(0, Math.round(nowM - inM)); row.flags.push('working'); }
    if (sh && !sch.rest && !sch.holiday) {
      const w = shiftWindow(sh, date);
      const late = Math.round(inM - w.s);
      if (late > (sh.grace_min || 0)) { row.late = late; if (lateP) row.flags.push('late_excused'); }
      if (outM !== null) {
        const early = Math.round(w.e - outM);
        if (early > 0) { row.early = early; row.flags.push(earlyP ? 'early_excused' : 'early'); }
        const ot = Math.round(outM - w.e);
        if (ot >= 15) row.overtime = ot;
      } else if (!row.flags.includes('working') && nowM > w.e + 60) row.flags.push('no_out');
      row.status = row.late > 0 && !lateP ? 'late' : 'present';
    } else {
      row.status = 'present';
      if (sch.rest || sch.holiday) { row.flags.push('extra_day'); row.overtime = row.worked && outM !== null ? row.worked : 0; }
      if (outM === null && !row.flags.includes('working')) row.flags.push('no_out');
    }
    if (fullLeave) row.flags.push('on_leave');
    if (row.site_radius && row.in_dist !== null && row.in_dist > row.site_radius) row.flags.push('out_range');
    if (row.site_radius && row.out_dist !== null && row.out_dist > row.site_radius) row.flags.push('out_range_out');
    if (a.in_lat === null && a.source !== 'manual') row.flags.push('no_loc');
    if (a.source === 'manual') row.flags.push('manual');
    if (exitP) row.flags.push('exit_perm');
  } else {
    if (fullLeave) row.status = fullLeave.type === 'mission' ? 'mission' : 'leave';
    else if (sch.holiday) row.status = 'holiday';
    else if (sch.rest) row.status = 'rest';
    else if (!sh) row.status = 'unscheduled';
    else if (date > today) row.status = 'upcoming';
    else {
      const w = shiftWindow(sh, date);
      if (nowM < w.s + (sh.grace_min || 0)) row.status = 'pending';
      else if (nowM < w.e) row.status = 'not_in';
      else row.status = 'absent';
    }
  }
  return row;
}

function employeesFor(filter = {}) {
  let list = all('SELECT * FROM employees ORDER BY name');
  if (filter.dept) list = list.filter(e => String(e.dept_id) === String(filter.dept));
  if (filter.emp) list = list.filter(e => String(e.id) === String(filter.emp));
  if (filter.q) { const q = String(filter.q).trim().toLowerCase(); list = list.filter(e => (e.name || '').toLowerCase().includes(q) || (e.code || '').toLowerCase().includes(q) || (e.job || '').toLowerCase().includes(q)); }
  return list;
}

function matchStatus(row, status) {
  if (!status || status === 'all') return true;
  if (status === 'attended') return row.status === 'present' || row.status === 'late';
  if (status === 'leaves') return ['leave', 'mission'].includes(row.status) || row.perms.length > 0;
  if (status === 'absent') return row.status === 'absent' || row.status === 'not_in';
  if (status === 'off') return row.status === 'rest' || row.status === 'holiday';
  if (status === 'no_out') return row.flags.includes('no_out');
  if (status === 'out_range') return row.flags.includes('out_range') || row.flags.includes('out_range_out');
  return row.status === status;
}

function rangeRows(from, to, filter = {}) {
  if (!isDate(from) || !isDate(to)) fail(400, 'تاريخ غير صحيح');
  if (to < from) [from, to] = [to, from];
  if (daysBetween(from, to) > 400) fail(400, 'أقصى مدة للتقرير 400 يوم');
  const now = nowLocal();
  const ctx = loadCtx(from, to);
  const emps = employeesFor(filter);
  const rows = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    for (const e of emps) {
      const hasAtt = ctx.att.has(e.id + '|' + d);
      if (!hasAtt) {
        if (!e.active) continue;
        if (e.hired_at && d < e.hired_at) continue;
        if (e.created_at && d < e.created_at.slice(0, 10) && !e.hired_at) continue;
      }
      const r = computeDay(e, d, ctx, now);
      if (r.status === 'upcoming') continue;
      if (matchStatus(r, filter.status)) rows.push(r);
    }
  }
  return rows;
}

function countRows(rows) {
  const c = { total: 0, present: 0, late: 0, absent: 0, not_in: 0, pending: 0, leave: 0, mission: 0, rest: 0, holiday: 0, unscheduled: 0, perms: 0, no_out: 0, out_range: 0, working: 0, worked: 0, late_min: 0 };
  for (const r of rows) {
    c.total++; c[r.status] = (c[r.status] || 0) + 1;
    if (r.perms.length) c.perms++;
    if (r.flags.includes('no_out')) c.no_out++;
    if (r.flags.includes('working')) c.working++;
    if (r.flags.includes('out_range') || r.flags.includes('out_range_out')) c.out_range++;
    c.worked += r.worked || 0; c.late_min += r.status === 'late' ? r.late : 0;
  }
  c.attended = c.present + c.late;
  c.expected = c.present + c.late + c.absent + c.not_in + c.pending;
  c.rate = c.expected ? Math.round((c.attended / c.expected) * 100) : 0;
  return c;
}

function summarize(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.emp_id)) m.set(r.emp_id, { emp_id: r.emp_id, code: r.code, name: r.name, job: r.job, dept: r.dept, dept_id: r.dept_id, scheduled: 0, attended: 0, late_days: 0, late_min: 0, early_days: 0, early_min: 0, absent: 0, leave: 0, mission: 0, rest: 0, holiday: 0, perms: 0, worked: 0, overtime: 0, no_out: 0, out_range: 0, extra_days: 0 });
    const s = m.get(r.emp_id);
    if (['present', 'late', 'absent'].includes(r.status) && !r.flags.includes('extra_day')) s.scheduled++;
    if (r.status === 'present' || r.status === 'late') s.attended++;
    if (r.status === 'late') { s.late_days++; s.late_min += r.late; }
    if (r.early > 0 && r.flags.includes('early')) { s.early_days++; s.early_min += r.early; }
    if (r.status === 'absent') s.absent++;
    if (r.status === 'leave') s.leave++;
    if (r.status === 'mission') s.mission++;
    if (r.status === 'rest') s.rest++;
    if (r.status === 'holiday') s.holiday++;
    if (r.perms.length) s.perms++;
    if (r.flags.includes('no_out')) s.no_out++;
    if (r.flags.includes('extra_day')) s.extra_days++;
    if (r.flags.includes('out_range') || r.flags.includes('out_range_out')) s.out_range++;
    s.worked += r.flags.includes('working') ? 0 : (r.worked || 0);
    s.overtime += r.overtime || 0;
  }
  const list = [...m.values()];
  for (const s of list) {
    const base = s.scheduled - 0;
    s.rate = base > 0 ? Math.round(((s.attended - s.extra_days) / base) * 100) : null;
    if (s.rate !== null) s.rate = Math.max(0, Math.min(100, s.rate));
    s.punctuality = s.attended > 0 ? Math.round(((s.attended - s.late_days) / s.attended) * 100) : null;
  }
  list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));
  return list;
}

/* ------------------------------------------------------------ Geocode --- */
const geoCache = new Map();
async function reverseGeocode(lat, lng) {
  if (SETTINGS.geocode !== '1' || lat === null || lng === null) return null;
  const key = lat.toFixed(4) + ',' + lng.toFixed(4);
  if (geoCache.has(key)) return geoCache.get(key);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=16&accept-language=ar`, {
      headers: { 'User-Agent': 'EmdadX-Attendance/' + VERSION }, signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j = await r.json(); const a = j.address || {};
    const parts = [a.road || a.neighbourhood || a.quarter, a.suburb || a.city_district || a.town || a.village, a.city || a.county || a.state, a.country]
      .filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 3);
    const addr = parts.join(' - ') || null;
    if (addr) { geoCache.set(key, addr); if (geoCache.size > 3000) geoCache.clear(); }
    return addr;
  } catch { return null; }
}

/* ----------------------------------------------------------------- SSE --- */
const sseClients = new Set();
let dataVersion = 0;
function sseSend(filter, payload) {
  const msg = `event: change\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of sseClients) { if (!filter(c)) continue; try { c.res.write(msg); } catch { sseClients.delete(c); } }
}
// admins / HR dashboards
function broadcast(type, data = {}) { dataVersion++; sseSend(c => c.kind === 'user', { type, v: dataVersion, ...data }); }
// one employee's phone(s)
function notifyEmp(empId, type, data = {}) { sseSend(c => c.kind === 'emp' && c.id === Number(empId), { type, ...data }); }
function notifyAllEmps(type, data = {}) { sseSend(c => c.kind === 'emp', { type, ...data }); }
setInterval(() => {
  for (const c of sseClients) { try { c.res.write(`event: ping\ndata: {"v":${dataVersion}}\n\n`); } catch { sseClients.delete(c); } }
}, 20000).unref();

/* ---------------------------------------------------------------- Auth --- */
const loginAttempts = new Map();
function rateLimit(key) {
  const now = Date.now(); const r = loginAttempts.get(key) || { n: 0, t: now };
  if (now - r.t > 10 * 60000) { r.n = 0; r.t = now; }
  r.n++; loginAttempts.set(key, r);
  if (r.n > 15) fail(429, 'محاولات كثيرة.. استنى 10 دقايق وجرب تاني');
}
function newSession(kind, id) {
  const token = crypto.randomBytes(24).toString('hex'); const t = nowLocal().ts;
  run('INSERT INTO sessions (token, kind, ref_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?)', token, kind, id, t, t);
  return token;
}
function getAuth(req, url) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (url.searchParams.get('token') || '');
  if (!token) return null;
  const s = one('SELECT * FROM sessions WHERE token = ?', token);
  if (!s) return null;
  if (s.kind === 'user') {
    const u = one('SELECT id, username, name, role, active, weak_pass FROM users WHERE id = ?', s.ref_id);
    if (!u || !u.active) return null;
    return { kind: 'user', token, user: u, who: u.name || u.username };
  }
  const e = one('SELECT * FROM employees WHERE id = ?', s.ref_id);
  if (!e || !e.active) return null;
  return { kind: 'emp', token, emp: e, who: e.name };
}
function publicEmp(e) {
  if (!e) return null;
  const { pin, device_id, salary, ...rest } = e;
  return { ...rest, has_pin: !!pin, has_device: !!device_id };
}

/* -------------------------------------------------------------- Seed ---- */
function seed() {
  if (!one('SELECT id FROM users LIMIT 1')) {
    run("INSERT INTO users (username, name, pass, role, created_at) VALUES ('admin', 'مدير النظام', ?, 'admin', ?)", hashSecret('admin'), nowLocal().ts);
  }
  if (one('SELECT id FROM shifts LIMIT 1')) return;
  const t = nowLocal().ts;
  const shiftIds = [
    ['الوردية الصباحية', 'morning', '09:00', '17:00', 15],
    ['الوردية المسائية', 'evening', '15:00', '23:00', 15],
    ['الوردية الليلية', 'night', '23:00', '07:00', 15],
  ].map(s => Number(run('INSERT INTO shifts (name, kind, start_time, end_time, grace_min, created_at) VALUES (?, ?, ?, ?, ?, ?)', ...s, t).lastInsertRowid));
  const deptIds = [
    ['الإدارة', '#1d4fb0'], ['المبيعات', '#f39324'], ['الحسابات', '#7a5af5'], ['المخازن والتوزيع', '#1fa45a'], ['خدمة العملاء', '#13a39a'], ['الصيانة الفنية', '#e2414b'],
  ].map(d => Number(run('INSERT INTO departments (name, color, created_at) VALUES (?, ?, ?)', d[0], d[1], t).lastInsertRowid));
  const siteId = Number(run("INSERT INTO sites (name, lat, lng, radius, address, created_at) VALUES ('المقر الرئيسي', 30.0444, 31.2357, 300, 'وسط البلد - القاهرة', ?)", t).lastInsertRowid);
  if (process.env.SEED_DEMO === '0') return;

  // demo employees
  const people = [
    ['أحمد محمود', 'مدير عام', 0, 0], ['منى السيد', 'محاسبة', 2, 0], ['محمد عبد الله', 'مندوب مبيعات', 1, 0],
    ['سارة إبراهيم', 'خدمة عملاء', 4, 1], ['كريم مصطفى', 'مهندس صيانة', 5, 0], ['ياسمين علي', 'مسؤولة موارد بشرية', 0, 0],
    ['عمر حسن', 'فني صيانة', 5, 1], ['نورهان خالد', 'مندوبة مبيعات', 1, 0], ['مصطفى جمال', 'فرد أمن', 3, 2], ['هبة عادل', 'محاسبة', 2, 0],
  ];
  const restDays = ['5,6', '5', '6', '5', '0', '5,6', '6', '1', '2', '5'];
  const pinHash = hashSecret('1234');
  const today = nowLocal().date;
  const start = addDays(today, -21);
  const empIds = people.map((p, i) => Number(run(
    'INSERT INTO employees (code, name, phone, job, dept_id, shift_id, site_id, rest_days, pin, active, hired_at, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?)',
    'E' + String(101 + i), p[0], '010' + String(10000000 + i * 1234567).slice(0, 8), p[1], deptIds[p[2]], shiftIds[p[3]], siteId, restDays[i], pinHash, start, t,
  ).lastInsertRowid));

  // deterministic pseudo random
  let s = 42; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const addrs = ['وسط البلد - القاهرة', 'شارع طلعت حرب - وسط البلد - القاهرة', 'ميدان التحرير - القاهرة', 'عابدين - القاهرة'];
  const now = nowLocal(); const nowM = tsMin(now.ts);
  const ctx = loadCtx(start, today);
  const onLeave = new Set([empIds[3] + '|' + addDays(today, -9), empIds[3] + '|' + addDays(today, -8), empIds[7] + '|' + addDays(today, -3)]);
  const ins = stmt('INSERT INTO attendance (emp_id, date, in_at, out_at, in_lat, in_lng, in_acc, in_addr, in_dist, out_lat, out_lng, out_acc, out_addr, out_dist, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  tx(() => {
    for (let d = start; d <= today; d = addDays(d, 1)) {
      empIds.forEach((id, i) => {
        const emp = { id, rest_days: restDays[i], shift_id: shiftIds[people[i][3]] };
        const sch = scheduleFor(emp, d, ctx);
        if (!sch.shift || sch.rest || onLeave.has(id + '|' + d)) return;
        const r = rnd();
        if (r < 0.07 && d !== today) return; // absent
        const w = shiftWindow(sch.shift, d);
        const lateish = r > 0.84;
        const inM = w.s + (lateish ? 16 + Math.floor(rnd() * 45) : -12 + Math.floor(rnd() * 22));
        if (inM > nowM) return;
        let outM = w.e + Math.floor(rnd() * 50) - (rnd() < 0.08 ? 40 : 5);
        if (outM > nowM) outM = null;
        if (d === today && outM && outM > nowM) outM = null;
        const far = rnd() < 0.05;
        const lat = 30.0444 + (rnd() - 0.5) * (far ? 0.02 : 0.002), lng = 31.2357 + (rnd() - 0.5) * (far ? 0.02 : 0.002);
        const dist = Math.round(haversine(lat, lng, 30.0444, 31.2357));
        const addr = addrs[Math.floor(rnd() * addrs.length)];
        ins.run(id, d, minToTs(inM), outM ? minToTs(outM) : null, lat, lng, 12, addr, dist,
          outM ? lat + 0.0002 : null, outM ? lng - 0.0002 : null, outM ? 15 : null, outM ? addr : null, outM ? dist + 20 : null, 'mobile', minToTs(inM));
      });
    }
  });
  // demo leaves
  const L = 'INSERT INTO leaves (emp_id, type, from_date, to_date, from_time, to_time, reason, status, requested_by, decided_by, decided_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)';
  run(L, empIds[3], 'annual', addDays(today, -9), addDays(today, -8), null, null, 'ظروف عائلية', 'approved', 'سارة إبراهيم', 'مدير النظام', t, t);
  run(L, empIds[6], 'casual', addDays(today, 2), addDays(today, 2), null, null, 'مشوار حكومي', 'pending', 'عمر حسن', null, null, t);
  run(L, empIds[2], 'late_perm', addDays(today, 1), addDays(today, 1), '09:00', '11:00', 'زيارة عميل الصبح قبل الشركة', 'pending', 'محمد عبد الله', null, null, t);
  run(L, empIds[7], 'mission', addDays(today, -3), addDays(today, -3), null, null, 'مأمورية عند عميل في الجيزة', 'approved', 'نورهان خالد', 'مدير النظام', t, t);
  seedVisits([empIds[4], empIds[6]], today, rnd, t);
  seedLive(empIds, [empIds[4], empIds[6]], today, rnd);
  seedChat(empIds, t);
  seedV12(empIds, [empIds[4], empIds[6]], today, rnd, t);
  seedV13([empIds[4], empIds[6]], today, t);
}
function seedV13(techs, today, t) {
  const cs = all('SELECT id, name FROM centers ORDER BY id LIMIT 6'); if (!cs.length) return;
  const nm = id => (one('SELECT name FROM employees WHERE id = ?', id) || {}).name;
  const K = 'INSERT INTO kb (code, model, problem, solution, emp_id, author, center_id, center_name, votes, demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)';
  const cases = [
    ['E-104', 'Fuji DryPix 6000', 'خطوط بيضاء طولية على الفيلم', 'رأس الطباعة الحرارية عليه أتربة. نظفته بقطعة قطن وكحول أيزوبروبيل في اتجاه واحد، وسيبته 5 دقايق ينشف، وعملت Test Print — الخطوط اختفت.', 0, 0, 6],
    ['E-104', 'Fuji DryPix 6000', 'خطوط بيضاء على الفيلم بعد التنظيف', 'لو التنظيف منفعش: رول الضغط (Platen Roller) مخدوش. غيرته وعملت معايرة كثافة من قائمة الصيانة.', 1, 1, 3],
    ['J-21', 'Agfa Drystar 5302', 'الفيلم بيتزنق جوه الطابعة (Paper Jam)', 'الدرج مش راكب على آخره والأفلام فيها رطوبة. طلعت الأفلام وقلبت الرزمة ونضفت رولات السحب، ونبهت المركز يقفل علبة الأفلام كويس.', 0, 2, 5],
    ['', 'Carestream DryView 5950', 'الصورة باهتة والكثافة ضعيفة', 'عملت Densitometer Calibration من قائمة الخدمة واتظبطت قيمة Dmax — اتأكدت إن نوع الفيلم في الإعدادات مطابق للعلبة.', 1, 3, 4],
    ['N-03', 'Konica Drypro 873', 'الطابعة مش ظاهرة على الشبكة من جهاز الأشعة', 'الـ IP اتغير بعد ما الراوتر فصل. ثبّت IP للطابعة وراجعت AE Title والبورت 104 على المودالتي وعملت DICOM Echo — اشتغلت.', 0, 4, 7],
    ['E-104', 'Fuji DryPix 6000', 'خطوط على الفيلم', 'تنظيف رأس الطباعة بالكحول حل المشكلة — المركز بيشتغل في مكان فيه تراب، نصحتهم بغطا للطابعة.', 1, 5, 2],
    ['T-12', 'Fuji DryPix 6000', 'الطابعة بتفصل وتدي إنذار حرارة', 'مروحة التبريد واقفة. غيرتها من العهدة ونضفت فتحات التهوية — درجة الحرارة رجعت طبيعي.', 0, 1, 4],
  ];
  tx(() => {
    cases.forEach((c, i) => { const e = techs[c[4] % techs.length], cen = cs[c[5] % cs.length], ts = addDays(today, -(3 + i * 5)) + ' 13:' + String(10 + i).padStart(2, '0') + ':00';
      run(K, c[0] || null, c[1], c[2], c[3], e, nm(e), cen.id, cen.name, c[6], ts, ts); });
    run("INSERT INTO rewards (emp_id, kind, title, message, stars, amount, style, by_name, created_at, demo) VALUES (?, 'stars', ?, ?, 5, 0, 'trophy', 'مدير النظام', ?, 1)", techs[0], 'نجم الأسبوع 🏆', 'شكرًا على مجهودك الأسبوع ده — المراكز كلها بتشكر في شغلك، وأسرع وقت استجابة في الفريق. كمّل كده يا بطل!', t);
    const c0 = cs[1 % cs.length];
    run("INSERT INTO tasks (center_id, center_name, title, details, priority, emp_id, status, created_by, source, reporter_name, reporter_phone, track_token, created_at, updated_at) VALUES (?,?,?,?,?,NULL,'new',?,'center',?,?,?,?,?)",
      c0.id, c0.name, 'الطابعة مش بتسحب الفيلم', 'الطابعة مش بتسحب الفيلم وبتطلع صوت تكتكة، والشغل واقف', 'urgent', 'أ. ياسمين (المركز)', 'أ. ياسمين', '01012345678', crypto.randomBytes(12).toString('base64url'), t, t);
    const P = "INSERT INTO plans (emp_id, center_id, center_name, date, time, note, remind_min, status, created_by, demo, created_at, updated_at) VALUES (?,?,?,?,?,?,30,'planned',?,1,?,?)";
    [[0, 0, 0, '10:00', 'متابعة الطابعة بعد تغيير الرول'], [0, 2, 1, '12:30', 'صيانة دورية'], [1, 3, 0, '11:00', 'توريد أفلام وفحص'], [1, 1, 2, '09:30', ''], [0, 4, 3, '13:00', 'معايرة كثافة']].forEach(x => {
      const e = techs[x[0]], cen = cs[x[1] % cs.length]; run(P, e, cen.id, cen.name, addDays(today, x[2]), x[3], x[4] || null, nm(e), t, t);
    });
  });
}
function seedV12(empIds, techs, today, rnd, t) {
  const salaries = { 'مدير عام': 18000, 'محاسبة': 9000, 'مندوب مبيعات': 8000, 'مندوبة مبيعات': 8000, 'خدمة عملاء': 7000, 'مهندس صيانة': 12500, 'مسؤولة موارد بشرية': 9500, 'فني صيانة': 9000, 'فرد أمن': 6000 };
  tx(() => {
    for (const e of all('SELECT id, job FROM employees WHERE demo = 1')) run('UPDATE employees SET salary = ? WHERE id = ?', salaries[e.job] || 7500, e.id);
    // devices at each demo center
    const printers = [['Fujifilm', 'DryPix 6000'], ['Fujifilm', 'DryPix Smart'], ['Agfa', 'Drystar 5302'], ['Carestream', 'DryView 5950'], ['Konica', 'Drypro 873'], ['Agfa', 'Drystar 5503']];
    const kinds = [['طابعة أفلام — المقطعية', 3], ['طابعة أفلام — الرنين', 3], ['طابعة أفلام — الأشعة العادية', 3], ['طابعة أفلام — الماموجرام', 4], ['طابعة أفلام — الاستقبال', 6]];
    for (const c of all('SELECT * FROM centers WHERE demo = 1')) {
      const n = 2 + Math.floor(rnd() * 2);
      for (let i = 0; i < n; i++) {
        const k = kinds[Math.floor(rnd() * kinds.length)];
        const last = addDays(today, -Math.floor(rnd() * (k[1] * 30 + 25)));
        run('INSERT INTO devices (center_id, name, brand, model, serial, installed_at, pm_months, last_pm, next_pm, active, demo, created_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?)',
          c.id, k[0], ...printers[Math.floor(rnd() * printers.length)], 'SN' + (100000 + Math.floor(rnd() * 899999)), addDays(today, -(400 + Math.floor(rnd() * 900))), k[1], last, addMonths(last, k[1]), t);
      }
    }
    // link demo visits to devices + rating links / ratings
    const devs = all('SELECT * FROM devices WHERE demo = 1');
    const notes = ['شغل ممتاز وسريع', 'الفني محترم ومتعاون', 'تمام، شكرًا', 'كان ممكن يوصل بدري شوية', ''];
    for (const v of all('SELECT * FROM visits WHERE rate_token IS NULL')) {
      const cd = devs.filter(d => d.center_id === v.center_id); const d = cd.length ? cd[Math.floor(rnd() * cd.length)] : null;
      const rated = v.date < today && rnd() < 0.6; const r = rnd() < 0.75 ? 5 : rnd() < 0.7 ? 4 : 3;
      run('UPDATE visits SET rate_token = ?, device_id = ?, device = COALESCE(?, device), rating = ?, rating_note = ?, rated_at = ? WHERE id = ?',
        crypto.randomBytes(12).toString('base64url'), d ? d.id : null, d ? d.name + ' — S/N ' + d.serial : null, rated ? r : null, rated ? notes[Math.floor(rnd() * notes.length)] || null : null, rated ? v.at : null, v.id);
    }
    // spare parts + technician custody
    const P = [['رول طابعة أفلام 14×17', 'رول', 950], ['فلتر تبريد', 'قطعة', 420], ['كارت باور', 'قطعة', 3800], ['رولات تنظيف', 'علبة', 180], ['مروحة تبريد', 'قطعة', 650], ['كابل داتا طبي', 'قطعة', 300]]
      .map(x => Number(run('INSERT INTO parts (name, unit, price, active, created_at) VALUES (?, ?, ?, 1, ?)', x[0], x[1], x[2], t).lastInsertRowid));
    for (const emp of techs) {
      P.forEach((pid, i) => run("INSERT INTO part_moves (part_id, emp_id, qty, kind, note, by_name, at) VALUES (?, ?, ?, 'issue', 'عهدة أول الشهر', 'مدير النظام', ?)", pid, emp, [6, 4, 1, 5, 2, 6][i], addDays(today, -12) + ' 09:00:00'));
      const vs = all('SELECT id, center_name, at FROM visits WHERE emp_id = ? ORDER BY at', emp);
      vs.filter((_, i) => i % 3 === 0).forEach((v, i) => {
        const pid = P[i % P.length], part = one('SELECT * FROM parts WHERE id = ?', pid);
        run("INSERT INTO part_moves (part_id, emp_id, qty, kind, visit_id, note, by_name, at) VALUES (?, ?, -1, 'use', ?, ?, 'demo', ?)", pid, emp, v.id, v.center_name, v.at);
        run('UPDATE visits SET parts_used = ? WHERE id = ?', JSON.stringify([{ id: pid, name: part.name, unit: part.unit, qty: 1 }]), v.id);
      });
    }
    // tasks: a few done (linked to visits) + open ones
    const nowM = tsMin(nowLocal().ts);
    for (const emp of techs) {
      for (const v of all('SELECT * FROM visits WHERE emp_id = ? AND date < ? ORDER BY at DESC LIMIT 3', emp, today)) {
        const vm = tsMin(v.at);
        const id = Number(run(`INSERT INTO tasks (center_id, center_name, device_id, title, details, priority, emp_id, due_at, status, accepted_at, onway_at, arrived_at, done_at, visit_id, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?, 'done', ?,?,?,?,?, 'مدير النظام', ?, ?)`, v.center_id, v.center_name, v.device_id, v.work_type + ' — ' + v.center_name, 'بلاغ من المركز', rnd() < 0.3 ? 'urgent' : 'normal', emp,
          minToTs(vm + 30), minToTs(vm - 150), minToTs(vm - 110), minToTs(vm - 70), minToTs(vm), v.id, minToTs(vm - 170), minToTs(vm)).lastInsertRowid);
        run('UPDATE visits SET task_id = ? WHERE id = ?', id, v.id);
      }
    }
    const cs = all('SELECT * FROM centers WHERE demo = 1 AND lat < 30.5');
    const T = (emp, c, title, det, prio, dueM, st) => {
      const d = devs.find(x => x.center_id === c.id);
      run(`INSERT INTO tasks (center_id, center_name, device_id, title, details, priority, emp_id, due_at, status, accepted_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'مدير النظام', ?, ?)`,
        c.id, c.name, d ? d.id : null, title, det, prio, emp, minToTs(nowM + dueM), st, st === 'new' ? null : minToTs(nowM - 40), minToTs(nowM - 60), minToTs(nowM - 60));
    };
    if (cs.length >= 3) {
      T(techs[0], cs[0], 'عطل في طابعة الأفلام', 'المركز بيقول الطابعة بتطلع خطوط على الفيلم — محتاجين زيارة النهارده', 'urgent', 120, 'new');
      T(techs[1], cs[1], 'صيانة دورية للمقطعية', 'الصيانة الدورية الشهرية + تغيير الفلتر', 'normal', 24 * 60, 'accepted');
      T(techs[0], cs[2], 'تركيب كابل داتا جديد', 'المركز طالب تركيب كابل وتجربة الإرسال على السيستم', 'normal', 26 * 60, 'new');
    }
    // payroll demo: an advance + a bonus
    const m = today.slice(0, 7);
    run('INSERT INTO advances (emp_id, amount, date, months, start_month, note, by_name, created_at) VALUES (?, 3000, ?, 3, ?, ?, ?, ?)', empIds[2], addDays(today, -20), m, 'سلفة ظروف', 'مدير النظام', t);
    run("INSERT INTO payroll_adj (emp_id, month, kind, amount, note, by_name, created_at) VALUES (?, ?, 'bonus', 750, 'حافز زيارات', 'مدير النظام', ?)", techs[0], m, t);
  });
}
function seedLive(empIds, techs, today, rnd) {
  // location trail every 15 minutes for whoever is checked in (and yesterday for the field techs)
  const nowM = tsMin(nowLocal().ts);
  const ins = stmt('INSERT INTO locations (emp_id, at, lat, lng, acc, battery, kind) VALUES (?, ?, ?, ?, ?, ?, ?)');
  tx(() => {
    for (const id of empIds) {
      for (const d of techs.includes(id) ? [addDays(today, -1), today] : [today]) {
        const att = one('SELECT * FROM attendance WHERE emp_id = ? AND date = ?', id, d);
        if (!att || !att.in_at || att.in_lat === null) continue;
        if (!att.out_at && d !== today) continue;
        const inM = tsMin(att.in_at), endM = att.out_at ? tsMin(att.out_at) : nowM;
        const wp = [{ m: inM, lat: att.in_lat, lng: att.in_lng }];
        for (const v of all('SELECT at, lat, lng FROM visits WHERE emp_id = ? AND date = ? AND lat IS NOT NULL ORDER BY at', id, d)) {
          const vm = tsMin(v.at); if (vm <= inM || vm >= endM) continue;
          wp.push({ m: vm - 45, lat: v.lat, lng: v.lng }, { m: vm, lat: v.lat, lng: v.lng });
        }
        wp.push({ m: endM, lat: att.out_lat ?? (wp.length > 1 ? 30.0444 : att.in_lat), lng: att.out_lng ?? (wp.length > 1 ? 31.2357 : att.in_lng) });
        let bat = 92 - Math.floor(rnd() * 15);
        ins.run(id, att.in_at, att.in_lat, att.in_lng, 12, bat, 'in');
        for (let m = inM + 15; m < endM; m += 15) {
          let k = 0; while (k < wp.length - 2 && wp[k + 1].m <= m) k++;
          const A = wp[k], B = wp[k + 1] || A, f = B.m > A.m ? Math.min(1, Math.max(0, (m - A.m) / (B.m - A.m))) : 0;
          const lat = A.lat + (B.lat - A.lat) * f + (rnd() - 0.5) * 0.0006, lng = A.lng + (B.lng - A.lng) * f + (rnd() - 0.5) * 0.0006;
          bat = Math.max(8, bat - (rnd() < 0.5 ? 1 : 2));
          ins.run(id, minToTs(m + Math.floor(rnd() * 2)), lat, lng, 8 + Math.floor(rnd() * 30), bat, 'ping');
        }
        if (att.out_at) ins.run(id, att.out_at, att.out_lat ?? att.in_lat, att.out_lng ?? att.in_lng, 12, bat, 'out');
      }
    }
  });
}
function seedChat(empIds, t) {
  const now = nowLocal(); const nowM = tsMin(now.ts);
  const ins = stmt("INSERT INTO messages (emp_id, sender, user_id, user_name, body, broadcast, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const at = minAgo => minToTs(nowM - minAgo);
  tx(() => {
    for (const id of empIds) ins.run(id, 'admin', 1, 'مدير النظام', 'تعميم: اجتماع الفريق يوم الخميس الساعة 10 الصبح في المقر الرئيسي. الحضور إلزامي 🙏', 1, at(26 * 60), at(25 * 60));
    ins.run(empIds[4], 'emp', null, null, 'خلصت صيانة الجهاز في مركز ألفا سكان وسلمت لمسؤول الأجهزة، والجهاز شغال تمام', 0, at(180), at(170));
    ins.run(empIds[4], 'admin', 1, 'مدير النظام', 'تمام يا كريم، شكرًا 👍 متنساش تصوّر الكارت القديم قبل ما ترجعه', 0, at(165), at(160));
    ins.run(empIds[4], 'emp', null, null, 'حاضر. محتاج رول طابعة جديد لمركز الشفاء بكرة الصبح', 0, at(22), null);
    ins.run(empIds[1], 'emp', null, null, 'صباح الخير يا فندم، ممكن أخرج ساعة بدري النهارده؟ عندي مشوار ضروري', 0, at(95), null);
    ins.run(empIds[6], 'admin', 1, 'مدير النظام', 'يا عمر عدّي على مركز رؤية الهرم قبل الساعة 6، عندهم عطل في الطابعة', 0, at(60), at(52));
    ins.run(empIds[6], 'emp', null, null, 'تمام يا فندم أنا في الطريق', 0, at(50), at(48));
  });
}
function seedVisits(techs, today, rnd, t) {
  // demo photos (svg placeholders)
  const dd = path.join(UPLOAD_DIR, 'demo'); fs.mkdirSync(dd, { recursive: true });
  const cols = [['#1d4fb0', '#0a2357'], ['#0d9488', '#0b5f58'], ['#6c4ee6', '#3b2a8a'], ['#e67e0d', '#8a4a07']];
  cols.forEach((c, i) => fs.writeFileSync(path.join(dd, `demo-${i + 1}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient></defs><rect width="800" height="600" fill="url(#g)"/><rect x="220" y="150" width="360" height="230" rx="26" fill="#fff" opacity=".9"/><rect x="250" y="180" width="300" height="140" rx="12" fill="${c[1]}" opacity=".8"/><circle cx="400" cy="250" r="44" fill="none" stroke="#f7c12d" stroke-width="10"/><rect x="330" y="380" width="140" height="70" fill="#fff" opacity=".85"/><rect x="260" y="450" width="280" height="22" rx="11" fill="#fff" opacity=".85"/><rect x="0" y="520" width="800" height="80" fill="#000" opacity=".45"/><text x="770" y="570" font-family="Arial" font-size="30" fill="#fff" text-anchor="end">صورة تجريبية</text></svg>`));
  const centers = [
    ['مركز النور للأشعة', 'مدينة نصر - القاهرة', 'د. هشام فؤاد', 30.0566, 31.3301], ['مركز الشفاء للأشعة', 'المعادي - القاهرة', 'أ. منال سعيد', 29.9602, 31.2569],
    ['مركز ألفا سكان', 'الدقي - الجيزة', 'د. رامي عادل', 30.0388, 31.2120], ['مركز الحياة للأشعة', 'شبرا الخيمة - القليوبية', 'أ. محمود صبري', 30.1286, 31.2422],
    ['مركز الدلتا للأشعة', 'طنطا - الغربية', 'د. إيمان الشافعي', 30.7865, 31.0004], ['مركز رؤية للأشعة', 'الهرم - الجيزة', 'أ. خالد رجب', 29.9937, 31.1636],
  ].map(c => Number(run('INSERT INTO centers (name, area, contact, phone, lat, lng, radius, demo, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 300, 1, ?, ?)', c[0], c[1], c[2], '01' + Math.floor(100000000 + rnd() * 899999999), c[3], c[4], 'مدير النظام', t).lastInsertRowid));
  const cinfo = all('SELECT * FROM centers WHERE demo = 1');
  const types = ['صيانة دورية', 'إصلاح عطل', 'معايرة وفحص', 'تركيب وتشغيل جهاز', 'توريد خامات'];
  const devices = ['جهاز مقطعية CT', 'جهاز رنين MRI', 'طابعة أفلام', 'جهاز أشعة X-Ray', 'جهاز ماموجرام', 'نظام CR'];
  const works = ['تغيير فلتر التبريد وتنظيف الجهاز وعمل اختبار تشغيل كامل', 'إصلاح عطل في كارت الباور وتجربة الجهاز على 3 حالات', 'معايرة الجهاز وضبط الجودة وكتابة تقرير', 'تغيير رول الطابعة وضبط الكثافة', 'فحص دوري للكابلات والتوصيلات وتحديث السوفتوير', 'توريد أفلام وأحبار وتسليمها للمخزن'];
  const recv = [['أ. سامح', 'مدير المركز'], ['م. وليد', 'مسؤول الأجهزة'], ['أ. دعاء', 'فني أشعة'], ['د. أحمد', 'الطبيب المسؤول'], ['أ. نهى', 'الاستقبال']];
  const results = ['done', 'done', 'done', 'done', 'partial', 'followup'];
  const ins = stmt('INSERT INTO visits (emp_id, date, at, center_id, center_name, work_type, device, details, result, receiver_name, receiver_role, receiver_phone, arrived_at, lat, lng, acc, dist, addr, photo, photo_size, reviewed, reviewed_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const nowM = tsMin(nowLocal().ts);
  tx(() => {
    const near = cinfo.filter(c => c.lat < 30.5), far0 = cinfo.filter(c => c.lat >= 30.5);
    for (let d = addDays(today, -12); d <= today; d = addDays(d, 1)) {
      for (const emp of techs) {
        const att = one('SELECT in_at, out_at FROM attendance WHERE emp_id = ? AND date = ?', emp, d);
        if (!att || !att.in_at) continue;               // visits only on days the tech actually worked
        const startM = tsMin(att.in_at) + 50, endM = att.out_at ? tsMin(att.out_at) - 25 : nowM;
        const n = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) {
          const pool = far0.length && rnd() < 0.1 ? far0 : near;
          const c = pool[Math.floor(rnd() * pool.length)];
          const at = startM + k * 140 + Math.floor(rnd() * 60);
          if (at > endM || at > nowM) continue;
          const far = rnd() < 0.08;
          const lat = c.lat + (rnd() - 0.5) * (far ? 0.03 : 0.0015), lng = c.lng + (rnd() - 0.5) * (far ? 0.03 : 0.0015);
          const r = recv[Math.floor(rnd() * recv.length)];
          ins.run(emp, d, minToTs(at), c.id, c.name, types[Math.floor(rnd() * types.length)], devices[Math.floor(rnd() * devices.length)], works[Math.floor(rnd() * works.length)],
            results[Math.floor(rnd() * results.length)], r[0], r[1], null, minToTs(at - 70).slice(11, 16), lat, lng, 15, Math.round(haversine(lat, lng, c.lat, c.lng)), c.area,
            `demo/demo-${1 + Math.floor(rnd() * 4)}.svg`, 52000, d < addDays(today, -2) ? 1 : 0, d < addDays(today, -2) ? 'مدير النظام' : null, minToTs(at));
        }
      }
    }
  });
}
seed();

/* ------------------------------------------------------------ Routes ---- */
const routes = new Map();
function route(method, p, auth, fn) { routes.set(method + ' ' + p, { auth, fn }); }
const needAdmin = a => { if (a.user.role !== 'admin') fail(403, 'الصلاحية دي للمدير بس'); };

route('GET', '/api/ping', null, () => ({ ok: true, version: VERSION, time: nowLocal() }));
route('GET', '/api/public-info', null, () => ({ company_name: SETTINGS.company_name, company_sub: SETTINGS.company_sub, version: VERSION, logo: logoVer(), demo: !!one('SELECT id FROM employees WHERE demo = 1 LIMIT 1') }));

route('POST', '/api/login', null, (b, a, ctx) => {
  rateLimit(ctx.ip + '|' + (b.mode || ''));
  if (b.mode === 'employee') {
    const code = str(b.code, 40); const pin = String(b.pin || '');
    const e = code ? one('SELECT * FROM employees WHERE code = ? COLLATE NOCASE', code) : null;
    if (!e || !checkSecret(pin, e.pin)) fail(401, 'كود الموظف أو الرقم السري غلط');
    if (!e.active) fail(403, 'حسابك موقوف.. كلم الإدارة');
    if (SETTINGS.bind_device === '1') {
      const dev = str(b.device, 80);
      if (e.device_id && dev !== e.device_id) fail(403, 'الحساب ده مربوط بموبايل تاني.. اطلب من الإدارة فك الربط');
      if (!e.device_id && dev) run('UPDATE employees SET device_id = ? WHERE id = ?', dev, e.id);
    }
    return { token: newSession('emp', e.id), kind: 'emp', emp: publicEmp(e) };
  }
  const u = one('SELECT * FROM users WHERE username = ? COLLATE NOCASE', str(b.username, 60) || '');
  if (!u || !checkSecret(String(b.password || ''), u.pass)) fail(401, 'اسم المستخدم أو كلمة المرور غلط');
  if (!u.active) fail(403, 'الحساب موقوف');
  run('UPDATE users SET weak_pass = ? WHERE id = ?', isWeakPass(b.password, u.username) ? 1 : 0, u.id);
  audit(u.name || u.username, 'login', ctx.ip);
  return { token: newSession('user', u.id), kind: 'user', user: { id: u.id, username: u.username, name: u.name, role: u.role } };
});
route('POST', '/api/logout', 'any', (b, a) => { run('DELETE FROM sessions WHERE token = ?', a.token); return { ok: true }; });
route('GET', '/api/time', 'any', () => nowLocal());
route('GET', '/api/me', 'any', a => a.kind === 'user' ? { kind: 'user', user: a.user } : { kind: 'emp', emp: publicEmp(a.emp) });
route('POST', '/api/me/password', 'user', (b, a) => {
  const u = one('SELECT * FROM users WHERE id = ?', a.user.id);
  if (!checkSecret(String(b.old || ''), u.pass)) fail(400, 'كلمة المرور الحالية غلط');
  if (String(b.new || '').length < 4) fail(400, 'كلمة المرور لازم 4 حروف على الأقل');
  run('UPDATE users SET pass = ?, weak_pass = ? WHERE id = ?', hashSecret(b.new), isWeakPass(b.new, u.username) ? 1 : 0, u.id);
  return { ok: true, weak: isWeakPass(b.new, u.username) };
});

/* ------ employee (mobile) ------ */
function pickShiftDate(emp, now) {
  const today = now.date, tomorrow = addDays(today, 1), nowM = tsMin(now.ts);
  const ctx = loadCtx(today, tomorrow);
  const st = scheduleFor(emp, today, ctx);
  if (st.shift && !st.rest) { const w = shiftWindow(st.shift, today); if (nowM <= w.e) return today; }
  const sm = scheduleFor(emp, tomorrow, ctx);
  if (sm.shift && !sm.rest) { const w = shiftWindow(sm.shift, tomorrow); if (w.s - nowM <= 240 && w.s - nowM >= 0) return tomorrow; }
  return today;
}
function openRecord(empId, now) {
  const limit = minToTs(tsMin(now.ts) - Number(SETTINGS.open_hours || 16) * 60);
  return one('SELECT * FROM attendance WHERE emp_id = ? AND out_at IS NULL AND in_at >= ? ORDER BY in_at DESC LIMIT 1', empId, limit);
}
function myHome(emp) {
  const now = nowLocal();
  const from = addDays(now.date, -34);
  const ctx = loadCtx(from, addDays(now.date, 1));
  const open = openRecord(emp.id, now);
  const days = [];
  for (let d = now.date; d >= from; d = addDays(d, -1)) {
    if (emp.hired_at && d < emp.hired_at && !ctx.att.has(emp.id + '|' + d)) continue;
    days.push(computeDay(emp, d, ctx, now));
  }
  const shiftDate = open ? open.date : pickShiftDate(emp, now);
  const todayRow = computeDay(emp, shiftDate, loadCtx(shiftDate, shiftDate), now);
  const site = emp.site_id ? one('SELECT * FROM sites WHERE id = ?', emp.site_id) : null;
  const dept = emp.dept_id ? one('SELECT name FROM departments WHERE id = ?', emp.dept_id) : null;
  const leaves = all('SELECT * FROM leaves WHERE emp_id = ? ORDER BY id DESC LIMIT 40', emp.id);
  const month = now.date.slice(0, 7);
  const monthRows = days.filter(r => r.date.startsWith(month));
  return {
    now, emp: { ...publicEmp(emp), dept: dept ? dept.name : null }, site, today: todayRow, open: open || null,
    history: days.slice(0, 31), leaves, month: countRows(monthRows),
    settings: {
      require_location: SETTINGS.require_location, geofence_mode: SETTINGS.geofence_mode, company_name: SETTINGS.company_name, bind_device: SETTINGS.bind_device,
      punch_selfie: SETTINGS.punch_selfie, photo_quality: SETTINGS.photo_quality,
      chat: chatAllowed(emp) ? '1' : '0', track: trackAllowed(emp) ? '1' : '0', track_interval: String(trackInterval()),
    },
    visits_today: one('SELECT COUNT(*) AS n FROM visits WHERE emp_id = ? AND date = ?', emp.id, now.date).n,
    chat_unread: one("SELECT COUNT(*) AS n FROM messages WHERE emp_id = ? AND sender = 'admin' AND read_at IS NULL", emp.id).n,
    last_ping: (one('SELECT at FROM locations WHERE emp_id = ? ORDER BY id DESC LIMIT 1', emp.id) || {}).at || null,
    decided: all("SELECT id, type, status, from_date, to_date, reply, decided_at FROM leaves WHERE emp_id = ? AND status <> 'pending' AND decided_at >= ? ORDER BY decided_at DESC LIMIT 3", emp.id, addDays(now.date, -3)),
    tasks: myTasks(emp.id), custody: custodyOf(emp.id),
    rewards_new: all('SELECT id, kind, title, message, stars, amount, style, by_name, created_at FROM rewards WHERE emp_id = ? AND seen_at IS NULL ORDER BY id', emp.id),
    stars_total: one('SELECT COALESCE(SUM(stars),0) AS n FROM rewards WHERE emp_id = ?', emp.id).n,
    logo: logoVer(),
    plans_today: all(PLAN_SQL + " WHERE p.emp_id = ? AND p.date = ? ORDER BY COALESCE(p.time, '99')", emp.id, now.date).map(planOut),
    punch_mode: SETTINGS.punch_mode, signature_required: SETTINGS.signature_required,
    push_on: !!one("SELECT id FROM push_subs WHERE kind = 'emp' AND ref_id = ? LIMIT 1", emp.id),
  };
}
route('GET', '/api/my/home', 'emp', (b, a) => myHome(a.emp));
route('POST', '/api/my/punch', 'emp', (b, a) => {
  const emp = a.emp; const now = nowLocal();
  const type = b.type === 'out' ? 'out' : 'in';
  if (SETTINGS.bind_device === '1') {
    const dev = str(b.device, 80);
    if (emp.device_id && dev !== emp.device_id) fail(403, 'التسجيل مسموح من الموبايل المربوط بحسابك بس');
    if (!emp.device_id && dev) run('UPDATE employees SET device_id = ? WHERE id = ?', dev, emp.id);
  }
  const lat = num(b.lat), lng = num(b.lng), acc = num(b.acc);
  const hasLoc = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const qr = b.qr ? verifyQr(b.qr) : null;
  if (qr && !qr.ok) fail(400, qr.err);
  const viaQr = !!(qr && qr.ok);
  if (viaQr && emp.site_id && qr.site_id !== emp.site_id) fail(403, 'الكود ده بتاع موقع شغل تاني غير موقعك');
  if (SETTINGS.punch_mode === 'qr' && !viaQr) fail(400, 'التسجيل بكود الـ QR بس.. امسح الكود اللي على شاشة المقر');
  if (!viaQr && SETTINGS.require_location === '1' && !hasLoc) fail(400, 'لازم تفعّل الموقع (GPS) علشان تسجل');
  const site = viaQr ? one('SELECT * FROM sites WHERE id = ?', qr.site_id) : (emp.site_id ? one('SELECT * FROM sites WHERE id = ?', emp.site_id) : null);
  let dist = null;
  if (hasLoc && site && site.lat !== null && site.lng !== null) dist = Math.round(haversine(lat, lng, site.lat, site.lng));
  if (viaQr && (dist === null || dist > (site.radius || 250))) dist = 0;   // the rotating code proves presence at the site
  if (!viaQr && SETTINGS.geofence_mode === 'block' && site && site.lat !== null) {
    if (dist === null) fail(400, 'لازم تفعّل الموقع علشان نتأكد إنك في مكان الشغل');
    if (dist > (site.radius || 250)) fail(403, `أنت خارج نطاق "${site.name}" بمسافة ${dist} متر.. قرّب من مكان الشغل وجرب تاني`);
  }
  const selfie = b.photo ? checkPhoto(b.photo) : null;
  if (SETTINGS.punch_selfie === '1' && !selfie) fail(400, 'لازم تصوّر سيلفي علشان تسجل');
  let rec;
  if (type === 'in') {
    const open = openRecord(emp.id, now);
    if (open) fail(409, `أنت مسجل حضور بالفعل الساعة ${open.in_at.slice(11, 16)}.. سجل انصراف الأول`);
    const date = pickShiftDate(emp, now);
    const ex = one('SELECT * FROM attendance WHERE emp_id = ? AND date = ?', emp.id, date);
    if (ex) fail(409, 'تم تسجيل حضورك وانصرافك لليوم ده بالفعل');
    const ph = selfie ? savePhoto(selfie).rel : null;
    const r = run('INSERT INTO attendance (emp_id, date, in_at, in_lat, in_lng, in_acc, in_dist, in_photo, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      emp.id, date, now.ts, hasLoc ? lat : (viaQr && site ? site.lat : null), hasLoc ? lng : (viaQr && site ? site.lng : null), acc, dist, ph, viaQr ? 'qr' : 'mobile', now.ts, now.ts);
    rec = one('SELECT * FROM attendance WHERE id = ?', Number(r.lastInsertRowid));
  } else {
    const open = openRecord(emp.id, now);
    if (!open) fail(409, 'مفيش تسجيل حضور مفتوح.. سجل حضور الأول');
    const ph = selfie ? savePhoto(selfie).rel : null;
    run('UPDATE attendance SET out_at = ?, out_lat = ?, out_lng = ?, out_acc = ?, out_dist = ?, out_photo = ?, updated_at = ? WHERE id = ?',
      now.ts, hasLoc ? lat : null, hasLoc ? lng : null, acc, dist, ph, now.ts, open.id);
    rec = one('SELECT * FROM attendance WHERE id = ?', open.id);
  }
  const field = type === 'in' ? 'in_addr' : 'out_addr';
  broadcast('punch', { emp_id: emp.id, name: emp.name, punch: type, time: now.time, dist, radius: site ? site.radius : null });
  if (hasLoc) logLocation(emp, now, lat, lng, acc, num(b.battery), type);
  if (hasLoc) reverseGeocode(lat, lng).then(addr => {
    if (addr) { run(`UPDATE attendance SET ${field} = ? WHERE id = ?`, addr, rec.id); broadcast('geocode', { id: rec.id }); }
  });
  return { ok: true, type, record: rec, now, dist, site: site ? { name: site.name, radius: site.radius } : null };
});
route('GET', '/api/my/address', 'emp', (b, a, c) => {
  const id = Number(c.url.searchParams.get('id'));
  const r = one('SELECT in_addr, out_addr FROM attendance WHERE id = ? AND emp_id = ?', id, a.emp.id);
  return r || {};
});
route('POST', '/api/my/leave', 'emp', (b, a) => {
  const l = cleanLeave(b);
  const t = nowLocal().ts;
  const r = run('INSERT INTO leaves (emp_id, type, from_date, to_date, from_time, to_time, reason, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    a.emp.id, l.type, l.from_date, l.to_date, l.from_time, l.to_time, l.reason, 'pending', a.emp.name, t);
  broadcast('leave', { id: Number(r.lastInsertRowid), name: a.emp.name });
  pushAdmins({ title: `طلب جديد من ${a.emp.name}`, body: `${LEAVE_LABEL[l.type] || ''} — ${l.from_date}${l.reason ? ' • ' + l.reason.slice(0, 60) : ''}`, url: './#/leaves', tag: 'leave' });
  return { ok: true };
});
route('POST', '/api/my/leave/cancel', 'emp', (b, a) => {
  const r = run("DELETE FROM leaves WHERE id = ? AND emp_id = ? AND status = 'pending'", Number(b.id), a.emp.id);
  if (!r.changes) fail(400, 'الطلب ده مينفعش يتلغي');
  broadcast('leave', {});
  return { ok: true };
});
route('POST', '/api/my/pin', 'emp', (b, a) => {
  if (!checkSecret(String(b.old || ''), a.emp.pin)) fail(400, 'الرقم السري الحالي غلط');
  if (!/^\d{4,8}$/.test(String(b.new || ''))) fail(400, 'الرقم السري لازم يكون من 4 لـ 8 أرقام');
  run('UPDATE employees SET pin = ? WHERE id = ?', hashSecret(b.new), a.emp.id);
  return { ok: true };
});

/* ------ admin ------ */
function bootstrap(a) {
  return {
    me: a.user, now: nowLocal(), version: VERSION,
    settings: publicSettings(),
    departments: all('SELECT * FROM departments ORDER BY id'),
    shifts: all('SELECT * FROM shifts ORDER BY start_time'),
    sites: all('SELECT * FROM sites ORDER BY id'),
    employees: all('SELECT * FROM employees ORDER BY name').map(e => a.user.role === 'admin' ? { ...publicEmp(e), salary: e.salary || 0 } : publicEmp(e)),
    holidays: all('SELECT * FROM holidays ORDER BY date'),
    users: a.user.role === 'admin' ? all('SELECT id, username, name, role, active, created_at FROM users ORDER BY id') : [],
    pending_leaves: one("SELECT COUNT(*) AS n FROM leaves WHERE status = 'pending'").n,
    has_demo: !!one('SELECT id FROM employees WHERE demo = 1 LIMIT 1') || !!one('SELECT id FROM centers WHERE demo = 1 LIMIT 1'),
    centers: centersWithStats(),
    visits_unreviewed: one('SELECT COUNT(*) AS n FROM visits WHERE reviewed = 0').n,
    chat_unread: one("SELECT COUNT(*) AS n FROM messages WHERE sender = 'emp' AND read_at IS NULL").n,
    tasks_open: one("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('new','accepted','onway','arrived')").n,
    pm_due: one('SELECT COUNT(*) AS n FROM devices WHERE active = 1 AND next_pm IS NOT NULL AND next_pm <= ?', addDays(nowLocal().date, 14)).n,
    parts: all('SELECT id, name, code, unit, price, active FROM parts ORDER BY name'),
    push_on: !!one("SELECT id FROM push_subs WHERE kind = 'user' AND ref_id = ? LIMIT 1", a.user.id),
  };
}
route('GET', '/api/bootstrap', 'user', (b, a) => bootstrap(a));

function saveSimple(table, fields, b) {
  const id = Number(b.id) || 0;
  const vals = fields.map(f => b[f]);
  if (id) { run(`UPDATE ${table} SET ${fields.map(f => f + ' = ?').join(', ')} WHERE id = ?`, ...vals, id); return id; }
  return Number(run(`INSERT INTO ${table} (${fields.join(', ')}, created_at) VALUES (${fields.map(() => '?').join(', ')}, ?)`, ...vals, nowLocal().ts).lastInsertRowid);
}
route('POST', '/api/departments/save', 'user', (b) => {
  const name = str(b.name, 80); if (!name) fail(400, 'اكتب اسم القسم');
  const id = saveSimple('departments', ['name', 'color', 'manager'], { id: b.id, name, color: str(b.color, 20) || '#1d4fb0', manager: str(b.manager, 80) });
  broadcast('departments'); return { ok: true, id };
});
route('POST', '/api/departments/delete', 'user', (b) => {
  const id = Number(b.id);
  const n = one('SELECT COUNT(*) AS n FROM employees WHERE dept_id = ?', id).n;
  if (n) fail(400, `القسم فيه ${n} موظف.. انقلهم لقسم تاني الأول`);
  run('DELETE FROM departments WHERE id = ?', id); broadcast('departments'); return { ok: true };
});
route('POST', '/api/shifts/save', 'user', (b) => {
  const name = str(b.name, 80); if (!name) fail(400, 'اكتب اسم الوردية');
  if (!isTime(b.start_time) || !isTime(b.end_time)) fail(400, 'مواعيد الوردية غير صحيحة');
  if (b.start_time.slice(0, 5) === b.end_time.slice(0, 5)) fail(400, 'ميعاد البداية والنهاية مينفعش يبقوا زي بعض');
  const kind = SHIFT_KINDS.includes(b.kind) ? b.kind : 'morning';
  const id = saveSimple('shifts', ['name', 'kind', 'start_time', 'end_time', 'grace_min'], { id: b.id, name, kind, start_time: b.start_time.slice(0, 5), end_time: b.end_time.slice(0, 5), grace_min: Math.max(0, Math.min(180, Number(b.grace_min) || 0)) });
  broadcast('shifts'); return { ok: true, id };
});
route('POST', '/api/shifts/delete', 'user', (b) => {
  const id = Number(b.id);
  const n = one('SELECT COUNT(*) AS n FROM employees WHERE shift_id = ?', id).n;
  if (n) fail(400, `فيه ${n} موظف على الوردية دي.. غيّر ورديتهم الأول`);
  tx(() => { run('DELETE FROM roster WHERE shift_id = ?', id); run('DELETE FROM shifts WHERE id = ?', id); });
  broadcast('shifts'); return { ok: true };
});
route('POST', '/api/sites/save', 'user', (b) => {
  const name = str(b.name, 80); if (!name) fail(400, 'اكتب اسم الموقع');
  const lat = num(b.lat), lng = num(b.lng);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, 'إحداثيات الموقع غير صحيحة');
  const id = saveSimple('sites', ['name', 'lat', 'lng', 'radius', 'address'], { id: b.id, name, lat, lng, radius: Math.max(20, Math.min(20000, Number(b.radius) || 250)), address: str(b.address, 200) });
  broadcast('sites'); return { ok: true, id };
});
route('POST', '/api/sites/delete', 'user', (b) => {
  const id = Number(b.id);
  tx(() => { run('UPDATE employees SET site_id = NULL WHERE site_id = ?', id); run('DELETE FROM sites WHERE id = ?', id); });
  broadcast('sites'); return { ok: true };
});
route('POST', '/api/holidays/save', 'user', (b) => {
  if (!isDate(b.date)) fail(400, 'التاريخ غير صحيح');
  const name = str(b.name, 80) || 'إجازة رسمية';
  try {
    if (Number(b.id)) run('UPDATE holidays SET date = ?, name = ? WHERE id = ?', b.date, name, Number(b.id));
    else run('INSERT INTO holidays (date, name) VALUES (?, ?)', b.date, name);
  } catch { fail(400, 'اليوم ده متسجل إجازة رسمية بالفعل'); }
  broadcast('holidays'); return { ok: true };
});
route('POST', '/api/holidays/delete', 'user', (b) => { run('DELETE FROM holidays WHERE id = ?', Number(b.id)); broadcast('holidays'); return { ok: true }; });

route('POST', '/api/employees/save', 'user', (b, a) => {
  const name = str(b.name, 100); if (!name) fail(400, 'اكتب اسم الموظف');
  let code = str(b.code, 40);
  const id = Number(b.id) || 0;
  if (!code) {
    const last = all("SELECT code FROM employees WHERE code LIKE 'E%'").map(r => Number(r.code.slice(1))).filter(n => !isNaN(n));
    code = 'E' + ((last.length ? Math.max(...last) : 100) + 1);
  }
  const rest = String(b.rest_days ?? '').split(',').map(x => x.trim()).filter(x => /^[0-6]$/.test(x));
  const data = {
    code, name, phone: str(b.phone, 30), job: str(b.job, 80), email: str(b.email, 120),
    dept_id: num(b.dept_id), shift_id: num(b.shift_id), site_id: num(b.site_id),
    rest_days: [...new Set(rest)].join(','), active: b.active === false || b.active === 0 || b.active === '0' ? 0 : 1,
    hired_at: isDate(b.hired_at) ? b.hired_at : null, notes: str(b.notes, 500),
    chat_enabled: b.chat_enabled === false || b.chat_enabled === 0 || b.chat_enabled === '0' ? 0 : 1,
    track_enabled: b.track_enabled === false || b.track_enabled === 0 || b.track_enabled === '0' ? 0 : 1,
  };
  const newPhoto = b.photo ? checkPhoto(b.photo) : null;
  let pinShown = null;
  try {
    if (id) {
      run('UPDATE employees SET code=?, name=?, phone=?, job=?, email=?, dept_id=?, shift_id=?, site_id=?, rest_days=?, active=?, hired_at=?, notes=? WHERE id=?',
        data.code, data.name, data.phone, data.job, data.email, data.dept_id, data.shift_id, data.site_id, data.rest_days, data.active, data.hired_at, data.notes, id);
      if (b.pin) { if (!/^\d{4,8}$/.test(String(b.pin))) fail(400, 'الرقم السري لازم من 4 لـ 8 أرقام'); run('UPDATE employees SET pin = ? WHERE id = ?', hashSecret(b.pin), id); pinShown = String(b.pin); }
      if (!data.active) run("DELETE FROM sessions WHERE kind = 'emp' AND ref_id = ?", id);
    } else {
      const pin = b.pin ? String(b.pin) : String(Math.floor(1000 + Math.random() * 9000));
      if (!/^\d{4,8}$/.test(pin)) fail(400, 'الرقم السري لازم من 4 لـ 8 أرقام');
      pinShown = pin;
      const r = run('INSERT INTO employees (code, name, phone, job, email, dept_id, shift_id, site_id, rest_days, pin, active, hired_at, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        data.code, data.name, data.phone, data.job, data.email, data.dept_id, data.shift_id, data.site_id, data.rest_days, hashSecret(pin), data.active, data.hired_at || nowLocal().date, data.notes, nowLocal().ts);
      b.id = Number(r.lastInsertRowid);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (String(e.message).includes('UNIQUE')) fail(400, 'كود الموظف ده مستخدم لموظف تاني');
    throw e;
  }
  const eid = Number(b.id);
  run('UPDATE employees SET chat_enabled = ?, track_enabled = ? WHERE id = ?', data.chat_enabled, data.track_enabled, eid);
  if (a.user.role === 'admin' && b.salary !== undefined && b.salary !== '') run('UPDATE employees SET salary = ? WHERE id = ?', Math.max(0, Math.min(1e7, Number(b.salary) || 0)), eid);
  if (newPhoto || b.photo_remove) {
    const old = (one('SELECT photo FROM employees WHERE id = ?', eid) || {}).photo;
    run('UPDATE employees SET photo = ? WHERE id = ?', newPhoto ? savePhoto(newPhoto).rel : null, eid);
    deletePhoto(old);
  }
  audit(a.who, id ? 'employee.update' : 'employee.create', { id: b.id, name });
  broadcast('employees'); notifyEmp(eid, 'profile');
  return { ok: true, id: eid, code, pin: pinShown };
});
route('POST', '/api/employees/delete', 'user', (b, a) => {
  const id = Number(b.id);
  const e = one('SELECT name FROM employees WHERE id = ?', id); if (!e) fail(404, 'الموظف مش موجود');
  const photos = photosOfEmp(id);
  tx(() => {
    run('DELETE FROM attendance WHERE emp_id = ?', id); run('DELETE FROM leaves WHERE emp_id = ?', id); run('DELETE FROM visits WHERE emp_id = ?', id);
    run('DELETE FROM roster WHERE emp_id = ?', id); run("DELETE FROM sessions WHERE kind = 'emp' AND ref_id = ?", id);
    run('DELETE FROM messages WHERE emp_id = ?', id); run('DELETE FROM locations WHERE emp_id = ?', id);
    run('DELETE FROM part_moves WHERE emp_id = ?', id); run('DELETE FROM advances WHERE emp_id = ?', id); run('DELETE FROM payroll_adj WHERE emp_id = ?', id);
    run("DELETE FROM push_subs WHERE kind = 'emp' AND ref_id = ?", id); run('UPDATE tasks SET emp_id = NULL WHERE emp_id = ?', id);
    run('DELETE FROM plans WHERE emp_id = ?', id); run('UPDATE kb SET emp_id = NULL WHERE emp_id = ?', id); run('DELETE FROM rewards WHERE emp_id = ?', id);
    run('DELETE FROM employees WHERE id = ?', id);
  });
  photos.forEach(deletePhoto);
  audit(a.who, 'employee.delete', e.name); broadcast('employees'); return { ok: true };
});
route('POST', '/api/employees/reset-device', 'user', (b, a) => {
  run('UPDATE employees SET device_id = NULL WHERE id = ?', Number(b.id));
  run("DELETE FROM sessions WHERE kind = 'emp' AND ref_id = ?", Number(b.id));
  audit(a.who, 'employee.reset_device', b.id); broadcast('employees'); return { ok: true };
});

function parseFilter(url) {
  const p = url.searchParams; const f = {};
  for (const k of ['dept', 'emp', 'status', 'q']) if (p.get(k)) f[k] = p.get(k);
  return f;
}
route('GET', '/api/report/day', 'user', (b, a, c) => {
  const date = c.url.searchParams.get('date') || nowLocal().date;
  if (!isDate(date)) fail(400, 'تاريخ غير صحيح');
  const f = parseFilter(c.url);
  const allRows = rangeRows(date, date, { ...f, status: null });
  return { date, rows: allRows.filter(r => matchStatus(r, f.status)), counts: countRows(allRows) };
});
route('GET', '/api/report/range', 'user', (b, a, c) => {
  const p = c.url.searchParams; const now = nowLocal();
  const from = p.get('from') || now.date.slice(0, 8) + '01', to = p.get('to') || now.date;
  const rows = rangeRows(from, to, parseFilter(c.url));
  rows.sort((x, y) => y.date.localeCompare(x.date) || (x.name || '').localeCompare(y.name || '', 'ar'));
  return { from, to, rows, counts: countRows(rows) };
});
route('GET', '/api/report/summary', 'user', (b, a, c) => {
  const p = c.url.searchParams; const now = nowLocal();
  const from = p.get('from') || now.date.slice(0, 8) + '01', to = p.get('to') || now.date;
  const f = parseFilter(c.url); delete f.status;
  const rows = rangeRows(from, to, f);
  const list = summarize(rows);
  const vc = new Map(all('SELECT emp_id, COUNT(*) AS n FROM visits WHERE date BETWEEN ? AND ? GROUP BY emp_id', from, to).map(r => [r.emp_id, r.n]));
  for (const s of list) s.visits = vc.get(s.emp_id) || 0;
  withScores(list, from, to);
  return { from, to, list, counts: countRows(rows) };
});
route('GET', '/api/dashboard', 'user', () => {
  const now = nowLocal(); const today = now.date;
  const from = addDays(today, -6);
  const rows = rangeRows(from, today, {});
  const todayRows = rows.filter(r => r.date === today);
  const days = [];
  for (let d = from; d <= today; d = addDays(d, 1)) { const c = countRows(rows.filter(r => r.date === d)); days.push({ date: d, present: c.present, late: c.late, absent: c.absent + c.not_in, leave: c.leave + c.mission, rate: c.rate }); }
  const feed = all(`SELECT a.id, a.emp_id, a.date, a.in_at, a.out_at, a.in_dist, a.out_dist, a.in_addr, a.out_addr, a.source, e.name, e.code, e.job, s.radius
    FROM attendance a JOIN employees e ON e.id = a.emp_id LEFT JOIN sites s ON s.id = e.site_id
    ORDER BY COALESCE(a.out_at, a.in_at) DESC LIMIT 14`);
  const pending = all(`SELECT l.*, e.name, e.code FROM leaves l JOIN employees e ON e.id = l.emp_id WHERE l.status = 'pending' ORDER BY l.id DESC LIMIT 8`);
  const week = countRows(rows);
  const deptStats = new Map();
  for (const r of todayRows) {
    const k = r.dept || 'بدون قسم';
    if (!deptStats.has(k)) deptStats.set(k, { dept: k, color: r.dept_color, total: 0, attended: 0 });
    const d = deptStats.get(k);
    if (['present', 'late', 'absent', 'not_in', 'pending'].includes(r.status)) d.total++;
    if (r.status === 'present' || r.status === 'late') d.attended++;
  }
  return {
    now, today: countRows(todayRows), week, days, feed, pending,
    not_in: todayRows.filter(r => ['not_in', 'pending', 'absent'].includes(r.status)).map(r => ({ emp_id: r.emp_id, name: r.name, code: r.code, shift_name: r.shift_name, shift_start: r.shift_start, status: r.status })),
    late_list: todayRows.filter(r => r.status === 'late').sort((x, y) => y.late - x.late).slice(0, 8).map(r => ({ name: r.name, late: r.late, in_at: r.in_at })),
    depts: [...deptStats.values()],
    employees: one('SELECT COUNT(*) AS n FROM employees WHERE active = 1').n,
    visits_today: one('SELECT COUNT(*) AS n FROM visits WHERE date = ?', today).n,
    visits_followup: one("SELECT COUNT(*) AS n FROM visits WHERE date = ? AND result IN ('followup','partial','failed')", today).n,
    visits_unreviewed: one('SELECT COUNT(*) AS n FROM visits WHERE reviewed = 0').n,
    visits_recent: all(VISIT_SQL + ' ORDER BY v.at DESC LIMIT 6').map(visitOut),
    tasks_open: all(TASK_SQL + " WHERE t.status IN ('new','accepted','onway','arrived') ORDER BY CASE t.priority WHEN 'urgent' THEN 0 ELSE 1 END, t.due_at LIMIT 8").map(taskOut),
    pm_due: pmDue(14).slice(0, 8),
    top: (() => { const f = today.slice(0, 8) + '01'; return withScores(summarize(rangeRows(f, today, {})), f, today).filter(s => s.score !== null).sort((x, y) => y.score - x.score).slice(0, 5); })(),
    recurring: kbRecurring().slice(0, 5),
    plans_today: one("SELECT COUNT(*) AS n, SUM(status = 'done') AS d FROM plans WHERE date = ?", today),
    rating_avg: (one("SELECT AVG(rating) AS r, COUNT(rating) AS n FROM visits WHERE rating IS NOT NULL AND date >= ?", addDays(today, -30)) || {}),
  };
});

route('GET', '/api/roster', 'user', (b, a, c) => {
  const from = c.url.searchParams.get('from'); if (!isDate(from)) fail(400, 'تاريخ غير صحيح');
  const to = addDays(from, 6);
  const ctx = loadCtx(from, to);
  const f = parseFilter(c.url);
  const emps = employeesFor(f).filter(e => e.active);
  const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push({ date: d, weekday: weekday(d), holiday: ctx.holidays.get(d) || null });
  const rows = emps.map(e => ({
    emp_id: e.id, name: e.name, code: e.code, dept_id: e.dept_id, shift_id: e.shift_id,
    cells: days.map(d => { const s = scheduleFor(e, d.date, ctx); return { date: d.date, shift_id: s.shift ? s.shift.id : null, rest: s.rest, override: s.override }; }),
  }));
  return { from, to, days, rows };
});
route('POST', '/api/roster/set', 'user', (b) => {
  const cells = Array.isArray(b.cells) ? b.cells : [b];
  tx(() => {
    for (const c of cells) {
      const emp = Number(c.emp_id); if (!emp || !isDate(c.date)) continue;
      if (c.value === 'default' || c.value === '' || c.value == null) run('DELETE FROM roster WHERE emp_id = ? AND date = ?', emp, c.date);
      else if (c.value === 'rest') run('INSERT OR REPLACE INTO roster (emp_id, date, shift_id, is_rest) VALUES (?, ?, NULL, 1)', emp, c.date);
      else run('INSERT OR REPLACE INTO roster (emp_id, date, shift_id, is_rest) VALUES (?, ?, ?, 0)', emp, c.date, Number(c.value));
    }
  });
  broadcast('roster'); return { ok: true };
});

function cleanLeave(b) {
  const type = LEAVE_TYPES.includes(b.type) ? b.type : fail(400, 'نوع الطلب غير صحيح');
  if (!isDate(b.from_date)) fail(400, 'اختار تاريخ البداية');
  const to = isDate(b.to_date) ? b.to_date : b.from_date;
  if (to < b.from_date) fail(400, 'تاريخ النهاية قبل البداية');
  if (daysBetween(b.from_date, to) > 120) fail(400, 'المدة طويلة جدا');
  const perm = PERM_LEAVES.includes(type) || type === 'att_fix';
  if (type === 'att_fix' && !isTime(b.from_time) && !isTime(b.to_time)) fail(400, 'اكتب ميعاد الحضور أو الانصراف الصح');
  if (type === 'att_fix' && b.from_date > nowLocal().date) fail(400, 'مينفعش تعدّل يوم لسه مجاش');
  if (perm && b.from_time && !isTime(b.from_time)) fail(400, 'الوقت غير صحيح');
  if (perm && b.to_time && !isTime(b.to_time)) fail(400, 'الوقت غير صحيح');
  return { type, from_date: b.from_date, to_date: perm ? b.from_date : to, from_time: perm ? str(b.from_time, 8) : null, to_time: perm ? str(b.to_time, 8) : null, reason: str(b.reason, 500) };
}
route('GET', '/api/leaves', 'user', (b, a, c) => {
  const p = c.url.searchParams; const st = p.get('status');
  let rows = all(`SELECT l.*, e.name, e.code, e.dept_id, e.job FROM leaves l JOIN employees e ON e.id = l.emp_id ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.from_date DESC, l.id DESC LIMIT 1500`);
  if (st && st !== 'all') rows = rows.filter(r => r.status === st);
  if (p.get('emp')) rows = rows.filter(r => String(r.emp_id) === p.get('emp'));
  if (p.get('type')) rows = rows.filter(r => r.type === p.get('type'));
  return { rows, counts: { pending: one("SELECT COUNT(*) AS n FROM leaves WHERE status='pending'").n, approved: one("SELECT COUNT(*) AS n FROM leaves WHERE status='approved'").n, rejected: one("SELECT COUNT(*) AS n FROM leaves WHERE status='rejected'").n } };
});
route('POST', '/api/leaves/save', 'user', (b, a) => {
  const l = cleanLeave(b); const emp = Number(b.emp_id);
  if (!one('SELECT id FROM employees WHERE id = ?', emp)) fail(400, 'اختار الموظف');
  const t = nowLocal().ts; const status = ['pending', 'approved', 'rejected'].includes(b.status) ? b.status : 'approved';
  let lid = Number(b.id) || 0;
  if (lid) run('UPDATE leaves SET emp_id=?, type=?, from_date=?, to_date=?, from_time=?, to_time=?, reason=?, status=?, decided_by=?, decided_at=? WHERE id=?', emp, l.type, l.from_date, l.to_date, l.from_time, l.to_time, l.reason, status, a.who, t, lid);
  else lid = Number(run('INSERT INTO leaves (emp_id, type, from_date, to_date, from_time, to_time, reason, status, requested_by, decided_by, decided_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', emp, l.type, l.from_date, l.to_date, l.from_time, l.to_time, l.reason, status, a.who, status === 'pending' ? null : a.who, status === 'pending' ? null : t, t).lastInsertRowid);
  if (l.type === 'att_fix' && status === 'approved') applyAttFix(one('SELECT * FROM leaves WHERE id = ?', lid), a.who);
  audit(a.who, 'leave.save', { emp, ...l, status }); broadcast('leave'); return { ok: true };
});
route('POST', '/api/leaves/decide', 'user', (b, a) => {
  const st = b.status === 'approved' ? 'approved' : b.status === 'rejected' ? 'rejected' : 'pending';
  run('UPDATE leaves SET status = ?, reply = ?, decided_by = ?, decided_at = ? WHERE id = ?', st, str(b.reply, 300), a.who, nowLocal().ts, Number(b.id));
  const lv = one('SELECT * FROM leaves WHERE id = ?', Number(b.id));
  if (lv && lv.type === 'att_fix' && st === 'approved') applyAttFix(lv, a.who);
  if (lv && st !== 'pending') {
    notifyEmp(lv.emp_id, 'leave_decided', { status: st, leave_type: lv.type });
    pushEmp(lv.emp_id, { title: st === 'approved' ? 'تمت الموافقة على طلبك ✓' : 'طلبك اترفض', body: `${LEAVE_LABEL[lv.type] || 'طلب'} — ${lv.from_date}${b.reply ? ' • ' + String(b.reply).slice(0, 80) : ''}`, url: './?emp&tab=leaves', tag: 'leave' });
  }
  audit(a.who, 'leave.' + st, b.id); broadcast('leave'); return { ok: true };
});
route('POST', '/api/leaves/delete', 'user', (b, a) => { run('DELETE FROM leaves WHERE id = ?', Number(b.id)); audit(a.who, 'leave.delete', b.id); broadcast('leave'); return { ok: true }; });

route('POST', '/api/attendance/save', 'user', (b, a) => {
  const emp = Number(b.emp_id); if (!one('SELECT id FROM employees WHERE id = ?', emp)) fail(400, 'اختار الموظف');
  if (!isDate(b.date)) fail(400, 'التاريخ غير صحيح');
  if (!isTime(b.in_time)) fail(400, 'ميعاد الحضور غير صحيح');
  const inTs = b.date + ' ' + normTime(b.in_time);
  let outTs = null;
  if (b.out_time) {
    if (!isTime(b.out_time)) fail(400, 'ميعاد الانصراف غير صحيح');
    outTs = (b.out_next_day ? addDays(b.date, 1) : b.date) + ' ' + normTime(b.out_time);
    if (outTs <= inTs) fail(400, 'ميعاد الانصراف لازم يكون بعد الحضور (علّم "اليوم التالي" لو الوردية ليلية)');
  }
  const t = nowLocal().ts; const id = Number(b.id) || 0;
  if (id) run('UPDATE attendance SET emp_id=?, date=?, in_at=?, out_at=?, notes=?, source=CASE WHEN source=\'mobile\' THEN \'edited\' ELSE source END, updated_at=? WHERE id=?', emp, b.date, inTs, outTs, str(b.notes, 300), t, id);
  else {
    if (one('SELECT id FROM attendance WHERE emp_id = ? AND date = ?', emp, b.date)) fail(409, 'فيه تسجيل للموظف ده في نفس اليوم.. عدّله بدل ما تضيف جديد');
    run("INSERT INTO attendance (emp_id, date, in_at, out_at, notes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)", emp, b.date, inTs, outTs, str(b.notes, 300), t, t);
  }
  audit(a.who, id ? 'attendance.edit' : 'attendance.manual', { emp, date: b.date, inTs, outTs }); broadcast('attendance'); return { ok: true };
});
route('POST', '/api/attendance/delete', 'user', (b, a) => {
  const r = one('SELECT * FROM attendance WHERE id = ?', Number(b.id)); if (!r) fail(404, 'السجل مش موجود');
  run('DELETE FROM attendance WHERE id = ?', r.id); audit(a.who, 'attendance.delete', r); broadcast('attendance'); return { ok: true };
});

route('POST', '/api/settings/save', 'user', (b, a) => {
  needAdmin(a);
  const allowed = Object.keys(DEFAULT_SETTINGS);
  tx(() => { for (const k of allowed) if (b[k] !== undefined) run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', k, String(b[k]).slice(0, 2000)); });
  if (b.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { run("UPDATE settings SET value = 'Africa/Cairo' WHERE key = 'timezone'"); } fmtCache.clear(); }
  loadSettings(); audit(a.who, 'settings', b); broadcast('settings'); notifyAllEmps('settings'); return { ok: true, settings: publicSettings() };
});
route('POST', '/api/users/save', 'user', (b, a) => {
  needAdmin(a);
  const username = str(b.username, 60); if (!username) fail(400, 'اكتب اسم المستخدم');
  const role = b.role === 'admin' ? 'admin' : 'hr'; const id = Number(b.id) || 0;
  try {
    if (id) {
      if (id === a.user.id && (role !== 'admin' || b.active === false)) fail(400, 'مينفعش تشيل صلاحية المدير من حسابك');
      run('UPDATE users SET username=?, name=?, role=?, active=? WHERE id=?', username, str(b.name, 80), role, b.active === false ? 0 : 1, id);
      if (b.password) run('UPDATE users SET pass = ?, weak_pass = ? WHERE id = ?', hashSecret(b.password), isWeakPass(b.password, username) ? 1 : 0, id);
    } else {
      if (!b.password || String(b.password).length < 4) fail(400, 'كلمة المرور لازم 4 حروف على الأقل');
      run('INSERT INTO users (username, name, pass, role, active, weak_pass, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)', username, str(b.name, 80), hashSecret(b.password), role, isWeakPass(b.password, username) ? 1 : 0, nowLocal().ts);
    }
  } catch (e) { if (e instanceof HttpError) throw e; if (String(e.message).includes('UNIQUE')) fail(400, 'اسم المستخدم موجود قبل كده'); throw e; }
  return { ok: true };
});
route('POST', '/api/users/delete', 'user', (b, a) => {
  needAdmin(a); const id = Number(b.id);
  if (id === a.user.id) fail(400, 'مينفعش تمسح حسابك');
  run("DELETE FROM sessions WHERE kind = 'user' AND ref_id = ?", id); run('DELETE FROM users WHERE id = ?', id); return { ok: true };
});

const BACKUP_TABLES = ['settings', 'users', 'departments', 'shifts', 'sites', 'employees', 'roster', 'attendance', 'leaves', 'holidays', 'centers', 'visits', 'messages', 'locations', 'devices', 'tasks', 'parts', 'part_moves', 'advances', 'payroll_adj', 'plans', 'kb', 'kb_votes', 'rewards'];
function makeBackup(withPhotos) {
  const out = { app: 'emdadx-attendance', version: VERSION, at: nowLocal().ts, tables: {} };
  for (const t of BACKUP_TABLES) out.tables[t] = all(`SELECT * FROM ${t}`);
  if (withPhotos) {
    out.photos = {};
    const rels = new Set([...out.tables.visits.map(v => v.signature), ...out.tables.visits.map(v => v.photo), ...out.tables.employees.map(e => e.photo), ...out.tables.attendance.map(a => a.in_photo), ...out.tables.attendance.map(a => a.out_photo)].filter(r => r && !r.startsWith('demo/')));
    for (const r of rels) { const f = photoFile(r); try { if (f) out.photos[r] = fs.readFileSync(f).toString('base64'); } catch {} }
  }
  return out;
}
route('GET', '/api/backup', 'user', (b, a, c) => { needAdmin(a); return makeBackup(c.url.searchParams.get('photos') === '1'); });
function autoBackup() {
  if (SETTINGS.auto_backup !== '1') return;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `auto-${nowLocal().date}.json`);
    if (fs.existsSync(file)) return;
    fs.writeFileSync(file, JSON.stringify(makeBackup(false)));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^auto-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > 14) fs.rmSync(path.join(BACKUP_DIR, files.shift()), { force: true });
  } catch (e) { console.error('[backup]', e.message); }
}
setTimeout(autoBackup, 8000).unref(); setInterval(autoBackup, 3600e3).unref();
route('GET', '/api/backups', 'user', (b, a) => {
  needAdmin(a);
  let files = [];
  try { files = fs.readdirSync(BACKUP_DIR).filter(f => /^auto-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().map(f => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size, date: f.slice(5, 15) })); } catch {}
  return { files };
});
route('GET', '/api/audit', 'user', (b, a) => { needAdmin(a); return { rows: all('SELECT * FROM audit ORDER BY id DESC LIMIT 300') }; });
route('POST', '/api/restore', 'user', (b, a) => {
  needAdmin(a);
  if (!b || b.app !== 'emdadx-attendance' || !b.tables) fail(400, 'ملف النسخة الاحتياطية غير صالح');
  tx(() => {
    for (const t of BACKUP_TABLES) {
      const rows = b.tables[t]; if (!Array.isArray(rows)) continue;
      const cols = all(`PRAGMA table_info(${t})`).map(c => c.name);
      run(`DELETE FROM ${t}`);
      for (const r of rows) {
        const keys = Object.keys(r).filter(k => cols.includes(k)); if (!keys.length) continue;
        db.prepare(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => nz(r[k])));
      }
    }
    run("DELETE FROM sessions WHERE token <> ?", a.token);
  });
  if (b.photos && typeof b.photos === 'object') {
    for (const [rel, b64] of Object.entries(b.photos)) {
      const f = photoFile(rel); if (!f || rel.startsWith('demo/')) continue;
      try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(String(b64), 'base64')); } catch {}
    }
  }
  if (!one("SELECT id FROM users WHERE role = 'admin' AND active = 1 LIMIT 1")) run("INSERT INTO users (username, name, pass, role, created_at) VALUES ('admin', 'مدير النظام', ?, 'admin', ?)", hashSecret('admin'), nowLocal().ts);
  loadSettings(); fmtCache.clear(); audit(a.who, 'restore', b.at); broadcast('restore'); return { ok: true };
});
route('POST', '/api/demo/clear', 'user', (b, a) => {
  needAdmin(a);
  const ids = all('SELECT id FROM employees WHERE demo = 1').map(r => r.id);
  const photos = ids.flatMap(photosOfEmp);
  tx(() => {
    for (const id of ids) {
      run('DELETE FROM attendance WHERE emp_id = ?', id); run('DELETE FROM leaves WHERE emp_id = ?', id); run('DELETE FROM visits WHERE emp_id = ?', id);
      run('DELETE FROM messages WHERE emp_id = ?', id); run('DELETE FROM locations WHERE emp_id = ?', id);
      run('DELETE FROM roster WHERE emp_id = ?', id); run("DELETE FROM sessions WHERE kind = 'emp' AND ref_id = ?", id);
      run('DELETE FROM part_moves WHERE emp_id = ?', id); run('DELETE FROM advances WHERE emp_id = ?', id); run('DELETE FROM payroll_adj WHERE emp_id = ?', id);
      run('DELETE FROM tasks WHERE emp_id = ?', id); run("DELETE FROM push_subs WHERE kind = 'emp' AND ref_id = ?", id);
      run('DELETE FROM plans WHERE emp_id = ?', id); run('DELETE FROM rewards WHERE emp_id = ?', id);
    }
    run('DELETE FROM kb WHERE demo = 1'); run('DELETE FROM kb_votes WHERE kb_id NOT IN (SELECT id FROM kb)');
    run('DELETE FROM employees WHERE demo = 1');
    run('DELETE FROM devices WHERE demo = 1');
    run('DELETE FROM parts WHERE id NOT IN (SELECT DISTINCT part_id FROM part_moves)');
    run('UPDATE visits SET center_name = (SELECT name FROM centers c WHERE c.id = visits.center_id), center_id = NULL WHERE center_id IN (SELECT id FROM centers WHERE demo = 1)');
    run('DELETE FROM centers WHERE demo = 1');
  });
  photos.forEach(deletePhoto);
  try { fs.rmSync(path.join(UPLOAD_DIR, 'demo'), { recursive: true, force: true }); } catch {}
  audit(a.who, 'demo.clear', ''); broadcast('employees'); return { ok: true };
});

/* --------------------------------------------- Centers & maintenance visits --- */
const VISIT_RESULTS = ['done', 'partial', 'followup', 'failed'];
const VISIT_SQL = `SELECT v.*, e.name AS emp_name, e.code AS emp_code, e.job AS emp_job, e.dept_id AS emp_dept,
  c.name AS c_name, c.area AS c_area, c.radius AS c_radius, c.lat AS c_lat, c.lng AS c_lng
  FROM visits v LEFT JOIN employees e ON e.id = v.emp_id LEFT JOIN centers c ON c.id = v.center_id`;
function visitOut(v) {
  const radius = Math.max(v.c_radius || 300, 150);
  let parts = []; try { parts = v.parts_used ? JSON.parse(v.parts_used) : []; } catch {}
  return { ...v, parts, center: v.c_name || v.center_name || '—', area: v.c_area || null, out_range: v.dist !== null && v.dist !== undefined && v.dist > radius, radius };
}
function centersWithStats() {
  return all(`SELECT c.*, (SELECT COUNT(*) FROM visits v WHERE v.center_id = c.id) AS visits,
    (SELECT MAX(date) FROM visits v WHERE v.center_id = c.id) AS last_visit,
    (SELECT COUNT(*) FROM visits v WHERE v.center_id = c.id AND v.result IN ('followup','partial','failed') AND v.date >= date('now','-30 day')) AS open_issues
    FROM centers c ORDER BY c.name`);
}
const workTypes = () => String(SETTINGS.work_types || '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 30);
const distinctVals = (col, extra = []) => [...new Set([...extra, ...all(`SELECT ${col} AS v, COUNT(*) AS n FROM visits WHERE ${col} IS NOT NULL AND ${col} <> '' GROUP BY ${col} ORDER BY n DESC LIMIT 40`).map(r => r.v)])];
const DEFAULT_DEVICES = ['جهاز مقطعية CT', 'جهاز رنين MRI', 'جهاز أشعة X-Ray', 'جهاز ماموجرام', 'جهاز سونار', 'طابعة أفلام', 'نظام CR / DR', 'جهاز تحميض'];
const DEFAULT_ROLES = ['مدير المركز', 'مسؤول الأجهزة', 'فني أشعة', 'الطبيب المسؤول', 'الاستقبال', 'أمين المخزن'];

function dropVisit(v) {
  tx(() => {
    run('DELETE FROM part_moves WHERE visit_id = ?', v.id); // parts go back to the technician's custody
    run("UPDATE tasks SET status = CASE WHEN arrived_at IS NOT NULL THEN 'arrived' ELSE 'accepted' END, done_at = NULL, visit_id = NULL WHERE visit_id = ?", v.id);
    run('DELETE FROM visits WHERE id = ?', v.id);
  });
  deletePhoto(v.photo); if (v.signature) deletePhoto(v.signature);
  broadcast('task', {}); broadcast('parts', {});
}
route('GET', '/api/my/visits', 'emp', (b, a) => {
  const now = nowLocal();
  return {
    now, visits: all(VISIT_SQL + ' WHERE v.emp_id = ? AND v.date >= ? ORDER BY v.at DESC LIMIT 150', a.emp.id, addDays(now.date, -30)).map(visitOut),
    centers: all('SELECT id, name, area, lat, lng, radius FROM centers WHERE active = 1 ORDER BY name'),
    work_types: workTypes(), devices: distinctVals('device', DEFAULT_DEVICES), roles: distinctVals('receiver_role', DEFAULT_ROLES),
    settings: { photo_quality: SETTINGS.photo_quality, photo_camera_only: SETTINGS.photo_camera_only, photo_required: SETTINGS.photo_required, signature_required: SETTINGS.signature_required },
    center_devices: all('SELECT d.id, d.center_id, d.name, d.brand, d.model, d.serial, d.next_pm FROM devices d JOIN centers c ON c.id = d.center_id WHERE d.active = 1 AND c.active = 1 ORDER BY d.name'),
    custody: custodyOf(a.emp.id), tasks: myTasks(a.emp.id),
    kb_models: all("SELECT model, COUNT(*) AS n FROM kb WHERE model IS NOT NULL AND model <> '' GROUP BY model ORDER BY n DESC LIMIT 40").map(r => r.model),
  };
});
route('POST', '/api/my/visit', 'emp', (b, a) => {
  const emp = a.emp; const now = nowLocal();
  let center = num(b.center_id) ? one('SELECT * FROM centers WHERE id = ?', num(b.center_id)) : null;
  const cname = str(b.center_name, 120);
  if (!center && cname) center = one('SELECT * FROM centers WHERE name = ? COLLATE NOCASE', cname);
  const details = str(b.details, 2000); if (!details) fail(400, 'اكتب تفاصيل الشغل اللي اتعمل');
  const receiver = str(b.receiver_name, 100); if (!receiver) fail(400, 'اكتب اسم اللي استلم منك في المركز');
  if (!center && !cname) fail(400, 'اختار المركز أو اكتب اسمه');
  const chk = b.photo ? checkPhoto(b.photo) : null;
  if (SETTINGS.photo_required === '1' && !chk) fail(400, 'لازم ترفع صورة إثبات للشغل');
  const sig = b.signature ? checkSign(b.signature) : null;
  if (SETTINGS.signature_required === '1' && !sig) fail(400, 'لازم المستلم يمضي على الشاشة');
  const task = num(b.task_id) ? one("SELECT * FROM tasks WHERE id = ? AND emp_id = ? AND status NOT IN ('done','cancelled')", num(b.task_id), emp.id) : null;
  // offline-saved visits carry the time they were really done (accepted only if within the last 48h)
  let at = now.ts, clientAt = null;
  if (b.client_at && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(b.client_at)) { const d = tsMin(now.ts) - tsMin(b.client_at); if (d > 2 && d < 48 * 60) { at = b.client_at; clientAt = b.client_at; } }
  if (!center) {
    const r = run('INSERT INTO centers (name, created_by, created_at) VALUES (?, ?, ?)', cname, emp.name, now.ts);
    center = one('SELECT * FROM centers WHERE id = ?', Number(r.lastInsertRowid));
    audit(emp.name, 'center.auto', cname);
  }
  const lat = num(b.lat), lng = num(b.lng), acc = num(b.acc);
  const hasLoc = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  let dist = null;
  if (hasLoc && center.lat !== null && center.lng !== null) dist = Math.round(haversine(lat, lng, center.lat, center.lng));
  else if (hasLoc && center.lat === null && (acc === null || acc <= 150)) { run('UPDATE centers SET lat = ?, lng = ? WHERE id = ?', lat, lng, center.id); dist = 0; }
  const ph = chk ? savePhoto(chk) : null;
  const sg = sig ? savePhoto(sig) : null;
  let device = num(b.device_id) ? one('SELECT * FROM devices WHERE id = ? AND center_id = ?', num(b.device_id), center.id) : null;
  const devName = device ? [device.name, device.serial ? 'S/N ' + device.serial : ''].filter(Boolean).join(' — ') : str(b.device, 100);
  const parts = (Array.isArray(b.parts) ? b.parts : []).map(x => ({ part: one('SELECT * FROM parts WHERE id = ?', num(x.part_id)), qty: Math.abs(Number(x.qty) || 0) })).filter(x => x.part && x.qty > 0).slice(0, 20);
  const token = crypto.randomBytes(12).toString('base64url');
  let id, kbNew = null, planDone = false;
  tx(() => {
    const r = run(`INSERT INTO visits (emp_id, date, at, center_id, center_name, work_type, device, details, result, receiver_name, receiver_role, receiver_phone, arrived_at, lat, lng, acc, dist, photo, photo_size, signature, device_id, task_id, rate_token, client_at, parts_used, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      emp.id, at.slice(0, 10), at, center.id, center.name, str(b.work_type, 80), devName, details, VISIT_RESULTS.includes(b.result) ? b.result : 'done',
      receiver, str(b.receiver_role, 80), str(b.receiver_phone, 30), isTime(b.arrived_at) ? b.arrived_at.slice(0, 5) : (task && task.arrived_at ? task.arrived_at.slice(11, 16) : null),
      hasLoc ? lat : null, hasLoc ? lng : null, acc, dist, ph ? ph.rel : null, ph ? ph.size : null, sg ? sg.rel : null, device ? device.id : null, task ? task.id : null, token, clientAt,
      parts.length ? JSON.stringify(parts.map(x => ({ id: x.part.id, name: x.part.name, unit: x.part.unit, qty: x.qty }))) : null, now.ts, now.ts);
    id = Number(r.lastInsertRowid);
    for (const x of parts) run("INSERT INTO part_moves (part_id, emp_id, qty, kind, visit_id, note, by_name, at) VALUES (?, ?, ?, 'use', ?, ?, ?, ?)", x.part.id, emp.id, -x.qty, id, center.name, emp.name, now.ts);
    if (device && /دوري|معايرة|وقائ/.test(String(b.work_type || '')) && (VISIT_RESULTS.includes(b.result) ? b.result : 'done') !== 'failed') {
      run('UPDATE devices SET last_pm = ?, next_pm = ? WHERE id = ?', at.slice(0, 10), addMonths(at.slice(0, 10), device.pm_months || 3), device.id);
    }
    if (task) run("UPDATE tasks SET status = 'done', done_at = ?, visit_id = ?, updated_at = ? WHERE id = ?", now.ts, id, now.ts, task.id);
    // fault info + knowledge base + schedule
    const fcode = str(b.fault_code, 40), fmodel = str(b.fault_model, 80), fdesc = str(b.fault_desc, 300) || (task ? task.title : null);
    run('UPDATE visits SET fault_code = ?, fault_model = ?, fault_desc = ? WHERE id = ?', fcode, fmodel, fdesc, id);
    if (b.save_kb && (fcode || fdesc)) {
      kbInsert({ code: fcode, model: fmodel, problem: fdesc || fcode, solution: details, emp_id: emp.id, author: emp.name, center_id: center.id, center_name: center.name, visit_id: id }, now);
      kbNew = { author: emp.name, code: fcode, problem: fdesc || fcode, model: fmodel };
    }
    const plan = num(b.plan_id) ? one("SELECT * FROM plans WHERE id = ? AND emp_id = ? AND status = 'planned'", num(b.plan_id), emp.id)
      : one("SELECT * FROM plans WHERE emp_id = ? AND date = ? AND status = 'planned' AND (center_id = ? OR center_name = ?) ORDER BY time LIMIT 1", emp.id, at.slice(0, 10), center.id, center.name);
    if (plan) { run("UPDATE plans SET status = 'done', visit_id = ?, updated_at = ? WHERE id = ?", id, now.ts, plan.id); run('UPDATE visits SET plan_id = ? WHERE id = ?', plan.id, id); planDone = true; }
  });
  if (kbNew) kbNotify(kbNew, emp.id);
  if (planDone) broadcast('plan', {});
  broadcast('visit', { name: emp.name, center: center.name });
  if (task) { broadcast('task', { id: task.id, name: emp.name, status: 'done' }); pushAdmins({ title: `✅ ${emp.name} خلّص مهمة`, body: `${task.title} — ${center.name}`, url: './#/tasks', tag: 'task' }); }
  if (hasLoc) logLocation(emp, now, lat, lng, acc, null, 'visit');
  if (hasLoc) reverseGeocode(lat, lng).then(addr => { if (addr) { run('UPDATE visits SET addr = ? WHERE id = ?', addr, id); broadcast('visit_geo', { id }); } });
  return { ok: true, visit: visitOut(one(VISIT_SQL + ' WHERE v.id = ?', id)) };
});
route('POST', '/api/my/visit/delete', 'emp', (b, a) => {
  const v = one('SELECT * FROM visits WHERE id = ? AND emp_id = ?', Number(b.id), a.emp.id);
  if (!v) fail(404, 'الزيارة مش موجودة');
  if (tsMin(nowLocal().ts) - tsMin(v.at) > 30) fail(403, 'مينفعش تمسح الزيارة بعد 30 دقيقة.. كلم الإدارة');
  dropVisit(v); broadcast('visit', {}); return { ok: true };
});

route('GET', '/api/visits', 'user', (b, a, c) => {
  const p = c.url.searchParams; const now = nowLocal();
  if (p.get('id')) { const v = one(VISIT_SQL + ' WHERE v.id = ?', Number(p.get('id'))); if (!v) fail(404, 'الزيارة مش موجودة'); return { rows: [visitOut(v)] }; }
  let from = p.get('from') || now.date, to = p.get('to') || now.date;
  if (!isDate(from) || !isDate(to)) fail(400, 'تاريخ غير صحيح');
  if (to < from) [from, to] = [to, from];
  let rows = all(VISIT_SQL + ' WHERE v.date BETWEEN ? AND ? ORDER BY v.at DESC LIMIT 5000', from, to).map(visitOut);
  const all0 = rows;
  if (p.get('emp')) rows = rows.filter(v => String(v.emp_id) === p.get('emp'));
  if (p.get('dept')) rows = rows.filter(v => String(v.emp_dept) === p.get('dept'));
  if (p.get('center')) rows = rows.filter(v => String(v.center_id) === p.get('center'));
  if (p.get('type')) rows = rows.filter(v => v.work_type === p.get('type'));
  if (p.get('result')) rows = rows.filter(v => v.result === p.get('result'));
  if (p.get('reviewed') === '0') rows = rows.filter(v => !v.reviewed);
  if (p.get('reviewed') === '1') rows = rows.filter(v => v.reviewed);
  if (p.get('q')) { const q = p.get('q').toLowerCase(); rows = rows.filter(v => [v.center, v.emp_name, v.receiver_name, v.device, v.details, v.work_type].some(x => String(x || '').toLowerCase().includes(q))); }
  const cnt = { total: rows.length, done: 0, partial: 0, followup: 0, failed: 0, unreviewed: 0, out_range: 0, centers: new Set(rows.map(v => v.center)).size, emps: new Set(rows.map(v => v.emp_id)).size, all: all0.length };
  for (const v of rows) { cnt[v.result] = (cnt[v.result] || 0) + 1; if (!v.reviewed) cnt.unreviewed++; if (v.out_range) cnt.out_range++; }
  return { from, to, rows, counts: cnt, work_types: workTypes() };
});
route('POST', '/api/visits/review', 'user', (b, a) => {
  const rv = b.reviewed ? 1 : 0;
  run('UPDATE visits SET reviewed = ?, reviewed_by = ?, admin_note = COALESCE(?, admin_note), updated_at = ? WHERE id = ?', rv, rv ? a.who : null, b.note === undefined ? null : str(b.note, 500), nowLocal().ts, Number(b.id));
  audit(a.who, rv ? 'visit.review' : 'visit.unreview', b.id); broadcast('visit_review', {}); return { ok: true };
});
route('POST', '/api/visits/save', 'user', (b, a) => {
  const v = one('SELECT * FROM visits WHERE id = ?', Number(b.id)); if (!v) fail(404, 'الزيارة مش موجودة');
  const center = num(b.center_id) ? one('SELECT * FROM centers WHERE id = ?', num(b.center_id)) : null;
  const details = str(b.details, 2000); if (!details) fail(400, 'اكتب تفاصيل الشغل');
  run('UPDATE visits SET center_id = ?, center_name = ?, work_type = ?, device = ?, details = ?, result = ?, receiver_name = ?, receiver_role = ?, receiver_phone = ?, admin_note = ?, updated_at = ? WHERE id = ?',
    center ? center.id : v.center_id, center ? center.name : v.center_name, str(b.work_type, 80), str(b.device, 100), details, VISIT_RESULTS.includes(b.result) ? b.result : v.result,
    str(b.receiver_name, 100), str(b.receiver_role, 80), str(b.receiver_phone, 30), str(b.admin_note, 500), nowLocal().ts, v.id);
  audit(a.who, 'visit.edit', v.id); broadcast('visit', {}); return { ok: true };
});
route('POST', '/api/visits/delete', 'user', (b, a) => {
  const v = one('SELECT * FROM visits WHERE id = ?', Number(b.id)); if (!v) fail(404, 'الزيارة مش موجودة');
  dropVisit(v);
  audit(a.who, 'visit.delete', { id: v.id, center: v.center_name, emp: v.emp_id }); broadcast('visit', {}); return { ok: true };
});
route('POST', '/api/centers/save', 'user', (b, a) => {
  const name = str(b.name, 120); if (!name) fail(400, 'اكتب اسم المركز');
  const lat = num(b.lat), lng = num(b.lng);
  if ((lat === null) !== (lng === null) || (lat !== null && (Math.abs(lat) > 90 || Math.abs(lng) > 180))) fail(400, 'إحداثيات المركز غير صحيحة');
  const vals = [name, str(b.area, 120), str(b.address, 200), str(b.contact, 100), str(b.phone, 30), lat, lng, Math.max(50, Math.min(5000, Number(b.radius) || 300)), str(b.notes, 500), b.active === false ? 0 : 1];
  const id = Number(b.id) || 0;
  if (id) { run('UPDATE centers SET name=?, area=?, address=?, contact=?, phone=?, lat=?, lng=?, radius=?, notes=?, active=? WHERE id=?', ...vals, id); run('UPDATE visits SET center_name = ? WHERE center_id = ?', name, id); }
  else run('INSERT INTO centers (name, area, address, contact, phone, lat, lng, radius, notes, active, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', ...vals, a.who, nowLocal().ts);
  audit(a.who, 'center.save', name); broadcast('centers'); return { ok: true };
});
route('POST', '/api/centers/delete', 'user', (b, a) => {
  const c = one('SELECT * FROM centers WHERE id = ?', Number(b.id)); if (!c) fail(404, 'المركز مش موجود');
  tx(() => { run('UPDATE visits SET center_name = ?, center_id = NULL WHERE center_id = ?', c.name, c.id); run('DELETE FROM centers WHERE id = ?', c.id); });
  audit(a.who, 'center.delete', c.name); broadcast('centers'); return { ok: true };
});

/* ------------------------------------------------- Live location tracking --- */
const trackInterval = () => Math.max(1, Math.min(120, Number(SETTINGS.track_interval) || 15));
const trackAllowed = emp => SETTINGS.track_enabled === '1' && emp.track_enabled !== 0;
function logLocation(emp, now, lat, lng, acc, battery, kind) {
  if (!trackAllowed(emp)) return null;
  const r = run('INSERT INTO locations (emp_id, at, lat, lng, acc, battery, kind) VALUES (?, ?, ?, ?, ?, ?, ?)', emp.id, now.ts, lat, lng, acc, battery, kind);
  broadcast('loc', { emp_id: emp.id, name: emp.name, lat, lng, acc, at: now.ts, kind, battery });
  return Number(r.lastInsertRowid);
}
route('POST', '/api/my/ping', 'emp', (b, a) => {
  const emp = a.emp; const now = nowLocal();
  if (!trackAllowed(emp)) return { ok: false, off: true };
  if (!openRecord(emp.id, now)) return { ok: false, closed: true };          // only during working hours
  const lat = num(b.lat), lng = num(b.lng);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, 'موقع غير صالح');
  const last = one('SELECT at FROM locations WHERE emp_id = ? ORDER BY id DESC LIMIT 1', emp.id);
  if (last && tsMin(now.ts) - tsMin(last.at) < 1) return { ok: true, skipped: true, at: last.at };
  const bat = num(b.battery);
  logLocation(emp, now, lat, lng, num(b.acc), bat === null ? null : Math.max(0, Math.min(100, Math.round(bat))), 'ping');
  return { ok: true, at: now.ts, interval: trackInterval() };
});
function nearestCenter(lat, lng, centers) {
  let best = null;
  for (const c of centers) { const d = haversine(lat, lng, c.lat, c.lng); if (!best || d < best.dist) best = { id: c.id, name: c.name, dist: Math.round(d), radius: c.radius || 300 }; }
  return best && best.dist <= Math.max(best.radius, 150) * 1.5 ? best : null;
}
route('GET', '/api/live', 'user', () => {
  const now = nowLocal(); const nowM = tsMin(now.ts);
  const limit = minToTs(nowM - Number(SETTINGS.open_hours || 16) * 60);
  const open = new Map(all('SELECT * FROM attendance WHERE out_at IS NULL AND in_at >= ?', limit).map(r => [r.emp_id, r]));
  const last = new Map(all(`SELECT l.* FROM locations l JOIN (SELECT emp_id, MAX(id) AS mid FROM locations WHERE at >= ? GROUP BY emp_id) x ON x.mid = l.id`, now.date + ' 00:00:00').map(r => [r.emp_id, r]));
  const pings = new Map(all("SELECT emp_id, COUNT(*) AS n FROM locations WHERE at >= ? GROUP BY emp_id", now.date + ' 00:00:00').map(r => [r.emp_id, r.n]));
  const vis = new Map(all('SELECT emp_id, COUNT(*) AS n FROM visits WHERE date = ? GROUP BY emp_id', now.date).map(r => [r.emp_id, r.n]));
  const centers = all('SELECT id, name, lat, lng, radius FROM centers WHERE active = 1 AND lat IS NOT NULL');
  const sites = new Map(all('SELECT * FROM sites').map(x => [x.id, x]));
  const depts = new Map(all('SELECT id, name, color FROM departments').map(x => [x.id, x]));
  const list = [];
  for (const e of all('SELECT * FROM employees WHERE active = 1 ORDER BY name')) {
    const o = open.get(e.id), l = last.get(e.id);
    if (!o && !l) continue;
    const site = sites.get(e.site_id);
    const item = {
      emp_id: e.id, name: e.name, code: e.code, job: e.job, photo: e.photo, phone: e.phone, dept: (depts.get(e.dept_id) || {}).name || null,
      working: !!o, in_at: o ? o.in_at : null, tracking: trackAllowed(e), visits_today: vis.get(e.id) || 0, pings_today: pings.get(e.id) || 0,
      last: l ? { lat: l.lat, lng: l.lng, acc: l.acc, at: l.at, kind: l.kind, battery: l.battery } : (o && o.in_lat !== null ? { lat: o.in_lat, lng: o.in_lng, acc: o.in_acc, at: o.in_at, kind: 'in', battery: null } : null),
    };
    if (item.last) {
      item.age_min = Math.max(0, Math.round(nowM - tsMin(item.last.at)));
      if (site && site.lat !== null) { item.site_dist = Math.round(haversine(item.last.lat, item.last.lng, site.lat, site.lng)); item.at_site = item.site_dist <= site.radius; item.site_name = site.name; }
      item.near_center = nearestCenter(item.last.lat, item.last.lng, centers);
    }
    list.push(item);
  }
  list.sort((x, y) => (y.working - x.working) || ((x.age_min ?? 1e9) - (y.age_min ?? 1e9)));
  return {
    now, interval: trackInterval(), enabled: SETTINGS.track_enabled === '1', list,
    centers: centers.map(c => ({ id: c.id, name: c.name, lat: c.lat, lng: c.lng, radius: c.radius })),
    sites: [...sites.values()].filter(x => x.lat !== null).map(x => ({ id: x.id, name: x.name, lat: x.lat, lng: x.lng, radius: x.radius })),
  };
});
route('GET', '/api/track', 'user', (b, a, c) => {
  const p = c.url.searchParams; const emp = one('SELECT * FROM employees WHERE id = ?', Number(p.get('emp')));
  if (!emp) fail(404, 'الموظف مش موجود');
  const date = isDate(p.get('date')) ? p.get('date') : nowLocal().date;
  const from = date + ' 00:00:00', to = addDays(date, 1) + ' 08:00:00';
  const att = one('SELECT * FROM attendance WHERE emp_id = ? AND date = ?', emp.id, date);
  const end = att && att.out_at ? att.out_at : to;
  const points = all('SELECT id, at, lat, lng, acc, battery, kind FROM locations WHERE emp_id = ? AND at >= ? AND at <= ? ORDER BY at', emp.id, from, end > to ? to : end);
  let km = 0;
  const good = points.filter(x => x.acc === null || x.acc <= 150);
  for (let i = 1; i < good.length; i++) km += haversine(good[i - 1].lat, good[i - 1].lng, good[i].lat, good[i].lng);
  const visits = all(VISIT_SQL + ' WHERE v.emp_id = ? AND v.date = ? ORDER BY v.at', emp.id, date).map(visitOut);
  return { date, emp: publicEmp(emp), att: att || null, points, visits, km: Math.round(km / 100) / 10, interval: trackInterval() };
});

/* ------------------------------------------------------------- Chat --- */
const chatAllowed = emp => SETTINGS.chat_enabled === '1' && emp.chat_enabled !== 0;
const msgOut = m => ({ id: m.id, emp_id: m.emp_id, sender: m.sender, user_name: m.user_name, body: m.body, broadcast: !!m.broadcast, at: m.created_at, read_at: m.read_at });
route('GET', '/api/my/chat', 'emp', (b, a, c) => {
  const emp = a.emp; const after = Number(c.url.searchParams.get('after')) || 0;
  const rows = after ? all('SELECT * FROM messages WHERE emp_id = ? AND id > ? ORDER BY id', emp.id, after)
    : all('SELECT * FROM (SELECT * FROM messages WHERE emp_id = ? ORDER BY id DESC LIMIT 200) ORDER BY id', emp.id);
  const unread = one("SELECT COUNT(*) AS n FROM messages WHERE emp_id = ? AND sender = 'admin' AND read_at IS NULL", emp.id).n;
  if (unread) { run("UPDATE messages SET read_at = ? WHERE emp_id = ? AND sender = 'admin' AND read_at IS NULL", nowLocal().ts, emp.id); broadcast('chat_read', { emp_id: emp.id, by: 'emp' }); }
  return { enabled: chatAllowed(emp), messages: rows.map(msgOut) };
});
route('POST', '/api/my/chat', 'emp', (b, a) => {
  const emp = a.emp;
  if (!chatAllowed(emp)) fail(403, 'المراسلة مقفولة من الإدارة');
  const body = str(b.body, 1500); if (!body) fail(400, 'اكتب الرسالة');
  const last = one("SELECT created_at FROM messages WHERE emp_id = ? AND sender = 'emp' ORDER BY id DESC LIMIT 1", emp.id);
  const now = nowLocal();
  if (last && last.created_at === now.ts) fail(429, 'استنى ثانية وابعت تاني');
  const id = Number(run("INSERT INTO messages (emp_id, sender, body, created_at) VALUES (?, 'emp', ?, ?)", emp.id, body, now.ts).lastInsertRowid);
  const m = msgOut(one('SELECT * FROM messages WHERE id = ?', id));
  broadcast('chat', { emp_id: emp.id, name: emp.name, msg: m });
  pushAdmins({ title: `💬 ${emp.name}`, body: body.slice(0, 160), url: './#/chat', tag: 'chat-' + emp.id });
  return { ok: true, msg: m };
});
route('GET', '/api/chat/threads', 'user', () => {
  const last = new Map(all('SELECT m.* FROM messages m JOIN (SELECT emp_id, MAX(id) AS mid FROM messages GROUP BY emp_id) x ON x.mid = m.id').map(m => [m.emp_id, m]));
  const unread = new Map(all("SELECT emp_id, COUNT(*) AS n FROM messages WHERE sender = 'emp' AND read_at IS NULL GROUP BY emp_id").map(r => [r.emp_id, r.n]));
  const threads = all('SELECT id, name, code, job, photo, active, chat_enabled, dept_id FROM employees ORDER BY name')
    .filter(e => e.active || last.has(e.id))
    .map(e => { const m = last.get(e.id); return { emp_id: e.id, name: e.name, code: e.code, job: e.job, photo: e.photo, active: e.active, chat: chatAllowed(e), unread: unread.get(e.id) || 0, last: m ? msgOut(m) : null }; });
  threads.sort((x, y) => (y.unread > 0) - (x.unread > 0) || (y.last ? y.last.id : 0) - (x.last ? x.last.id : 0) || x.name.localeCompare(y.name, 'ar'));
  return { enabled: SETTINGS.chat_enabled === '1', threads, unread: [...unread.values()].reduce((s, n) => s + n, 0) };
});
route('GET', '/api/chat/thread', 'user', (b, a, c) => {
  const emp = one('SELECT * FROM employees WHERE id = ?', Number(c.url.searchParams.get('emp'))); if (!emp) fail(404, 'الموظف مش موجود');
  const rows = all('SELECT * FROM (SELECT * FROM messages WHERE emp_id = ? ORDER BY id DESC LIMIT 300) ORDER BY id', emp.id);
  const n = run("UPDATE messages SET read_at = ? WHERE emp_id = ? AND sender = 'emp' AND read_at IS NULL", nowLocal().ts, emp.id).changes;
  if (n) { notifyEmp(emp.id, 'chat_read'); broadcast('chat_read', { emp_id: emp.id, by: 'admin' }); }
  return { emp: publicEmp(emp), chat: chatAllowed(emp), messages: rows.map(msgOut) };
});
function adminSend(a, empId, body, isBroadcast) {
  const id = Number(run("INSERT INTO messages (emp_id, sender, user_id, user_name, body, broadcast, created_at) VALUES (?, 'admin', ?, ?, ?, ?, ?)", empId, a.user.id, a.who, body, isBroadcast ? 1 : 0, nowLocal().ts).lastInsertRowid);
  const m = msgOut(one('SELECT * FROM messages WHERE id = ?', id));
  notifyEmp(empId, 'chat', { msg: m });
  pushEmp(empId, { title: isBroadcast ? '📢 تعميم من الإدارة' : `💬 ${a.who}`, body: body.slice(0, 160), url: './?emp&tab=chat', tag: 'chat' });
  return m;
}
route('POST', '/api/chat/send', 'user', (b, a) => {
  const emp = one('SELECT * FROM employees WHERE id = ?', Number(b.emp_id)); if (!emp) fail(404, 'الموظف مش موجود');
  const body = str(b.body, 1500); if (!body) fail(400, 'اكتب الرسالة');
  const m = adminSend(a, emp.id, body, false);
  broadcast('chat', { emp_id: emp.id, msg: m, from_admin: true });
  return { ok: true, msg: m };
});
route('POST', '/api/chat/broadcast', 'user', (b, a) => {
  const body = str(b.body, 1500); if (!body) fail(400, 'اكتب الرسالة');
  const emps = all('SELECT * FROM employees WHERE active = 1').filter(e => !b.dept || String(e.dept_id) === String(b.dept));
  if (!emps.length) fail(400, 'مفيش موظفين يوصلهم التعميم');
  tx(() => { for (const e of emps) adminSend(a, e.id, body, true); });
  audit(a.who, 'chat.broadcast', { n: emps.length, body: body.slice(0, 60) });
  broadcast('chat', { broadcast: true, from_admin: true });
  return { ok: true, sent: emps.length };
});
route('POST', '/api/chat/delete', 'user', (b, a) => {
  const m = one('SELECT * FROM messages WHERE id = ?', Number(b.id)); if (!m) fail(404, 'الرسالة مش موجودة');
  run('DELETE FROM messages WHERE id = ?', m.id); notifyEmp(m.emp_id, 'chat_deleted', { id: m.id }); broadcast('chat', { emp_id: m.emp_id });
  return { ok: true };
});

/* ===================================================== v1.2 additions === */
const LEAVE_LABEL = { annual: 'إجازة اعتيادية', casual: 'إجازة عارضة', sick: 'إجازة مرضية', unpaid: 'إجازة بدون أجر', mission: 'مأمورية', late_perm: 'إذن تأخير', early_perm: 'إذن انصراف مبكر', exit_perm: 'إذن خروج', att_fix: 'تعديل حضور/انصراف' };
function addMonths(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + Number(n || 0), 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
const monthAdd = (ym, n) => addMonths(ym + '-01', n).slice(0, 7);
const publicSettings = () => Object.fromEntries(Object.entries(SETTINGS).filter(([k]) => !k.startsWith('_')));
function setSecret(k, v) { run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', k, v); SETTINGS[k] = v; }

/* ---------- attendance correction requests ---------- */
function applyAttFix(lv, who) {
  const date = lv.from_date;
  const ex = one('SELECT * FROM attendance WHERE emp_id = ? AND date = ?', lv.emp_id, date);
  const inTs = lv.from_time ? date + ' ' + normTime(lv.from_time) : (ex ? ex.in_at : null);
  let outTs = null;
  if (lv.to_time) { outTs = date + ' ' + normTime(lv.to_time); if (inTs && outTs <= inTs) outTs = addDays(date, 1) + ' ' + normTime(lv.to_time); }
  else if (ex) outTs = ex.out_at;
  if (!inTs) return;
  const t = nowLocal().ts;
  if (ex) run("UPDATE attendance SET in_at = ?, out_at = ?, source = CASE WHEN source = 'mobile' THEN 'edited' ELSE source END, notes = ?, updated_at = ? WHERE id = ?", inTs, outTs, 'تعديل بطلب من الموظف' + (lv.reason ? ': ' + lv.reason : ''), t, ex.id);
  else run("INSERT INTO attendance (emp_id, date, in_at, out_at, notes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)", lv.emp_id, date, inTs, outTs, 'تعديل بطلب من الموظف' + (lv.reason ? ': ' + lv.reason : ''), t, t);
  audit(who, 'attendance.fix', { emp: lv.emp_id, date, inTs, outTs });
  broadcast('attendance');
}

/* ---------- Web Push (VAPID + aes128gcm, RFC 8291/8292) — no npm packages ---------- */
const b64u = buf => Buffer.from(buf).toString('base64url');
function vapid() {
  if (!SETTINGS._vapid_jwk) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    setSecret('_vapid_jwk', JSON.stringify(jwk));
    setSecret('_vapid_pub', b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])));
  }
  if (!vapid.key) vapid.key = crypto.createPrivateKey({ key: JSON.parse(SETTINGS._vapid_jwk), format: 'jwk' });
  return { pub: SETTINGS._vapid_pub, key: vapid.key };
}
function vapidJwt(aud) {
  const v = vapid();
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const p = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SETTINGS.push_contact || 'mailto:admin@emdadx.app' }));
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), { key: v.key, dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${b64u(sig)}`;
}
function encryptPush(p256dh, authSecret, plaintext, opt = {}) {
  const uaPub = Buffer.from(p256dh, 'base64url'), auth = Buffer.from(authSecret, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  if (opt.asPrivate) ecdh.setPrivateKey(Buffer.from(opt.asPrivate, 'base64url')); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPub);
  const salt = opt.salt ? Buffer.from(opt.salt, 'base64url') : crypto.randomBytes(16);
  const hk = (s, ikm, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, n));
  const ikm = hk(auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const cek = hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(opt.rs || 4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
async function sendPush(sub, data) {
  try {
    const url = new URL(sub.endpoint);
    const body = encryptPush(sub.p256dh, sub.auth, JSON.stringify(data));
    const r = await fetch(sub.endpoint, {
      method: 'POST', body, signal: AbortSignal.timeout(12000),
      headers: { TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: `vapid t=${vapidJwt(url.origin)}, k=${vapid().pub}` },
    });
    if (r.status === 404 || r.status === 410) run('DELETE FROM push_subs WHERE id = ?', sub.id);
    else if (r.ok) run('UPDATE push_subs SET last_ok = ?, fails = 0 WHERE id = ?', nowLocal().ts, sub.id);
    else { run('UPDATE push_subs SET fails = fails + 1 WHERE id = ?', sub.id); if (sub.fails >= 9) run('DELETE FROM push_subs WHERE id = ?', sub.id); }
    return r.status;
  } catch (e) { try { run('UPDATE push_subs SET fails = fails + 1 WHERE id = ?', sub.id); } catch {} return 0; }
}
function pushEmp(empId, data) { for (const s of all("SELECT * FROM push_subs WHERE kind = 'emp' AND ref_id = ?", Number(empId))) sendPush(s, data); }
function pushAdmins(data) { for (const s of all("SELECT p.* FROM push_subs p JOIN users u ON u.id = p.ref_id WHERE p.kind = 'user' AND u.active = 1")) sendPush(s, data); }
route('GET', '/api/push/key', 'any', () => ({ key: vapid().pub }));
route('POST', '/api/push/subscribe', 'any', (b, a, c) => {
  const ep = str(b.endpoint, 1000), k = b.keys || {};
  if (!ep || !/^https:\/\//.test(ep) || !k.p256dh || !k.auth) fail(400, 'اشتراك غير صالح');
  const kind = a.kind === 'user' ? 'user' : 'emp', ref = a.kind === 'user' ? a.user.id : a.emp.id;
  run('DELETE FROM push_subs WHERE endpoint = ?', ep);
  run('INSERT INTO push_subs (kind, ref_id, endpoint, p256dh, auth, ua, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', kind, ref, ep, String(k.p256dh).slice(0, 200), String(k.auth).slice(0, 100), String(c.req.headers['user-agent'] || '').slice(0, 200), nowLocal().ts);
  return { ok: true };
});
route('POST', '/api/push/unsubscribe', 'any', (b) => { run('DELETE FROM push_subs WHERE endpoint = ?', str(b.endpoint, 1000) || ''); return { ok: true }; });
route('POST', '/api/push/test', 'any', async (b, a) => {
  const kind = a.kind === 'user' ? 'user' : 'emp', ref = a.kind === 'user' ? a.user.id : a.emp.id;
  const subs = all('SELECT * FROM push_subs WHERE kind = ? AND ref_id = ?', kind, ref);
  if (!subs.length) fail(400, 'الإشعارات مش متفعلة على أي جهاز');
  const st = await Promise.all(subs.map(s => sendPush(s, { title: 'تجربة الإشعارات ✓', body: 'الإشعارات شغالة على الجهاز ده', url: kind === 'user' ? './' : './?emp', tag: 'test' })));
  return { ok: st.some(x => x >= 200 && x < 300), sent: st.length, statuses: st };
});

/* ---------- Devices & preventive maintenance ---------- */
const DEV_SQL = `SELECT d.*, c.name AS center, c.area AS area,
  (SELECT COUNT(*) FROM visits v WHERE v.device_id = d.id) AS visits,
  (SELECT MAX(v.date) FROM visits v WHERE v.device_id = d.id) AS last_visit,
  (SELECT COUNT(*) FROM visits v WHERE v.device_id = d.id AND v.work_type LIKE '%عطل%') AS faults
  FROM devices d LEFT JOIN centers c ON c.id = d.center_id`;
function pmDue(days = 14) { return all(DEV_SQL + ' WHERE d.active = 1 AND d.next_pm IS NOT NULL AND d.next_pm <= ? ORDER BY d.next_pm', addDays(nowLocal().date, days)); }
route('GET', '/api/devices', 'user', (b, a, c) => {
  const p = c.url.searchParams; let rows = all(DEV_SQL + ' ORDER BY c.name, d.name');
  if (p.get('center')) rows = rows.filter(d => String(d.center_id) === p.get('center'));
  const today = nowLocal().date;
  for (const d of rows) d.pm_state = !d.next_pm ? 'none' : d.next_pm < today ? 'overdue' : d.next_pm <= addDays(today, 14) ? 'soon' : 'ok';
  return { rows, today };
});
route('GET', '/api/devices/history', 'user', (b, a, c) => {
  const d = one(DEV_SQL + ' WHERE d.id = ?', Number(c.url.searchParams.get('id'))); if (!d) fail(404, 'الجهاز مش موجود');
  return { device: d, visits: all(VISIT_SQL + ' WHERE v.device_id = ? ORDER BY v.at DESC LIMIT 200', d.id).map(visitOut) };
});
route('POST', '/api/devices/save', 'user', (b, a) => {
  const name = str(b.name, 100); if (!name) fail(400, 'اكتب اسم الجهاز');
  const center = one('SELECT id FROM centers WHERE id = ?', num(b.center_id)); if (!center) fail(400, 'اختار المركز');
  const pm = Math.max(0, Math.min(24, Number(b.pm_months) || 0));
  const last = isDate(b.last_pm) ? b.last_pm : null;
  const next = isDate(b.next_pm) ? b.next_pm : (last && pm ? addMonths(last, pm) : null);
  const vals = [center.id, name, str(b.brand, 60), str(b.model, 60), str(b.serial, 60), isDate(b.installed_at) ? b.installed_at : null, pm, last, next, str(b.notes, 400), b.active === false ? 0 : 1];
  if (Number(b.id)) run('UPDATE devices SET center_id=?, name=?, brand=?, model=?, serial=?, installed_at=?, pm_months=?, last_pm=?, next_pm=?, notes=?, active=? WHERE id=?', ...vals, Number(b.id));
  else run('INSERT INTO devices (center_id, name, brand, model, serial, installed_at, pm_months, last_pm, next_pm, notes, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', ...vals, nowLocal().ts);
  audit(a.who, 'device.save', name); broadcast('devices'); return { ok: true };
});
route('POST', '/api/devices/delete', 'user', (b, a) => {
  const d = one('SELECT * FROM devices WHERE id = ?', Number(b.id)); if (!d) fail(404, 'الجهاز مش موجود');
  tx(() => { run('UPDATE visits SET device_id = NULL WHERE device_id = ?', d.id); run('UPDATE tasks SET device_id = NULL WHERE device_id = ?', d.id); run('DELETE FROM devices WHERE id = ?', d.id); });
  audit(a.who, 'device.delete', d.name); broadcast('devices'); return { ok: true };
});

/* ---------- Tasks (assignments from the management) ---------- */
const TASK_ST = ['new', 'accepted', 'onway', 'arrived', 'done', 'declined', 'cancelled'];
const TASK_SQL = `SELECT t.*, e.name AS emp_name, e.phone AS emp_phone, e.photo AS emp_photo, c.name AS c_name, c.area AS c_area, c.lat AS c_lat, c.lng AS c_lng, c.address AS c_address, c.phone AS c_phone, c.contact AS c_contact,
  d.name AS dev_name, d.serial AS dev_serial
  FROM tasks t LEFT JOIN employees e ON e.id = t.emp_id LEFT JOIN centers c ON c.id = t.center_id LEFT JOIN devices d ON d.id = t.device_id`;
function taskOut(t) {
  const m = ts => ts ? tsMin(ts) : null;
  const now = tsMin(nowLocal().ts);
  return {
    ...t, center: t.c_name || t.center_name || '—',
    accept_min: t.accepted_at ? Math.round(m(t.accepted_at) - m(t.created_at)) : null,
    travel_min: t.onway_at && t.arrived_at ? Math.round(m(t.arrived_at) - m(t.onway_at)) : null,
    onsite_min: t.arrived_at && t.done_at ? Math.round(m(t.done_at) - m(t.arrived_at)) : null,
    total_min: t.done_at ? Math.round(m(t.done_at) - m(t.created_at)) : null,
    overdue: !!(t.due_at && !['done', 'cancelled', 'declined'].includes(t.status) && m(t.due_at) < now),
  };
}
const myTasks = empId => all(TASK_SQL + " WHERE t.emp_id = ? AND (t.status IN ('new','accepted','onway','arrived') OR (t.status = 'done' AND t.done_at >= ?)) ORDER BY CASE t.status WHEN 'arrived' THEN 0 WHEN 'onway' THEN 1 WHEN 'accepted' THEN 2 WHEN 'new' THEN 3 ELSE 4 END, CASE t.priority WHEN 'urgent' THEN 0 ELSE 1 END, t.due_at", empId, nowLocal().date + ' 00:00:00').map(taskOut);
route('GET', '/api/tasks', 'user', (b, a, c) => {
  const p = c.url.searchParams; const now = nowLocal();
  const from = isDate(p.get('from')) ? p.get('from') : addDays(now.date, -30), to = isDate(p.get('to')) ? p.get('to') : addDays(now.date, 60);
  let rows = all(TASK_SQL + " WHERE (t.status IN ('new','accepted','onway','arrived') OR substr(t.created_at,1,10) BETWEEN ? AND ?) ORDER BY CASE WHEN t.status IN ('new','accepted','onway','arrived') THEN 0 ELSE 1 END, CASE t.priority WHEN 'urgent' THEN 0 ELSE 1 END, COALESCE(t.due_at, t.created_at) DESC LIMIT 1500", from, to).map(taskOut);
  const counts = { all: rows.length, open: 0, overdue: 0 };
  for (const t of rows) { counts[t.status] = (counts[t.status] || 0) + 1; if (['new', 'accepted', 'onway', 'arrived'].includes(t.status)) counts.open++; if (t.overdue) counts.overdue++; }
  const done = rows.filter(t => t.status === 'done');
  const avg = k => { const v = done.map(t => t[k]).filter(x => x !== null && x >= 0); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null; };
  counts.avg_accept = avg('accept_min'); counts.avg_travel = avg('travel_min'); counts.avg_onsite = avg('onsite_min'); counts.avg_total = avg('total_min');
  if (p.get('emp')) rows = rows.filter(t => String(t.emp_id) === p.get('emp'));
  if (p.get('status')) rows = rows.filter(t => p.get('status') === 'open' ? ['new', 'accepted', 'onway', 'arrived'].includes(t.status) : p.get('status') === 'overdue' ? t.overdue : t.status === p.get('status'));
  return { rows, counts };
});
route('POST', '/api/tasks/save', 'user', (b, a) => {
  const title = str(b.title, 150); if (!title) fail(400, 'اكتب عنوان المهمة');
  let center = num(b.center_id) ? one('SELECT * FROM centers WHERE id = ?', num(b.center_id)) : null;
  const emp = num(b.emp_id) ? one('SELECT * FROM employees WHERE id = ? AND active = 1', num(b.emp_id)) : null;
  if (!emp) fail(400, 'اختار الموظف المسؤول');
  const device = num(b.device_id) && center ? one('SELECT id FROM devices WHERE id = ? AND center_id = ?', num(b.device_id), center.id) : null;
  const due = b.due_at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(b.due_at) ? b.due_at.replace('T', ' ').slice(0, 16) + ':00' : null;
  const prio = b.priority === 'urgent' ? 'urgent' : 'normal';
  const t = nowLocal().ts; const id = Number(b.id) || 0;
  let reassigned = !id;
  if (id) {
    const old = one('SELECT * FROM tasks WHERE id = ?', id); if (!old) fail(404, 'المهمة مش موجودة');
    reassigned = old.emp_id !== emp.id;
    run('UPDATE tasks SET center_id=?, center_name=?, device_id=?, title=?, details=?, priority=?, emp_id=?, due_at=?, updated_at=?' + (reassigned ? ", status='new', accepted_at=NULL, onway_at=NULL, arrived_at=NULL" : '') + ' WHERE id=?',
      center ? center.id : null, center ? center.name : str(b.center_name, 120), device ? device.id : null, title, str(b.details, 1500), prio, emp.id, due, t, id);
  } else {
    b.id = Number(run('INSERT INTO tasks (center_id, center_name, device_id, title, details, priority, emp_id, due_at, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      center ? center.id : null, center ? center.name : str(b.center_name, 120), device ? device.id : null, title, str(b.details, 1500), prio, emp.id, due, 'new', a.who, t, t).lastInsertRowid);
  }
  if (reassigned) {
    notifyEmp(emp.id, 'task', { id: Number(b.id), title });
    pushEmp(emp.id, { title: prio === 'urgent' ? '🚨 مهمة عاجلة جديدة' : '📋 مهمة جديدة', body: `${title}${center ? ' — ' + center.name : ''}${due ? ' • ' + due.slice(11, 16) : ''}`, url: './?emp&tab=visits', tag: 'task-' + b.id });
  } else notifyEmp(emp.id, 'task', { id: Number(b.id) });
  audit(a.who, id ? 'task.edit' : 'task.create', { id: b.id, title, emp: emp.name }); broadcast('task', {}); return { ok: true, id: Number(b.id) };
});
route('POST', '/api/tasks/cancel', 'user', (b, a) => {
  const tk = one('SELECT * FROM tasks WHERE id = ?', Number(b.id)); if (!tk) fail(404, 'المهمة مش موجودة');
  run("UPDATE tasks SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ?", nowLocal().ts, nowLocal().ts, tk.id);
  if (tk.emp_id) notifyEmp(tk.emp_id, 'task', { id: tk.id });
  audit(a.who, 'task.cancel', tk.title); broadcast('task', {}); return { ok: true };
});
route('POST', '/api/tasks/delete', 'user', (b, a) => {
  const tk = one('SELECT * FROM tasks WHERE id = ?', Number(b.id)); if (!tk) fail(404, 'المهمة مش موجودة');
  run('DELETE FROM tasks WHERE id = ?', tk.id); run('UPDATE visits SET task_id = NULL WHERE task_id = ?', tk.id);
  if (tk.emp_id) notifyEmp(tk.emp_id, 'task', { id: tk.id });
  audit(a.who, 'task.delete', tk.title); broadcast('task', {}); return { ok: true };
});
route('POST', '/api/my/task', 'emp', (b, a) => {
  const emp = a.emp; const now = nowLocal();
  const tk = one('SELECT * FROM tasks WHERE id = ? AND emp_id = ?', Number(b.id), emp.id); if (!tk) fail(404, 'المهمة مش موجودة');
  if (['done', 'cancelled', 'declined'].includes(tk.status)) fail(409, 'المهمة دي اتقفلت');
  const act = String(b.action || '');
  const lat = num(b.lat), lng = num(b.lng);
  if (act === 'accept') run("UPDATE tasks SET status = 'accepted', accepted_at = COALESCE(accepted_at, ?), updated_at = ? WHERE id = ?", now.ts, now.ts, tk.id);
  else if (act === 'onway') run("UPDATE tasks SET status = 'onway', accepted_at = COALESCE(accepted_at, ?), onway_at = ?, updated_at = ? WHERE id = ?", now.ts, now.ts, now.ts, tk.id);
  else if (act === 'arrive') {
    const c = tk.center_id ? one('SELECT * FROM centers WHERE id = ?', tk.center_id) : null;
    const dist = lat !== null && c && c.lat !== null ? Math.round(haversine(lat, lng, c.lat, c.lng)) : null;
    run("UPDATE tasks SET status = 'arrived', accepted_at = COALESCE(accepted_at, ?), arrived_at = ?, arrive_lat = ?, arrive_lng = ?, arrive_dist = ?, updated_at = ? WHERE id = ?", now.ts, now.ts, lat, lng, dist, now.ts, tk.id);
    if (lat !== null) logLocation(emp, now, lat, lng, num(b.acc), null, 'arrive');
  } else if (act === 'decline') {
    const note = str(b.note, 300); if (!note) fail(400, 'اكتب سبب الاعتذار');
    run("UPDATE tasks SET status = 'declined', emp_note = ?, closed_at = ?, updated_at = ? WHERE id = ?", note, now.ts, now.ts, tk.id);
    pushAdmins({ title: `⚠️ ${emp.name} اعتذر عن مهمة`, body: `${tk.title} • ${note}`, url: './#/tasks', tag: 'task' });
  } else fail(400, 'إجراء غير معروف');
  const label = { accept: 'قبل المهمة', onway: 'في الطريق', arrive: 'وصل المركز', decline: 'اعتذر' }[act];
  broadcast('task', { id: tk.id, name: emp.name, status: act, label, title: tk.title });
  return { ok: true, task: taskOut(one(TASK_SQL + ' WHERE t.id = ?', tk.id)) };
});

/* ---------- Spare parts & technician custody ---------- */
function custodyOf(empId) {
  return all(`SELECT p.id AS part_id, p.name, p.code, p.unit, SUM(m.qty) AS balance FROM part_moves m JOIN parts p ON p.id = m.part_id
    WHERE m.emp_id = ? GROUP BY p.id HAVING ABS(SUM(m.qty)) > 0.0001 OR p.active = 1 ORDER BY p.name`, empId).filter(r => Math.abs(r.balance) > 0.0001);
}
route('GET', '/api/parts', 'user', () => {
  const parts = all(`SELECT p.*, COALESCE((SELECT SUM(qty) FROM part_moves WHERE part_id = p.id AND kind = 'issue'), 0) AS issued,
    COALESCE((SELECT -SUM(qty) FROM part_moves WHERE part_id = p.id AND kind = 'use'), 0) AS used,
    COALESCE((SELECT SUM(qty) FROM part_moves WHERE part_id = p.id), 0) AS in_custody FROM parts p ORDER BY p.active DESC, p.name`);
  const balances = all(`SELECT m.emp_id, e.name AS emp_name, e.photo, m.part_id, p.name AS part_name, p.unit, SUM(m.qty) AS balance
    FROM part_moves m JOIN parts p ON p.id = m.part_id JOIN employees e ON e.id = m.emp_id GROUP BY m.emp_id, m.part_id HAVING ABS(SUM(m.qty)) > 0.0001 ORDER BY e.name, p.name`);
  const moves = all(`SELECT m.*, e.name AS emp_name, p.name AS part_name, p.unit FROM part_moves m JOIN parts p ON p.id = m.part_id JOIN employees e ON e.id = m.emp_id ORDER BY m.id DESC LIMIT 400`);
  return { parts, balances, moves };
});
route('POST', '/api/parts/save', 'user', (b, a) => {
  const name = str(b.name, 120); if (!name) fail(400, 'اكتب اسم الصنف');
  const vals = [name, str(b.code, 40), str(b.unit, 20) || 'قطعة', Math.max(0, Number(b.price) || 0), b.active === false ? 0 : 1];
  if (Number(b.id)) run('UPDATE parts SET name=?, code=?, unit=?, price=?, active=? WHERE id=?', ...vals, Number(b.id));
  else run('INSERT INTO parts (name, code, unit, price, active, created_at) VALUES (?,?,?,?,?,?)', ...vals, nowLocal().ts);
  audit(a.who, 'part.save', name); broadcast('parts'); return { ok: true };
});
route('POST', '/api/parts/delete', 'user', (b, a) => {
  const p = one('SELECT * FROM parts WHERE id = ?', Number(b.id)); if (!p) fail(404, 'الصنف مش موجود');
  if (one('SELECT id FROM part_moves WHERE part_id = ? LIMIT 1', p.id)) { run('UPDATE parts SET active = 0 WHERE id = ?', p.id); broadcast('parts'); return { ok: true, deactivated: true }; }
  run('DELETE FROM parts WHERE id = ?', p.id); audit(a.who, 'part.delete', p.name); broadcast('parts'); return { ok: true };
});
route('POST', '/api/parts/move', 'user', (b, a) => {
  const p = one('SELECT * FROM parts WHERE id = ?', num(b.part_id)); if (!p) fail(400, 'اختار الصنف');
  const e = one('SELECT * FROM employees WHERE id = ?', num(b.emp_id)); if (!e) fail(400, 'اختار الفني');
  const q = Number(b.qty); if (!q || !isFinite(q)) fail(400, 'اكتب الكمية');
  const kind = ['issue', 'return', 'adjust'].includes(b.kind) ? b.kind : 'issue';
  const qty = kind === 'issue' ? Math.abs(q) : kind === 'return' ? -Math.abs(q) : q;
  run('INSERT INTO part_moves (part_id, emp_id, qty, kind, note, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)', p.id, e.id, qty, kind, str(b.note, 200), a.who, nowLocal().ts);
  notifyEmp(e.id, 'custody'); audit(a.who, 'part.' + kind, { part: p.name, emp: e.name, qty }); broadcast('parts'); return { ok: true };
});
route('POST', '/api/parts/move/delete', 'user', (b, a) => {
  const m = one('SELECT * FROM part_moves WHERE id = ?', Number(b.id)); if (!m) fail(404, 'الحركة مش موجودة');
  if (m.kind === 'use') fail(400, 'الحركة دي مرتبطة بزيارة.. عدّل الزيارة نفسها');
  run('DELETE FROM part_moves WHERE id = ?', m.id); notifyEmp(m.emp_id, 'custody'); broadcast('parts'); return { ok: true };
});

/* ---------- Payroll ---------- */
const money = n => Math.round((Number(n) || 0) * 100) / 100;
function payrollFor(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'الشهر غير صحيح');
  const now = nowLocal();
  const from = month + '-01', last = addDays(addMonths(from, 1), -1);
  const to = last > now.date ? now.date : last;
  const days = Math.max(1, Number(SETTINGS.payroll_days) || 30);
  const lateF = Number(SETTINGS.late_factor) || 0, absF = Number(SETTINGS.absent_factor) || 0, otF = SETTINGS.ot_enabled === '1' ? (Number(SETTINGS.ot_factor) || 0) : 0;
  const free = Math.max(0, Number(SETTINGS.late_free_min) || 0);
  const rows = from <= to ? rangeRows(from, to, {}) : [];
  const shifts = new Map(all('SELECT * FROM shifts').map(s => [s.id, s]));
  const adv = all('SELECT * FROM advances');
  const adj = all('SELECT * FROM payroll_adj WHERE month = ?', month);
  const emps = all('SELECT * FROM employees ORDER BY name').filter(e => e.active || rows.some(r => r.emp_id === e.id));
  const out = emps.map(e => {
    const R = rows.filter(r => r.emp_id === e.id);
    const sh = shifts.get(e.shift_id); let shMin = 480;
    if (sh) { const [h1, m1] = sh.start_time.split(':').map(Number), [h2, m2] = sh.end_time.split(':').map(Number); shMin = ((h2 * 60 + m2) - (h1 * 60 + m1) + 1440) % 1440 || 480; }
    const base = Number(e.salary) || 0, dayRate = base / days, minRate = dayRate / shMin;
    const lateRaw = R.filter(r => r.status === 'late').reduce((s, r) => s + r.late, 0);
    const lateMin = Math.max(0, lateRaw - free);
    const absent = R.filter(r => r.status === 'absent').length;
    const unpaid = R.filter(r => r.status === 'leave' && r.leave_type === 'unpaid').length;
    const otMin = R.reduce((s, r) => s + (r.overtime || 0), 0);
    const attended = R.filter(r => r.status === 'present' || r.status === 'late').length;
    const a1 = adv.filter(x => x.emp_id === e.id && x.start_month <= month && month < monthAdd(x.start_month, x.months));
    const advance = a1.reduce((s, x) => s + x.amount / Math.max(1, x.months), 0);
    const A = adj.filter(x => x.emp_id === e.id);
    const bonus = A.filter(x => x.kind === 'bonus').reduce((s, x) => s + x.amount, 0);
    const deduct = A.filter(x => x.kind === 'deduct').reduce((s, x) => s + x.amount, 0);
    const late_ded = lateMin * minRate * lateF, absent_ded = absent * dayRate * absF, unpaid_ded = unpaid * dayRate, ot_pay = otMin * minRate * otF;
    const net = base - late_ded - absent_ded - unpaid_ded - advance - deduct + ot_pay + bonus;
    return {
      emp_id: e.id, code: e.code, name: e.name, job: e.job, photo: e.photo, salary: money(base), day_rate: money(dayRate), attended, late_min: lateMin, late_raw: lateRaw, absent, unpaid, ot_min: otMin,
      late_ded: money(late_ded), absent_ded: money(absent_ded), unpaid_ded: money(unpaid_ded), ot_pay: money(ot_pay), advance: money(advance), bonus: money(bonus), deduct: money(deduct), net: money(net),
      adj: A, advances: a1.map(x => ({ id: x.id, amount: x.amount, months: x.months, start_month: x.start_month, note: x.note })),
    };
  });
  const tot = k => money(out.reduce((s, r) => s + r[k], 0));
  return { month, from, to, partial: to < last, rows: out, totals: { salary: tot('salary'), late_ded: tot('late_ded'), absent_ded: tot('absent_ded'), unpaid_ded: tot('unpaid_ded'), ot_pay: tot('ot_pay'), advance: tot('advance'), bonus: tot('bonus'), deduct: tot('deduct'), net: tot('net') }, currency: SETTINGS.currency };
}
route('GET', '/api/payroll', 'user', (b, a, c) => { needAdmin(a); return payrollFor(c.url.searchParams.get('month') || nowLocal().date.slice(0, 7)); });
route('POST', '/api/payroll/adj', 'user', (b, a) => {
  needAdmin(a);
  const e = one('SELECT id, name FROM employees WHERE id = ?', num(b.emp_id)); if (!e) fail(400, 'اختار الموظف');
  if (!/^\d{4}-\d{2}$/.test(String(b.month))) fail(400, 'الشهر غير صحيح');
  const amount = Math.abs(Number(b.amount) || 0); if (!amount) fail(400, 'اكتب المبلغ');
  run('INSERT INTO payroll_adj (emp_id, month, kind, amount, note, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', e.id, b.month, b.kind === 'bonus' ? 'bonus' : 'deduct', amount, str(b.note, 200), a.who, nowLocal().ts);
  audit(a.who, 'payroll.adj', { emp: e.name, kind: b.kind, amount }); return { ok: true };
});
route('POST', '/api/payroll/adj/delete', 'user', (b, a) => { needAdmin(a); run('DELETE FROM payroll_adj WHERE id = ?', Number(b.id)); return { ok: true }; });
route('GET', '/api/advances', 'user', (b, a) => {
  needAdmin(a); const m = nowLocal().date.slice(0, 7);
  return { rows: all('SELECT x.*, e.name, e.code FROM advances x JOIN employees e ON e.id = x.emp_id ORDER BY x.date DESC').map(x => {
    let paidMonths = 0; for (let i = 0; i < x.months; i++) if (monthAdd(x.start_month, i) < m) paidMonths++;
    return { ...x, installment: money(x.amount / Math.max(1, x.months)), remaining: money(x.amount - (x.amount / Math.max(1, x.months)) * paidMonths), done: paidMonths >= x.months };
  }) };
});
route('POST', '/api/advances/save', 'user', (b, a) => {
  needAdmin(a);
  const e = one('SELECT id, name FROM employees WHERE id = ?', num(b.emp_id)); if (!e) fail(400, 'اختار الموظف');
  const amount = Math.abs(Number(b.amount) || 0); if (!amount) fail(400, 'اكتب مبلغ السلفة');
  const date = isDate(b.date) ? b.date : nowLocal().date;
  const months = Math.max(1, Math.min(36, Number(b.months) || 1));
  const start = /^\d{4}-\d{2}$/.test(String(b.start_month)) ? b.start_month : monthAdd(date.slice(0, 7), 1);
  run('INSERT INTO advances (emp_id, amount, date, months, start_month, note, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', e.id, amount, date, months, start, str(b.note, 200), a.who, nowLocal().ts);
  audit(a.who, 'advance.save', { emp: e.name, amount, months }); return { ok: true };
});
route('POST', '/api/advances/delete', 'user', (b, a) => { needAdmin(a); run('DELETE FROM advances WHERE id = ?', Number(b.id)); return { ok: true }; });

/* ---------- Performance score ---------- */
function scoreOf(s, rating) {
  if (s.rate === null || s.rate === undefined) return null;
  const punct = s.punctuality ?? 100;
  let sc;
  if (s.visits) {
    const service = rating ? rating * 20 : 85;
    sc = 0.4 * s.rate + 0.3 * punct + 0.3 * service;
  } else sc = 0.55 * s.rate + 0.45 * punct;
  return Math.max(0, Math.min(100, Math.round(sc)));
}
function withScores(list, from, to) {
  const vc = new Map(all('SELECT emp_id, COUNT(*) AS n, AVG(rating) AS r, COUNT(rating) AS rn FROM visits WHERE date BETWEEN ? AND ? GROUP BY emp_id', from, to).map(r => [r.emp_id, r]));
  for (const s of list) { const v = vc.get(s.emp_id) || {}; s.visits = v.n || 0; s.rating = v.rn ? Math.round(v.r * 10) / 10 : null; s.ratings = v.rn || 0; s.score = scoreOf(s, s.rating); }
  return list;
}

/* ---------- Public visit report + rating (link sent to the center) ---------- */
function htmlEsc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function t12s(ts) { if (!ts) return '—'; const [h, m] = ts.slice(11, 16).split(':').map(Number); return `${String(h % 12 || 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'ص' : 'م'}`; }
function visitReportHtml(v, token) {
  const res = { done: ['تم الإنجاز', '#14955a'], partial: ['تم جزئيًا', '#e67e0d'], followup: ['محتاج متابعة', '#6c4ee6'], failed: ['لم يتم', '#dc3545'] }[v.result] || ['—', '#555'];
  const parts = v.parts_used ? JSON.parse(v.parts_used) : [];
  const base = APP_PATH;
  const stars = n => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>تقرير زيارة — ${htmlEsc(v.center)}</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}html{-webkit-text-size-adjust:100%}body{font-family:Cairo,Tahoma,Arial,sans-serif;background:#eef3fa;color:#0d1b3a;padding:18px 14px 40px;line-height:1.7}
.w{max-width:760px;margin:0 auto;background:#fff;border-radius:22px;box-shadow:0 20px 50px -25px rgba(10,35,87,.4);overflow:hidden}
.h{background:linear-gradient(120deg,#0a2357,#1b4aa6);color:#fff;padding:22px 24px;display:flex;align-items:center;gap:14px;position:relative}
.h::after{content:'';position:absolute;bottom:0;right:0;width:160px;height:5px;background:#f7c12d}
.lg{width:52px;height:52px;border-radius:16px;background:#f7c12d;color:#0a2357;display:grid;place-items:center;font-weight:900;font-size:22px;flex-shrink:0}
.h b{display:block;font-size:19px;font-weight:900}.h span{font-size:13px;color:#bcd0f5}
.c{padding:20px 22px;display:flex;flex-direction:column;gap:14px}
h1{font-size:21px;font-weight:900;color:#0a2357}.sub{color:#6b7a99;font-size:13.5px;font-weight:600}
.chip{display:inline-block;padding:2px 12px;border-radius:20px;font-weight:800;font-size:13px;color:#fff}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:14px;background:#f5f8fe;border-radius:14px;padding:12px 14px}.kv span{color:#6b7a99;font-weight:600}.kv b{font-weight:800}
.det{background:#f5f8fe;border-radius:14px;padding:12px 14px;white-space:pre-wrap;font-size:14.5px}
.ph{width:100%;max-height:420px;object-fit:contain;background:#0b1530;border-radius:14px;display:block}
.sg{background:#fff;border:1.5px dashed #cfd9ea;border-radius:14px;padding:8px;text-align:center}.sg img{max-height:130px;max-width:100%}
.sec{font-weight:900;color:#0a2357;font-size:15px;border-top:1px dashed #e2e9f4;padding-top:12px}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{border:1px solid #e2e9f4;padding:6px 8px;text-align:center}th{background:#0a2357;color:#fff}
.rate{background:#fff6d9;border:1px solid #f3dd8f;border-radius:16px;padding:14px;text-align:center}
.st{display:flex;justify-content:center;gap:6px;direction:ltr;margin:6px 0 10px}.st button{font-size:40px;background:none;border:0;color:#d4dbe8;cursor:pointer;line-height:1;transition:transform .15s}.st button.on{color:#f2b40c}.st button:active{transform:scale(.9)}
textarea{width:100%;border:1.5px solid #e2e9f4;border-radius:12px;padding:10px;font:inherit;font-size:16px;min-height:70px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:46px;padding:0 22px;border-radius:14px;border:0;font:inherit;font-weight:800;font-size:15px;cursor:pointer;background:#0a2357;color:#fff;margin-top:10px}
.btn.g{background:#f7c12d;color:#0a2357}.ok{color:#14955a;font-weight:900;font-size:17px}.ft{text-align:center;color:#6b7a99;font-size:12px;padding:12px}
.acts{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
@media print{body{background:#fff;padding:0}.w{box-shadow:none;border-radius:0}.noprint{display:none!important}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body>
<div class="w"><div class="h"><div class="lg">${SETTINGS.company_logo ? `<img src="${base}/logo?v=${logoVer()}" alt="" style="width:100%;height:100%;object-fit:contain;border-radius:14px;background:#fff;padding:4px">` : htmlEsc(String(SETTINGS.company_name || 'E').slice(0, 1))}</div><div><b>${htmlEsc(SETTINGS.company_name)}</b><span>تقرير زيارة صيانة</span></div></div>
<div class="c"><div><h1>${htmlEsc(v.center)}</h1><div class="sub">${htmlEsc(v.area || '')} • ${htmlEsc(v.date)} — ${t12s(v.at)}</div></div>
<div><span class="chip" style="background:${res[1]}">${res[0]}</span></div>
<div class="kv"><span>الفني</span><b>${htmlEsc(v.emp_name || '')}</b>${v.work_type ? `<span>نوع الشغل</span><b>${htmlEsc(v.work_type)}</b>` : ''}${v.device ? `<span>الجهاز</span><b>${htmlEsc(v.device)}</b>` : ''}${v.fault_model ? `<span>الموديل</span><b>${htmlEsc(v.fault_model)}</b>` : ''}${v.fault_desc ? `<span>العطل</span><b>${htmlEsc(v.fault_desc)}${v.fault_code ? ' (' + htmlEsc(v.fault_code) + ')' : ''}</b>` : ''}${v.arrived_at ? `<span>الوصول</span><b>${t12s('0000-00-00 ' + v.arrived_at)}</b>` : ''}<span>الانتهاء</span><b>${t12s(v.at)}</b><span>المستلم</span><b>${htmlEsc(v.receiver_name || '—')}${v.receiver_role ? ' — ' + htmlEsc(v.receiver_role) : ''}</b></div>
<div class="sec">الشغل اللي اتعمل</div><div class="det">${htmlEsc(v.details || '')}</div>
${parts.length ? `<div class="sec">قطع الغيار المستخدمة</div><table><tr><th>الصنف</th><th>الكمية</th></tr>${parts.map(p => `<tr><td>${htmlEsc(p.name)}</td><td>${htmlEsc(p.qty)} ${htmlEsc(p.unit || '')}</td></tr>`).join('')}</table>` : ''}
${v.photo ? `<div class="sec">صورة الإثبات</div><img class="ph" src="${base}/v/${token}/photo" alt="">` : ''}
${v.signature ? `<div class="sec">توقيع المستلم</div><div class="sg"><img src="${base}/v/${token}/sign" alt=""><div class="sub">${htmlEsc(v.receiver_name || '')}</div></div>` : ''}
<div class="rate noprint" id="rate">${v.rating ? `<div class="ok">شكرًا لتقييمك 🙏</div><div class="st" style="font-size:34px;color:#f2b40c">${stars(v.rating)}</div>${v.rating_note ? `<div class="sub">${htmlEsc(v.rating_note)}</div>` : ''}` :
  `<b style="font-size:16px">قيّم الخدمة</b><div class="sub">رأيك بيفرق معانا</div><div class="st">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}" aria-label="${n}">★</button>`).join('')}</div><textarea id="nt" placeholder="ملاحظاتك (اختياري)"></textarea><button class="btn g" id="sb" type="button">إرسال التقييم</button>`}</div>
${v.rating ? `<div class="sub" style="display:none" id="pr">تقييم المركز: ${stars(v.rating)}</div>` : ''}
<div class="acts noprint"><button class="btn" onclick="window.print()">طباعة / حفظ PDF</button></div></div>
<div class="ft">EmdadX — ${htmlEsc(SETTINGS.company_name)}</div></div>
<script>(function(){var n=0,bs=document.querySelectorAll('.st button[data-n]');bs.forEach(function(b){b.onclick=function(){n=+b.dataset.n;bs.forEach(function(x){x.classList.toggle('on',+x.dataset.n<=n)})}});var sb=document.getElementById('sb');if(sb)sb.onclick=function(){if(!n){alert('اختار عدد النجوم');return}sb.disabled=true;fetch('${base}/api/public/rate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'${token}',rating:n,note:document.getElementById('nt').value})}).then(function(r){return r.json()}).then(function(j){if(j.error){alert(j.error);sb.disabled=false;return}document.getElementById('rate').innerHTML='<div class="ok">شكرًا لتقييمك 🙏</div><div class="st" style="font-size:34px;color:#f2b40c">'+'★★★★★'.slice(0,n)+'☆☆☆☆☆'.slice(0,5-n)+'</div>'}).catch(function(){alert('مفيش اتصال.. جرب تاني');sb.disabled=false})}})();</script></body></html>`;
}
route('POST', '/api/public/rate', null, (b, a, c) => {
  rateLimit(c.ip + '|rate');
  const v = one(VISIT_SQL + ' WHERE v.rate_token = ?', str(b.token, 40) || '-'); if (!v) fail(404, 'اللينك غير صالح');
  if (v.rating) fail(409, 'الزيارة دي اتقيمت قبل كده');
  const n = Math.round(Number(b.rating)); if (!(n >= 1 && n <= 5)) fail(400, 'اختار عدد النجوم');
  run('UPDATE visits SET rating = ?, rating_note = ?, rated_at = ? WHERE id = ?', n, str(b.note, 400), nowLocal().ts, v.id);
  broadcast('visit', { rated: true, name: v.center_name, rating: n });
  pushAdmins({ title: `${'⭐'.repeat(n)} تقييم جديد`, body: `${v.c_name || v.center_name} قيّم زيارة ${v.emp_name || ''}${b.note ? ' • ' + String(b.note).slice(0, 60) : ''}`, url: './#/visits', tag: 'rate' });
  return { ok: true };
});
route('GET', '/api/visit-link', 'any', (b, a, c) => {
  const id = Number(c.url.searchParams.get('id'));
  const v = one('SELECT id, emp_id, rate_token FROM visits WHERE id = ?', id); if (!v) fail(404, 'الزيارة مش موجودة');
  if (a.kind === 'emp' && v.emp_id !== a.emp.id) fail(403, 'غير مسموح');
  let tk = v.rate_token; if (!tk) { tk = crypto.randomBytes(12).toString('base64url'); run('UPDATE visits SET rate_token = ? WHERE id = ?', tk, v.id); }
  return { path: APP_PATH + '/v/' + tk };
});

/* ---------- Company logo (shown on login, sidebar, reports, kiosk) ---------- */
const logoVer = () => SETTINGS.company_logo ? crypto.createHash('md5').update(SETTINGS.company_logo).digest('hex').slice(0, 8) : null;
function checkLogo(dataUrl) {
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) fail(400, 'اللوجو لازم يكون صورة PNG أو JPG');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 100 || buf.length > 400 * 1024) fail(400, 'حجم اللوجو كبير');
  const png = buf.readUInt32BE(0) === 0x89504E47, jpg = buf[0] === 0xFF && buf[1] === 0xD8, webp = buf.subarray(8, 12).toString() === 'WEBP';
  if (!png && !jpg && !webp) fail(400, 'ملف اللوجو غير صالح');
  return { buf, ext: png ? '.png' : jpg ? '.jpg' : '.webp' };
}
route('POST', '/api/settings/logo', 'user', (b, a) => {
  needAdmin(a);
  const old = SETTINGS.company_logo;
  const rel = b.image ? savePhoto(checkLogo(b.image)).rel : '';
  run("INSERT OR REPLACE INTO settings (key, value) VALUES ('company_logo', ?)", rel); loadSettings();
  if (old && old !== rel) deletePhoto(old);
  audit(a.who, 'settings.logo', rel ? 'upload' : 'remove'); broadcast('settings'); notifyAllEmps('settings');
  return { ok: true, logo: logoVer() };
});

/* ---------- Technician's own visit schedule (plans) + reminders ---------- */
const PLAN_SQL = `SELECT p.*, e.name AS emp_name, e.photo AS emp_photo, e.code AS emp_code, c.name AS c_name, c.area AS c_area, c.lat AS c_lat, c.lng AS c_lng
  FROM plans p LEFT JOIN employees e ON e.id = p.emp_id LEFT JOIN centers c ON c.id = p.center_id`;
function planOut(p) {
  const today = nowLocal().date;
  const st = p.status === 'planned' && p.date < today ? 'missed' : p.status;
  return { ...p, center: p.c_name || p.center_name || '—', state: st };
}
route('GET', '/api/my/plans', 'emp', (b, a) => {
  const d = nowLocal().date;
  return { rows: all(PLAN_SQL + ' WHERE p.emp_id = ? AND p.date BETWEEN ? AND ? ORDER BY p.date, COALESCE(p.time, \'99\')', a.emp.id, addDays(d, -7), addDays(d, 120)).map(planOut) };
});
route('POST', '/api/my/plans/save', 'emp', (b, a) => {
  const emp = a.emp; const now = nowLocal();
  let center = num(b.center_id) ? one('SELECT * FROM centers WHERE id = ?', num(b.center_id)) : null;
  const cname = str(b.center_name, 120);
  if (!center && cname) center = one('SELECT * FROM centers WHERE name = ? COLLATE NOCASE', cname);
  if (!center && !cname) fail(400, 'اختار المركز');
  if (!isDate(b.date)) fail(400, 'اختار اليوم');
  if (b.date < now.date) fail(400, 'مينفعش تجدول في يوم فات');
  const time = isTime(b.time) ? b.time.slice(0, 5) : null;
  const remind = [0, 15, 30, 60, 120, 1440].includes(Number(b.remind_min)) ? Number(b.remind_min) : 30;
  const note = str(b.note, 300);
  if (Number(b.id)) {
    const p = one('SELECT * FROM plans WHERE id = ? AND emp_id = ?', Number(b.id), emp.id); if (!p) fail(404, 'الميعاد مش موجود');
    run('UPDATE plans SET center_id = ?, center_name = ?, date = ?, time = ?, note = ?, remind_min = ?, notified_at = NULL, updated_at = ? WHERE id = ?',
      center ? center.id : null, center ? center.name : cname, b.date, time, note, remind, now.ts, p.id);
    broadcast('plan', { name: emp.name, center: center ? center.name : cname, date: b.date, edit: true });
    return { ok: true };
  }
  const rep = ['weekly', 'monthly'].includes(b.repeat) ? b.repeat : 'none';
  const count = rep === 'none' ? 1 : Math.max(2, Math.min(rep === 'weekly' ? 12 : 6, Number(b.count) || 4));
  const series = rep === 'none' ? null : crypto.randomBytes(6).toString('hex');
  tx(() => { for (let i = 0; i < count; i++) {
    const d = rep === 'weekly' ? addDays(b.date, 7 * i) : rep === 'monthly' ? addMonths(b.date, i) : b.date;
    run("INSERT INTO plans (emp_id, center_id, center_name, date, time, note, remind_min, series, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,'planned',?,?,?)",
      emp.id, center ? center.id : null, center ? center.name : cname, d, time, note, remind, series, emp.name, now.ts, now.ts);
  } });
  broadcast('plan', { name: emp.name, center: center ? center.name : cname, date: b.date, n: count });
  return { ok: true, count };
});
route('POST', '/api/my/plans/delete', 'emp', (b, a) => {
  const p = one('SELECT * FROM plans WHERE id = ? AND emp_id = ?', Number(b.id), a.emp.id); if (!p) fail(404, 'الميعاد مش موجود');
  if (b.series && p.series) run("DELETE FROM plans WHERE series = ? AND emp_id = ? AND status = 'planned' AND date >= ?", p.series, a.emp.id, p.date);
  else run('DELETE FROM plans WHERE id = ?', p.id);
  broadcast('plan', {}); return { ok: true };
});
route('GET', '/api/plans', 'user', (b, a, c) => {
  const q = c.url.searchParams; const d = nowLocal().date;
  let from = isDate(q.get('from')) ? q.get('from') : d, to = isDate(q.get('to')) ? q.get('to') : addDays(d, 6);
  if (to < from) [from, to] = [to, from];
  let rows = all(PLAN_SQL + ' WHERE p.date BETWEEN ? AND ? ORDER BY p.date, COALESCE(p.time, \'99\'), e.name LIMIT 3000', from, to).map(planOut);
  if (q.get('emp')) rows = rows.filter(r => String(r.emp_id) === q.get('emp'));
  const counts = { all: rows.length, planned: 0, done: 0, missed: 0 };
  for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1;
  return { from, to, rows, counts };
});
route('POST', '/api/plans/delete', 'user', (b, a) => { run('DELETE FROM plans WHERE id = ?', Number(b.id)); audit(a.who, 'plan.delete', b.id); broadcast('plan', {}); return { ok: true }; });
function planReminders(now) {
  const nowM = tsMin(now.ts);
  for (const p of all(PLAN_SQL + " WHERE p.status = 'planned' AND p.notified_at IS NULL AND p.date BETWEEN ? AND ?", now.date, addDays(now.date, 1))) {
    const at = tsMin(p.date + ' ' + (p.time || '08:00') + ':00') - (p.time ? (p.remind_min ?? 30) : 0);
    if (nowM < at || nowM - at > 180) continue;
    run('UPDATE plans SET notified_at = ? WHERE id = ?', now.ts, p.id);
    const center = p.c_name || p.center_name;
    const when = p.date === now.date ? 'النهارده' : 'بكرة';
    pushEmp(p.emp_id, { title: `⏰ تذكير: زيارة ${center}`, body: `${when}${p.time ? ' الساعة ' + t12s(p.date + ' ' + p.time) : ''}${p.note ? ' • ' + p.note : ''}`, url: './?emp&tab=visits', tag: 'plan' + p.id });
    notifyEmp(p.emp_id, 'plan_remind', { id: p.id, center, time: p.time, note: p.note });
  }
}

/* ---------- Fault knowledge base + smart assistant (shared between all engineers) ---------- */
const AR_STOP = new Set(['في', 'من', 'على', 'علي', 'عن', 'الى', 'الي', 'و', 'او', 'ثم', 'مع', 'ده', 'دي', 'دا', 'هو', 'هي', 'انا', 'اللي', 'الذي', 'التي', 'لما', 'لو', 'بعد', 'قبل', 'كان', 'بقى', 'ازاي', 'ايه', 'اية', 'فيه', 'فية', 'مش', 'لا', 'ما', 'بس', 'جدا', 'عند', 'عشان', 'علشان', 'حل', 'مشكله', 'عطل', 'the', 'a', 'of', 'and', 'is', 'to']);
function arNorm(s) {
  return String(s || '').toLowerCase().replace(/[ً-ٰٟـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^\p{L}\p{N}\s-]/gu, ' ');
}
const codeNorm = s => arNorm(s).replace(/[\s-]+/g, '').toUpperCase();
function arTokens(s) {
  const out = new Set();
  for (let w of arNorm(s).split(/[\s-]+/)) {
    if (!w || AR_STOP.has(w)) continue;
    if (w.length > 4 && w.startsWith('ال')) w = w.slice(2);
    else if (w.length > 5 && /^(وال|بال|فال|كال)/.test(w)) w = w.slice(3);
    if (w.length > 4 && /(ات|ين|ون|ها|هم)$/.test(w)) w = w.slice(0, -2);
    if (w.length >= 2 && !AR_STOP.has(w)) out.add(w);
  }
  return out;
}
const KB_GENERIC = new Set(['طابعه', 'طابعات', 'جهاز', 'اجهزه', 'مركز', 'فيلم', 'افلام', 'اشعه', 'صوره', 'شغال', 'بيطلع', 'بتطلع', 'بيعمل', 'بتعمل']);
const KB_SQL = 'SELECT k.*, e.photo AS emp_photo FROM kb k LEFT JOIN employees e ON e.id = k.emp_id';
function kbSearch(q, limit = 20, who = '') {
  const rows = all(KB_SQL + ' ORDER BY k.updated_at DESC LIMIT 3000');
  const qt = arTokens(q), qc = codeNorm(q), qcodes = new Set([...arNorm(q).split(/\s+/)].map(codeNorm).filter(x => /\d/.test(x) && x.length >= 2));
  if (qc && /\d/.test(qc) && qc.length <= 12) qcodes.add(qc);
  const voted = who ? new Set(all('SELECT kb_id FROM kb_votes WHERE who = ?', who).map(r => r.kb_id)) : new Set();
  const docs = rows.map(r => ({ r, tp: arTokens(r.problem + ' ' + (r.model || '')), ts: arTokens(r.solution) }));
  const df = new Map(); for (const d of docs) for (const t of new Set([...d.tp, ...d.ts])) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length || 1, idf = t => Math.max(0.02, Math.log((N + 1) / ((df.get(t) || 0) + 0.5))) ** 2 * (KB_GENERIC.has(t) ? 0.3 : 1);
  const scored = [];
  for (const { r, tp, ts } of docs) {
    let sc = 0; const rc = codeNorm(r.code);
    if (rc && qcodes.has(rc)) sc += 100;
    for (const t of qt) {
      const w = idf(t);
      if (tp.has(t)) sc += 16 * w; else if (ts.has(t)) sc += 6 * w;
      else if (t.length >= 3 && [...tp].some(x => x.startsWith(t) || t.startsWith(x))) sc += 7 * w;
    }
    if (sc < 1.5) continue;
    scored.push({ ...r, score: sc, voted: voted.has(r.id) });
  }
  const top = Math.max(0, ...scored.map(x => x.score));
  const out = scored.filter(x => x.score >= top * 0.5).map(x => ({ ...x, score: Math.round(x.score * (1 + Math.min(0.3, (x.votes || 0) * 0.03))) }));
  out.sort((x, y) => y.score - x.score || (y.votes || 0) - (x.votes || 0) || String(y.updated_at).localeCompare(String(x.updated_at)));
  return out.slice(0, limit);
}
function kbAnswer(q, res) {
  if (!String(q || '').trim()) return '';
  if (!res.length) return 'مفيش حل متسجل للعطل ده لسه. لما تحله سجّل الحل (من الزيارة أو من "إضافة حل") علشان زمايلك يستفيدوا.';
  const best = res[0], same = res.filter(r => r.code && codeNorm(r.code) === codeNorm(best.code)).length;
  let t = best.code ? `العطل ${best.code}${best.model ? ' في ' + best.model : ''} اتسجل قبل كده${same > 1 ? ' ' + same + ' مرات' : ''}.` : `لقيت ${res.length} حالة شبه المشكلة دي.`;
  t += ` أنسب حل${best.votes ? ` (${best.votes} ${best.votes > 2 && best.votes < 11 ? 'مهندسين' : 'مهندس'} قالوا إنه نفع)` : ''}: ${best.solution}`;
  t += ` — ${best.author || 'مهندس'}${best.center_name ? '، ' + best.center_name : ''}.`;
  return t;
}
function kbRecurring(days = 60) {
  const from = addDays(nowLocal().date, -days);
  const ev = [
    ...all('SELECT code, model, problem, center_id, center_name, substr(created_at,1,10) AS d FROM kb WHERE created_at >= ?', from),
    ...all("SELECT fault_code AS code, fault_model AS model, fault_desc AS problem, center_id, center_name, date AS d FROM visits WHERE date >= ? AND (fault_code IS NOT NULL AND fault_code <> '') AND id NOT IN (SELECT visit_id FROM kb WHERE visit_id IS NOT NULL)", from),
  ];
  const g = new Map();
  for (const e of ev) {
    const key = e.code ? 'C:' + codeNorm(e.code) : 'P:' + [...arTokens(e.problem)].sort().slice(0, 4).join(' ');
    if (key === 'P:') continue;
    if (!g.has(key)) g.set(key, { code: e.code || null, model: e.model || null, problem: e.problem, count: 0, centers: new Map(), last: '' });
    const x = g.get(key); x.count++; x.last = e.d > x.last ? e.d : x.last; if (!x.model && e.model) x.model = e.model;
    const cn = e.center_name || '—'; x.centers.set(cn, (x.centers.get(cn) || 0) + 1);
  }
  return [...g.values()].filter(x => x.count >= 2).map(x => {
    const centers = [...x.centers.entries()].sort((a, b) => b[1] - a[1]);
    return { code: x.code, model: x.model, problem: x.problem, count: x.count, last: x.last, centers: centers.map(([name, n]) => ({ name, n })), same_center: centers[0] && centers[0][1] >= 2 ? centers[0][0] : null };
  }).sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)).slice(0, 12);
}
const kbWho = a => a.kind === 'emp' ? 'e' + a.emp.id : 'u' + a.user.id;
route('GET', '/api/kb', 'any', (b, a, c) => {
  const q = c.url.searchParams.get('q') || '';
  const who = kbWho(a);
  if (q.trim()) { const res = kbSearch(q, 25, who); return { q, rows: res, answer: kbAnswer(q, res) }; }
  const voted = new Set(all('SELECT kb_id FROM kb_votes WHERE who = ?', who).map(r => r.kb_id));
  return {
    rows: all(KB_SQL + ' ORDER BY k.updated_at DESC LIMIT 300').map(r => ({ ...r, voted: voted.has(r.id) })),
    recurring: kbRecurring(), models: all("SELECT model, COUNT(*) AS n FROM kb WHERE model IS NOT NULL AND model <> '' GROUP BY model ORDER BY n DESC LIMIT 40").map(r => r.model),
    total: one('SELECT COUNT(*) AS n FROM kb').n,
  };
});
function kbInsert(x, now) {
  const r = run('INSERT INTO kb (code, model, problem, solution, emp_id, author, center_id, center_name, visit_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    x.code || null, x.model || null, x.problem, x.solution, x.emp_id || null, x.author || null, x.center_id || null, x.center_name || null, x.visit_id || null, now.ts, now.ts);
  return Number(r.lastInsertRowid);
}
function kbNotify(entry, authorEmp) {
  const d = { author: entry.author, code: entry.code, problem: entry.problem, model: entry.model };
  broadcast('kb', d);
  sseSend(c => c.kind === 'emp' && c.id !== authorEmp, { type: 'kb', ...d });
}
route('POST', '/api/kb/save', 'any', (b, a) => {
  const now = nowLocal();
  const problem = str(b.problem, 300), solution = str(b.solution, 3000);
  if (!problem) fail(400, 'اكتب المشكلة أو العطل'); if (!solution) fail(400, 'اكتب الحل');
  const x = { code: str(b.code, 40), model: str(b.model, 80), problem, solution };
  if (Number(b.id)) {
    const k = one('SELECT * FROM kb WHERE id = ?', Number(b.id)); if (!k) fail(404, 'مش موجود');
    if (a.kind === 'emp' && k.emp_id !== a.emp.id) fail(403, 'تقدر تعدّل الحلول اللي إنت كاتبها بس');
    run('UPDATE kb SET code = ?, model = ?, problem = ?, solution = ?, updated_at = ? WHERE id = ?', x.code || null, x.model || null, x.problem, x.solution, now.ts, k.id);
    broadcast('kb', {}); notifyAllEmps('kb', {}); return { ok: true, id: k.id };
  }
  const author = a.kind === 'emp' ? a.emp.name : (a.user.name || a.user.username);
  const center = num(b.center_id) ? one('SELECT id, name FROM centers WHERE id = ?', num(b.center_id)) : null;
  const id = kbInsert({ ...x, emp_id: a.kind === 'emp' ? a.emp.id : null, author, center_id: center ? center.id : null, center_name: center ? center.name : str(b.center_name, 120) }, now);
  kbNotify({ ...x, author }, a.kind === 'emp' ? a.emp.id : 0);
  return { ok: true, id };
});
route('POST', '/api/kb/delete', 'any', (b, a) => {
  const k = one('SELECT * FROM kb WHERE id = ?', Number(b.id)); if (!k) fail(404, 'مش موجود');
  if (a.kind === 'emp' && k.emp_id !== a.emp.id) fail(403, 'تقدر تمسح الحلول اللي إنت كاتبها بس');
  run('DELETE FROM kb WHERE id = ?', k.id); run('DELETE FROM kb_votes WHERE kb_id = ?', k.id);
  broadcast('kb', {}); notifyAllEmps('kb', {}); return { ok: true };
});
route('POST', '/api/kb/vote', 'any', (b, a) => {
  const k = one('SELECT * FROM kb WHERE id = ?', Number(b.id)); if (!k) fail(404, 'مش موجود');
  const who = kbWho(a);
  const had = one('SELECT kb_id FROM kb_votes WHERE kb_id = ? AND who = ?', k.id, who);
  if (had) run('DELETE FROM kb_votes WHERE kb_id = ? AND who = ?', k.id, who); else run('INSERT INTO kb_votes (kb_id, who, at) VALUES (?, ?, ?)', k.id, who, nowLocal().ts);
  const n = one('SELECT COUNT(*) AS n FROM kb_votes WHERE kb_id = ?', k.id).n; run('UPDATE kb SET votes = ? WHERE id = ?', n, k.id);
  return { ok: true, votes: n, voted: !had };
});

/* ---------- Public links: center fault-report link + printer QR stickers ---------- */
function linkSecret() { if (!SETTINGS._link_secret) setSecret('_link_secret', crypto.randomBytes(24).toString('hex')); return SETTINGS._link_secret; }
const linkSig = msg => crypto.createHmac('sha256', linkSecret()).update(msg).digest('base64url').slice(0, 10);
const centerKey = id => `c${id}.${linkSig('c|' + id)}`;
const deviceKey = id => `d${id}.${linkSig('d|' + id)}`;
function parseLinkKey(k) {
  const m = /^([cd])(\d+)\.([A-Za-z0-9_-]{10})$/.exec(String(k || '')); if (!m || linkSig(m[1] + '|' + m[2]) !== m[3]) return null;
  if (m[1] === 'c') { const c = one('SELECT * FROM centers WHERE id = ?', Number(m[2])); return c ? { center: c, device: null } : null; }
  const d = one('SELECT * FROM devices WHERE id = ?', Number(m[2])); if (!d) return null;
  return { device: d, center: one('SELECT * FROM centers WHERE id = ?', d.center_id) };
}
const linkPath = key => APP_PATH + '/r/' + key;
route('GET', '/api/links', 'user', (b, a, c) => {
  const q = c.url.searchParams;
  if (q.get('device')) { const ids = q.get('device').split(',').map(Number).filter(Boolean).slice(0, 300);
    return { rows: ids.map(id => one(DEV_SQL + ' WHERE d.id = ?', id)).filter(Boolean).map(d => ({ id: d.id, name: d.name, model: [d.brand, d.model].filter(Boolean).join(' '), serial: d.serial, center: d.center, path: linkPath(deviceKey(d.id)) })) }; }
  const cen = one('SELECT * FROM centers WHERE id = ?', Number(q.get('center'))); if (!cen) fail(404, 'المركز مش موجود');
  return { center: cen.name, path: linkPath(centerKey(cen.id)), devices: all('SELECT id, name, brand, model, serial FROM devices WHERE center_id = ? AND active = 1 ORDER BY name', cen.id).map(d => ({ ...d, path: linkPath(deviceKey(d.id)) })) };
});
route('POST', '/api/links/reset', 'user', (b, a) => { needAdmin(a); setSecret('_link_secret', crypto.randomBytes(24).toString('hex')); audit(a.who, 'links.reset', ''); return { ok: true }; });
route('POST', '/api/public/report', null, (b, a, c) => {
  rateLimit(c.ip + '|report');
  const L = parseLinkKey(b.key); if (!L || !L.center) fail(404, 'اللينك ده غير صالح.. اطلب لينك جديد من شركة الصيانة');
  const problem = str(b.problem, 600); if (!problem) fail(400, 'اكتب المشكلة');
  const name = str(b.name, 80); if (!name) fail(400, 'اكتب اسمك');
  const phone = str(b.phone, 30);
  const urgent = b.urgent ? 'urgent' : 'normal';
  const ph = b.photo ? savePhoto(checkPhoto(b.photo)) : null;
  const now = nowLocal(), tok = crypto.randomBytes(12).toString('base64url');
  const dev = L.device;
  const title = (dev ? `${dev.name}${dev.serial ? ' (' + dev.serial + ')' : ''}: ` : '') + problem.split('\n')[0].slice(0, 110);
  const id = Number(run(`INSERT INTO tasks (center_id, center_name, device_id, title, details, priority, emp_id, status, created_by, source, reporter_name, reporter_phone, track_token, photo, created_at, updated_at)
    VALUES (?,?,?,?,?,?,NULL,'new',?,'center',?,?,?,?,?,?)`, L.center.id, L.center.name, dev ? dev.id : null, title, problem, urgent, name + ' (المركز)', name, phone, tok, ph ? ph.rel : null, now.ts, now.ts).lastInsertRowid);
  broadcast('task', { id, name: L.center.name, status: 'report', label: 'بلّغ عن عطل', title: problem.slice(0, 60) });
  pushAdmins({ title: `${urgent === 'urgent' ? '🚨' : '📞'} بلاغ عطل من ${L.center.name}`, body: `${problem.slice(0, 90)} — ${name}${phone ? ' ' + phone : ''}`, url: './#/tasks', tag: 'report' + id });
  audit(name, 'task.report', { center: L.center.name, id });
  return { ok: true, track: tok };
});
route('GET', '/api/public/track', null, (b, a, c) => {
  const t = one(TASK_SQL + ' WHERE t.track_token = ?', String(c.url.searchParams.get('t') || '-')); if (!t) fail(404, 'البلاغ مش موجود');
  return { status: t.status, title: t.title, center: t.center || t.c_name || t.center_name, emp: t.emp_name ? t.emp_name.split(' ').slice(0, 2).join(' ') : null, emp_phone: t.emp_id && ['accepted', 'onway', 'arrived'].includes(t.status) ? t.emp_phone : null,
    created_at: t.created_at, accepted_at: t.accepted_at, onway_at: t.onway_at, arrived_at: t.arrived_at, done_at: t.done_at, company: SETTINGS.company_name, phone: SETTINGS.push_contact || null,
    report: t.visit_id ? (one('SELECT rate_token FROM visits WHERE id = ?', t.visit_id) || {}).rate_token : null };
});
route('GET', '/api/my/device', 'emp', (b, a, c) => {
  const L = parseLinkKey(c.url.searchParams.get('k')); if (!L || !L.device) fail(404, 'الستيكر ده مش لطابعة متسجلة');
  const d = L.device;
  const visits = all(VISIT_SQL + ' WHERE v.device_id = ? ORDER BY v.at DESC LIMIT 40', d.id).map(visitOut);
  const model = [d.brand, d.model].filter(Boolean).join(' ');
  const kbr = (model || d.name) ? kbSearch(model + ' ' + d.name, 8, kbWho(a)) : [];
  return { device: { ...d, center: L.center ? L.center.name : '', center_lat: L.center ? L.center.lat : null, model_full: model }, visits, tasks: all(TASK_SQL + " WHERE t.device_id = ? AND t.status IN ('new','accepted','onway','arrived')", d.id).map(taskOut), kb: kbr };
});
function reportPageHtml(L, key) {
  const c = L.center, d = L.device, base = APP_PATH;
  const logo = SETTINGS.company_logo ? `<img src="${base}/logo?v=${logoVer()}" alt="">` : htmlEsc(String(SETTINGS.company_name || 'E').slice(0, 1));
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0a2357"><title>بلاغ عطل — ${htmlEsc(c.name)}</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}html{-webkit-text-size-adjust:100%}body{font-family:Cairo,Tahoma,Arial,sans-serif;background:#eef3fa;color:#0d1b3a;padding:16px 14px 40px;line-height:1.7}
.w{max-width:560px;margin:0 auto}.card{background:#fff;border-radius:22px;box-shadow:0 20px 50px -25px rgba(10,35,87,.4);overflow:hidden;margin-bottom:14px}
.h{background:linear-gradient(120deg,#0a2357,#1b4aa6);color:#fff;padding:20px 22px;display:flex;align-items:center;gap:14px;position:relative}.h::after{content:'';position:absolute;bottom:0;right:0;width:140px;height:5px;background:#f7c12d}
.lg{width:54px;height:54px;border-radius:16px;background:#f7c12d;color:#0a2357;display:grid;place-items:center;font-weight:900;font-size:22px;flex-shrink:0;overflow:hidden}.lg img{width:100%;height:100%;object-fit:contain;background:#fff;padding:4px}
.h b{font-size:18px;display:block}.h span{color:#cfe0ff;font-size:13px}.b{padding:18px 20px}
.dev{background:#f5f8fe;border-radius:14px;padding:10px 14px;margin-bottom:14px;font-size:14px}.dev b{color:#0a2357}
label{display:block;font-weight:800;font-size:13.5px;margin:12px 0 5px;color:#0a2357}
input,textarea{width:100%;font:inherit;font-size:16px;border:1.5px solid #e2e9f4;border-radius:14px;padding:11px 14px;background:#fff;color:#0d1b3a;outline:none}input:focus,textarea:focus{border-color:#1b4aa6}
.row{display:flex;gap:10px}.row>*{flex:1;min-width:0}
.urg{display:flex;align-items:center;gap:10px;margin-top:12px;font-weight:700;background:#fdecee;color:#b4232f;border-radius:14px;padding:10px 14px}.urg input{width:22px;height:22px;flex:none}
.ph{display:flex;align-items:center;gap:10px;border:2px dashed #e2e9f4;border-radius:14px;padding:12px;margin-top:6px;cursor:pointer;color:#6b7a99;font-weight:700}.ph img{width:70px;height:70px;object-fit:cover;border-radius:10px}
.btn{display:block;width:100%;border:0;border-radius:16px;background:linear-gradient(135deg,#1b4aa6,#0a2357);color:#fff;font:inherit;font-weight:900;font-size:17px;padding:14px;margin-top:18px;cursor:pointer}.btn:disabled{opacity:.6}
.err{color:#dc3545;font-weight:700;margin-top:10px;display:none}.ok{text-align:center;padding:26px 20px}
.steps{margin-top:14px;text-align:right}.st{display:flex;gap:12px;align-items:flex-start;padding:8px 0;position:relative}.st i{width:22px;height:22px;border-radius:50%;border:3px solid #e2e9f4;background:#fff;flex-shrink:0;margin-top:2px}
.st.on i{background:#14955a;border-color:#14955a;box-shadow:0 0 0 4px #e5f6ed}.st.cur i{background:#f7c12d;border-color:#f7c12d;box-shadow:0 0 0 4px #fff6d9;animation:p 1.4s infinite}@keyframes p{50%{transform:scale(1.15)}}
.st b{display:block;font-size:14.5px}.st span{font-size:12.5px;color:#6b7a99}.st:not(:last-child)::after{content:'';position:absolute;right:10px;top:30px;bottom:-6px;width:3px;background:#e2e9f4}
.tech{margin-top:10px;font-size:13px;color:#6b7a99;text-align:center}.tech a{color:#1b4aa6;font-weight:800}.mut{color:#6b7a99;font-size:13px}</style></head><body><div class="w">
<div class="card"><div class="h"><div class="lg">${logo}</div><div><b>${htmlEsc(SETTINGS.company_name)}</b><span>بلاغ عطل — ${htmlEsc(c.name)}</span></div></div>
<div class="b" id="main">
${d ? `<div class="dev">🖨️ <b>${htmlEsc(d.name)}</b>${d.brand || d.model ? ' — ' + htmlEsc([d.brand, d.model].filter(Boolean).join(' ')) : ''}${d.serial ? `<br><span class="mut">S/N ${htmlEsc(d.serial)}</span>` : ''}</div>` : ''}
<form id="f"><label>إيه المشكلة؟ *</label><textarea name="problem" rows="3" placeholder="مثال: الطابعة بتطلع خطوط على الفيلم / ظهر كود E-104" required></textarea>
<div class="row"><div><label>اسمك *</label><input name="name" required autocomplete="name"></div><div><label>موبايلك</label><input name="phone" inputmode="tel" autocomplete="tel"></div></div>
<label>صورة للمشكلة أو للشاشة (اختياري)</label><label class="ph" id="phl"><input type="file" accept="image/*" id="phin" hidden><span id="pht">📷 صوّر الفيلم أو رسالة العطل</span></label>
<label class="urg"><input type="checkbox" name="urgent"> عاجل — الشغل واقف</label>
<button class="btn" id="sb">إرسال البلاغ</button><div class="err" id="er"></div></form></div></div>
<p class="mut" style="text-align:center">البلاغ بيوصل لشركة الصيانة فورًا وتقدر تتابعه من الصفحة دي</p>
${d ? `<p class="mut" style="text-align:center;margin-top:10px">للفنيين: <a href="${base}/?emp&dev=${encodeURIComponent(key)}" style="color:#1b4aa6;font-weight:800">افتح سجل الطابعة في البرنامج</a></p>` : ''}
</div><script>
(function(){var KEY=${JSON.stringify(key)},B=${JSON.stringify(base)},photo=null,LS='rep_'+KEY;
function $(i){return document.getElementById(i)}function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function t12(ts){if(!ts)return'';var h=+ts.slice(11,13),m=ts.slice(14,16);return(h%12||12)+':'+m+(h<12?' ص':' م')}
$('phin').onchange=function(e){var f=e.target.files[0];if(!f)return;var img=new Image(),u=URL.createObjectURL(f);img.onload=function(){var s=Math.min(1,1100/Math.max(img.width,img.height)),c=document.createElement('canvas');c.width=img.width*s;c.height=img.height*s;c.getContext('2d').drawImage(img,0,0,c.width,c.height);var q=.6,d=c.toDataURL('image/jpeg',q);while(d.length>560000&&q>.25){q-=.1;d=c.toDataURL('image/jpeg',q)}photo=d;$('pht').innerHTML='<img src="'+d+'"> الصورة جاهزة';URL.revokeObjectURL(u)};img.src=u};
$('f').onsubmit=function(e){e.preventDefault();var f=e.target,b=$('sb');b.disabled=true;b.textContent='جاري الإرسال...';$('er').style.display='none';
fetch(B+'/api/public/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:KEY,problem:f.problem.value,name:f.name.value,phone:f.phone.value,urgent:f.urgent.checked,photo:photo})}).then(function(r){return r.json()}).then(function(j){if(j.error)throw new Error(j.error);try{localStorage.setItem(LS,j.track);localStorage.setItem('rep_name',f.name.value);localStorage.setItem('rep_phone',f.phone.value)}catch(x){}track(j.track,true)}).catch(function(er){$('er').textContent=er.message||'حصلت مشكلة';$('er').style.display='block';b.disabled=false;b.textContent='إرسال البلاغ'})};
try{$('f').name.value=localStorage.getItem('rep_name')||'';$('f').phone.value=localStorage.getItem('rep_phone')||''}catch(x){}
var timer=null;function track(t,first){fetch(B+'/api/public/track?t='+encodeURIComponent(t)).then(function(r){return r.json()}).then(function(j){if(j.error){try{localStorage.removeItem(LS)}catch(x){}return}
var S=[['created_at','البلاغ وصل للشركة','اتسجل '+t12(j.created_at)],['emp','اتحدد فني',j.emp?'م. '+esc(j.emp):'جاري تحديد أقرب فني'],['accepted_at','الفني قبل البلاغ',t12(j.accepted_at)],['onway_at','الفني في الطريق ليك 🚗',t12(j.onway_at)],['arrived_at','الفني وصل',t12(j.arrived_at)],['done_at','المشكلة اتحلت ✅',t12(j.done_at)]];
var lastOn=-1;S.forEach(function(s,i){if(j[s[0]])lastOn=i});
var h='<div class="ok"><div style="font-size:44px">'+(j.status==='done'?'✅':j.status==='cancelled'?'⚪':'📨')+'</div><b style="font-size:19px;color:#0a2357">'+(j.status==='done'?'المشكلة اتحلت':j.status==='cancelled'?'البلاغ اتقفل':(first?'البلاغ وصل ✓':'متابعة البلاغ'))+'</b><div class="mut">'+esc(j.title)+'</div><div class="steps">';
S.forEach(function(s,i){h+='<div class="st '+(i<=lastOn?'on':(i===lastOn+1&&j.status!=='done'&&j.status!=='cancelled'?'cur':''))+'"><i></i><div><b>'+s[1]+'</b><span>'+(i<=lastOn||i===1?s[2]:'')+'</span></div></div>'});
h+='</div>'+(j.emp_phone?'<div class="tech">تقدر تكلم الفني: <a href="tel:'+esc(j.emp_phone)+'">'+esc(j.emp_phone)+'</a></div>':'')+(j.report?'<a class="btn" href="'+B+'/v/'+j.report+'">تقرير الزيارة وتقييم الخدمة ⭐</a>':'')+'<button class="btn" style="background:#eef3fa;color:#0a2357" onclick="localStorage.removeItem(\\''+LS+'\\');location.reload()">بلاغ جديد</button></div>';
$('main').innerHTML=h;clearTimeout(timer);if(j.status!=='done'&&j.status!=='cancelled')timer=setTimeout(function(){track(t)},20000)}).catch(function(){timer=setTimeout(function(){track(t)},30000)})}
try{var old=localStorage.getItem(LS);if(old)track(old)}catch(x){}})();
</script></body></html>`;
}

/* ---------- Rewards & recognition (animated card on the employee's phone) ---------- */
route('POST', '/api/rewards/send', 'user', (b, a) => {
  const now = nowLocal();
  let emps = [];
  if (b.target === 'all') emps = all('SELECT id, name FROM employees WHERE active = 1');
  else if (b.target === 'dept') emps = all('SELECT id, name FROM employees WHERE active = 1 AND dept_id = ?', num(b.dept_id));
  else emps = (Array.isArray(b.emp_ids) ? b.emp_ids : [b.emp_id]).map(Number).filter(Boolean).map(id => one('SELECT id, name FROM employees WHERE id = ?', id)).filter(Boolean);
  if (!emps.length) fail(400, 'اختار الموظف');
  const title = str(b.title, 80) || 'شكرًا ليك';
  const message = str(b.message, 600); if (!message) fail(400, 'اكتب الرسالة');
  const stars = Math.max(0, Math.min(5, Math.round(Number(b.stars) || 0)));
  let amount = Math.max(0, Math.min(1e6, Number(b.amount) || 0));
  if (amount && a.user.role !== 'admin') amount = 0;
  const style = ['confetti', 'trophy', 'stars', 'hearts'].includes(b.style) ? b.style : 'confetti';
  const kind = amount ? 'bonus' : stars ? 'stars' : 'msg';
  tx(() => { for (const e of emps) {
    let adj = null;
    if (amount) adj = Number(run('INSERT INTO payroll_adj (emp_id, month, kind, amount, note, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', e.id, now.date.slice(0, 7), 'bonus', amount, 'مكافأة: ' + title, a.who, now.ts).lastInsertRowid);
    run('INSERT INTO rewards (emp_id, kind, title, message, stars, amount, style, adj_id, by_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', e.id, kind, title, message, stars, amount, style, adj, a.who, now.ts);
  } });
  for (const e of emps) { notifyEmp(e.id, 'reward', {}); pushEmp(e.id, { title: '🎁 عندك مفاجأة من الإدارة', body: 'افتح البرنامج علشان تشوفها', url: './?emp', tag: 'reward' }); }
  audit(a.who, 'reward.send', { n: emps.length, title, stars, amount }); broadcast('reward', {});
  return { ok: true, count: emps.length };
});
route('GET', '/api/rewards', 'user', () => ({
  rows: all('SELECT r.*, e.name AS emp_name, e.photo AS emp_photo, e.code AS emp_code FROM rewards r JOIN employees e ON e.id = r.emp_id ORDER BY r.id DESC LIMIT 500'),
  board: all("SELECT e.id AS emp_id, e.name, e.photo, COALESCE(SUM(r.stars),0) AS stars, COUNT(r.id) AS n, COALESCE(SUM(r.amount),0) AS amount FROM employees e LEFT JOIN rewards r ON r.emp_id = e.id AND r.created_at >= ? WHERE e.active = 1 GROUP BY e.id HAVING n > 0 ORDER BY stars DESC, n DESC", addDays(nowLocal().date, -90)),
}));
route('POST', '/api/rewards/delete', 'user', (b, a) => {
  needAdmin(a); const r = one('SELECT * FROM rewards WHERE id = ?', Number(b.id)); if (!r) fail(404, 'مش موجودة');
  run('DELETE FROM rewards WHERE id = ?', r.id); if (r.adj_id) run('DELETE FROM payroll_adj WHERE id = ?', r.adj_id);
  broadcast('reward', {}); return { ok: true };
});
route('GET', '/api/my/rewards', 'emp', (b, a) => ({ rows: all('SELECT * FROM rewards WHERE emp_id = ? ORDER BY id DESC LIMIT 100', a.emp.id), stars: one('SELECT COALESCE(SUM(stars),0) AS n FROM rewards WHERE emp_id = ?', a.emp.id).n }));
route('POST', '/api/my/rewards/seen', 'emp', (b, a) => {
  const r = one('SELECT * FROM rewards WHERE id = ? AND emp_id = ?', Number(b.id), a.emp.id); if (!r) fail(404, 'مش موجودة');
  if (!r.seen_at) { run('UPDATE rewards SET seen_at = ? WHERE id = ?', nowLocal().ts, r.id); broadcast('reward_seen', { name: a.emp.name, title: r.title }); }
  return { ok: true };
});

/* ---------- QR kiosk (rotating code on a screen at the site) ---------- */
function kioskSecret() { if (!SETTINGS._kiosk_secret) setSecret('_kiosk_secret', crypto.randomBytes(24).toString('hex')); return SETTINGS._kiosk_secret; }
const hmac = (msg, n = 16) => crypto.createHmac('sha256', kioskSecret()).update(msg).digest('base64url').slice(0, n);
const kioskKey = siteId => `${siteId}.${hmac('kiosk|' + siteId)}`;
function kioskSite(k) { const [id, sig] = String(k || '').split('.'); const site = one('SELECT * FROM sites WHERE id = ?', Number(id)); if (!site || sig !== hmac('kiosk|' + site.id)) fail(403, 'لينك الشاشة غير صالح'); return site; }
const QR_SLOT = 30;
function qrToken(siteId, slot) { return `${siteId}.${slot}.${hmac('qr|' + siteId + '|' + slot, 12)}`; }
function verifyQr(tok) {
  const [id, slot, sig] = String(tok || '').split('.'); const now = Math.floor(Date.now() / 1000 / QR_SLOT);
  if (!id || !slot || !sig || sig !== hmac('qr|' + id + '|' + slot, 12)) return { ok: false, err: 'كود الـ QR غير صالح' };
  if (now - Number(slot) > 2 || Number(slot) > now + 1) return { ok: false, err: 'كود الـ QR انتهى.. امسح الكود اللي على الشاشة دلوقتي' };
  return { ok: true, site_id: Number(id) };
}
route('POST', '/api/kiosk/reset', 'user', (b, a) => { needAdmin(a); setSecret('_kiosk_secret', crypto.randomBytes(24).toString('hex')); audit(a.who, 'kiosk.reset', ''); return { ok: true }; });
route('GET', '/api/kiosk/link', 'user', (b, a, c) => { needAdmin(a); const site = one('SELECT * FROM sites WHERE id = ?', Number(c.url.searchParams.get('site'))); if (!site) fail(404, 'الموقع مش موجود'); return { path: APP_PATH + '/kiosk.html?k=' + encodeURIComponent(kioskKey(site.id)) }; });
route('GET', '/api/kiosk/qr', null, (b, a, c) => {
  const site = kioskSite(c.url.searchParams.get('k'));
  const nowS = Date.now() / 1000, slot = Math.floor(nowS / QR_SLOT);
  return { site: site.name, company: SETTINGS.company_name, logo: logoVer(), token: qrToken(site.id, slot), ttl: Math.round((slot + 1) * QR_SLOT - nowS), slot_sec: QR_SLOT, now: nowLocal(), mode: SETTINGS.punch_mode };
});
route('GET', '/api/kiosk/feed', null, (b, a, c) => {
  const site = kioskSite(c.url.searchParams.get('k')); const d = nowLocal().date;
  const rows = all(`SELECT a.in_at, a.out_at, a.source, e.name, e.photo FROM attendance a JOIN employees e ON e.id = a.emp_id WHERE a.date = ? AND (e.site_id = ? OR e.site_id IS NULL) ORDER BY COALESCE(a.out_at, a.in_at) DESC LIMIT 14`, d, site.id);
  return { rows: rows.map(r => ({ name: r.name, in_at: r.in_at, out_at: r.out_at, qr: r.source === 'qr' })), count: rows.filter(r => !r.out_at).length };
});

/* ---------- Daily summary + stale location nudges ---------- */
function dailySummary() {
  const now = nowLocal(); const rows = rangeRows(now.date, now.date, {}); const c = countRows(rows);
  const late = rows.filter(r => r.status === 'late').map(r => r.name), abs = rows.filter(r => r.status === 'absent' || r.status === 'not_in').map(r => r.name);
  const v = one("SELECT COUNT(*) AS n, SUM(CASE WHEN result IN ('followup','partial','failed') THEN 1 ELSE 0 END) AS f FROM visits WHERE date = ?", now.date);
  const tOpen = one("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('new','accepted','onway','arrived')").n;
  const tDone = one("SELECT COUNT(*) AS n FROM tasks WHERE status = 'done' AND substr(done_at,1,10) = ?", now.date).n;
  const lines = [`✅ حاضر ${c.attended} • ⏰ متأخر ${c.late} • ❌ غياب ${c.absent + c.not_in} • 🌴 إجازات ${c.leave + c.mission}`, `🔧 زيارات النهارده ${v.n || 0}${v.f ? ` (${v.f} محتاجة متابعة)` : ''} • 📋 مهام خلصت ${tDone} • مفتوحة ${tOpen}`];
  if (late.length) lines.push('⏰ المتأخرين: ' + late.join('، '));
  if (abs.length) lines.push('❌ الغياب: ' + abs.join('، '));
  const due = pmDue(0).length; if (due) lines.push(`🛠️ ${due} جهاز صيانته الدورية متأخرة`);
  return { date: now.date, rate: c.rate, title: `📊 ملخص ${now.date} — نسبة الحضور ${c.rate}%`, text: lines.join('\n') };
}
route('GET', '/api/summary/today', 'user', () => dailySummary());
const nudged = new Map();
function minuteJobs() {
  try {
    const now = nowLocal();
    if (SETTINGS.daily_summary === '1' && now.time.slice(0, 5) === (SETTINGS.daily_summary_time || '20:00') && SETTINGS._summary_sent !== now.date) {
      setSecret('_summary_sent', now.date);
      const s = dailySummary(); pushAdmins({ title: s.title, body: s.text, url: './#/dashboard', tag: 'summary' }); broadcast('summary', s);
    }
    planReminders(now);
    if (SETTINGS.nudge_enabled === '1' && SETTINGS.track_enabled === '1' && Number(now.time.slice(3, 5)) % 5 === 0) {
      const iv = trackInterval(), nowM = tsMin(now.ts);
      const limit = minToTs(nowM - Number(SETTINGS.open_hours || 16) * 60);
      for (const o of all('SELECT a.emp_id, a.in_at FROM attendance a JOIN employees e ON e.id = a.emp_id WHERE a.out_at IS NULL AND a.in_at >= ? AND e.active = 1 AND e.track_enabled <> 0', limit)) {
        const last = one('SELECT at FROM locations WHERE emp_id = ? ORDER BY id DESC LIMIT 1', o.emp_id);
        const age = nowM - tsMin(last ? last.at : o.in_at);
        if (age < iv * 2 + 5) continue;
        if (Date.now() - (nudged.get(o.emp_id) || 0) < 50 * 60000) continue;
        nudged.set(o.emp_id, Date.now());
        pushEmp(o.emp_id, { title: '📍 افتح البرنامج لحظة', body: `موقعك متبعتش للإدارة من ${Math.round(age)} دقيقة — افتح البرنامج علشان يتحدث`, url: './?emp', tag: 'nudge' });
      }
    }
  } catch (e) { console.error('[jobs]', e.message); }
}
setInterval(minuteJobs, 60000).unref();

/* -------------------------------------------------------- HTTP server --- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(body);
}
function sendJson(res, status, obj) { send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'البيانات كبيرة جدا')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const s = Buffer.concat(chunks).toString('utf8'); if (!s) return resolve({}); try { resolve(JSON.parse(s)); } catch { reject(new HttpError(400, 'بيانات غير صالحة')); } });
    req.on('error', reject);
  });
}
function serveStatic(req, res, rel) {
  let p = decodeURIComponent(rel.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (path.extname(p)) return send(res, 404, 'not found');
      return serveStatic(req, res, '/index.html');
    }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || p === '/sw.js' ? 'no-cache' : 'public, max-age=3600' };
    if (p === '/sw.js') headers['Service-Worker-Allowed'] = APP_PATH ? APP_PATH + '/' : '/';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;
  if (APP_PATH) {
    if (p === APP_PATH) { res.writeHead(301, { Location: APP_PATH + '/' }); return res.end(); }
    if (p.startsWith(APP_PATH + '/')) p = p.slice(APP_PATH.length);
    else if (!p.startsWith('/api/')) { res.writeHead(302, { Location: APP_PATH + '/' }); return res.end(); }
  }
  if (req.method === 'OPTIONS') {
    return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Client-Id', 'Access-Control-Max-Age': '86400' });
  }
  if (p === '/logo' && req.method === 'GET') {
    const f = photoFile(SETTINGS.company_logo);
    if (!f) { res.writeHead(404); return res.end(); }
    return fs.stat(f, (err, st) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': f.endsWith('.png') ? 'image/png' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=3600' });
      fs.createReadStream(f).pipe(res);
    });
  }
  const rm = /^\/r\/([cd]\d+\.[A-Za-z0-9_-]{10})$/.exec(p);
  if (rm && req.method === 'GET') {
    const L = parseLinkKey(rm[1]);
    if (!L || !L.center) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<h2 style="font-family:Tahoma;text-align:center;margin-top:60px" dir="rtl">اللينك ده غير صالح.. اطلب لينك جديد من شركة الصيانة</h2>'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(reportPageHtml(L, rm[1]));
  }
  const vm = /^\/v\/([A-Za-z0-9_-]{8,40})(\/(photo|sign))?$/.exec(p);
  if (vm && req.method === 'GET') {
    const v = one(VISIT_SQL + ' WHERE v.rate_token = ?', vm[1]);
    if (!v) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<h2 style="font-family:Tahoma;text-align:center;margin-top:60px" dir="rtl">اللينك ده غير صالح أو الزيارة اتمسحت</h2>'); }
    if (vm[3]) {
      const f = photoFile(vm[3] === 'photo' ? v.photo : v.signature);
      if (!f) { res.writeHead(404); return res.end(); }
      return fs.stat(f, (err, st) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': f.endsWith('.svg') ? 'image/svg+xml' : f.endsWith('.png') ? 'image/png' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=86400' });
        fs.createReadStream(f).pipe(res);
      });
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(visitReportHtml(visitOut(v), vm[1]));
  }
  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  try {
    if (p === '/api/photo' && req.method === 'GET') {
      const a = getAuth(req, url); if (!a) fail(401, 'سجل دخول الأول');
      const rel = url.searchParams.get('f') || ''; const f = photoFile(rel); if (!f) fail(404, 'الصورة مش موجودة');
      if (a.kind === 'emp' && a.emp.photo !== rel && !one('SELECT id FROM visits WHERE emp_id = ? AND photo = ? UNION SELECT id FROM attendance WHERE emp_id = ? AND (in_photo = ? OR out_photo = ?) UNION SELECT id FROM tasks WHERE emp_id = ? AND photo = ? LIMIT 1', a.emp.id, rel, a.emp.id, rel, rel, a.emp.id, rel)) fail(403, 'غير مسموح');
      return fs.stat(f, (err, st) => {
        if (err || !st.isFile()) return sendJson(res, 404, { error: 'الصورة مش موجودة' });
        res.writeHead(200, { 'Content-Type': f.endsWith('.svg') ? 'image/svg+xml' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg', 'Content-Length': st.size, 'Cache-Control': 'private, max-age=31536000, immutable' });
        fs.createReadStream(f).pipe(res);
      });
    }
    if (p === '/api/backups/file' && req.method === 'GET') {
      const a = getAuth(req, url); if (!a || a.kind !== 'user' || a.user.role !== 'admin') fail(403, 'غير مسموح');
      const name = url.searchParams.get('name') || ''; if (!/^auto-\d{4}-\d{2}-\d{2}\.json$/.test(name)) fail(400, 'اسم غير صالح');
      const f = path.join(BACKUP_DIR, name); if (!fs.existsSync(f)) fail(404, 'النسخة مش موجودة');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${name}"` });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === '/api/events' && req.method === 'GET') {
      const a = getAuth(req, url); if (!a) fail(401, 'سجل دخول الأول');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });
      res.write(`retry: 3000\nevent: hello\ndata: {"v":${dataVersion}}\n\n`);
      const c = { res, kind: a.kind, id: a.kind === 'emp' ? a.emp.id : a.user.id }; sseClients.add(c);
      req.on('close', () => sseClients.delete(c));
      return;
    }
    const r = routes.get(req.method + ' ' + p);
    if (!r) fail(404, 'المسار غير موجود');
    let a = null;
    if (r.auth) {
      a = getAuth(req, url);
      if (!a) fail(401, 'انتهت الجلسة.. سجل دخول تاني');
      if (r.auth === 'user' && a.kind !== 'user') fail(403, 'غير مسموح');
      if (r.auth === 'emp' && a.kind !== 'emp') fail(403, 'الصفحة دي للموظفين');
      run('UPDATE sessions SET last_seen = ? WHERE token = ?', nowLocal().ts, a.token);
    }
    const body = req.method === 'POST' ? await readBody(req, p === '/api/restore' ? 300e6 : 3e6) : {};
    const out = await r.fn(body, a, { url, ip, req });
    sendJson(res, 200, out);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[ERR]', req.method, p, e);
    sendJson(res, status, { error: status === 500 ? 'حصل خطأ في السيرفر: ' + e.message : e.message });
  }
});

// clean old sessions + location history older than 120 days
function housekeeping() {
  try { run('DELETE FROM sessions WHERE last_seen < ?', addDays(nowLocal().date, -45)); } catch {}
  try { run('DELETE FROM locations WHERE at < ?', addDays(nowLocal().date, -120)); } catch {}
}
setTimeout(housekeeping, 20000).unref(); setInterval(housekeeping, 6 * 3600e3).unref();

server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  const base = APP_PATH ? APP_PATH + '/' : '/';
  console.log('');
  console.log('  ===================================================');
  console.log('   EmdadX Attendance  |  برنامج الحضور والانصراف  v' + VERSION);
  console.log('  ===================================================');
  console.log(`   على الجهاز ده :  http://localhost:${PORT}${base}`);
  for (const ip of ips) console.log(`   على الشبكة    :  http://${ip}:${PORT}${base}`);
  console.log('   دخول الإدارة  :  admin / admin');
  console.log('   قاعدة البيانات:  ' + DB_FILE);
  console.log('   ملحوظة: الموقع (GPS) على الموبايل محتاج رابط https (زي Railway)');
  console.log('  ===================================================');
  console.log('');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { db.close(); } catch {} process.exit(0); });
