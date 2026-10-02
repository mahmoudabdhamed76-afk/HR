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

const VERSION = '1.0.0';
const PORT = Number(process.env.PORT) || 8686;
const HOST = process.env.HOST || '0.0.0.0';
const APP_PATH = (process.env.APP_PATH || '').replace(/\/+$/, '');
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'attendance.db');

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
`);

// safe schema upgrades for future versions
for (const sql of [
  "ALTER TABLE employees ADD COLUMN email TEXT",
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
    source: a ? a.source : null, notes: a ? a.notes : null,
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
function broadcast(type, data = {}) {
  dataVersion++;
  const msg = `event: change\ndata: ${JSON.stringify({ type, v: dataVersion, ...data })}\n\n`;
  for (const c of sseClients) { try { c.res.write(msg); } catch { sseClients.delete(c); } }
}
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
    const u = one('SELECT id, username, name, role, active FROM users WHERE id = ?', s.ref_id);
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
    ['الإدارة', '#1d4fb0'], ['المبيعات', '#f39324'], ['الحسابات', '#7a5af5'], ['المخازن والتوزيع', '#1fa45a'], ['خدمة العملاء', '#13a39a'],
  ].map(d => Number(run('INSERT INTO departments (name, color, created_at) VALUES (?, ?, ?)', d[0], d[1], t).lastInsertRowid));
  const siteId = Number(run("INSERT INTO sites (name, lat, lng, radius, address, created_at) VALUES ('المقر الرئيسي', 30.0444, 31.2357, 300, 'وسط البلد - القاهرة', ?)", t).lastInsertRowid);
  if (process.env.SEED_DEMO === '0') return;

  // demo employees
  const people = [
    ['أحمد محمود', 'مدير عام', 0, 0], ['منى السيد', 'محاسبة', 2, 0], ['محمد عبد الله', 'مندوب مبيعات', 1, 0],
    ['سارة إبراهيم', 'خدمة عملاء', 4, 1], ['كريم مصطفى', 'أمين مخزن', 3, 0], ['ياسمين علي', 'مسؤولة موارد بشرية', 0, 0],
    ['عمر حسن', 'سائق توزيع', 3, 1], ['نورهان خالد', 'مندوبة مبيعات', 1, 0], ['مصطفى جمال', 'فرد أمن', 3, 2], ['هبة عادل', 'محاسبة', 2, 0],
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
  run('UPDATE users SET pass = ? WHERE id = ?', hashSecret(b.new), u.id);
  return { ok: true };
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
    settings: { require_location: SETTINGS.require_location, geofence_mode: SETTINGS.geofence_mode, company_name: SETTINGS.company_name, bind_device: SETTINGS.bind_device },
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
  let rec;
  if (type === 'in') {
    const open = openRecord(emp.id, now);
    if (open) fail(409, `أنت مسجل حضور بالفعل الساعة ${open.in_at.slice(11, 16)}.. سجل انصراف الأول`);
    const date = pickShiftDate(emp, now);
    const ex = one('SELECT * FROM attendance WHERE emp_id = ? AND date = ?', emp.id, date);
    if (ex) fail(409, 'تم تسجيل حضورك وانصرافك لليوم ده بالفعل');
    const r = run('INSERT INTO attendance (emp_id, date, in_at, in_lat, in_lng, in_acc, in_dist, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      emp.id, date, now.ts, hasLoc ? lat : null, hasLoc ? lng : null, acc, dist, 'mobile', now.ts, now.ts);
    rec = one('SELECT * FROM attendance WHERE id = ?', Number(r.lastInsertRowid));
  } else {
    const open = openRecord(emp.id, now);
    if (!open) fail(409, 'مفيش تسجيل حضور مفتوح.. سجل حضور الأول');
    run('UPDATE attendance SET out_at = ?, out_lat = ?, out_lng = ?, out_acc = ?, out_dist = ?, updated_at = ? WHERE id = ?',
      now.ts, hasLoc ? lat : null, hasLoc ? lng : null, acc, dist, now.ts, open.id);
    rec = one('SELECT * FROM attendance WHERE id = ?', open.id);
  }
  const field = type === 'in' ? 'in_addr' : 'out_addr';
  broadcast('punch', { emp_id: emp.id, name: emp.name, punch: type, time: now.time, dist, radius: site ? site.radius : null });
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
    has_demo: !!one('SELECT id FROM employees WHERE demo = 1 LIMIT 1'),
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
  };
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
  audit(a.who, id ? 'employee.update' : 'employee.create', { id: b.id, name });
  broadcast('employees');
  return { ok: true, id: Number(b.id), code, pin: pinShown };
});
route('POST', '/api/employees/delete', 'user', (b, a) => {
  const id = Number(b.id);
  const e = one('SELECT name FROM employees WHERE id = ?', id); if (!e) fail(404, 'الموظف مش موجود');
  tx(() => {
    run('DELETE FROM attendance WHERE emp_id = ?', id); run('DELETE FROM leaves WHERE emp_id = ?', id);
    run('DELETE FROM roster WHERE emp_id = ?', id); run("DELETE FROM sessions WHERE kind = 'emp' AND ref_id = ?", id);
    run('DELETE FROM employees WHERE id = ?', id);
  });
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
  return { from, to, list: summarize(rows), counts: countRows(rows) };
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
  tx(() => { for (const k of allowed) if (b[k] !== undefined) run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', k, String(b[k]).slice(0, 200)); });
  if (b.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { run("UPDATE settings SET value = 'Africa/Cairo' WHERE key = 'timezone'"); } fmtCache.clear(); }
  loadSettings(); audit(a.who, 'settings', b); broadcast('settings'); return { ok: true, settings: SETTINGS };
});
route('POST', '/api/users/save', 'user', (b, a) => {
  needAdmin(a);
  const username = str(b.username, 60); if (!username) fail(400, 'اكتب اسم المستخدم');
  const role = b.role === 'admin' ? 'admin' : 'hr'; const id = Number(b.id) || 0;
  try {
    if (id) {
      if (id === a.user.id && (role !== 'admin' || b.active === false)) fail(400, 'مينفعش تشيل صلاحية المدير من حسابك');
      run('UPDATE users SET username=?, name=?, role=?, active=? WHERE id=?', username, str(b.name, 80), role, b.active === false ? 0 : 1, id);
      if (b.password) run('UPDATE users SET pass = ? WHERE id = ?', hashSecret(b.password), id);
    } else {
      if (!b.password || String(b.password).length < 4) fail(400, 'كلمة المرور لازم 4 حروف على الأقل');
      run('INSERT INTO users (username, name, pass, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)', username, str(b.name, 80), hashSecret(b.password), role, nowLocal().ts);
    }
  } catch (e) { if (e instanceof HttpError) throw e; if (String(e.message).includes('UNIQUE')) fail(400, 'اسم المستخدم موجود قبل كده'); throw e; }
  return { ok: true };
});
route('POST', '/api/users/delete', 'user', (b, a) => {
  needAdmin(a); const id = Number(b.id);
  if (id === a.user.id) fail(400, 'مينفعش تمسح حسابك');
  run("DELETE FROM sessions WHERE kind = 'user' AND ref_id = ?", id); run('DELETE FROM users WHERE id = ?', id); return { ok: true };
});

const BACKUP_TABLES = ['settings', 'users', 'departments', 'shifts', 'sites', 'employees', 'roster', 'attendance', 'leaves', 'holidays'];
route('GET', '/api/backup', 'user', (b, a) => {
  needAdmin(a);
  const out = { app: 'emdadx-attendance', version: VERSION, at: nowLocal().ts, tables: {} };
  for (const t of BACKUP_TABLES) out.tables[t] = all(`SELECT * FROM ${t}`);
  return out;
});
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
  if (!one("SELECT id FROM users WHERE role = 'admin' AND active = 1 LIMIT 1")) run("INSERT INTO users (username, name, pass, role, created_at) VALUES ('admin', 'مدير النظام', ?, 'admin', ?)", hashSecret('admin'), nowLocal().ts);
  loadSettings(); fmtCache.clear(); audit(a.who, 'restore', b.at); broadcast('restore'); return { ok: true };
});
route('POST', '/api/demo/clear', 'user', (b, a) => {
  needAdmin(a);
  tx(() => {
    const ids = all('SELECT id FROM employees WHERE demo = 1').map(r => r.id);
    for (const id of ids) {
      run('DELETE FROM attendance WHERE emp_id = ?', id); run('DELETE FROM leaves WHERE emp_id = ?', id);
      run('DELETE FROM roster WHERE emp_id = ?', id); run("DELETE FROM sessions WHERE kind = 'emp' AND ref_id = ?", id);
    }
    run('DELETE FROM employees WHERE demo = 1');
  });
  audit(a.who, 'demo.clear', ''); broadcast('employees'); return { ok: true };
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
    if (p === '/api/events' && req.method === 'GET') {
      const a = getAuth(req, url); if (!a || a.kind !== 'user') fail(401, 'سجل دخول الأول');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });
      res.write(`retry: 3000\nevent: hello\ndata: {"v":${dataVersion}}\n\n`);
      const c = { res }; sseClients.add(c);
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
    const body = req.method === 'POST' ? await readBody(req, p === '/api/restore' ? 80e6 : 2e6) : {};
    const out = await r.fn(body, a, { url, ip, req });
    sendJson(res, 200, out);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[ERR]', req.method, p, e);
    sendJson(res, status, { error: status === 500 ? 'حصل خطأ في السيرفر: ' + e.message : e.message });
  }
});

// clean old sessions daily
setInterval(() => { try { run('DELETE FROM sessions WHERE last_seen < ?', addDays(nowLocal().date, -45)); } catch {} }, 6 * 3600e3).unref();

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
