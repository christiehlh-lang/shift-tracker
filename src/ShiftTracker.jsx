import { useState, useEffect, useRef } from "react";
import { Calendar, DollarSign, Plus, Trash2, ChevronLeft, ChevronRight, X, AlertTriangle, FileText, Edit3, Upload, Check } from "lucide-react";
import { parseAspenPdf } from "./aspenPdf";

// ─── Pay rate configs ───
const ASPEN_RATES = {
  ordinary: 52.50,
  evening: 60.38,
  saturday: 78.70,
  sunday: 91.80,
  publicHoliday: 105.00,
  onCallMF: 50.00,
  onCallSat: 80.00,
  onCallSunPH: 110.00,
  calledIn15: 78.00,
  calledIn2: 105.00,
};

const KEMPSEY_RATES = {
  morning: 61.82,
  afternoon10to1: 67.44,
  afternoon1to4: 68.84,
  saturday: 84.30,
  sunday: 98.35,
};

// Full-time pay per fortnight: fixed gross and take-home (after-tax) amounts.
const FT_GROSS = 5068;
const FT_NET = 3064;

const JOBS = {
  aspen: { name: "Aspen", color: "#2563eb", light: "#dbeafe" },
  kempsey: { name: "Kempsey ED", color: "#059669", light: "#d1fae5" },
  fulltime: { name: "Full-time", color: "#7c3aed", light: "#ede9fe" },
};

// ─── Helpers ───
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

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

