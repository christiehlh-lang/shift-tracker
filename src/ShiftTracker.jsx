import { useState, useEffect, useRef } from "react";
import { Calendar, DollarSign, Plus, Trash2, ChevronLeft, ChevronRight, X, AlertTriangle, FileText, Edit3, Upload, Check, Settings } from "lucide-react";
import { parseAspenPdf } from "./aspenPdf";
import { parseFulltimePdf, detectPdfKind } from "./fulltimePdf";

// ─── Default pay rates (editable in Rates tab) ───
const DEFAULT_RATES = {
  aspen: {
    ordinary: 52.50, evening: 60.38, saturday: 78.70, sunday: 91.80,
    publicHoliday: 105.00, onCallMF: 50.00, onCallSat: 80.00, onCallSunPH: 110.00,
    calledIn15: 78.00, calledIn2: 105.00,
  },
  kempsey: {
    morning: 61.82, afternoon10to1: 67.44, afternoon1to4: 68.84,
    saturday: 84.30, sunday: 98.35,
  },
  fulltime: { gross: 5068, net: 3064 },
};

const RATE_LABELS = {
  aspen: [
    { key: "ordinary", label: "Ordinary (07-15)", unit: "/hr" },
    { key: "evening", label: "Evening (15-07)", unit: "/hr" },
    { key: "saturday", label: "Saturday", unit: "/hr" },
    { key: "sunday", label: "Sunday", unit: "/hr" },
    { key: "publicHoliday", label: "Public Holiday", unit: "/hr" },
    { key: "onCallMF", label: "On-call Mon-Fri", unit: "flat" },
    { key: "onCallSat", label: "On-call Sat", unit: "flat" },
    { key: "onCallSunPH", label: "On-call Sun/PH", unit: "flat" },
    { key: "calledIn15", label: "Called-in 1.5x", unit: "/hr" },
    { key: "calledIn2", label: "Called-in 2x", unit: "/hr" },
  ],
  kempsey: [
    { key: "morning", label: "Morning (6am-10am)", unit: "/hr" },
    { key: "afternoon10to1", label: "Afternoon (10am-1pm)", unit: "/hr" },
    { key: "afternoon1to4", label: "Afternoon (1pm-4pm)", unit: "/hr" },
    { key: "saturday", label: "Saturday", unit: "/hr" },
    { key: "sunday", label: "Sunday", unit: "/hr" },
  ],
  fulltime: [
    { key: "gross", label: "Gross per fortnight", unit: "" },
    { key: "net", label: "Net per fortnight", unit: "" },
  ],
};

const JOBS = {
  aspen: { name: "Aspen", color: "#F37221", light: "#fce3cc" },
  kempsey: { name: "Kempsey ED", color: "#0A654A", light: "#d4f0b6" },
  fulltime: { name: "Full-time", color: "#CD70AD", light: "#f6e1ef" },
};

// ─── Storage helpers ───
function getStorageKey(k) { return `shifttracker_${k}`; }

