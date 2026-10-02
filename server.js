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

const VERSION = '1.1.0';
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
const PHOTO_PATH_RE = /^(\d{4}-\d{2}\/[a-f0-9]{24}\.(jpg|webp)|demo\/demo-\d+\.svg)$/;
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
const LEAVE_TYPES = [...FULL_DAY_LEAVES, ...PERM_LEAVES];
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
  const { pin, device_id, ...rest } = e;
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
route('GET', '/api/public-info', null, () => ({ company_name: SETTINGS.company_name, company_sub: SETTINGS.company_sub, version: VERSION, demo: !!one('SELECT id FROM employees WHERE demo = 1 LIMIT 1') }));

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
  if (SETTINGS.require_location === '1' && !hasLoc) fail(400, 'لازم تفعّل الموقع (GPS) علشان تسجل');
  const site = emp.site_id ? one('SELECT * FROM sites WHERE id = ?', emp.site_id) : null;
  let dist = null;
  if (hasLoc && site && site.lat !== null && site.lng !== null) dist = Math.round(haversine(lat, lng, site.lat, site.lng));
  if (SETTINGS.geofence_mode === 'block' && site && site.lat !== null) {
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
      emp.id, date, now.ts, hasLoc ? lat : null, hasLoc ? lng : null, acc, dist, ph, 'mobile', now.ts, now.ts);
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
    settings: SETTINGS,
    departments: all('SELECT * FROM departments ORDER BY id'),
    shifts: all('SELECT * FROM shifts ORDER BY start_time'),
    sites: all('SELECT * FROM sites ORDER BY id'),
    employees: all('SELECT * FROM employees ORDER BY name').map(publicEmp),
    holidays: all('SELECT * FROM holidays ORDER BY date'),
    users: a.user.role === 'admin' ? all('SELECT id, username, name, role, active, created_at FROM users ORDER BY id') : [],
    pending_leaves: one("SELECT COUNT(*) AS n FROM leaves WHERE status = 'pending'").n,
    has_demo: !!one('SELECT id FROM employees WHERE demo = 1 LIMIT 1') || !!one('SELECT id FROM centers WHERE demo = 1 LIMIT 1'),
    centers: centersWithStats(),
    visits_unreviewed: one('SELECT COUNT(*) AS n FROM visits WHERE reviewed = 0').n,
    chat_unread: one("SELECT COUNT(*) AS n FROM messages WHERE sender = 'emp' AND read_at IS NULL").n,
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
  const perm = PERM_LEAVES.includes(type);
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
  if (Number(b.id)) run('UPDATE leaves SET emp_id=?, type=?, from_date=?, to_date=?, from_time=?, to_time=?, reason=?, status=?, decided_by=?, decided_at=? WHERE id=?', emp, l.type, l.from_date, l.to_date, l.from_time, l.to_time, l.reason, status, a.who, t, Number(b.id));
  else run('INSERT INTO leaves (emp_id, type, from_date, to_date, from_time, to_time, reason, status, requested_by, decided_by, decided_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', emp, l.type, l.from_date, l.to_date, l.from_time, l.to_time, l.reason, status, a.who, status === 'pending' ? null : a.who, status === 'pending' ? null : t, t);
  audit(a.who, 'leave.save', { emp, ...l, status }); broadcast('leave'); return { ok: true };
});
route('POST', '/api/leaves/decide', 'user', (b, a) => {
  const st = b.status === 'approved' ? 'approved' : b.status === 'rejected' ? 'rejected' : 'pending';
  run('UPDATE leaves SET status = ?, reply = ?, decided_by = ?, decided_at = ? WHERE id = ?', st, str(b.reply, 300), a.who, nowLocal().ts, Number(b.id));
  const lv = one('SELECT emp_id, type FROM leaves WHERE id = ?', Number(b.id));
  if (lv && st !== 'pending') notifyEmp(lv.emp_id, 'leave_decided', { status: st, leave_type: lv.type });
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
  loadSettings(); audit(a.who, 'settings', b); broadcast('settings'); notifyAllEmps('settings'); return { ok: true, settings: SETTINGS };
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

const BACKUP_TABLES = ['settings', 'users', 'departments', 'shifts', 'sites', 'employees', 'roster', 'attendance', 'leaves', 'holidays', 'centers', 'visits', 'messages', 'locations'];
function makeBackup(withPhotos) {
  const out = { app: 'emdadx-attendance', version: VERSION, at: nowLocal().ts, tables: {} };
  for (const t of BACKUP_TABLES) out.tables[t] = all(`SELECT * FROM ${t}`);
  if (withPhotos) {
    out.photos = {};
    const rels = new Set([...out.tables.visits.map(v => v.photo), ...out.tables.employees.map(e => e.photo), ...out.tables.attendance.map(a => a.in_photo), ...out.tables.attendance.map(a => a.out_photo)].filter(r => r && !r.startsWith('demo/')));
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
    }
    run('DELETE FROM employees WHERE demo = 1');
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
  return { ...v, center: v.c_name || v.center_name || '—', area: v.c_area || null, out_range: v.dist !== null && v.dist !== undefined && v.dist > radius, radius };
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

route('GET', '/api/my/visits', 'emp', (b, a) => {
  const now = nowLocal();
  return {
    now, visits: all(VISIT_SQL + ' WHERE v.emp_id = ? AND v.date >= ? ORDER BY v.at DESC LIMIT 150', a.emp.id, addDays(now.date, -30)).map(visitOut),
    centers: all('SELECT id, name, area, lat, lng, radius FROM centers WHERE active = 1 ORDER BY name'),
    work_types: workTypes(), devices: distinctVals('device', DEFAULT_DEVICES), roles: distinctVals('receiver_role', DEFAULT_ROLES),
    settings: { photo_quality: SETTINGS.photo_quality, photo_camera_only: SETTINGS.photo_camera_only, photo_required: SETTINGS.photo_required },
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
  const r = run(`INSERT INTO visits (emp_id, date, at, center_id, center_name, work_type, device, details, result, receiver_name, receiver_role, receiver_phone, arrived_at, lat, lng, acc, dist, photo, photo_size, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    emp.id, now.date, now.ts, center.id, center.name, str(b.work_type, 80), str(b.device, 100), details, VISIT_RESULTS.includes(b.result) ? b.result : 'done',
    receiver, str(b.receiver_role, 80), str(b.receiver_phone, 30), isTime(b.arrived_at) ? b.arrived_at.slice(0, 5) : null,
    hasLoc ? lat : null, hasLoc ? lng : null, acc, dist, ph ? ph.rel : null, ph ? ph.size : null, now.ts, now.ts);
  const id = Number(r.lastInsertRowid);
  broadcast('visit', { name: emp.name, center: center.name });
  if (hasLoc) reverseGeocode(lat, lng).then(addr => { if (addr) { run('UPDATE visits SET addr = ? WHERE id = ?', addr, id); broadcast('visit_geo', { id }); } });
  return { ok: true, visit: visitOut(one(VISIT_SQL + ' WHERE v.id = ?', id)) };
});
route('POST', '/api/my/visit/delete', 'emp', (b, a) => {
  const v = one('SELECT * FROM visits WHERE id = ? AND emp_id = ?', Number(b.id), a.emp.id);
  if (!v) fail(404, 'الزيارة مش موجودة');
  if (tsMin(nowLocal().ts) - tsMin(v.at) > 30) fail(403, 'مينفعش تمسح الزيارة بعد 30 دقيقة.. كلم الإدارة');
  run('DELETE FROM visits WHERE id = ?', v.id); deletePhoto(v.photo); broadcast('visit', {}); return { ok: true };
});

route('GET', '/api/visits', 'user', (b, a, c) => {
  const p = c.url.searchParams; const now = nowLocal();
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
  run('DELETE FROM visits WHERE id = ?', v.id); deletePhoto(v.photo);
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
  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  try {
    if (p === '/api/photo' && req.method === 'GET') {
      const a = getAuth(req, url); if (!a) fail(401, 'سجل دخول الأول');
      const rel = url.searchParams.get('f') || ''; const f = photoFile(rel); if (!f) fail(404, 'الصورة مش موجودة');
      if (a.kind === 'emp' && a.emp.photo !== rel && !one('SELECT id FROM visits WHERE emp_id = ? AND photo = ? UNION SELECT id FROM attendance WHERE emp_id = ? AND (in_photo = ? OR out_photo = ?) LIMIT 1', a.emp.id, rel, a.emp.id, rel, rel)) fail(403, 'غير مسموح');
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