function fmtMoney(n) {
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function getDayOfWeek(dateStr) {
  return new Date(dateStr).getDay(); // 0=Sun, 6=Sat
}

function getFortnightKey(dateStr) {
  // Anchor: 20/06/2026 is a known Aspen pay-fortnight start (Saturday).
  // Aspen fortnights run Saturday → Friday (14 days).
  const anchor = new Date(2026, 5, 20);
  const d = new Date(dateStr);
  const diff = Math.floor((d - anchor) / (1000 * 60 * 60 * 24));
  const fnNum = Math.floor(diff / 14);
  const start = new Date(anchor.getTime() + fnNum * 14 * 86400000);
  const end = new Date(start.getTime() + 13 * 86400000);
  return `${start.toISOString().slice(0, 10)}_${end.toISOString().slice(0, 10)}`;
}

// The Aspen-fortnight card a shift belongs to. Kempsey dates are shifted back
// 2 days so a Kempsey shift lands in the same card whose Mon–Sun window covers it.
function shiftFortnightKey(s) {
  if (s.job === "kempsey") {
    const d = new Date(s.date + "T00:00:00");
    d.setDate(d.getDate() - 2);
    return getFortnightKey(d);
  }
  return getFortnightKey(s.date);
}

// ─── Per-job pay cycles ───
// Each job is paid fortnightly. The work period and the actual payday differ:
//   Aspen     — Sat → Fri,  paid Thursday of the week after the period
//   Kempsey   — Mon → Sun,  paid Thursday of the week after the period
//   Full-time — Mon → Fri (2 wks), paid Wednesday of the week after the period
// payFromMon = days after the Monday of the week following the period end
// (Wed = 2, Thu = 3).
const JOB_CYCLE = {
  aspen:    { anchor: new Date(2026, 5, 20), endOffset: 13, payFromMon: 3 }, // Sat 20/06
  kempsey:  { anchor: new Date(2026, 5, 22), endOffset: 13, payFromMon: 3 }, // Mon 22/06
  fulltime: { anchor: new Date(2026, 5, 15), endOffset: 11, payFromMon: 2 }, // Mon 15/06
};

// The pay window for a job at a given offset (0 = period containing `base`).
function payWindow(job, base, offset = 0) {
  const c = JOB_CYCLE[job];
  const d = base instanceof Date ? base : new Date(base + "T00:00:00");
  const diff = Math.floor((d - c.anchor) / 86400000);
  const fn = Math.floor(diff / 14) + offset;
  const start = new Date(c.anchor.getTime() + fn * 14 * 86400000);
  const end = new Date(start.getTime() + c.endOffset * 86400000);
  return { start, end };
}

// The payday for a given pay window: Wed/Thu of the week after the period ends.
function paydayFor(job, win) {
  const c = JOB_CYCLE[job];
  const d = new Date(win.end);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const monOffset = dow === 0 ? -6 : 1 - dow; // back to this week's Monday
  const monNext = new Date(d);
  monNext.setDate(d.getDate() + monOffset + 7); // Monday of the following week
  const pay = new Date(monNext);
  pay.setDate(monNext.getDate() + c.payFromMon);
  return pay;
}

function inWindow(dateStr, win) {
  const d = new Date(dateStr + "T00:00:00");
  return d >= win.start && d <= win.end;
}

function jobGrossInWindow(job, shifts, win) {
  const list = shifts.filter(s => s.job === job && s.entryType === "shift" && inWindow(s.date, win));
  if (job === "aspen") return aspenBreakdown(list).gross;
  if (job === "kempsey") return kempseyBreakdown(list).gross;
  return FT_GROSS;
}

// Upcoming paydays across all jobs, soonest first, grouped by date.
function upcomingPaydays(shifts, base, count = 4) {
  const today = new Date(base instanceof Date ? base : base + "T00:00:00");
  today.setHours(0, 0, 0, 0);
  const entries = [];
  for (const job of ["aspen", "kempsey", "fulltime"]) {
    for (let off = -1; off <= 3; off++) {
      const win = payWindow(job, today, off);
      const pd = paydayFor(job, win);
      if (pd >= today) entries.push({ job, win, payday: pd, gross: jobGrossInWindow(job, shifts, win) });
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

function windowLabel(win) {
  const fmt = (d) => d.toLocaleDateString("en-AU", { weekday: "short", day: "2-digit", month: "short" });
  return `${fmt(win.start)} – ${fmt(win.end)}`;
}

// ─── Pay breakdowns from stored shift objects ───
function aspenBreakdown(list) {
  const cats = { ordinary: 0, evening: 0, saturday: 0, sunday: 0, publicHoliday: 0 };
  const oncall = { mf: 0, sat: 0, sunph: 0 };
  const calledin = { h15: 0, h2: 0 };
  let gross = 0, workedHours = 0;
  list.forEach(s => {
    gross += calcShiftPay(s);
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

function kempseyBreakdown(list) {
  const rates = { morning: 0, afternoon10to1: 0, afternoon1to4: 0, saturday: 0, sunday: 0 };
  let gross = 0, hours = 0;
  list.forEach(s => {
    gross += calcShiftPay(s);
    const h = parseFloat(s.hours) || 0;
    hours += h;
    const dow = getDayOfWeek(s.date);
    if (dow === 0) rates.sunday += h;
    else if (dow === 6) rates.saturday += h;
    else rates[s.kempseyRate || "morning"] += h;
  });
  return { rates, gross, hours };
}


function calcAspenPay(shift) {
  const dow = getDayOfWeek(shift.date);
  const hours = parseFloat(shift.hours) || 0;
  if (shift.shiftType === "oncall") {
    if (dow === 0 || shift.isPublicHoliday) return ASPEN_RATES.onCallSunPH;
    if (dow === 6) return ASPEN_RATES.onCallSat;
    return ASPEN_RATES.onCallMF;
  }
  if (shift.shiftType === "calledin15") return hours * ASPEN_RATES.calledIn15;
  if (shift.shiftType === "calledin2") return hours * ASPEN_RATES.calledIn2;
  if (shift.isPublicHoliday) return hours * ASPEN_RATES.publicHoliday;
  if (dow === 0) return hours * ASPEN_RATES.sunday;
  if (dow === 6) return hours * ASPEN_RATES.saturday;
  // Split ordinary / evening
  const ordHrs = parseFloat(shift.ordinaryHours) || 0;
  const eveHrs = parseFloat(shift.eveningHours) || 0;
  if (ordHrs || eveHrs) {
    return ordHrs * ASPEN_RATES.ordinary + eveHrs * ASPEN_RATES.evening;
  }
  // Fallback: assume ordinary
  return hours * ASPEN_RATES.ordinary;
}

function calcKempseyPay(shift) {
  const dow = getDayOfWeek(shift.date);
  const hours = parseFloat(shift.hours) || 0;
  if (dow === 0) return hours * KEMPSEY_RATES.sunday;
  if (dow === 6) return hours * KEMPSEY_RATES.saturday;
  // Use shift time category
  if (shift.kempseyRate === "morning") return hours * KEMPSEY_RATES.morning;
  if (shift.kempseyRate === "afternoon10to1") return hours * KEMPSEY_RATES.afternoon10to1;
  if (shift.kempseyRate === "afternoon1to4") return hours * KEMPSEY_RATES.afternoon1to4;
  return hours * KEMPSEY_RATES.morning; // default
}

function calcShiftPay(shift) {
  if (shift.job === "aspen") return calcAspenPay(shift);
  if (shift.job === "kempsey") return calcKempseyPay(shift);
  return 0; // Full-time is fixed
}

function estimateTakeHome(gross) {
  return Math.round(gross * 0.5 + 505);
}

// ─── Calendar helpers ───
function getMonthDays(year, month) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const days = [];
  // Pad start
  for (let i = 0; i < first.getDay(); i++) days.push(null);
  for (let d = 1; d <= last.getDate(); d++) days.push(d);
  return days;
}

function toDateStr(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Local YYYY-MM-DD from a Date (avoids UTC shift from toISOString).
function ymd(d) {
  return toDateStr(d.getFullYear(), d.getMonth(), d.getDate());
}

// ─── Components ───

function ShiftForm({ onSave, editShift, onCancel }) {
  const [job, setJob] = useState(editShift?.job || "aspen");
  const [date, setDate] = useState(editShift?.date || new Date().toISOString().slice(0, 10));
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
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{editShift ? "Edit entry" : "Add entry"}</h3>
        {onCancel && <button onClick={onCancel} style={iconBtnStyle}><X size={18} /></button>}
      </div>

      {/* Entry type */}
      <div style={fieldGroup}>
        <label style={labelStyle}>Type</label>
        <div style={{ display: "flex", gap: 8 }}>
          {["shift", "meeting", "note"].map(t => (
            <button key={t} onClick={() => setEntryType(t)}
              style={{ ...tagBtn, background: entryType === t ? "var(--accent)" : "var(--bg)", color: entryType === t ? "#fff" : "var(--text)" }}>
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
              style={{ ...tagBtn, background: job === k ? v.color : "var(--bg)", color: job === k ? "#fff" : "var(--text)", borderColor: v.color }}>
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
          {/* Hours */}
          <div style={fieldGroup}>
            <label style={labelStyle}>Total hours</label>
            <input type="number" step="0.5" value={hours} onChange={e => setHours(e.target.value)} placeholder="e.g. 8" style={inputStyle} />
          </div>

          {/* Aspen specifics */}
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
              <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={isPH} onChange={e => setIsPH(e.target.checked)} />
                Public holiday
              </label>
            </>
          )}

          {/* Kempsey specifics */}
          {job === "kempsey" && getDayOfWeek(date) >= 1 && getDayOfWeek(date) <= 5 && (
            <div style={fieldGroup}>
              <label style={labelStyle}>Rate period</label>
              <select value={kempseyRate} onChange={e => setKempseyRate(e.target.value)} style={inputStyle}>
                <option value="morning">Morning/day (6am-10am) - $61.82/hr</option>
                <option value="afternoon10to1">Afternoon (10am-1pm) - $67.44/hr</option>
                <option value="afternoon1to4">Afternoon (1pm-4pm) - $68.84/hr</option>
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
        <div style={{ background: "var(--bg)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: "var(--muted)" }}>Estimated pay: </span>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{fmtMoney(calcShiftPay({ job, date, hours, ordinaryHours, eveningHours, shiftType, kempseyRate, isPublicHoliday: isPH }))}</span>
        </div>
      )}

      <button onClick={handleSubmit} style={{ ...primaryBtn, width: "100%" }}>
        {editShift ? "Save changes" : "Add entry"}
      </button>
    </div>
  );
}

// Short label for a calendar entry chip.
function entryLabel(s) {
  if (s.entryType === "meeting") return s.notes ? s.notes : "Meeting";
  if (s.entryType === "note") return s.notes ? s.notes : "Note";
  if (s.job === "aspen") {
    if (s.shiftType === "oncall") return "On-call";
    if (s.shiftType === "calledin15") return "Called-in 1.5×";
    if (s.shiftType === "calledin2") return "Called-in 2×";
    const m = (s.notes || "").match(/^(OCC Health|HIAS|TRAIN)/);
    return m ? m[1] : "Aspen";
  }
  if (s.job === "kempsey") return "Kempsey";
  return "Full-time";
}

function entryChipColors(s) {
  if (s.entryType === "meeting") return { bg: "#fef3c7", fg: "#92400e" };
  if (s.entryType === "note") return { bg: "#e0e7ff", fg: "#3730a3" };
  const j = JOBS[s.job];
  return { bg: j?.light || "#eee", fg: j?.color || "#333" };
}

function CalendarView({ shifts, year, month, onNav, onDayClick }) {
  const days = getMonthDays(year, month);
  const monthLabel = new Date(year, month).toLocaleDateString("en-AU", { month: "long", year: "numeric" });

  const shiftsForDay = (d) => {
    if (!d) return [];
    const ds = toDateStr(year, month, d);
    return shifts
      .filter(s => s.date === ds)
      .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <button onClick={() => onNav(-1)} style={iconBtnStyle} aria-label="Previous month"><ChevronLeft size={20} /></button>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{monthLabel}</h3>
        <button onClick={() => onNav(1)} style={iconBtnStyle} aria-label="Next month"><ChevronRight size={20} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => (
          <div key={d} style={{ textAlign: "center", fontSize: 11, fontWeight: 600, color: "var(--muted)", padding: "4px 0" }}>{d}</div>
        ))}
        {days.map((d, i) => {
          const dayShifts = shiftsForDay(d);
          const isToday = d && toDateStr(year, month, d) === new Date().toISOString().slice(0, 10);
          return (
            <div key={i}
              onClick={() => d && onDayClick(toDateStr(year, month, d))}
              style={{
                minHeight: 96, borderRadius: 8, padding: 4, cursor: d ? "pointer" : "default",
                background: isToday ? "var(--accent-light)" : d ? "var(--surface)" : "transparent",
                border: isToday ? "2px solid var(--accent)" : "1px solid var(--border)",
                display: "flex", flexDirection: "column", gap: 3, overflow: "hidden",
              }}
            >
              {d && (
                <>
                  <div style={{ fontSize: 12, fontWeight: isToday ? 800 : 500, textAlign: "right", paddingRight: 2, color: isToday ? "var(--accent)" : "var(--text)" }}>{d}</div>
                  {dayShifts.map(s => {
                    const c = entryChipColors(s);
                    return (
                      <div key={s.id} title={`${JOBS[s.job]?.name || ""} ${entryLabel(s)} ${s.startTime || ""}${s.endTime ? "–" + s.endTime : ""}`}
                        style={{
                          background: c.bg, color: c.fg, borderRadius: 4, padding: "2px 4px",
                          fontSize: 10, lineHeight: 1.25, fontWeight: 600,
                          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                        }}>
                        {s.startTime ? <span style={{ fontWeight: 700 }}>{s.startTime} </span> : null}
                        {entryLabel(s)}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          );
        })}
      </div>
      {/* Legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 12, fontSize: 12, color: "var(--muted)" }}>
        {Object.entries(JOBS).map(([k, v]) => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: 3, background: v.light, border: `1px solid ${v.color}` }} />
            {v.name}
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div style={{ width: 10, height: 10, borderRadius: 3, background: "#fef3c7", border: "1px solid #92400e" }} />
          Meeting
        </div>
      </div>
    </div>
  );
}

function PayRow({ label, sub, value, bold }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "3px 0", fontSize: 13, fontWeight: bold ? 700 : 400 }}>
      <span>{label} {sub && <span style={{ color: "var(--muted)", fontSize: 12 }}>{sub}</span>}</span>
      <span style={{ fontWeight: bold ? 800 : 600 }}>{value}</span>
    </div>
  );
}

// Upcoming paydays across all jobs — the money actually coming in, soonest first.
function UpcomingPayCard({ shifts, base }) {
  const groups = upcomingPaydays(shifts, base, 4);
  const fmtDay = (d) => d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  const fmtShort = (d) => d.toLocaleDateString("en-AU", { day: "2-digit", month: "short" });

  const groupTotals = (g) => {
    let variable = 0, ft = 0;
    g.items.forEach(it => { if (it.job === "fulltime") ft += FT_GROSS; else variable += it.gross; });
    const gross = variable + ft;
    const net = (ft ? FT_NET : 0) + (variable > 0 ? estimateTakeHome(variable) : 0);
    return { gross, net };
  };

  if (!groups.length) {
    return (
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Upcoming pay</div>
        <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>No upcoming paydays.</div>
      </div>
    );
  }

  const next = groups[0];
  const nextT = groupTotals(next);

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Upcoming pay</div>

      {/* Next payday — highlighted */}
      <div style={{ background: "var(--accent-light)", border: `1px solid ${JOBS.aspen.color}33`, borderRadius: 10, padding: 14, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)" }}>NEXT PAY · {fmtDay(next.payday)}</div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>{daysUntil(next.payday, base)}</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 6 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {next.items.map(it => (
              <span key={it.job} style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 6, background: JOBS[it.job].light, color: JOBS[it.job].color }}>
                {JOBS[it.job].name} {fmtMoney(it.job === "fulltime" ? FT_GROSS : it.gross)}
              </span>
            ))}
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{fmtMoney(nextT.gross)}</div>
            <div style={{ fontSize: 11, color: "var(--accent)", fontWeight: 700 }}>~{fmtMoney(nextT.net)} take-home</div>
          </div>
        </div>
        <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 6 }}>
          for {next.items.map(it => `${JOBS[it.job].name} ${fmtShort(it.win.start)}–${fmtShort(it.win.end)}`).join(" · ")}
        </div>
      </div>

      {/* Following paydays */}
      {groups.slice(1).map(g => {
        const t = groupTotals(g);
        return (
          <div key={g.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 4px", borderTop: "1px solid var(--border)" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{fmtDay(g.payday)}</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>{g.items.map(it => JOBS[it.job].name).join(" + ")}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{fmtMoney(t.gross)}</div>
              <div style={{ fontSize: 10, color: "var(--muted)" }}>~{fmtMoney(t.net)} net</div>
            </div>
          </div>
        );
      })}
    </div>
  );
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

// One job's pay, with its own cycle navigation and category breakdown.
function JobPayPanel({ job, shifts, base }) {
  const [offset, setOffset] = useState(0);
  const win = payWindow(job, base, offset);
  const info = JOBS[job];
  const list = shifts.filter(s => s.job === job && s.entryType === "shift" && inWindow(s.date, win));

  let body = null, total = 0, footerSub = null;

  if (job === "aspen") {
    const b = aspenBreakdown(list);
    total = b.gross;
    const rows = [
      ["Ordinary (07–15)", b.cats.ordinary, ASPEN_RATES.ordinary],
      ["Evening (15–07)", b.cats.evening, ASPEN_RATES.evening],
      ["Saturday", b.cats.saturday, ASPEN_RATES.saturday],
      ["Sunday", b.cats.sunday, ASPEN_RATES.sunday],
      ["Public holiday", b.cats.publicHoliday, ASPEN_RATES.publicHoliday],
      ["Called-in 1.5×", b.calledin.h15, ASPEN_RATES.calledIn15],
      ["Called-in 2×", b.calledin.h2, ASPEN_RATES.calledIn2],
    ].filter(r => r[1] > 0);
    const oc = [
      ["On-call M–F", b.oncall.mf, ASPEN_RATES.onCallMF],
      ["On-call Sat", b.oncall.sat, ASPEN_RATES.onCallSat],
      ["On-call Sun/PH", b.oncall.sunph, ASPEN_RATES.onCallSunPH],
    ].filter(r => r[1] > 0);
    footerSub = `${+b.workedHours.toFixed(1)}h worked`;
    body = (
      <>
        {rows.map(([l, h, r]) => <PayRow key={l} label={l} sub={`${+h.toFixed(2)}h × $${r}`} value={fmtMoney(h * r)} />)}
        {oc.map(([l, n, r]) => <PayRow key={l} label={l} sub={`${n} × $${r}`} value={fmtMoney(n * r)} />)}
        {!rows.length && !oc.length && <div style={{ fontSize: 13, color: "var(--muted)", padding: "6px 0" }}>No shifts this period.</div>}
      </>
    );
  } else if (job === "kempsey") {
    const b = kempseyBreakdown(list);
    total = b.gross;
    const rows = [
      ["Morning (6–10)", b.rates.morning, KEMPSEY_RATES.morning],
      ["Afternoon (10–1)", b.rates.afternoon10to1, KEMPSEY_RATES.afternoon10to1],
      ["Afternoon (1–4)", b.rates.afternoon1to4, KEMPSEY_RATES.afternoon1to4],
      ["Saturday", b.rates.saturday, KEMPSEY_RATES.saturday],
      ["Sunday", b.rates.sunday, KEMPSEY_RATES.sunday],
    ].filter(r => r[1] > 0);
    footerSub = `${+b.hours.toFixed(1)}h worked`;
    body = (
      <>
        {rows.map(([l, h, r]) => <PayRow key={l} label={l} sub={`${+h.toFixed(2)}h × $${r}`} value={fmtMoney(h * r)} />)}
        {!rows.length && <div style={{ fontSize: 13, color: "var(--muted)", padding: "6px 0" }}>No shifts this period.</div>}
      </>
    );
  } else {
    total = FT_GROSS;
    footerSub = `${fmtMoney(FT_NET)} net`;
    body = (
      <>
        <PayRow label="Salary (fixed)" sub="gross per fortnight" value={fmtMoney(FT_GROSS)} />
        <PayRow label="After tax" sub="take-home" value={fmtMoney(FT_NET)} />
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Paid on the alternate week to Aspen.</div>
      </>
    );
  }

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 14, borderTop: `3px solid ${info.color}` }}>
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
        Pays {paydayFor(job, win).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}
      </div>
      {body}
      <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8 }}>
        <PayRow label="Subtotal" sub={footerSub} value={fmtMoney(total)} bold />
      </div>
    </div>
  );
}

function FatigueIndicator({ shifts, targetDate }) {
  // Check hours in 7 days before and including target
  const target = new Date(targetDate);
  let totalHrs = 0;
  let consecutiveDays = 0;
  const jobs = new Set();

  for (let i = 0; i < 7; i++) {
    const d = new Date(target);
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    const dayShifts = shifts.filter(s => s.date === ds && s.entryType === "shift");
    const dayHrs = dayShifts.reduce((sum, s) => sum + (parseFloat(s.hours) || 0), 0);
    totalHrs += dayHrs;
    if (dayHrs > 0 && i === consecutiveDays) consecutiveDays++;
    dayShifts.forEach(s => jobs.add(s.job));
  }

  const level = totalHrs > 60 ? "high" : totalHrs > 45 ? "moderate" : "low";
  const colors = { high: "#dc2626", moderate: "#d97706", low: "#16a34a" };

  return (
    <div style={{ background: "var(--surface)", border: `1px solid ${colors[level]}33`, borderRadius: 10, padding: 14, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
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

function ShiftList({ shifts, onEdit, onDelete }) {
  if (!shifts.length) return <div style={{ fontSize: 13, color: "var(--muted)", padding: 16, textAlign: "center" }}>No entries for this period.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {shifts.slice().sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || "").localeCompare(b.startTime || "")).map(s => {
        const pay = s.entryType === "shift" ? calcShiftPay(s) : 0;
        const jobInfo = JOBS[s.job];
        return (
          <div key={s.id} style={{
            display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
            background: "var(--surface)", borderRadius: 8, borderLeft: `3px solid ${jobInfo?.color || "#888"}`,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtDate(s.date)}</span>
                {s.startTime && <span style={{ fontSize: 11, color: "var(--muted)" }}>{s.startTime}{s.endTime ? `-${s.endTime}` : ""}</span>}
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4,
                  background: jobInfo?.light, color: jobInfo?.color,
                }}>{jobInfo?.name}</span>
                {s.entryType === "meeting" && <span style={{ fontSize: 10, background: "#fef3c7", color: "#92400e", padding: "1px 6px", borderRadius: 4 }}>Meeting</span>}
                {s.entryType === "note" && <span style={{ fontSize: 10, background: "#e0e7ff", color: "#3730a3", padding: "1px 6px", borderRadius: 4 }}>Note</span>}
                {s.isPublicHoliday && <span style={{ fontSize: 10, background: "#fce7f3", color: "#9d174d", padding: "1px 6px", borderRadius: 4 }}>PH</span>}
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
            <button onClick={() => onEdit(s)} style={iconBtnStyle} aria-label="Edit"><Edit3 size={14} /></button>
            <button onClick={() => onDelete(s.id)} style={{ ...iconBtnStyle, color: "#dc2626" }} aria-label="Delete"><Trash2 size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Styles ───
const iconBtnStyle = { background: "none", border: "none", cursor: "pointer", padding: 4, color: "var(--muted)", borderRadius: 4 };
const primaryBtn = { background: "var(--accent)", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontWeight: 600, fontSize: 14, cursor: "pointer" };
const tagBtn = { border: "1px solid var(--border)", borderRadius: 6, padding: "6px 12px", fontSize: 13, cursor: "pointer", fontWeight: 500, transition: "all 0.15s" };
const fieldGroup = { marginBottom: 12 };
const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 4 };
const inputStyle = { width: "100%", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 14, background: "var(--bg)", color: "var(--text)", boxSizing: "border-box" };

function ImportOverlay({ state, onConfirm, onClose, existing }) {
  const overlay = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200,
    display: "flex", alignItems: "flex-end", justifyContent: "center",
  };
  const sheet = {
    background: "var(--surface)", width: "100%", maxWidth: 520, maxHeight: "88vh",
    overflowY: "auto", borderRadius: "16px 16px 0 0", padding: 20,
    boxShadow: "0 -4px 24px rgba(0,0,0,0.2)",
  };
  const header = (title) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
      <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{title}</h3>
      <button onClick={onClose} style={iconBtnStyle}><X size={20} /></button>
    </div>
  );

  if (state.loading) {
    return <div style={overlay}><div style={sheet}><div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Reading PDF…</div></div></div>;
  }
  if (state.error) {
    return (
      <div style={overlay} onClick={onClose}>
        <div style={sheet} onClick={e => e.stopPropagation()}>
          {header("Import failed")}
          <div style={{ fontSize: 14, color: "#dc2626", marginBottom: 16 }}>{state.error}</div>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>Make sure it's an Aspen Medical “Individual Schedule” roster PDF with the bold pay-period date range at the top.</div>
          <button onClick={onClose} style={{ ...primaryBtn, width: "100%", marginTop: 16 }}>Close</button>
        </div>
      </div>
    );
  }

  const { result } = state;
  const { fortnightStart, fortnightEnd, shifts, summary } = result;
  const { cat, oncall, workedHours, gross } = summary;
  const fmtR = (d) => d.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit" });

  // How many are new vs already imported.
  const have = new Set(existing.map(s => `${s.date}|${s.startTime || ""}|${s.shiftType}|${s.notes || ""}`));
  const newCount = shifts.filter((s) => {
    const date = ymd(s.date);
    const isOncall = s.kind === "oncall";
    const notes = isOncall ? "On-call (imported)" : `${s.code} (imported)`;
    return !have.has(`${date}|${s.start || ""}|${isOncall ? "oncall" : "clinical"}|${notes}`);
  }).length;

  const rows = [
    ["Ordinary (07–15)", cat.ordinary, ASPEN_RATES.ordinary],
    ["Evening (15–07)", cat.evening, ASPEN_RATES.evening],
    ["Saturday", cat.saturday, ASPEN_RATES.saturday],
    ["Sunday", cat.sunday, ASPEN_RATES.sunday],
    ["Public holiday", cat.publicHoliday, ASPEN_RATES.publicHoliday],
  ].filter(r => r[1] > 0);
  const ocRows = [
    ["On-call M–F", oncall.mf, ASPEN_RATES.onCallMF],
    ["On-call Sat", oncall.sat, ASPEN_RATES.onCallSat],
    ["On-call Sun/PH", oncall.sunph, ASPEN_RATES.onCallSunPH],
  ].filter(r => r[1] > 0);

  return (
    <div style={overlay} onClick={onClose}>
      <div style={sheet} onClick={e => e.stopPropagation()}>
        {header("Review imported shifts")}
        <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>Pay fortnight (from PDF)</div>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 14 }}>{fmtR(fortnightStart)} – {fmtR(fortnightEnd)}</div>

        {/* Breakdown */}
        <div style={{ background: "var(--bg)", borderRadius: 10, padding: 12, marginBottom: 14 }}>
          {rows.map(([label, h, rate]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
              <span>{label} <span style={{ color: "var(--muted)" }}>{h}h × ${rate}</span></span>
              <span style={{ fontWeight: 600 }}>{fmtMoney(h * rate)}</span>
            </div>
          ))}
          {ocRows.map(([label, n, rate]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
              <span>{label} <span style={{ color: "var(--muted)" }}>{n} × ${rate}</span></span>
              <span style={{ fontWeight: 600 }}>{fmtMoney(n * rate)}</span>
            </div>
          ))}
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8, display: "flex", justifyContent: "space-between", fontWeight: 800 }}>
            <span>{workedHours}h worked</span>
            <span>{fmtMoney(gross)}</span>
          </div>
        </div>

        {/* Shift list */}
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>{shifts.length} shift{shifts.length === 1 ? "" : "s"} detected</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 16 }}>
          {shifts.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "6px 10px", background: "var(--bg)", borderRadius: 6 }}>
              <span style={{ width: 70, color: "var(--muted)" }}>{fmtDate(ymd(s.date))}</span>
              <span style={{ flex: 1, fontWeight: 600 }}>
                {s.kind === "oncall" ? "On-call" : s.code}
                {s.start && <span style={{ fontWeight: 400, color: "var(--muted)" }}> {s.start}–{s.end}</span>}
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
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("calendar"); // calendar | pay | list
  const [showForm, setShowForm] = useState(false);
  const [editShift, setEditShift] = useState(null);
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [selectedDate, setSelectedDate] = useState(null);
  const [jobFilter, setJobFilter] = useState("all");
  const [importState, setImportState] = useState(null); // { loading } | { result } | { error }
  const fileInputRef = useRef(null);

  // Load
  useEffect(() => {
    loadData("shifts", []).then(d => { setShifts(d); setLoaded(true); });
  }, []);

  // Save on change
  useEffect(() => {
    if (loaded) saveData("shifts", shifts);
  }, [shifts, loaded]);

  const handleSave = (shift) => {
    setShifts(prev => {
      const idx = prev.findIndex(s => s.id === shift.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = shift; return next; }
      return [...prev, shift];
    });
    setShowForm(false);
    setEditShift(null);
  };

  const handleDelete = (id) => {
    setShifts(prev => prev.filter(s => s.id !== id));
  };

  // ─── Aspen PDF import ───
  const handlePdfFile = async (file) => {
    if (!file) return;
    setImportState({ loading: true });
    try {
      const buf = await file.arrayBuffer();
      const result = await parseAspenPdf(new Uint8Array(buf));
      setImportState({ result });
    } catch (e) {
      console.error("PDF import failed:", e);
      setImportState({ error: e.message || "Could not read this PDF." });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const confirmImport = () => {
    const { result } = importState;
    setShifts(prev => {
      const have = new Set(
        prev.map(s => `${s.date}|${s.startTime || ""}|${s.shiftType}|${s.notes || ""}`)
      );
      const additions = [];
      result.shifts.forEach((s, i) => {
        const date = ymd(s.date);
        const isOncall = s.kind === "oncall";
        const notes = isOncall ? "On-call (imported)" : `${s.code} (imported)`;
        const key = `${date}|${s.start || ""}|${isOncall ? "oncall" : "clinical"}|${notes}`;
        if (have.has(key)) return;
        have.add(key);
        additions.push({
          id: `${Date.now()}_${i}`,
          job: "aspen",
          date,
          entryType: "shift",
          shiftType: isOncall ? "oncall" : "clinical",
          hours: isOncall ? 0 : s.hours,
          ordinaryHours: isOncall ? 0 : s.ordinaryHours,
          eveningHours: isOncall ? 0 : s.eveningHours,
          isPublicHoliday: false,
          kempseyRate: "morning",
          startTime: s.start || "",
          endTime: s.end || "",
          notes,
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
  };

  const handleDayClick = (dateStr) => {
    setSelectedDate(dateStr);
    setView("list");
  };

  const filtered = shifts.filter(s => jobFilter === "all" || s.job === jobFilter);
  const fortnights = [...new Set(filtered.filter(s => s.entryType === "shift").map(shiftFortnightKey))].sort().reverse();
  const today = new Date().toISOString().slice(0, 10);
  const currentFn = getFortnightKey(today);

  const selectedShifts = selectedDate
    ? filtered.filter(s => s.date === selectedDate)
    : filtered.filter(s => shiftFortnightKey(s) === currentFn);

  if (!loaded) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Loading...</div>;

  return (
    <div style={{
      "--bg": "#f8f9fb", "--surface": "#ffffff", "--text": "#1a1a2e", "--muted": "#6b7280",
      "--border": "#e5e7eb", "--accent": "#2563eb", "--accent-light": "#dbeafe", "--hover": "#f0f1f3",
      fontFamily: "'Inter', -apple-system, system-ui, sans-serif",
      color: "var(--text)", background: "var(--bg)", minHeight: "100vh", padding: "0 0 80px 0",
      maxWidth: 960, margin: "0 auto",
    }}>
      {/* Header */}
      <div style={{ padding: "20px 16px 12px", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" }}>Shift Tracker</h1>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--muted)" }}>Track shifts, meetings, and pay across three jobs</p>
          </div>
          <button
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            style={{ ...tagBtn, display: "flex", alignItems: "center", gap: 6, background: JOBS.aspen.color, color: "#fff", borderColor: JOBS.aspen.color, flexShrink: 0 }}
          >
            <Upload size={14} /> Import Aspen PDF
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
          onClose={() => setImportState(null)}
          existing={shifts}
        />
      )}

      {/* Job filter */}
      <div style={{ display: "flex", gap: 6, padding: "10px 16px", overflowX: "auto" }}>
        <button onClick={() => setJobFilter("all")}
          style={{ ...tagBtn, background: jobFilter === "all" ? "var(--text)" : "var(--surface)", color: jobFilter === "all" ? "#fff" : "var(--text)", borderColor: "var(--border)", flexShrink: 0 }}>
          All jobs
        </button>
        {Object.entries(JOBS).map(([k, v]) => (
          <button key={k} onClick={() => setJobFilter(k)}
            style={{ ...tagBtn, background: jobFilter === k ? v.color : "var(--surface)", color: jobFilter === k ? "#fff" : "var(--text)", borderColor: v.color, flexShrink: 0 }}>
            {v.name}
          </button>
        ))}
      </div>

      {/* Nav tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
        {[
          { id: "calendar", icon: Calendar, label: "Calendar" },
          { id: "pay", icon: DollarSign, label: "Pay" },
          { id: "list", icon: FileText, label: "List" },
        ].map(tab => (
          <button key={tab.id} onClick={() => { setView(tab.id); setSelectedDate(null); }}
            style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: "10px 0", border: "none", background: "none", cursor: "pointer",
              fontSize: 13, fontWeight: view === tab.id ? 700 : 400,
              color: view === tab.id ? "var(--accent)" : "var(--muted)",
              borderBottom: view === tab.id ? "2px solid var(--accent)" : "2px solid transparent",
            }}>
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: 16 }}>
        {/* Fatigue */}
        <FatigueIndicator shifts={shifts} targetDate={today} />

        {/* Current period overall summary (not on Pay tab, which has its own) */}
        {view !== "pay" && <UpcomingPayCard shifts={filtered} base={today} />}

        {/* Calendar */}
        {view === "calendar" && (
          <CalendarView
            shifts={filtered}
            year={calYear} month={calMonth}
            onNav={handleCalNav}
            onDayClick={handleDayClick}
          />
        )}

        {/* Pay view: overall + per-job sections, each on its own cycle */}
        {view === "pay" && (
          <div>
            <UpcomingPayCard shifts={filtered} base={today} />
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: "4px 0 10px" }}>By job — work periods</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
              <JobPayPanel job="aspen" shifts={filtered} base={today} />
              <JobPayPanel job="kempsey" shifts={filtered} base={today} />
              <JobPayPanel job="fulltime" shifts={filtered} base={today} />
            </div>
            <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 12 }}>
              Each job shows its own pay cycle. Use the arrows on a job to step through its past/future periods.
            </p>
          </div>
        )}

        {/* List view */}
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
              shifts={selectedShifts}
              onEdit={(s) => { setEditShift(s); setShowForm(true); }}
              onDelete={handleDelete}
            />
          </div>
        )}

        {/* Form */}
        {showForm && (
          <div style={{ marginTop: 16 }}>
            <ShiftForm
              editShift={editShift}
              onSave={handleSave}
              onCancel={() => { setShowForm(false); setEditShift(null); }}
            />
          </div>
        )}
      </div>

      {/* FAB */}
      {!showForm && (
        <button
          onClick={() => { setEditShift(null); setShowForm(true); }}
          style={{
            position: "fixed", bottom: 20, right: 20, width: 52, height: 52, borderRadius: 26,
            background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 4px 12px rgba(37,99,235,0.4)", zIndex: 100,
          }}
          aria-label="Add entry"
        >
          <Plus size={24} />
        </button>
      )}
    </div>
  );
}
