/**
 * Smart Survey AI — ASCII DXF Exporter
 * AutoCAD / Civil 3D compatible
 * No external dependencies — pure ASCII DXF R12 format
 */

// ─── LAYER DEFINITIONS ────────────────────────────────────────────────────────
const LAYERS = {
  PROFILE:   { color: 5 },   // Blue    — ground profile polyline
  GRID:      { color: 8 },   // Grey    — grid lines
  STATIONS:  { color: 3 },   // Green   — station tick marks
  RL_TEXT:   { color: 2 },   // Yellow  — reduced level labels
  BM:        { color: 1 },   // Red     — benchmark marker
  TITLE:     { color: 7 },   // White   — title block text
  CHAINAGES: { color: 6 },   // Magenta — chainage labels
};

// ─── DXF SECTION BUILDERS ─────────────────────────────────────────────────────

function dxfHeader(minX, minY, maxX, maxY) {
  return [
    "0", "SECTION",
    "2", "HEADER",
    "9", "$ACADVER", "1", "AC1009",
    "9", "$INSBASE",  "10", "0.0", "20", "0.0", "30", "0.0",
    "9", "$EXTMIN",   "10", String(minX), "20", String(minY), "30", "0.0",
    "9", "$EXTMAX",   "10", String(maxX), "20", String(maxY), "30", "0.0",
    "9", "$LUNITS",   "70", "2",
    "9", "$LUPREC",   "70", "3",
    "0", "ENDSEC",
  ].join("\n");
}

function dxfTables() {
  const layerEntries = Object.entries(LAYERS).map(([name, props]) => [
    "0", "LAYER",
    "2", name,
    "70", "0",
    "62", String(props.color),
    "6", "CONTINUOUS",
  ].join("\n")).join("\n");

  return [
    "0", "SECTION",
    "2", "TABLES",
    "0", "TABLE",
    "2", "LAYER",
    "70", String(Object.keys(LAYERS).length),
    layerEntries,
    "0", "ENDTAB",
    "0", "ENDSEC",
  ].join("\n");
}

// ─── ENTITY BUILDERS ──────────────────────────────────────────────────────────

function dxfText(x, y, height, text, layer, rotation = 0) {
  return [
    "0", "TEXT",
    "8", layer,
    "10", x.toFixed(4),
    "20", y.toFixed(4),
    "30", "0.0",
    "40", height.toFixed(4),
    "1",  String(text),
    "50", rotation.toFixed(2),
    "72", "1",   // horizontal center
    "11", x.toFixed(4),
    "21", y.toFixed(4),
    "31", "0.0",
  ].join("\n");
}

function dxfLine(x1, y1, x2, y2, layer) {
  return [
    "0", "LINE",
    "8", layer,
    "10", x1.toFixed(4),
    "20", y1.toFixed(4),
    "30", "0.0",
    "11", x2.toFixed(4),
    "21", y2.toFixed(4),
    "31", "0.0",
  ].join("\n");
}

function dxfCircle(x, y, r, layer) {
  return [
    "0", "CIRCLE",
    "8", layer,
    "10", x.toFixed(4),
    "20", y.toFixed(4),
    "30", "0.0",
    "40", r.toFixed(4),
  ].join("\n");
}

function dxfPolyline(points, layer, closed = false) {
  const header = [
    "0", "POLYLINE",
    "8", layer,
    "66", "1",
    "70", closed ? "1" : "0",
  ].join("\n");

  const vertices = points.map(([x, y]) => [
    "0", "VERTEX",
    "8", layer,
    "10", x.toFixed(4),
    "20", y.toFixed(4),
    "30", "0.0",
  ].join("\n")).join("\n");

  const footer = ["0", "SEQEND"].join("\n");
  return [header, vertices, footer].join("\n");
}

// ─── MAIN EXPORT FUNCTION ─────────────────────────────────────────────────────

/**
 * @param {Array} rows       — computed leveling rows with _rl, station, chainage
 * @param {string|number} bm — benchmark elevation
 * @param {object} opts      — { surveyName, method, closureError, totalDist }
 */
