// ─── Full-time calendar (Outlook weekly print) PDF parser ───
// Extracts timed meetings from an Outlook "week" PDF. Events are coloured boxes
// positioned on a time grid; the box geometry (start/end) is recovered by
// rendering the page and scanning each day-column for runs of coloured (event)
// pixels. Titles/times come from the text layer.

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtTime(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// Pure scan: given rendered pixels + text items, return meetings for one page.
export function scanPage({ img, W, H, scale, items, viewportHeight }) {
  // 1. Hour axis → time mapping (linear fit of "7 AM".."7 PM" labels).
  const hourRe = /^(\d{1,2})\s?(AM|PM)$/i;
  const hours = [];
  for (const it of items) {
    const m = it.str.match(hourRe);
    if (m) { let h = (+m[1]) % 12; if (/pm/i.test(m[2])) h += 12; hours.push({ h, y: it.y }); }
  }
  if (hours.length < 3) return [];
  const n = hours.length;
  const sx = hours.reduce((s, p) => s + p.h, 0), sy = hours.reduce((s, p) => s + p.y, 0);
  const sxx = hours.reduce((s, p) => s + p.h * p.h, 0), sxy = hours.reduce((s, p) => s + p.h * p.y, 0);
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx); // y = a*h + b
  const b = (sy - a * sx) / n;
  const yToMin = (yTop) => Math.round(((yTop - b) / a) * 60 / 15) * 15;
  const gridTop = a * 7 + b - 4;      // ~7 AM
  const gridBot = a * 20 + b + 8;     // ~8 PM

  // 2. Week start (Monday) from the range header, e.g. "Monday, 29 June 2026".
  const allText = items.map(i => i.str).join(" ");
  const wm = allText.match(/(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  let weekStart = null;
  if (wm) weekStart = new Date(+wm[3], MONTHS.indexOf(wm[2].toLowerCase()), +wm[1]);
  if (!weekStart) return [];

  // 3. Day columns from the day-name headers.
  const dayItems = items.filter(i => DAYS.includes(i.str)).sort((u, v) => u.x - v.x);
  if (dayItems.length < 2) return [];
  // Day-name labels sit at the column centre; columns are evenly spaced.
  const colXs = dayItems.map(d => d.x);
  const diffs = colXs.slice(1).map((x, i) => x - colXs[i]).sort((p, q) => p - q);
  const colW = diffs[Math.floor(diffs.length / 2)] || 65;
  const bounds = colXs.map(cx => [cx - colW / 2, cx + colW / 2]);

  const isEvent = (idx) => {
    const r = img[idx], g = img[idx + 1], bl = img[idx + 2];
    const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
    return (mx - mn) > 25 && (r + g + bl) > 150; // coloured (not white/grey/black)
  };

  const meetings = [];
  for (let c = 0; c < bounds.length; c++) {
    const [L, R] = bounds[c];
    // Scan only the centre strip so we don't catch a neighbour column's box,
    // which can overhang slightly past the column midpoint.
    const cx = (L + R) / 2;
    const xL = Math.round((cx - colW * 0.3) * scale), xR = Math.round((cx + colW * 0.3) * scale);
    const yTopGrid = Math.max(0, Math.round(gridTop * scale));
    const yBotGrid = Math.min(H, Math.round(gridBot * scale));
    const runs = [];
    let run = null, gap = 0;
    for (let py = yTopGrid; py < yBotGrid; py++) {
      let has = false;
      for (let px = xL; px < xR; px += 2) {
        if (isEvent((py * W + px) * 4)) { has = true; break; }
      }
      // Break on a white gap (>=2 empty rows) so back-to-back meetings split;
      // rows inside a box always have coloured background, so never empty.
      if (has) { if (!run) run = [py, py]; else run[1] = py; gap = 0; }
      else if (run) { if (++gap >= 2) { runs.push(run); run = null; gap = 0; } }
    }
    if (run) runs.push(run);

    for (const [p0, p1] of runs) {
      if (p1 - p0 < scale * 6) continue; // ignore tiny specks
      const yTop = p0 / scale, yBot = p1 / scale;
      const date = new Date(weekStart); date.setDate(date.getDate() + c);
      const box = items
        .filter(it => it.x >= L - 2 && it.x <= R + 2 && it.y >= yTop - 2 && it.y <= yBot + 6)
        .sort((u, v) => u.y - v.y || u.x - v.x);
      const lines = [];
      for (const it of box) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(it.y - last.y) < 4) {
          if (last.toks[last.toks.length - 1] !== it.str) last.toks.push(it.str);
        } else lines.push({ y: it.y, toks: [it.str] });
      }
      const lineStrs = [];
      for (const ln of lines) { const t = ln.toks.join(" "); if (lineStrs[lineStrs.length - 1] !== t) lineStrs.push(t); }
      const teams = lineStrs.some(s => /^Microsoft/i.test(s));
      const title = lineStrs.filter(s => !/^Microsoft/i.test(s)).join(" ").trim() || "Meeting";
      meetings.push({
        date: ymdLocal(date),
        start: fmtTime(yToMin(yTop)),
        end: fmtTime(yToMin(yBot)),
        title,
        teams,
      });
    }
  }
  return meetings;
}

// Render a page to a canvas and return pixels + text items for scanPage.
async function renderPage(pdfjs, page, scale) {
  const vp = page.getViewport({ scale });
  const vp1 = page.getViewport({ scale: 1 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const tc = await page.getTextContent();
  const items = tc.items
    .filter(i => i.str && i.str.trim())
    .map(i => ({ str: i.str.trim(), x: i.transform[4], y: vp1.height - i.transform[5], w: i.width }));
  return { img, W: canvas.width, H: canvas.height, scale, items, viewportHeight: vp1.height };
}

export async function parseFulltimePdf(data) {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data }).promise;
  const meetings = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const rendered = await renderPage(pdfjs, page, 3);
    meetings.push(...scanPage(rendered));
  }
  meetings.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  return { meetings };
}

// Lightweight format detector from a PDF's first-page text.
export async function detectPdfKind(data) {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const text = tc.items.map(i => i.str).join(" ");
  if (/Aspen Medical|Individual Schedule|DH - Nurse/i.test(text)) return "aspen";
  if (/\b\d{1,2}\s?(AM|PM)\b/i.test(text) && /(Mon|Tue|Wed|Thu|Fri)/.test(text)) return "fulltime";
  return "aspen";
}