async function loadData(key, fallback) {
  try {
    const raw = localStorage.getItem(getStorageKey(key));
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

async function saveData(key, val) {
  try {
    localStorage.setItem(getStorageKey(key), JSON.stringify(val));
  } catch (e) { console.error("Save failed:", e); }
}

function mergeRates(stored) {
  if (!stored) return { ...DEFAULT_RATES };
  return {
    aspen: { ...DEFAULT_RATES.aspen, ...(stored.aspen || {}) },
    kempsey: { ...DEFAULT_RATES.kempsey, ...(stored.kempsey || {}) },
    fulltime: { ...DEFAULT_RATES.fulltime, ...(stored.fulltime || {}) },
  };
}

// ─── Date helpers ───
function todaySydney() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short" });
}

function fmtMoney(n) {
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function getDayOfWeek(dateStr) {
  return new Date(dateStr).getDay();
}

function getFortnightKey(dateStr) {
  const anchor = new Date(2026, 5, 20);
  const d = new Date(dateStr);
  const diff = Math.floor((d - anchor) / (1000 * 60 * 60 * 24));
  const fnNum = Math.floor(diff / 14);
  const start = new Date(anchor.getTime() + fnNum * 14 * 86400000);
  const end = new Date(start.getTime() + 13 * 86400000);
  return `${ymd(start)}_${ymd(end)}`;
}

function shiftFortnightKey(s) {
  if (s.job === "kempsey") {
    const d = new Date(s.date + "T00:00:00");
    d.setDate(d.getDate() - 2);
    return getFortnightKey(d);
  }
  return getFortnightKey(s.date);
}

// ─── Pay cycle helpers ───
const JOB_CYCLE = {
  aspen:    { anchor: new Date(2026, 5, 20), endOffset: 13, payFromMon: 3 },
  kempsey:  { anchor: new Date(2026, 5, 22), endOffset: 13, payFromMon: 3 },
  fulltime: { anchor: new Date(2026, 5, 15), endOffset: 11, payFromMon: 2 },
};

function payWindow(job, base, offset = 0) {
  const c = JOB_CYCLE[job];
  const d = base instanceof Date ? base : new Date(base + "T00:00:00");
  const diff = Math.floor((d - c.anchor) / 86400000);
  const fn = Math.floor(diff / 14) + offset;
  const start = new Date(c.anchor.getTime() + fn * 14 * 86400000);
  const end = new Date(start.getTime() + c.endOffset * 86400000);
  return { start, end };
}

function paydayFor(job, win) {
  const c = JOB_CYCLE[job];
  const d = new Date(win.end);
  const dow = d.getDay();
  const monOffset = dow === 0 ? -6 : 1 - dow;
  const monNext = new Date(d);
  monNext.setDate(d.getDate() + monOffset + 7);
  const pay = new Date(monNext);
  pay.setDate(monNext.getDate() + c.payFromMon);
  return pay;
}

function inWindow(dateStr, win) {
  const d = new Date(dateStr + "T00:00:00");
  return d >= win.start && d <= win.end;
}

function windowLabel(win) {
  const fmt = (d) => d.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", weekday: "short", day: "2-digit", month: "short" });
  return `${fmt(win.start)} – ${fmt(win.end)}`;
}

// ─── Pay calculations (accept rates parameter) ───
function calcAspenPay(shift, rates) {
  const R = rates.aspen;
  const dow = getDayOfWeek(shift.date);
  const hours = parseFloat(shift.hours) || 0;
  if (shift.shiftType === "oncall") {
    if (dow === 0 || shift.isPublicHoliday) return R.onCallSunPH;
    if (dow === 6) return R.onCallSat;
    return R.onCallMF;
  }
  if (shift.shiftType === "calledin15") return hours * R.calledIn15;
  if (shift.shiftType === "calledin2") return hours * R.calledIn2;
  if (shift.isPublicHoliday) return hours * R.publicHoliday;
  if (dow === 0) return hours * R.sunday;
  if (dow === 6) return hours * R.saturday;
  const ordHrs = parseFloat(shift.ordinaryHours) || 0;
  const eveHrs = parseFloat(shift.eveningHours) || 0;
  if (ordHrs || eveHrs) return ordHrs * R.ordinary + eveHrs * R.evening;
  return hours * R.ordinary;
}

function calcKempseyPay(shift, rates) {
  const R = rates.kempsey;
  const dow = getDayOfWeek(shift.date);
  const hours = parseFloat(shift.hours) || 0;
  if (dow === 0) return hours * R.sunday;
  if (dow === 6) return hours * R.saturday;
  if (shift.kempseyRate === "afternoon10to1") return hours * R.afternoon10to1;
  if (shift.kempseyRate === "afternoon1to4") return hours * R.afternoon1to4;
  return hours * R.morning;
}

function calcShiftPay(shift, rates) {
  if (shift.job === "aspen") return calcAspenPay(shift, rates);
  if (shift.job === "kempsey") return calcKempseyPay(shift, rates);
  return 0;
}

function estimateTakeHome(gross) {
  if (gross <= 0) return 0;
  return Math.min(gross, Math.round(gross * 0.5 + 505));
}

// ─── Pay breakdowns ───
function aspenBreakdown(list, rates) {
  const R = rates.aspen;
  const cats = { ordinary: 0, evening: 0, saturday: 0, sunday: 0, publicHoliday: 0 };
  const oncall = { mf: 0, sat: 0, sunph: 0 };
  const calledin = { h15: 0, h2: 0 };
  let gross = 0, workedHours = 0;
  list.forEach(s => {
    gross += calcShiftPay(s, rates);
    const dow = getDayOfWeek(s.date);
    const hours = parseFloat(s.hours) || 0;
    if (s.shiftType === "oncall") {
      if (dow === 0 || s.isPublicHoliday) oncall.sunph++;
      else if (dow === 6) oncall.sat++;
      else oncall.mf++;
      return;
    }
    if (s.shiftType === "calledin15") { calledin.h15 += hours; workedHours += hours; return; }
    if (s.shiftType === "calledin2") { calledin.h2 += hours; workedHours += hours; return; }
    workedHours += hours;
    if (s.isPublicHoliday) { cats.publicHoliday += hours; return; }
    if (dow === 0) { cats.sunday += hours; return; }
    if (dow === 6) { cats.saturday += hours; return; }
    const ord = parseFloat(s.ordinaryHours) || 0;
    const eve = parseFloat(s.eveningHours) || 0;
    if (ord || eve) { cats.ordinary += ord; cats.evening += eve; }
    else cats.ordinary += hours;
  });
  return { cats, oncall, calledin, gross, workedHours };
}

function kempseyBreakdown(list, rates) {
  const rateMap = { morning: 0, afternoon10to1: 0, afternoon1to4: 0, saturday: 0, sunday: 0 };
  let gross = 0, hours = 0;
  list.forEach(s => {
    gross += calcShiftPay(s, rates);
    const h = parseFloat(s.hours) || 0;
    hours += h;
    const dow = getDayOfWeek(s.date);
    if (dow === 0) rateMap.sunday += h;
    else if (dow === 6) rateMap.saturday += h;
    else rateMap[s.kempseyRate || "morning"] += h;
  });
  return { rates: rateMap, gross, hours };
}

function jobGrossInWindow(job, shifts, win, rates) {
  const list = shifts.filter(s => s.job === job && s.entryType === "shift" && inWindow(s.date, win));
  if (job === "aspen") return aspenBreakdown(list, rates).gross;
  if (job === "kempsey") return kempseyBreakdown(list, rates).gross;
  return rates.fulltime.gross;
}

function upcomingPaydays(shifts, base, rates, count = 4) {
  const today = new Date(base instanceof Date ? base : base + "T00:00:00");
  today.setHours(0, 0, 0, 0);
  const entries = [];
  for (const job of ["aspen", "kempsey", "fulltime"]) {
    for (let off = -1; off <= 3; off++) {
      const win = payWindow(job, today, off);
      const pd = paydayFor(job, win);
      if (pd >= today) entries.push({ job, win, payday: pd, gross: jobGrossInWindow(job, shifts, win, rates) });
    }
  }
  entries.sort((a, b) => a.payday - b.payday);
  const groups = [];
  for (const e of entries) {
    const key = ymd(e.payday);
    let g = groups.find(x => x.key === key);
    if (!g) { g = { key, payday: e.payday, items: [] }; groups.push(g); }
    if (!g.items.some(it => it.job === e.job)) g.items.push(e);
  }
  return groups.slice(0, count);
}

function itemNet(it, rates) {
  return it.job === "fulltime" ? rates.fulltime.net : estimateTakeHome(it.gross);
}
function itemGross(it, rates) {
  return it.job === "fulltime" ? rates.fulltime.gross : it.gross;
}

// ─── Calendar helpers (Monday-first) ───
function getMonthDays(year, month) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const days = [];
  const startDay = first.getDay();
  const pad = startDay === 0 ? 6 : startDay - 1;
  for (let i = 0; i < pad; i++) days.push(null);
  for (let d = 1; d <= last.getDate(); d++) days.push(d);
  return days;
}

function toDateStr(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function ymd(d) {
  return toDateStr(d.getFullYear(), d.getMonth(), d.getDate());
}

function entryLabel(s) {
  if (s.entryType === "meeting") return s.notes ? s.notes : "Meeting";
  if (s.entryType === "note") return s.notes ? s.notes : "Note";
  if (s.job === "aspen") {
    if (s.shiftType === "oncall") return "On-call";
    if (s.shiftType === "calledin15") return "Called-in 1.5x";
    if (s.shiftType === "calledin2") return "Called-in 2x";
    const m = (s.notes || "").match(/^(OCC Health|HIAS|TRAIN)/);
    return m ? m[1] : "Aspen";
  }
  if (s.job === "kempsey") return "Kempsey";
  return "Full-time";
}

function daysUntil(d, base) {
  const today = new Date(base instanceof Date ? base : base + "T00:00:00");
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  return `in ${Math.round(days / 7)} weeks`;
}

// ─── Styles ───
const iconBtnStyle = { background: "none", border: "none", cursor: "pointer", padding: 6, color: "var(--muted)", borderRadius: 6 };
const primaryBtn = { background: "var(--accent)", color: "#fff", border: "none", borderRadius: 10, padding: "12px 20px", fontWeight: 600, fontSize: 15, cursor: "pointer" };
const tagBtn = { border: "1px solid var(--border)", borderRadius: 8, padding: "7px 14px", fontSize: 13, cursor: "pointer", fontWeight: 500, transition: "all 0.15s" };
const fieldGroup = { marginBottom: 14 };
const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 4 };
const inputStyle = { width: "100%", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, fontSize: 15, background: "var(--bg)", color: "var(--text)", boxSizing: "border-box" };

// ─── Components ───

function ShiftForm({ onSave, editShift, onCancel, rates, defaultDate }) {
  const [job, setJob] = useState(editShift?.job || "aspen");
  const [date, setDate] = useState(editShift?.date || defaultDate || todaySydney());
  const [hours, setHours] = useState(editShift?.hours || "");
  const [ordinaryHours, setOrdinaryHours] = useState(editShift?.ordinaryHours || "");
  const [eveningHours, setEveningHours] = useState(editShift?.eveningHours || "");
  const [shiftType, setShiftType] = useState(editShift?.shiftType || "clinical");
  const [kempseyRate, setKempseyRate] = useState(editShift?.kempseyRate || "morning");
  const [isPH, setIsPH] = useState(editShift?.isPublicHoliday || false);
  const [notes, setNotes] = useState(editShift?.notes || "");
  const [entryType, setEntryType] = useState(editShift?.entryType || "shift");
  const [startTime, setStartTime] = useState(editShift?.startTime || "");
  const [endTime, setEndTime] = useState(editShift?.endTime || "");

  const handleSubmit = () => {
    if (!date) return;
    const shift = {
      id: editShift?.id || Date.now().toString(),
      job, date, hours: parseFloat(hours) || 0,
      ordinaryHours: parseFloat(ordinaryHours) || 0,
      eveningHours: parseFloat(eveningHours) || 0,
      shiftType, kempseyRate, isPublicHoliday: isPH,
      notes, entryType, startTime, endTime,
    };
    onSave(shift);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{editShift ? "Edit entry" : "New entry"}</h3>
        {onCancel && <button onClick={onCancel} style={iconBtnStyle}><X size={20} /></button>}
      </div>

      {/* Entry type */}
      <div style={fieldGroup}>
        <label style={labelStyle}>Type</label>
        <div style={{ display: "flex", gap: 8 }}>
          {["shift", "meeting", "note"].map(t => (
            <button key={t} onClick={() => setEntryType(t)}
              style={{ ...tagBtn, flex: 1, textAlign: "center", background: entryType === t ? "var(--accent)" : "var(--bg)", color: entryType === t ? "#fff" : "var(--text)" }}>
              {t === "shift" ? "Shift" : t === "meeting" ? "Meeting" : "Note"}
            </button>
          ))}
        </div>
      </div>

      {/* Job */}
      <div style={fieldGroup}>
        <label style={labelStyle}>Job</label>
        <div style={{ display: "flex", gap: 8 }}>
          {Object.entries(JOBS).map(([k, v]) => (
            <button key={k} onClick={() => setJob(k)}
              style={{ ...tagBtn, flex: 1, textAlign: "center", background: job === k ? v.color : "var(--bg)", color: job === k ? "#fff" : "var(--text)", borderColor: v.color }}>
              {v.name}
            </button>
          ))}
        </div>
      </div>

      {/* Date */}
      <div style={fieldGroup}>
        <label style={labelStyle}>Date</label>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
      </div>

      {/* Times */}
      <div style={{ display: "flex", gap: 12, ...fieldGroup }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Start time</label>
          <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>End time</label>
          <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} style={inputStyle} />
        </div>
      </div>

      {entryType === "shift" && (
        <>
          <div style={fieldGroup}>
            <label style={labelStyle}>Total hours</label>
            <input type="number" step="0.5" value={hours} onChange={e => setHours(e.target.value)} placeholder="e.g. 8" style={inputStyle} />
          </div>

          {job === "aspen" && (
            <>
              <div style={fieldGroup}>
                <label style={labelStyle}>Shift category</label>
                <select value={shiftType} onChange={e => setShiftType(e.target.value)} style={inputStyle}>
                  <option value="clinical">Clinical (OccH / HIAS / TRAIN)</option>
                  <option value="oncall">On-call</option>
                  <option value="calledin15">Called-in 1.5x</option>
                  <option value="calledin2">Called-in 2x</option>
                </select>
              </div>
              {shiftType === "clinical" && getDayOfWeek(date) >= 1 && getDayOfWeek(date) <= 5 && !isPH && (
                <div style={{ display: "flex", gap: 12, ...fieldGroup }}>
                  <div style={{ flex: 1 }}>
                    <label style={labelStyle}>Ordinary hrs (07-15)</label>
                    <input type="number" step="0.5" value={ordinaryHours} onChange={e => setOrdinaryHours(e.target.value)} style={inputStyle} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={labelStyle}>Evening hrs (15-07)</label>
                    <input type="number" step="0.5" value={eveningHours} onChange={e => setEveningHours(e.target.value)} style={inputStyle} />
                  </div>
                </div>
              )}
              <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 14 }}>
                <input type="checkbox" checked={isPH} onChange={e => setIsPH(e.target.checked)} style={{ width: 18, height: 18 }} />
                Public holiday
              </label>
            </>
          )}

          {job === "kempsey" && getDayOfWeek(date) >= 1 && getDayOfWeek(date) <= 5 && (
            <div style={fieldGroup}>
              <label style={labelStyle}>Rate period</label>
              <select value={kempseyRate} onChange={e => setKempseyRate(e.target.value)} style={inputStyle}>
                <option value="morning">Morning (6am-10am) - {fmtMoney(rates.kempsey.morning)}/hr</option>
                <option value="afternoon10to1">Afternoon (10am-1pm) - {fmtMoney(rates.kempsey.afternoon10to1)}/hr</option>
                <option value="afternoon1to4">Afternoon (1pm-4pm) - {fmtMoney(rates.kempsey.afternoon1to4)}/hr</option>
              </select>
            </div>
          )}
        </>
      )}

      {/* Notes */}
      <div style={fieldGroup}>
        <label style={labelStyle}>Notes</label>
        <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes" style={inputStyle} />
      </div>

      {/* Pay preview */}
      {entryType === "shift" && job !== "fulltime" && (
        <div style={{ background: "var(--bg)", borderRadius: 10, padding: 14, marginBottom: 14 }}>
          <span style={{ fontSize: 13, color: "var(--muted)" }}>Estimated pay: </span>
          <span style={{ fontWeight: 700, fontSize: 16 }}>{fmtMoney(calcShiftPay({ job, date, hours, ordinaryHours, eveningHours, shiftType, kempseyRate, isPublicHoliday: isPH }, rates))}</span>
        </div>
      )}

      <button onClick={handleSubmit} style={{ ...primaryBtn, width: "100%" }}>
        {editShift ? "Save changes" : "Add entry"}
      </button>
    </div>
  );
}

