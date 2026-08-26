// ─── Aspen Core Schedule PDF parser ───
// Reads an Aspen Medical "Individual Schedule" roster PDF and extracts the
// countable shifts for the pay fortnight named (in bold) at the top of the PDF.
//
// The grid is 7 columns (Mon–Sun) x N week-rows. Each cell is anchored by a
// "DH - Nurse:" label; the shift code + time sit just below it. Cells may wrap
// the end-time onto a second text run, so we reconstruct each cell from the
// text runs that fall just below its anchor (nearest anchor above, tie-broken
// by horizontal distance to the anchor).
//
// Only OCC Health / HIAS / TRAIN count as worked clinical hours. "OcH OC" is
// on-call (flat rate, counted once per overnight period, attributed to the
// evening it starts — the 00:00 morning tails are ignored). AV / DO / Day Off /
// CS / CS24 (safety check) / SA are excluded.

export const ASPEN_RATES = {
  ordinary: 44.14,
  evening: 50.76,
  saturday: 66.21,
  sunday: 77.25,
  publicHoliday: 88.28,
  onCallMF: 50.0,
  onCallSat: 80.0,
  onCallSunPH: 110.0,
};

const DATE_HDR = /^\d{2}\/\d{2}$/;
const CODE_RE =
  /(OCC Health|OcH OC|OcH CS24|HIAS|TRAIN|AV|Day Off|DO|CS24 SC|CS|SA)(?:\s*(\d{1,2}:\d{2})-(\d{1,2}:\d{2}))?/;
const CLINICAL = new Set(["OCC Health", "HIAS", "TRAIN"]);
const SKIP_ITEM = /coreschedule|Schedule|Aspen|Medical|Individual|Name :/;

function toMinutes(t) {
  const [h, m] = t.split(":");
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}

function durationHours(start, end) {
  let e = toMinutes(end);
  if (e === 0) e = 24 * 60; // 00:00 end means midnight
  return (e - toMinutes(start)) / 60;
}

function parseDMY(s) {
  const [d, m, y] = s.split("/").map(Number);
  return new Date(y, m - 1, d);
}

