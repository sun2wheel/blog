#!/usr/bin/env node
/**
 * Generates a standalone, self-contained SVG of the "Power" dashboard chart
 * for use as an example image in the blog. The source was a live Recharts/Chakra
 * component whose colors came from CSS variables that don't exist on the blog,
 * so we redraw it cleanly here with real hex colors, axes, legend, title and caption.
 *
 * The bar values below were reverse-engineered from the rendered SVG markup:
 * the plot area was 232px tall mapping 0..160 (kW) with the baseline at y=237,
 * so kW = (237 - y_top - height ... ) — i.e. value = height_px * (160 / 232).
 *
 * Usage: node scripts/gen-power-chart.js
 * Output: static/images/blog/power-example-2026-06-07.svg
 */

const fs = require("fs");
const path = require("path");
// sun2wheel logo (white/negative version) as a base64 data-URI so the SVG stays
// self-contained. Regenerate with:
//   base64 -i static/images/sun2wheel-logo-white.png > scripts/logo-data.js
const LOGO_DATA = require("./logo-data.js");
const LOGO_AR = 2363 / 857; // native aspect ratio (w/h)

// ---- Source data: the rendered chart spanned 96 quarter-hour slots (24h). ----
// Pixel->value scale from the original chart.
const PX_PER_UNIT = 232 / 160; // 1.45 px per kW

// Helper: convert an original bar pixel-height to a kW value.
const px2kw = (h) => +(h / PX_PER_UNIT).toFixed(1);

// The original chart's notable bars (sampled from the markup). We rebuild a
// smooth 96-slot day from the characteristic shape rather than transcribing
// every path, keeping the same peaks/timing the data showed.
// Index 0 = 00:00, step = 15 min, 96 slots -> 24:00.
const SLOTS = 96;
const t = (i) => i / 4; // hour as float

function bell(i, center, width, peak) {
  const x = (t(i) - center) / width;
  return peak * Math.exp(-x * x);
}

// We model two physical primitives — PV production and site load — then
// DERIVE the four plotted series from the energy balance at each time step:
//   self-consumption = min(production, load)        // PV used on site
//   export           = max(0, production - load)    // only the surplus
//   grid import      = max(0, load - production)     // only the deficit
// Export therefore appears ONLY when production exceeds load (the midday hours),
// not across the whole production curve.
const data = Array.from({ length: SLOTS }, (_, i) => {
  const h = t(i);

  // Site load: ~30 kW overnight/evening baseline, small morning & evening bumps,
  // plus a late-night charging spike (~01:00).
  let load = 30;
  load += bell(i, 8, 1.5, 8); // morning ramp
  load += bell(i, 19, 2.0, 12); // evening peak
  load += bell(i, 1, 0.6, 20); // late-night charge
  load = Math.max(0, load);

  // PV production: solar bell, peaks ~170 kW near solar noon, zero before ~05:30
  // and after ~21:00.
  let prod = bell(i, 12.6, 3.1, 170);
  if (h < 5.3 || h > 21) prod = 0;
  prod = Math.max(0, prod);

  // Curtailment / flexibility event: a sharp midday throttle (~120 kW reduction
  // around 11:45) that trims production right when the spot price is negative.
  let curt = 0;
  if (h >= 11.4 && h <= 12.2) curt = bell(i, 11.8, 0.22, 120);
  curt = Math.min(curt, prod); // can't curtail more than is produced

  // Production actually delivered after curtailment.
  const prodNet = Math.max(0, prod - curt);

  // Energy balance.
  const self = Math.min(prodNet, load);
  const exp = Math.max(0, prodNet - load);
  const imp = Math.max(0, load - prodNet);

  return {
    self: +self.toFixed(1),
    exp: +exp.toFixed(1),
    imp: +imp.toFixed(1),
    curt: +curt.toFixed(1),
  };
});

// ---- Day-ahead spot price (Swiss bidding zone CH), 2026-06-07 ----
// Source: Energy-Charts API (api.energy-charts.info/price?bzn=CH),
// data CC BY 4.0 from Bundesnetzagentur | SMARD.de. Hourly EUR/MWh,
// indexed 0..23 = local time (CEST, UTC+2).
const PRICE = [
  113.99, 102.29, 99.0, 93.78, 88.86, 77.85, 50.51, 1.8, -7.53, -6.81,
  -10.22, -13.35, -16.21, -26.14, -26.87, -22.49, -10.59, -2.0, 75.69,
  102.55, 124.16, 133.03, 136.46, 130.27,
];

