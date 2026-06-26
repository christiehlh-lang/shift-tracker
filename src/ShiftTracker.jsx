import { useState, useEffect } from "react";
import { Calendar, DollarSign, Plus, Trash2, ChevronLeft, ChevronRight, X, AlertTriangle, FileText, Edit3 } from "lucide-react";

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

const FT_FORTNIGHTLY = 3064;

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
  // Anchor: 20/06/2025 is a known fortnight start (Friday)
  const anchor = new Date(2025, 5, 20);
  const d = new Date(dateStr);
  const diff = Math.floor((d - anchor) / (1000 * 60 * 60 * 24));
  const fnNum = Math.floor(diff / 14);
  const start = new Date(anchor.getTime() + fnNum * 14 * 86400000);
  const end = new Date(start.getTime() + 13 * 86400000);
  return `${start.toISOString().slice(0, 10)}_${end.toISOString().slice(0, 10)}`;
}

function fortnightLabel(key) {
  const [s, e] = key.split("_");
  const fmt = (d) => new Date(d).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit" });
  return `${fmt(s)} - ${fmt(e)}`;
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

function CalendarView({ shifts, year, month, onNav, onDayClick }) {
  const days = getMonthDays(year, month);
  const monthLabel = new Date(year, month).toLocaleDateString("en-AU", { month: "long", year: "numeric" });

  const shiftsForDay = (d) => {
    if (!d) return [];
    const ds = toDateStr(year, month, d);
    return shifts.filter(s => s.date === ds);
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <button onClick={() => onNav(-1)} style={iconBtnStyle} aria-label="Previous month"><ChevronLeft size={20} /></button>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{monthLabel}</h3>
        <button onClick={() => onNav(1)} style={iconBtnStyle} aria-label="Next month"><ChevronRight size={20} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(d => (
          <div key={d} style={{ textAlign: "center", fontSize: 11, fontWeight: 600, color: "var(--muted)", padding: "4px 0" }}>{d}</div>
        ))}
        {days.map((d, i) => {
          const dayShifts = shiftsForDay(d);
          const isToday = d && toDateStr(year, month, d) === new Date().toISOString().slice(0, 10);
          return (
            <div key={i}
              onClick={() => d && onDayClick(toDateStr(year, month, d))}
              style={{
                minHeight: 48, borderRadius: 6, padding: 3, cursor: d ? "pointer" : "default",
                background: isToday ? "var(--accent-light)" : d ? "var(--surface)" : "transparent",
                border: isToday ? "2px solid var(--accent)" : "1px solid transparent",
                transition: "background 0.15s",
              }}
              onMouseEnter={e => { if (d) e.currentTarget.style.background = "var(--hover)"; }}
              onMouseLeave={e => { if (d) e.currentTarget.style.background = isToday ? "var(--accent-light)" : "var(--surface)"; }}
            >
              {d && (
                <>
                  <div style={{ fontSize: 12, fontWeight: isToday ? 700 : 400, textAlign: "right", paddingRight: 2 }}>{d}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginTop: 2 }}>
                    {dayShifts.map(s => (
                      <div key={s.id} style={{
                        width: 6, height: 6, borderRadius: 3,
                        background: JOBS[s.job]?.color || "#888",
                      }} title={`${JOBS[s.job]?.name} ${s.entryType}`} />
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      {/* Legend */}
      <div style={{ display: "flex", gap: 16, marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
        {Object.entries(JOBS).map(([k, v]) => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: 4, background: v.color }} />
            {v.name}
          </div>
        ))}
      </div>
    </div>
  );
}

function PaySummaryCard({ shifts, fortnightKey }) {
  const fnShifts = shifts.filter(s => getFortnightKey(s.date) === fortnightKey && s.entryType === "shift");

  let aspenTotal = 0, kempseyTotal = 0;
  let aspenHrs = 0, kempseyHrs = 0;

  fnShifts.forEach(s => {
    const pay = calcShiftPay(s);
    if (s.job === "aspen") { aspenTotal += pay; if (s.shiftType !== "oncall") aspenHrs += parseFloat(s.hours) || 0; }
    if (s.job === "kempsey") { kempseyTotal += pay; kempseyHrs += parseFloat(s.hours) || 0; }
  });

  const totalGross = aspenTotal + kempseyTotal + FT_FORTNIGHTLY;
  const takeHome = estimateTakeHome(totalGross);

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>{fortnightLabel(fortnightKey)}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 11, color: JOBS.aspen.color, fontWeight: 600 }}>Aspen</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{fmtMoney(aspenTotal)}</div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>{aspenHrs}h worked</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 11, color: JOBS.kempsey.color, fontWeight: 600 }}>Kempsey</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{fmtMoney(kempseyTotal)}</div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>{kempseyHrs}h worked</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 11, color: JOBS.fulltime.color, fontWeight: 600 }}>Full-time</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{fmtMoney(FT_FORTNIGHTLY)}</div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>fixed</div>
        </div>
      </div>
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Total gross</div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>{fmtMoney(totalGross)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Est. take-home</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "var(--accent)" }}>~{fmtMoney(takeHome)}</div>
        </div>
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
  const fortnights = [...new Set(filtered.filter(s => s.entryType === "shift").map(s => getFortnightKey(s.date)))].sort().reverse();
  const today = new Date().toISOString().slice(0, 10);
  const currentFn = getFortnightKey(today);

  const selectedShifts = selectedDate
    ? filtered.filter(s => s.date === selectedDate)
    : filtered.filter(s => getFortnightKey(s.date) === currentFn);

  if (!loaded) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Loading...</div>;

  return (
    <div style={{
      "--bg": "#f8f9fb", "--surface": "#ffffff", "--text": "#1a1a2e", "--muted": "#6b7280",
      "--border": "#e5e7eb", "--accent": "#2563eb", "--accent-light": "#dbeafe", "--hover": "#f0f1f3",
      fontFamily: "'Inter', -apple-system, system-ui, sans-serif",
      color: "var(--text)", background: "var(--bg)", minHeight: "100vh", padding: "0 0 80px 0",
      maxWidth: 520, margin: "0 auto",
    }}>
      {/* Header */}
      <div style={{ padding: "20px 16px 12px", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" }}>Shift Tracker</h1>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--muted)" }}>Track shifts, meetings, and pay across three jobs</p>
      </div>

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

        {/* Current fortnight summary */}
        {view !== "pay" && <PaySummaryCard shifts={filtered} fortnightKey={currentFn} />}

        {/* Calendar */}
        {view === "calendar" && (
          <CalendarView
            shifts={filtered}
            year={calYear} month={calMonth}
            onNav={handleCalNav}
            onDayClick={handleDayClick}
          />
        )}

        {/* Pay view */}
        {view === "pay" && (
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Fortnight pay summaries</h3>
            {fortnights.length === 0 && <div style={{ fontSize: 13, color: "var(--muted)" }}>No shifts recorded yet.</div>}
            {fortnights.map(fn => <PaySummaryCard key={fn} shifts={filtered} fortnightKey={fn} />)}
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