export function exportDXF(rows, bm, opts = {}) {
  const {
    surveyName = "Survey",
    method = "HI Method",
    closureError = 0,
    totalDist = 0,
  } = opts;

  const fmt3 = v => (v != null && isFinite(v) ? Number(v).toFixed(3) : "?");
  const num  = v => isFinite(parseFloat(v)) ? parseFloat(v) : null;

  // Filter only rows with valid RL
  const validRows = rows.filter(r => r._rl != null && isFinite(r._rl));
  if (validRows.length < 2) {
    alert("Need at least 2 rows with computed RLs to export DXF.");
    return;
  }

  // ── Determine X positions (chainage or index-based) ──────────────────────
  const xPositions = validRows.map((r, i) => {
    const ch = num(r.chainage);
    return ch != null ? ch : i * 20; // fallback: 20m spacing
  });

  const rlValues  = validRows.map(r => r._rl);
  const minX = Math.min(...xPositions);
  const maxX = Math.max(...xPositions);
  const minRL = Math.min(...rlValues, num(bm) ?? 100);
  const maxRL = Math.max(...rlValues, num(bm) ?? 100);

  const xRange = maxX - minX || 100;
  const rlRange = maxRL - minRL || 1;

  // ── Scale: fit profile in ~200 x 100 drawing units ──────────────────────
  const DRAW_W = 200;
  const DRAW_H = 80;
  const MARGIN_X = 20;
  const MARGIN_Y = 30;  // leave room below for labels

  const scaleX = DRAW_W / xRange;
  const scaleY = DRAW_H / rlRange;

  const toDrawX = (x)  => MARGIN_X + (x - minX) * scaleX;
  const toDrawY = (rl) => MARGIN_Y + (rl - minRL) * scaleY;

  const bmElev = num(bm) ?? 100;
  const bmY = toDrawY(bmElev);

  const entities = [];

  // ── GRID LAYER: horizontal RL grid lines ─────────────────────────────────
  const gridStep = rlRange > 5 ? Math.ceil(rlRange / 5) : 0.5;
  const gridStart = Math.floor(minRL / gridStep) * gridStep;
  const gridEnd   = Math.ceil(maxRL  / gridStep) * gridStep;

  for (let g = gridStart; g <= gridEnd + 0.001; g += gridStep) {
    const gy = toDrawY(g);
    entities.push(dxfLine(MARGIN_X - 3, gy, MARGIN_X + DRAW_W + 3, gy, "GRID"));
    entities.push(dxfText(MARGIN_X - 5, gy, 1.5, fmt3(g), "RL_TEXT"));
  }

  // Vertical grid lines at each station
  validRows.forEach((r, i) => {
    const dx = toDrawX(xPositions[i]);
    entities.push(dxfLine(dx, MARGIN_Y - 2, dx, MARGIN_Y + DRAW_H + 2, "GRID"));
  });

  // ── PROFILE LAYER: ground line LWPOLYLINE ────────────────────────────────
  const profilePts = validRows.map((r, i) => [toDrawX(xPositions[i]), toDrawY(r._rl)]);
  entities.push(dxfPolyline(profilePts, "PROFILE"));

  // ── STATIONS LAYER: tick marks + station labels ───────────────────────────
  validRows.forEach((r, i) => {
    const dx = toDrawX(xPositions[i]);
    const dy = toDrawY(r._rl);

    // Station tick (vertical line below profile)
    entities.push(dxfLine(dx, MARGIN_Y - 1, dx, MARGIN_Y - 4, "STATIONS"));

    // Station name label (below x-axis)
    const stationLabel = r.station || `P${i + 1}`;
    entities.push(dxfText(dx, MARGIN_Y - 7, 1.8, stationLabel, "STATIONS", 90));

    // RL text above point
    entities.push(dxfText(dx + 0.5, dy + 1.5, 1.6, fmt3(r._rl), "RL_TEXT", 0));

    // Chainage label below station name
    if (xPositions[i] != null) {
      entities.push(dxfText(dx, MARGIN_Y - 13, 1.5, `CH:${fmt3(xPositions[i])}`, "CHAINAGES", 90));
    }
  });

  // ── BM LAYER: benchmark reference line + marker ───────────────────────────
  entities.push(dxfLine(MARGIN_X - 3, bmY, MARGIN_X + DRAW_W + 3, bmY, "BM"));
  entities.push(dxfCircle(MARGIN_X - 5, bmY, 1.2, "BM"));
  entities.push(dxfText(MARGIN_X - 10, bmY, 2.0, `BM=${fmt3(bmElev)}m`, "BM"));

  // ── TITLE BLOCK ───────────────────────────────────────────────────────────
  const titleY = MARGIN_Y + DRAW_H + 12;
  const now = new Date().toLocaleDateString("en-PK", { year:"numeric", month:"short", day:"2-digit" });

  const titleLines = [
    [`Survey: ${surveyName}`,      3.0, 0],
    [`Method: ${method}`,          2.0, -5],
    [`Stations: ${validRows.length}  BM: ${fmt3(bmElev)}m`, 2.0, -10],
    [`Closure Error: ${(Math.abs(closureError) * 1000).toFixed(1)}mm  Total Dist: ${totalDist.toFixed(3)}km`, 2.0, -15],
    [`Generated: ${now}  — Smart Survey AI Pro X`, 1.8, -20],
  ];

  titleLines.forEach(([text, height, offsetY]) => {
    entities.push(dxfText(MARGIN_X, titleY + offsetY, height, text, "TITLE"));
  });

  // Border box around title
  entities.push(dxfLine(MARGIN_X - 2, titleY + 4,  MARGIN_X + DRAW_W + 2, titleY + 4,  "TITLE"));
  entities.push(dxfLine(MARGIN_X - 2, titleY - 22, MARGIN_X + DRAW_W + 2, titleY - 22, "TITLE"));
  entities.push(dxfLine(MARGIN_X - 2, titleY + 4,  MARGIN_X - 2,          titleY - 22, "TITLE"));
  entities.push(dxfLine(MARGIN_X + DRAW_W + 2, titleY + 4, MARGIN_X + DRAW_W + 2, titleY - 22, "TITLE"));

  // ── Assemble DXF ─────────────────────────────────────────────────────────
  const allMinX = MARGIN_X - 15;
  const allMinY = MARGIN_Y - 15;
  const allMaxX = MARGIN_X + DRAW_W + 10;
  const allMaxY = titleY + 10;

  const dxf = [
    dxfHeader(allMinX, allMinY, allMaxX, allMaxY),
    dxfTables(),
    "0", "SECTION",
    "2", "ENTITIES",
    ...entities,
    "0", "ENDSEC",
    "0", "EOF",
  ].join("\n");

  // ── Trigger download ──────────────────────────────────────────────────────
  const blob = new Blob([dxf], { type: "application/dxf" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${surveyName.replace(/\s+/g, "_")}_profile.dxf`;
  a.click();
  URL.revokeObjectURL(a.href);
}