// ---- Chart geometry ----
const W = 760;
const H = 380;
const M = { top: 56, right: 56, bottom: 112, left: 56 };
const plotW = W - M.left - M.right;
const plotH = H - M.top - M.bottom;

const COLORS = {
  curt: "#a0aec0",
  exp: "#eab308", // concrete yellow (Chakra yellow-solid equivalent)
  expNeg: "#a0aec0", // grey: export during NEGATIVE spot prices (unprofitable)
  imp: "#60a5fa",
  self: "#34d399",
  price: "#f472b6", // pink line for the spot price
};

const Y_MAX = 200; // headroom above the ~175 kW curtailment spike
const yScale = (v) => M.top + plotH - (v / Y_MAX) * plotH;
const barW = plotW / SLOTS;

// Secondary (price) axis, ZERO-ALIGNED with the power axis: 0 EUR/MWh maps to
// exactly the same pixel as 0 kW (the plot baseline). Positive prices rise from
// the baseline like the bars; negative prices dip below it (into the bottom
// margin), which literally shows the price "going below zero".
const P_MAX = 160; // EUR/MWh at the top gridline (== Y_MAX kW)
const pScale = (v) => M.top + plotH - (v / P_MAX) * plotH;
// X position of the centre of hour h (0..24) on the plot.
const xAtHour = (h) => M.left + (h / 24) * plotW;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- Build SVG ----
// The four series are a partition of the energy flow, so we STACK them from the
// baseline up: self-consumption first, then export and import (only one of which
// is non-zero at a time), then curtailment on top (the production that was
// throttled and would otherwise have added to export).
let bars = "";
data.forEach((d, i) => {
  const x = M.left + i * barW;
  const w = Math.max(0.6, barW - 0.6);
  // Export is drawn grey whenever the spot price for this slot's hour is < 0
  // (exporting then is unprofitable / penalised), and yellow otherwise.
  const priceNow = PRICE[Math.floor(t(i)) % 24];
  const expColor = priceNow < 0 ? COLORS.expNeg : COLORS.exp;
  const stack = [
    ["self", COLORS.self, d.self],
    ["imp", COLORS.imp, d.imp],
    ["exp", expColor, d.exp],
    ["curt", COLORS.curt, d.curt],
  ];
  let cum = 0;
  for (const [, color, val] of stack) {
    if (val <= 0) continue;
    const yTop = yScale(cum + val);
    const yBot = yScale(cum);
    bars += `<rect x="${x.toFixed(2)}" y="${yTop.toFixed(2)}" width="${w.toFixed(2)}" height="${(yBot - yTop).toFixed(2)}" fill="${color}" fill-opacity="0.9"/>\n`;
    cum += val;
  }
});

// Y gridlines + labels (every 40)
let yAxis = "";
for (let v = 0; v <= Y_MAX; v += 40) {
  const y = yScale(v);
  yAxis += `<line x1="${M.left}" y1="${y.toFixed(2)}" x2="${M.left + plotW}" y2="${y.toFixed(2)}" stroke="#2d3748" stroke-width="1"/>\n`;
  yAxis += `<text x="${M.left - 8}" y="${(y + 4).toFixed(2)}" text-anchor="end" font-size="12" fill="#718096">${v}</text>\n`;
}

// Secondary (right) price axis. 0 EUR/MWh shares the 0 kW baseline; we label
// from the negative dip (-40) up to P_MAX so the below-zero excursion is read.
let priceAxis = "";
for (let v = -40; v <= P_MAX; v += 40) {
  const y = pScale(v);
  priceAxis += `<text x="${M.left + plotW + 8}" y="${(y + 4).toFixed(2)}" text-anchor="start" font-size="12" fill="${COLORS.price}">${v}</text>\n`;
}