// Pure grid parser. `pages` is [{ height, items: [{ str, x, y }] }] where y is
// measured from the top of the page (larger y = further down).
export function extractRosterFromPages(pages) {
  // 1. Fortnight range (bold) — from the first page's text.
  const firstText = pages[0].items.map((i) => i.str).join(" ");
  const fm = firstText.match(
    /(\d{2})\/(\d{2})\/(\d{4})\s*[–\-]\s*(\d{2})\/(\d{2})\/(\d{4})/
  );
  if (!fm) throw new Error("Could not find the bold fortnight date range at the top of the PDF.");
  const fortnightStart = new Date(+fm[3], +fm[2] - 1, +fm[1]);
  const fortnightEnd = new Date(+fm[6], +fm[5] - 1, +fm[4]);
  const year = fortnightStart.getFullYear();

  const entries = []; // { date: Date, code, start, end }

  for (const page of pages) {
    const items = page.items.filter((i) => i.str && i.str.trim());

    // 2. Date-header rows: cluster items by y, keep rows with >=5 dd/mm tokens.
    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    for (const it of sorted) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(it.y - last.y) < 4) last.items.push(it);
      else rows.push({ y: it.y, items: [it] });
    }
    const bands = [];
    for (const row of rows) {
      const toks = row.items
        .filter((i) => DATE_HDR.test(i.str.trim()))
        .sort((a, b) => a.x - b.x);
      if (toks.length >= 5) {
        bands.push({
          y: row.y,
          cols: toks.map((t) => ({ cx: t.x, date: t.str.trim() })),
        });
      }
    }
    if (!bands.length) continue;
    bands.sort((a, b) => a.y - b.y);
    const centers = bands[0].cols.map((c) => c.cx);
    const colIdx = (x) => {
      let best = 0;
      for (let i = 1; i < centers.length; i++)
        if (Math.abs(centers[i] - x) < Math.abs(centers[best] - x)) best = i;
      return best;
    };
    const bandFor = (y) => {
      let b = null;
      for (const band of bands) if (y > band.y + 5) b = band;
      return b;
    };

    // 3. Anchors (DH - Nurse:) and content runs.
    const anchors = items.filter((i) => i.str.startsWith("DH - Nurse"));
    const content = items.filter(
      (i) => !i.str.startsWith("DH - Nurse") && !DATE_HDR.test(i.str.trim()) && !SKIP_ITEM.test(i.str)
    );

    const cells = anchors.map(() => []);
    for (const w of content) {
      const cands = [];
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        if (w.y >= a.y - 3 && w.y <= a.y + 34) cands.push(i);
      }
      if (!cands.length) continue;
      cands.sort((i, j) => {
        const di = Math.abs(w.x - anchors[i].x);
        const dj = Math.abs(w.x - anchors[j].x);
        if (di !== dj) return di - dj;
        return w.y - anchors[i].y - (w.y - anchors[j].y);
      });
      cells[cands[0]].push(w);
    }

    for (let i = 0; i < anchors.length; i++) {
      const cw = cells[i].sort((a, b) => a.y - b.y || a.x - b.x);
      if (!cw.length) continue;
      const band = bandFor(anchors[i].y);
      if (!band) continue;
      const ci = colIdx(anchors[i].x);
      if (!band.cols[ci]) continue;
      const [dd, mm] = band.cols[ci].date.split("/");
      const date = new Date(year, +mm - 1, +dd);
      let txt = cw.map((w) => w.str).join(" ");
      txt = txt.replace(/(\d{1,2}:\d{2})-\s*(\d{1,2}:\d{2})/g, "$1-$2");
      const mt = txt.match(CODE_RE);
      if (mt) entries.push({ date, code: mt[1], start: mt[2] || null, end: mt[3] || null });
    }
  }

  // De-duplicate (date|code|start|end).
  const seen = new Set();
  const unique = entries.filter((e) => {
    const k = `${e.date.getTime()}|${e.code}|${e.start}|${e.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 4. Classify within the bold fortnight only.
  const inRange = (d) => d >= fortnightStart && d <= fortnightEnd;
  const shifts = [];
  for (const e of unique) {
    if (!inRange(e.date)) continue;
    const dow = e.date.getDay(); // 0=Sun..6=Sat

    if (e.code === "OcH OC") {
      if (!e.start || e.start === "00:00") continue; // morning tail — not counted
      shifts.push({
        date: e.date,
        kind: "oncall",
        code: e.code,
        start: e.start,
        end: e.end,
        dow,
      });
      continue;
    }

    if (CLINICAL.has(e.code) && e.start && e.end) {
      const hours = durationHours(e.start, e.end);
      let ordinaryHours = 0;
      let eveningHours = 0;
      if (dow !== 0 && dow !== 6) {
        const s = toMinutes(e.start);
        let en = toMinutes(e.end);
        if (en === 0) en = 1440;
        ordinaryHours = Math.max(0, Math.min(en, 900) - Math.max(s, 420)) / 60;
        eveningHours = hours - ordinaryHours;
      }
      shifts.push({
        date: e.date,
        kind: "clinical",
        code: e.code,
        start: e.start,
        end: e.end,
        dow,
        hours,
        ordinaryHours,
        eveningHours,
      });
    }
  }

  shifts.sort((a, b) => a.date - b.date || (a.start || "").localeCompare(b.start || ""));
  return { fortnightStart, fortnightEnd, shifts, summary: summarise(shifts) };
}

export function summarise(shifts) {
  const cat = { ordinary: 0, evening: 0, saturday: 0, sunday: 0, publicHoliday: 0 };
  const oncall = { mf: 0, sat: 0, sunph: 0 };
  for (const s of shifts) {
    if (s.kind === "oncall") {
      if (s.dow === 0) oncall.sunph++;
      else if (s.dow === 6) oncall.sat++;
      else oncall.mf++;
    } else {
      if (s.dow === 0) cat.sunday += s.hours;
      else if (s.dow === 6) cat.saturday += s.hours;
      else {
        cat.ordinary += s.ordinaryHours;
        cat.evening += s.eveningHours;
      }
    }
  }
  const workedHours =
    cat.ordinary + cat.evening + cat.saturday + cat.sunday + cat.publicHoliday;
  const gross =
    cat.ordinary * ASPEN_RATES.ordinary +
    cat.evening * ASPEN_RATES.evening +
    cat.saturday * ASPEN_RATES.saturday +
    cat.sunday * ASPEN_RATES.sunday +
    cat.publicHoliday * ASPEN_RATES.publicHoliday +
    oncall.mf * ASPEN_RATES.onCallMF +
    oncall.sat * ASPEN_RATES.onCallSat +
    oncall.sunph * ASPEN_RATES.onCallSunPH;
  return { cat, oncall, workedHours, gross };
}

// Browser entry point: parse an ArrayBuffer/Uint8Array of an Aspen roster PDF.
export async function parseAspenPdf(data) {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items
      .filter((it) => it.str !== undefined)
      .map((it) => ({ str: it.str, x: it.transform[4], y: vp.height - it.transform[5] }));
    pages.push({ height: vp.height, items });
  }
  return extractRosterFromPages(pages);
}
