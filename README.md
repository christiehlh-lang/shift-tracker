# Shift Tracker

A mobile-friendly web app for tracking shifts, meetings, and pay across three jobs
(Aspen, Kempsey ED, and a fixed full-time role), with award-rate pay calculations,
fortnightly pay summaries, and a fatigue-load indicator.

## Features

- **Calendar view** — month grid with colour-coded dots per job; tap a day to see its entries.
- **Pay view** — fortnightly gross pay per job plus an estimated take-home figure.
- **List view** — current fortnight (or a selected day) with per-shift pay.
- **Import Aspen roster PDF** — upload an Aspen Medical "Individual Schedule" PDF and
  the app reads the grid, identifies the pay fortnight from the bold date range at the
  top, extracts only the countable shifts (OCC Health / HIAS / TRAIN clinical hours and
  OcH OC on-call), splits weekday hours into ordinary/evening, and shows a review sheet
  with the computed gross before adding them. AV / DO / CS / CS24 (safety check) / SA
  are ignored. Parsing runs entirely in the browser (pdf.js) — nothing is uploaded.
- **Import full-time calendar PDF** — upload an Outlook weekly calendar export and the
  app extracts each meeting (day, start/end time, title, Teams flag) by rendering the
  page and detecting the event boxes, adding them as full-time meetings on the planner.
  The same Import button auto-detects whether the PDF is an Aspen roster or a full-time
  calendar. Parsing runs entirely in the browser.
- **Add / edit entries** — shifts, meetings, or notes with job, date, times, hours and notes.
- **Award-rate engine** — Aspen (ordinary/evening/weekend/PH/on-call/called-in) and
  Kempsey ED (morning/afternoon/weekend) rates, computed automatically.
- **Fatigue indicator** — flags load based on hours worked over the trailing 7 days.
- **Local persistence** — all data is stored in the browser via `localStorage`.

## Getting started

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default http://localhost:5173).

## Build

```bash
npm run build      # outputs to dist/
npm run preview    # serve the production build locally
```

## Tech stack

- React 18
- Vite 5
- lucide-react (icons)

## Notes

- Pay rates and the full-time fortnightly figure live at the top of
  `src/ShiftTracker.jsx` (`ASPEN_RATES`, `KEMPSEY_RATES`, `FT_FORTNIGHTLY`).
- The take-home estimate is a rough heuristic, not tax advice.
- Data lives only in the current browser; clearing site data removes it.