// Price line: hourly points plotted at the centre of each hour.
const pricePts = PRICE.map((p, h) => `${xAtHour(h + 0.5).toFixed(2)},${pScale(p).toFixed(2)}`).join(" ");
const priceLine = `<polyline points="${pricePts}" fill="none" stroke="${COLORS.price}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;

// X axis: vertical gridlines (drawn behind the bars) + labels every 3h.
let xGrid = "";
let xAxis = "";
for (let hr = 0; hr <= 24; hr += 3) {
  const gx = xAtHour(hr); // gridline at the exact hour boundary
  xGrid += `<line x1="${gx.toFixed(2)}" y1="${M.top}" x2="${gx.toFixed(2)}" y2="${(M.top + plotH).toFixed(2)}" stroke="#2d3748" stroke-width="1"/>\n`;
  const label = `${String(hr % 24).padStart(2, "0")}:00`;
  xAxis += `<text x="${gx.toFixed(2)}" y="${(M.top + plotH + 72).toFixed(2)}" text-anchor="middle" font-size="12" fill="#718096">${label}</text>\n`;
}

// Language-specific text. Pass `--lang en` for the English variant.
const LANG = (process.argv.find((a) => a.startsWith("--lang="))?.split("=")[1] ||
  (process.argv[process.argv.indexOf("--lang") + 1]) ||
  "de").toLowerCase() === "en" ? "en" : "de";

const TEXT = {
  de: {
    title: "Leistung & Day-Ahead-Preis – 7. Juni 2026",
    yLabel: "Leistung (kW)",
    priceLabel: "Day-Ahead-Preis (EUR/MWh)",
    legend: [
      ["Eigenverbrauch", COLORS.self],
      ["Einspeisung", COLORS.exp],
      ["Einspeisung bei Negativpreis", COLORS.expNeg],
      ["Netzbezug", COLORS.imp],
      ["Day-Ahead-Preis (CH)", COLORS.price],
    ],
    file: "power-example-2026-06-07-de.svg",
  },
  en: {
    title: "Power & Day-Ahead Price – June 7, 2026",
    yLabel: "Power (kW)",
    priceLabel: "Day-ahead price (EUR/MWh)",
    legend: [
      ["Self-Consumption", COLORS.self],
      ["Export", COLORS.exp],
      ["Export at negative price", COLORS.expNeg],
      ["Grid Import", COLORS.imp],
      ["Day-ahead price (CH)", COLORS.price],
    ],
    file: "power-example-2026-06-07-en.svg",
  },
}[LANG];

// Legend — a marker per series; the price uses a line swatch instead of a box.
let legend = "";
let lx = M.left;
const ly = H - 16;
const LEG_FS = 11;
for (const [label, color] of TEXT.legend) {
  if (color === COLORS.price) {
    legend += `<line x1="${lx}" y1="${ly - 4}" x2="${lx + 14}" y2="${ly - 4}" stroke="${color}" stroke-width="2.5"/>`;
    legend += `<text x="${lx + 20}" y="${ly}" font-size="${LEG_FS}" fill="#cbd5e0">${esc(label)}</text>`;
    lx += 24 + label.length * 6.4;
  } else {
    legend += `<rect x="${lx}" y="${ly - 9}" width="11" height="11" rx="2" fill="${color}"/>`;
    legend += `<text x="${lx + 16}" y="${ly}" font-size="${LEG_FS}" fill="#cbd5e0">${esc(label)}</text>`;
    lx += 20 + label.length * 6.4;
  }
}

const title = TEXT.title;
const yLabel = TEXT.yLabel;
const priceLabel = TEXT.priceLabel;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, Segoe UI, Roboto, sans-serif">
  <rect width="${W}" height="${H}" fill="#1a1a2e" rx="6"/>
  ${(() => {
    // White/negative logo placed directly on the dark chart background.
    const logoH = 30;
    const logoW = logoH * LOGO_AR;
    return `<image x="14" y="12" width="${logoW.toFixed(1)}" height="${logoH}" href="${LOGO_DATA}" preserveAspectRatio="xMidYMid meet"/>`;
  })()}
  <text x="${W - M.right}" y="33" font-size="15" font-weight="600" fill="#a0aec0" text-anchor="end">${esc(title)}</text>
  <text x="16" y="${M.top + plotH / 2}" font-size="12" fill="#718096" text-anchor="middle" transform="rotate(-90 16 ${M.top + plotH / 2})">${esc(yLabel)}</text>
  <text x="${W - 12}" y="${M.top + plotH / 2}" font-size="12" fill="${COLORS.price}" text-anchor="middle" transform="rotate(90 ${W - 12} ${M.top + plotH / 2})">${esc(priceLabel)}</text>
  <g>${yAxis}</g>
  <g>${xGrid}</g>
  <g>${priceAxis}</g>
  <g>${bars}</g>
  ${priceLine}
  <g>${xAxis}</g>
  <g>${legend}</g>
</svg>
`;

const outDir = path.join(__dirname, "..", "static", "images", "blog");
const outFile = path.join(outDir, TEXT.file);
fs.writeFileSync(outFile, svg, "utf8");
console.log("Wrote", outFile, `(${svg.length} bytes)`);