// ─── Simplified Calendar ───
function CalendarView({ shifts, year, month, onNav, selectedDate, onDayClick, onEdit, onDelete, rates, onAdd }) {
  const days = getMonthDays(year, month);
  const monthLabel = new Date(year, month).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", month: "long", year: "numeric" });

  const shiftsForDay = (d) => {
    if (!d) return [];
    const ds = toDateStr(year, month, d);
    return shifts.filter(s => s.date === ds).sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
  };

  const selectedDayShifts = selectedDate
    ? shifts.filter(s => s.date === selectedDate).sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""))
    : [];

  const today = todaySydney();

  return (
    <div>
      {/* Month header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, padding: "0 4px" }}>
        <button onClick={() => onNav(-1)} style={{ ...iconBtnStyle, padding: 8 }} aria-label="Previous month"><ChevronLeft size={22} /></button>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{monthLabel}</h3>
        <button onClick={() => onNav(1)} style={{ ...iconBtnStyle, padding: 8 }} aria-label="Next month"><ChevronRight size={22} /></button>
      </div>

      {/* Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 6 }}>
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <div key={i} style={{ textAlign: "center", fontSize: 12, fontWeight: 600, color: i >= 5 ? "var(--accent)" : "var(--muted)", padding: "6px 0" }}>{d}</div>
        ))}
        {days.map((d, i) => {
          const dayShifts = shiftsForDay(d);
          const ds = d ? toDateStr(year, month, d) : null;
          const isToday = ds === today;
          const isSelected = ds === selectedDate;
          const jobSet = [...new Set(dayShifts.map(s => s.job))];

          return (
            <div key={i}
              onClick={() => d && onDayClick(ds === selectedDate ? null : ds)}
              style={{
                height: 48, borderRadius: 12, cursor: d ? "pointer" : "default",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                background: isSelected ? "var(--accent)" : isToday ? "var(--accent-light)" : "transparent",
                transition: "background 0.15s",
              }}
            >
              {d && (
                <>
                  <div style={{
                    fontSize: 15, fontWeight: isToday || isSelected ? 700 : 400,
                    color: isSelected ? "#fff" : isToday ? "var(--accent)" : "var(--text)",
                    lineHeight: 1.2,
                  }}>{d}</div>
                  {dayShifts.length > 0 && (
                    <div style={{ display: "flex", gap: 3, marginTop: 3 }}>
                      {jobSet.slice(0, 3).map(j => (
                        <div key={j} style={{
                          width: 6, height: 6, borderRadius: "50%",
                          background: isSelected ? "rgba(255,255,255,0.8)" : JOBS[j]?.color || "#888",
                        }} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 16, padding: "8px 4px", fontSize: 11, color: "var(--muted)" }}>
        {Object.entries(JOBS).map(([k, v]) => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: v.color }} />
            {v.name}
          </div>
        ))}
      </div>

      {/* Selected day detail */}
      {selectedDate && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{fmtDate(selectedDate)}</h4>
            <button onClick={() => onAdd(selectedDate)} style={{ ...tagBtn, fontSize: 12, padding: "5px 12px", display: "flex", alignItems: "center", gap: 4, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }}>
              <Plus size={14} /> Add
            </button>
          </div>
          {selectedDayShifts.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--muted)", padding: 20, textAlign: "center", background: "var(--surface)", borderRadius: 12 }}>
              No entries for this day
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {selectedDayShifts.map(s => {
              const pay = s.entryType === "shift" ? calcShiftPay(s, rates) : 0;
              const jobInfo = JOBS[s.job];
              return (
                <div key={s.id} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "12px 14px",
                  background: "var(--surface)", borderRadius: 12,
                  borderLeft: `3px solid ${jobInfo?.color || "#888"}`,
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {s.startTime && <span style={{ fontSize: 14, fontWeight: 600 }}>{s.startTime}{s.endTime ? `–${s.endTime}` : ""}</span>}
                      <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 5, background: jobInfo?.light, color: jobInfo?.color }}>{jobInfo?.name}</span>
                      {s.entryType === "meeting" && <span style={{ fontSize: 10, background: "#fef3c7", color: "#92400e", padding: "2px 6px", borderRadius: 4 }}>Meeting</span>}
                      {s.entryType === "note" && <span style={{ fontSize: 10, background: "#e0e7ff", color: "#3730a3", padding: "2px 6px", borderRadius: 4 }}>Note</span>}
                      {s.isPublicHoliday && <span style={{ fontSize: 10, background: "#fce7f3", color: "#9d174d", padding: "2px 6px", borderRadius: 4 }}>PH</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>
                      {s.entryType === "shift" && s.hours > 0 && `${s.hours}h`}
                      {s.entryType === "shift" && s.job === "aspen" && s.shiftType === "oncall" && " on-call"}
                      {s.notes && ` - ${s.notes}`}
                    </div>
                  </div>
                  {pay > 0 && <div style={{ fontSize: 15, fontWeight: 700, color: jobInfo?.color }}>{fmtMoney(pay)}</div>}
                  <button onClick={() => onEdit(s)} style={iconBtnStyle} aria-label="Edit"><Edit3 size={16} /></button>
                  <button onClick={() => onDelete(s.id)} style={{ ...iconBtnStyle, color: "#dc2626" }} aria-label="Delete"><Trash2 size={16} /></button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Pay components ───
function PayRow({ label, sub, value, bold }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "4px 0", fontSize: 13, fontWeight: bold ? 700 : 400 }}>
      <span>{label} {sub && <span style={{ color: "var(--muted)", fontSize: 12 }}>{sub}</span>}</span>
      <span style={{ fontWeight: bold ? 800 : 600 }}>{value}</span>
    </div>
  );
}

function UpcomingPayCard({ shifts, base, rates }) {
  const groups = upcomingPaydays(shifts, base, rates, 4);
  const fmtDay = (d) => d.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short" });
  const fmtShort = (d) => d.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", day: "2-digit", month: "short" });

  if (!groups.length) {
    return (
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Upcoming pay</div>
        <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>No upcoming paydays.</div>
      </div>
    );
  }

  const next = groups[0];

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Upcoming pay</div>

      <div style={{ background: "var(--accent-light)", border: `1px solid ${JOBS.aspen.color}33`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)" }}>NEXT PAY · {fmtDay(next.payday)}</div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>{daysUntil(next.payday, base)}</div>
        </div>
        {next.items.map(it => (
          <div key={it.job} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}>
            <div>
              <span style={{ fontSize: 12, fontWeight: 700, padding: "2px 8px", borderRadius: 6, background: JOBS[it.job].light, color: JOBS[it.job].color }}>{JOBS[it.job].name}</span>
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>{fmtShort(it.win.start)}–{fmtShort(it.win.end)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 26, fontWeight: 800, color: "var(--accent)", lineHeight: 1.05 }}>~{fmtMoney(itemNet(it, rates))}</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>take-home · {fmtMoney(itemGross(it, rates))} gross</div>
            </div>
          </div>
        ))}
      </div>

      {groups.slice(1).map(g => (
        <div key={g.key}>
          {g.items.map((it, idx) => (
            <div key={it.job} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 4px", borderTop: "1px solid var(--border)" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {idx === 0 ? fmtDay(g.payday) : <span style={{ color: "transparent" }}>{fmtDay(g.payday)}</span>}
                </div>
                <div style={{ fontSize: 11, color: JOBS[it.job].color, fontWeight: 600 }}>{JOBS[it.job].name}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 18, fontWeight: 800 }}>~{fmtMoney(itemNet(it, rates))}</div>
                <div style={{ fontSize: 10, color: "var(--muted)" }}>take-home · {fmtMoney(itemGross(it, rates))} gross</div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function JobPayPanel({ job, shifts, base, rates }) {
  const [offset, setOffset] = useState(0);
  const win = payWindow(job, base, offset);
  const info = JOBS[job];
  const R = rates[job];
  const list = shifts.filter(s => s.job === job && s.entryType === "shift" && inWindow(s.date, win));

  let body = null, total = 0, footerSub = null;

  if (job === "aspen") {
    const b = aspenBreakdown(list, rates);
    total = b.gross;
    const rows = [
      ["Ordinary (07-15)", b.cats.ordinary, R.ordinary],
      ["Evening (15-07)", b.cats.evening, R.evening],
      ["Saturday", b.cats.saturday, R.saturday],
      ["Sunday", b.cats.sunday, R.sunday],
      ["Public holiday", b.cats.publicHoliday, R.publicHoliday],
      ["Called-in 1.5x", b.calledin.h15, R.calledIn15],
      ["Called-in 2x", b.calledin.h2, R.calledIn2],
    ].filter(r => r[1] > 0);
    const oc = [
      ["On-call M-F", b.oncall.mf, R.onCallMF],
      ["On-call Sat", b.oncall.sat, R.onCallSat],
      ["On-call Sun/PH", b.oncall.sunph, R.onCallSunPH],
    ].filter(r => r[1] > 0);
    footerSub = `${+b.workedHours.toFixed(1)}h worked`;
    body = (
      <>
        {rows.map(([l, h, r]) => <PayRow key={l} label={l} sub={`${+h.toFixed(2)}h x $${r}`} value={fmtMoney(h * r)} />)}
        {oc.map(([l, n, r]) => <PayRow key={l} label={l} sub={`${n} x $${r}`} value={fmtMoney(n * r)} />)}
        {!rows.length && !oc.length && <div style={{ fontSize: 13, color: "var(--muted)", padding: "6px 0" }}>No shifts this period.</div>}
      </>
    );
  } else if (job === "kempsey") {
    const b = kempseyBreakdown(list, rates);
    total = b.gross;
    const rows = [
      ["Morning (6-10)", b.rates.morning, R.morning],
      ["Afternoon (10-1)", b.rates.afternoon10to1, R.afternoon10to1],
      ["Afternoon (1-4)", b.rates.afternoon1to4, R.afternoon1to4],
      ["Saturday", b.rates.saturday, R.saturday],
      ["Sunday", b.rates.sunday, R.sunday],
    ].filter(r => r[1] > 0);
    footerSub = `${+b.hours.toFixed(1)}h worked`;
    body = (
      <>
        {rows.map(([l, h, r]) => <PayRow key={l} label={l} sub={`${+h.toFixed(2)}h x $${r}`} value={fmtMoney(h * r)} />)}
        {!rows.length && <div style={{ fontSize: 13, color: "var(--muted)", padding: "6px 0" }}>No shifts this period.</div>}
      </>
    );
  } else {
    total = rates.fulltime.gross;
    footerSub = `${fmtMoney(rates.fulltime.net)} net`;
    body = (
      <>
        <PayRow label="Salary (fixed)" sub="gross per fortnight" value={fmtMoney(rates.fulltime.gross)} />
        <PayRow label="After tax" sub="take-home" value={fmtMoney(rates.fulltime.net)} />
      </>
    );
  }

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: 14, borderTop: `3px solid ${info.color}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: info.color }}>{info.name}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <button onClick={() => setOffset(offset - 1)} style={iconBtnStyle} aria-label="Previous period"><ChevronLeft size={16} /></button>
          <button onClick={() => setOffset(offset + 1)} disabled={offset >= 0} style={{ ...iconBtnStyle, opacity: offset >= 0 ? 0.3 : 1 }} aria-label="Next period"><ChevronRight size={16} /></button>
        </div>
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 2 }}>
        {windowLabel(win)}{offset === 0 ? " · current" : ""}
      </div>
      <div style={{ fontSize: 11, color: info.color, fontWeight: 600, marginBottom: 8 }}>
        Pays {paydayFor(job, win).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short" })}
      </div>
      {body}
      <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8 }}>
        <PayRow label="Subtotal" sub={footerSub} value={fmtMoney(total)} bold />
      </div>
    </div>
  );
}

function FatigueIndicator({ shifts, targetDate }) {
  const target = new Date(targetDate + "T00:00:00");
  let totalHrs = 0;
  let consecutiveDays = 0;
  const jobs = new Set();

  for (let i = 0; i < 7; i++) {
    const d = new Date(target);
    d.setDate(d.getDate() - i);
    const ds = ymd(d);
    const dayShifts = shifts.filter(s => s.date === ds && s.entryType === "shift");
    const dayHrs = dayShifts.reduce((sum, s) => sum + (parseFloat(s.hours) || 0), 0);
    totalHrs += dayHrs;
    if (dayHrs > 0 && i === consecutiveDays) consecutiveDays++;
    dayShifts.forEach(s => jobs.add(s.job));
  }

  const level = totalHrs > 60 ? "high" : totalHrs > 45 ? "moderate" : "low";
  const colors = { high: "#dc2626", moderate: "#d97706", low: "#16a34a" };

  return (
    <div style={{ background: "var(--surface)", border: `1px solid ${colors[level]}33`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        {level === "high" && <AlertTriangle size={16} color={colors[level]} />}
        <span style={{ fontSize: 13, fontWeight: 600, color: colors[level] }}>
          {level === "high" ? "High fatigue risk" : level === "moderate" ? "Moderate load" : "Manageable load"}
        </span>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>
        {totalHrs}h in the past 7 days across {jobs.size} job{jobs.size > 1 ? "s" : ""}.
        {consecutiveDays > 5 && ` ${consecutiveDays} consecutive work days.`}
      </div>
    </div>
  );
}

function ShiftList({ shifts, onEdit, onDelete, rates }) {
  if (!shifts.length) return <div style={{ fontSize: 13, color: "var(--muted)", padding: 20, textAlign: "center", background: "var(--surface)", borderRadius: 12 }}>No entries for this period.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {shifts.slice().sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || "").localeCompare(b.startTime || "")).map(s => {
        const pay = s.entryType === "shift" ? calcShiftPay(s, rates) : 0;
        const jobInfo = JOBS[s.job];
        return (
          <div key={s.id} style={{
            display: "flex", alignItems: "center", gap: 10, padding: "12px 14px",
            background: "var(--surface)", borderRadius: 12, borderLeft: `3px solid ${jobInfo?.color || "#888"}`,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtDate(s.date)}</span>
                {s.startTime && <span style={{ fontSize: 11, color: "var(--muted)" }}>{s.startTime}{s.endTime ? `-${s.endTime}` : ""}</span>}
                <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 5, background: jobInfo?.light, color: jobInfo?.color }}>{jobInfo?.name}</span>
                {s.entryType === "meeting" && <span style={{ fontSize: 10, background: "#fef3c7", color: "#92400e", padding: "2px 6px", borderRadius: 4 }}>Meeting</span>}
                {s.entryType === "note" && <span style={{ fontSize: 10, background: "#e0e7ff", color: "#3730a3", padding: "2px 6px", borderRadius: 4 }}>Note</span>}
                {s.isPublicHoliday && <span style={{ fontSize: 10, background: "#fce7f3", color: "#9d174d", padding: "2px 6px", borderRadius: 4 }}>PH</span>}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                {s.entryType === "shift" && s.hours > 0 && `${s.hours}h`}
                {s.entryType === "shift" && s.job === "aspen" && s.shiftType === "oncall" && " on-call"}
                {s.notes && ` - ${s.notes}`}
              </div>
            </div>
            {s.entryType === "shift" && s.job !== "fulltime" && (
              <div style={{ fontSize: 14, fontWeight: 700, color: jobInfo?.color }}>{fmtMoney(pay)}</div>
            )}
            <button onClick={() => onEdit(s)} style={iconBtnStyle} aria-label="Edit"><Edit3 size={16} /></button>
            <button onClick={() => onDelete(s.id)} style={{ ...iconBtnStyle, color: "#dc2626" }} aria-label="Delete"><Trash2 size={16} /></button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Rates Editor ───
function RatesEditor({ rates, onUpdateRate, onReset }) {
  const RateGroup = ({ job, labels }) => (
    <div style={{ background: "var(--surface)", borderRadius: 14, padding: 16, marginBottom: 12, borderTop: `3px solid ${JOBS[job].color}` }}>
      <h4 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: JOBS[job].color }}>{JOBS[job].name}</h4>
      {labels.map(({ key, label, unit }) => (
        <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
            {unit && <div style={{ fontSize: 11, color: "var(--muted)" }}>{unit}</div>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 14, color: "var(--muted)" }}>$</span>
            <input
              type="number"
              step="0.01"
              value={rates[job][key]}
              onChange={e => onUpdateRate(job, key, parseFloat(e.target.value) || 0)}
              style={{
                width: 90, padding: "8px 10px", border: "1px solid var(--border)",
                borderRadius: 8, fontSize: 15, textAlign: "right",
                background: "var(--bg)", color: "var(--text)", boxSizing: "border-box",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div>
      <h3 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 6px" }}>Hourly Rates</h3>
      <p style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 16px" }}>
        Tap any rate to edit it. Changes save automatically.
      </p>
      <RateGroup job="aspen" labels={RATE_LABELS.aspen} />
      <RateGroup job="kempsey" labels={RATE_LABELS.kempsey} />
      <RateGroup job="fulltime" labels={RATE_LABELS.fulltime} />
      <button onClick={onReset} style={{
        ...tagBtn, width: "100%", textAlign: "center", marginTop: 8,
        color: "#dc2626", borderColor: "#fecaca", background: "#fff5f5",
      }}>
        Reset all to defaults
      </button>
    </div>
  );
}

// ─── Import Overlay ───
function ImportOverlay({ state, onConfirm, onConfirmFt, onClose, existing, rates }) {
  const overlay = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200,
    display: "flex", alignItems: "flex-end", justifyContent: "center",
  };
  const sheet = {
    background: "var(--surface)", width: "100%", maxWidth: 520, maxHeight: "88vh",
    overflowY: "auto", borderRadius: "16px 16px 0 0", padding: "20px 20px calc(20px + env(safe-area-inset-bottom, 0px))",
    boxShadow: "0 -4px 24px rgba(0,0,0,0.2)",
  };
  const header = (title) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
      <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{title}</h3>
      <button onClick={onClose} style={iconBtnStyle}><X size={20} /></button>
    </div>
  );

  if (state.loading) {
    return <div style={overlay}><div style={sheet}><div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Reading PDF...</div></div></div>;
  }
  if (state.error) {
    return (
      <div style={overlay} onClick={onClose}>
        <div style={sheet} onClick={e => e.stopPropagation()}>
          {header("Import failed")}
          <div style={{ fontSize: 14, color: "#dc2626", marginBottom: 16 }}>{state.error}</div>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>Upload an Aspen Medical roster PDF, or a full-time Outlook weekly calendar PDF.</div>
          <button onClick={onClose} style={{ ...primaryBtn, width: "100%", marginTop: 16 }}>Close</button>
        </div>
      </div>
    );
  }

  if (state.ft) {
    const meetings = state.ft.meetings;
    const have = new Set(existing.map(s => `${s.date}|${s.startTime || ""}|${s.entryType}|${s.notes || ""}`));
    const newCount = meetings.filter(m => {
      const notes = m.teams ? `${m.title} (Teams)` : m.title;
      return !have.has(`${m.date}|${m.start}|meeting|${notes}`);
    }).length;
    const byDay = {};
    meetings.forEach(m => { (byDay[m.date] = byDay[m.date] || []).push(m); });
    const dayLabel = (ds) => new Date(ds + "T00:00:00").toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short" });
    return (
      <div style={overlay} onClick={onClose}>
        <div style={sheet} onClick={e => e.stopPropagation()}>
          {header("Review full-time meetings")}
          {!meetings.length && <div style={{ fontSize: 13, color: "var(--muted)" }}>No meetings found in this PDF.</div>}
          {Object.keys(byDay).sort().map(ds => (
            <div key={ds} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: JOBS.fulltime.color, marginBottom: 4 }}>{dayLabel(ds)}</div>
              {byDay[ds].map((m, i) => (
                <div key={i} style={{ display: "flex", gap: 10, fontSize: 13, padding: "5px 10px", background: "var(--bg)", borderRadius: 6, marginBottom: 3 }}>
                  <span style={{ width: 96, color: "var(--muted)", flexShrink: 0 }}>{m.start}-{m.end}</span>
                  <span style={{ flex: 1, fontWeight: 600 }}>{m.title}{m.teams && <span style={{ fontSize: 10, marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: "#ede9fe", color: "#6d28d9" }}>Teams</span>}</span>
                </div>
              ))}
            </div>
          ))}
          <button onClick={onConfirmFt} disabled={newCount === 0}
            style={{ ...primaryBtn, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, opacity: newCount === 0 ? 0.5 : 1, marginTop: 4 }}>
            <Check size={16} />
            {newCount === 0 ? "Already imported" : `Add ${newCount} meeting${newCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    );
  }

  const { result } = state;
  const { fortnightStart, fortnightEnd, shifts, summary } = result;
  const { cat, oncall, workedHours, gross } = summary;
  const R = rates.aspen;
  const fmtR = (d) => d.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", day: "2-digit", month: "2-digit" });

  const have = new Set(existing.map(s => `${s.date}|${s.startTime || ""}|${s.shiftType}|${s.notes || ""}`));
  const newCount = shifts.filter((s) => {
    const date = ymd(s.date);
    const isOncall = s.kind === "oncall";
    const notes = isOncall ? "On-call (imported)" : `${s.code} (imported)`;
    return !have.has(`${date}|${s.start || ""}|${isOncall ? "oncall" : "clinical"}|${notes}`);
  }).length;

  const rows = [
    ["Ordinary (07-15)", cat.ordinary, R.ordinary],
    ["Evening (15-07)", cat.evening, R.evening],
    ["Saturday", cat.saturday, R.saturday],
    ["Sunday", cat.sunday, R.sunday],
    ["Public holiday", cat.publicHoliday, R.publicHoliday],
  ].filter(r => r[1] > 0);
  const ocRows = [
    ["On-call M-F", oncall.mf, R.onCallMF],
    ["On-call Sat", oncall.sat, R.onCallSat],
    ["On-call Sun/PH", oncall.sunph, R.onCallSunPH],
  ].filter(r => r[1] > 0);

  return (
    <div style={overlay} onClick={onClose}>
      <div style={sheet} onClick={e => e.stopPropagation()}>
        {header("Review imported shifts")}
        <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>Pay fortnight (from PDF)</div>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 14 }}>{fmtR(fortnightStart)} - {fmtR(fortnightEnd)}</div>

        <div style={{ background: "var(--bg)", borderRadius: 10, padding: 12, marginBottom: 14 }}>
          {rows.map(([label, h, rate]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
              <span>{label} <span style={{ color: "var(--muted)" }}>{h}h x ${rate}</span></span>
              <span style={{ fontWeight: 600 }}>{fmtMoney(h * rate)}</span>
            </div>
          ))}
          {ocRows.map(([label, n, rate]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
              <span>{label} <span style={{ color: "var(--muted)" }}>{n} x ${rate}</span></span>
              <span style={{ fontWeight: 600 }}>{fmtMoney(n * rate)}</span>
            </div>
          ))}
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8, display: "flex", justifyContent: "space-between", fontWeight: 800 }}>
            <span>{workedHours}h worked</span>
            <span>{fmtMoney(gross)}</span>
          </div>
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>{shifts.length} shift{shifts.length === 1 ? "" : "s"} detected</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 16 }}>
          {shifts.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "6px 10px", background: "var(--bg)", borderRadius: 6 }}>
              <span style={{ width: 70, color: "var(--muted)" }}>{fmtDate(ymd(s.date))}</span>
              <span style={{ flex: 1, fontWeight: 600 }}>
                {s.kind === "oncall" ? "On-call" : s.code}
                {s.start && <span style={{ fontWeight: 400, color: "var(--muted)" }}> {s.start}-{s.end}</span>}
              </span>
              <span style={{ fontWeight: 600 }}>
                {s.kind === "oncall" ? "flat" : `${s.hours}h`}
              </span>
            </div>
          ))}
          {!shifts.length && <div style={{ fontSize: 13, color: "var(--muted)", padding: 8 }}>No countable shifts found in this fortnight.</div>}
        </div>

        <button onClick={onConfirm} disabled={newCount === 0}
          style={{ ...primaryBtn, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, opacity: newCount === 0 ? 0.5 : 1 }}>
          <Check size={16} />
          {newCount === 0 ? "Already imported" : `Add ${newCount} shift${newCount === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}

// ─── Main App ───
export default function ShiftTracker() {
  const [shifts, setShifts] = useState([]);
  const [rates, setRates] = useState(DEFAULT_RATES);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("calendar");
  const [showForm, setShowForm] = useState(false);
  const [editShift, setEditShift] = useState(null);
  const [formDefaultDate, setFormDefaultDate] = useState(null);
  const [calYear, setCalYear] = useState(+todaySydney().slice(0, 4));
  const [calMonth, setCalMonth] = useState(+todaySydney().slice(5, 7) - 1);
  const [selectedDate, setSelectedDate] = useState(null);
  const [jobFilter, setJobFilter] = useState("all");
  const [importState, setImportState] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    Promise.all([
      loadData("shifts", []),
      loadData("rates", null),
    ]).then(([s, r]) => {
      setShifts(s);
      setRates(mergeRates(r));
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (loaded) saveData("shifts", shifts);
  }, [shifts, loaded]);

  useEffect(() => {
    if (loaded) saveData("rates", rates);
  }, [rates, loaded]);

  const handleSave = (shift) => {
    setShifts(prev => {
      const idx = prev.findIndex(s => s.id === shift.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = shift; return next; }
      return [...prev, shift];
    });
    setShowForm(false);
    setEditShift(null);
    setFormDefaultDate(null);
  };

  const handleDelete = (id) => {
    setShifts(prev => prev.filter(s => s.id !== id));
  };

  const handleUpdateRate = (job, key, value) => {
    setRates(prev => ({
      ...prev,
      [job]: { ...prev[job], [key]: value },
    }));
  };

  const handleResetRates = () => {
    setRates({ ...DEFAULT_RATES });
  };

  const openForm = (date) => {
    setEditShift(null);
    setFormDefaultDate(date || null);
    setShowForm(true);
  };

  const openEditForm = (shift) => {
    setEditShift(shift);
    setFormDefaultDate(null);
    setShowForm(true);
  };

  // PDF import
  const handlePdfFile = async (file) => {
    if (!file) return;
    setImportState({ loading: true });
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const kind = await detectPdfKind(buf.slice());
      if (kind === "fulltime") {
        const ft = await parseFulltimePdf(buf.slice());
        setImportState({ ft });
      } else {
        const result = await parseAspenPdf(buf.slice());
        setImportState({ result });
      }
    } catch (e) {
      console.error("PDF import failed:", e);
      setImportState({ error: e.message || "Could not read this PDF." });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const confirmFtImport = () => {
    const { ft } = importState;
    setShifts(prev => {
      const have = new Set(prev.map(s => `${s.date}|${s.startTime || ""}|${s.entryType}|${s.notes || ""}`));
      const additions = [];
      ft.meetings.forEach((m, i) => {
        const notes = m.teams ? `${m.title} (Teams)` : m.title;
        const key = `${m.date}|${m.start}|meeting|${notes}`;
        if (have.has(key)) return;
        have.add(key);
        additions.push({
          id: `ft_${Date.now()}_${i}`, job: "fulltime", date: m.date,
          entryType: "meeting", shiftType: "clinical",
          hours: 0, ordinaryHours: 0, eveningHours: 0,
          isPublicHoliday: false, kempseyRate: "morning",
          startTime: m.start, endTime: m.end, notes,
        });
      });
      return [...prev, ...additions];
    });
    setImportState(null);
  };

  const confirmImport = () => {
    const { result } = importState;
    setShifts(prev => {
      const have = new Set(prev.map(s => `${s.date}|${s.startTime || ""}|${s.shiftType}|${s.notes || ""}`));
      const additions = [];
      result.shifts.forEach((s, i) => {
        const date = ymd(s.date);
        const isOncall = s.kind === "oncall";
        const notes = isOncall ? "On-call (imported)" : `${s.code} (imported)`;
        const key = `${date}|${s.start || ""}|${isOncall ? "oncall" : "clinical"}|${notes}`;
        if (have.has(key)) return;
        have.add(key);
        additions.push({
          id: `${Date.now()}_${i}`, job: "aspen", date,
          entryType: "shift", shiftType: isOncall ? "oncall" : "clinical",
          hours: isOncall ? 0 : s.hours,
          ordinaryHours: isOncall ? 0 : s.ordinaryHours,
          eveningHours: isOncall ? 0 : s.eveningHours,
          isPublicHoliday: false, kempseyRate: "morning",
          startTime: s.start || "", endTime: s.end || "", notes,
        });
      });
      return [...prev, ...additions];
    });
    setImportState(null);
  };

  const handleCalNav = (dir) => {
    let m = calMonth + dir;
    let y = calYear;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setCalMonth(m);
    setCalYear(y);
    setSelectedDate(null);
  };

  const filtered = shifts.filter(s => jobFilter === "all" || s.job === jobFilter);
  const today = todaySydney();
  const currentFn = getFortnightKey(today);

  const listShifts = selectedDate
    ? filtered.filter(s => s.date === selectedDate)
    : filtered.filter(s => shiftFortnightKey(s) === currentFn);

  if (!loaded) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Loading...</div>;

  const tabs = [
    { id: "calendar", icon: Calendar, label: "Calendar" },
    { id: "pay", icon: DollarSign, label: "Pay" },
    { id: "list", icon: FileText, label: "List" },
    { id: "rates", icon: Settings, label: "Rates" },
  ];

  return (
    <div style={{
      "--bg": "#f8faf4", "--surface": "#ffffff", "--text": "#0a0a0a", "--muted": "#6b7563",
      "--border": "#e3e8dc", "--accent": "#0a654a", "--accent-light": "#d4f0b6", "--hover": "#eef3e6",
      fontFamily: "'Inter', -apple-system, system-ui, sans-serif",
      color: "var(--text)", background: "var(--bg)", minHeight: "100vh",
      maxWidth: 520, margin: "0 auto",
      paddingTop: "env(safe-area-inset-top, 0px)",
    }}>
      {/* Header */}
      <div style={{ padding: "16px 16px 10px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" }}>Shift Tracker</h1>
          <button
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            style={{ ...iconBtnStyle, padding: 8 }}
            aria-label="Import PDF"
          >
            <Upload size={20} />
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          style={{ display: "none" }}
          onChange={e => handlePdfFile(e.target.files && e.target.files[0])}
        />
      </div>

      {/* Import overlay */}
      {importState && (
        <ImportOverlay
          state={importState}
          onConfirm={confirmImport}
          onConfirmFt={confirmFtImport}
          onClose={() => setImportState(null)}
          existing={shifts}
          rates={rates}
        />
      )}

      {/* Job filter (not on rates tab) */}
      {view !== "rates" && (
        <div style={{ display: "flex", gap: 6, padding: "10px 16px", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          <button onClick={() => setJobFilter("all")}
            style={{ ...tagBtn, background: jobFilter === "all" ? "var(--text)" : "var(--surface)", color: jobFilter === "all" ? "#fff" : "var(--text)", borderColor: "var(--border)", flexShrink: 0, fontSize: 12, padding: "6px 12px" }}>
            All
          </button>
          {Object.entries(JOBS).map(([k, v]) => (
            <button key={k} onClick={() => setJobFilter(k)}
              style={{ ...tagBtn, background: jobFilter === k ? v.color : "var(--surface)", color: jobFilter === k ? "#fff" : "var(--text)", borderColor: v.color, flexShrink: 0, fontSize: 12, padding: "6px 12px" }}>
              {v.name}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div style={{ padding: "12px 16px 120px" }}>
        {/* Fatigue (not on rates tab) */}
        {view !== "rates" && <FatigueIndicator shifts={shifts} targetDate={today} />}

        {/* Upcoming pay (calendar & list tabs) */}
        {(view === "calendar" || view === "list") && <UpcomingPayCard shifts={filtered} base={today} rates={rates} />}

        {/* Calendar */}
        {view === "calendar" && (
          <CalendarView
            shifts={filtered}
            year={calYear} month={calMonth}
            onNav={handleCalNav}
            selectedDate={selectedDate}
            onDayClick={setSelectedDate}
            onEdit={openEditForm}
            onDelete={handleDelete}
            rates={rates}
            onAdd={openForm}
          />
        )}

        {/* Pay */}
        {view === "pay" && (
          <div>
            <UpcomingPayCard shifts={filtered} base={today} rates={rates} />
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: "4px 0 10px" }}>By job</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <JobPayPanel job="aspen" shifts={filtered} base={today} rates={rates} />
              <JobPayPanel job="kempsey" shifts={filtered} base={today} rates={rates} />
              <JobPayPanel job="fulltime" shifts={filtered} base={today} rates={rates} />
            </div>
          </div>
        )}

        {/* List */}
        {view === "list" && (
          <div>
            {selectedDate && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <button onClick={() => setSelectedDate(null)} style={iconBtnStyle}><ChevronLeft size={16} /></button>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{fmtDate(selectedDate)}</h3>
              </div>
            )}
            {!selectedDate && <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Current fortnight</h3>}
            <ShiftList
              shifts={listShifts}
              onEdit={openEditForm}
              onDelete={handleDelete}
              rates={rates}
            />
          </div>
        )}

        {/* Rates */}
        {view === "rates" && (
          <RatesEditor
            rates={rates}
            onUpdateRate={handleUpdateRate}
            onReset={handleResetRates}
          />
        )}
      </div>

      {/* Form bottom sheet */}
      {showForm && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200,
          display: "flex", alignItems: "flex-end", justifyContent: "center",
        }} onClick={() => { setShowForm(false); setEditShift(null); setFormDefaultDate(null); }}>
          <div style={{
            background: "var(--surface)", width: "100%", maxWidth: 520, maxHeight: "90vh",
            overflowY: "auto", borderRadius: "16px 16px 0 0",
            padding: "20px 20px calc(20px + env(safe-area-inset-bottom, 0px))",
            boxShadow: "0 -4px 24px rgba(0,0,0,0.2)",
          }} onClick={e => e.stopPropagation()}>
            <ShiftForm
              editShift={editShift}
              defaultDate={formDefaultDate}
              onSave={handleSave}
              onCancel={() => { setShowForm(false); setEditShift(null); setFormDefaultDate(null); }}
              rates={rates}
            />
          </div>
        </div>
      )}

      {/* FAB (not on rates tab) */}
      {!showForm && view !== "rates" && (
        <button
          onClick={() => openForm(selectedDate)}
          style={{
            position: "fixed", bottom: "calc(68px + env(safe-area-inset-bottom, 0px))", right: 20,
            width: 52, height: 52, borderRadius: 26,
            background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 4px 16px rgba(10,101,74,0.4)", zIndex: 90,
          }}
          aria-label="Add entry"
        >
          <Plus size={24} />
        </button>
      )}

      {/* Bottom tab bar */}
      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0,
        background: "var(--surface)", borderTop: "1px solid var(--border)",
        display: "flex", zIndex: 100, maxWidth: 520, margin: "0 auto",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}>
        {tabs.map(tab => (
          <button key={tab.id}
            onClick={() => { setView(tab.id); if (tab.id !== "list") setSelectedDate(null); }}
            style={{
              flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              padding: "8px 0 6px", gap: 2, border: "none", background: "none", cursor: "pointer",
              color: view === tab.id ? "var(--accent)" : "var(--muted)",
              fontSize: 10, fontWeight: view === tab.id ? 600 : 400,
            }}>
            <tab.icon size={22} strokeWidth={view === tab.id ? 2.5 : 2} />
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}
