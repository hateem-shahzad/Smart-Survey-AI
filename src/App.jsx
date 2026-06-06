
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Area, AreaChart
} from "recharts";
import { exportDXF } from "./utils/exportDXF.js";
// ─── TYPES & CONSTANTS ──────────────────────────────────────────────────────
const SURVEY_TYPES = [
  { id: "simple", label: "Simple Leveling", icon: "📏", desc: "Basic HI method for flat terrain" },
  { id: "differential", label: "Differential Leveling", icon: "⛰️", desc: "Multi-TP long distance leveling" },
  { id: "profile", label: "Profile Leveling", icon: "📈", desc: "L-Section for roads & pipelines" },
  { id: "crosssection", label: "Cross Section", icon: "➕", desc: "Width profiles perpendicular to CL" },
  { id: "traverse", label: "Traverse Survey", icon: "🔺", desc: "Polygon traversal & closure" },
  { id: "area", label: "Area Survey", icon: "🗺️", desc: "Area calculation & boundary survey" },
];

const UNIT_FACTORS = {
  m: 1, cm: 0.01, mm: 0.001, km: 1000,
  ft: 0.3048, "in": 0.0254, chain: 20.1168, link: 0.201168
};

const GLOSSARY = {
  BS: "Back Sight — First reading taken after setting up the instrument. Always adds to HI.",
  IS: "Intermediate Sight — Readings between BS and FS. Used for intermediate points.",
  FS: "Fore Sight — Last reading before moving the instrument. Always subtracts from HI.",
  HI: "Height of Instrument — Elevation of the line of sight. HI = Previous RL + BS.",
  RL: "Reduced Level — True elevation of a point above datum (e.g. MSL).",
  BM: "Benchmark — Known elevation point used as reference datum.",
  TP: "Turning Point — Station where both FS and BS are taken (instrument change).",
  CE: "Closure Error — Difference between calculated and known closing elevation.",
};

// ─── DB (SIMULATED WITH localStorage) ────────────────────────────────────────
const DB = {
  save: (key, data) => { try { localStorage.setItem(`ssai_${key}`, JSON.stringify(data)); } catch (e) { } },
  load: (key) => { try { const d = localStorage.getItem(`ssai_${key}`); return d ? JSON.parse(d) : null; } catch (e) { return null; } },
  del: (key) => { try { localStorage.removeItem(`ssai_${key}`); } catch (e) { } },
};

// ─── UTILS ────────────────────────────────────────────────────────────────────
const num = (v) => isFinite(parseFloat(v)) ? parseFloat(v) : null;
const fmt = (v, d = 3) => v != null && isFinite(v) ? v.toFixed(d) : "—";
const uid = () => Math.random().toString(36).slice(2, 9);

function computeLeveling(rows, bmElevation) {
  const result = [];
  let hi = null, lastRL = null;
  let sumBS = 0, sumFS = 0;
  let tpCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = { ...rows[i] };
    const bs = num(r.bs), is = num(r.is), fs = num(r.fs);
    let rl = null, hiVal = hi;

    if (i === 0) {
      rl = num(bmElevation) ?? 100.000;
      if (bs != null) { hiVal = rl + bs; }
    } else {
      // FS closes the previous setup → compute RL from current HI
      if (fs != null && hi != null) rl = hi - fs;
      else if (is != null && hi != null) rl = hi - is;
      else rl = lastRL;

      // BS opens a new setup → new HI based on this RL
      if (bs != null) hiVal = rl + bs;
    }

    if (bs != null) { sumBS += bs; hi = hiVal; }
    if (fs != null) { sumFS += fs; if (bs != null) tpCount++; }

    result.push({ ...r, _hi: hiVal, _rl: rl, _id: r._id || uid() });
    lastRL = rl;
  }

  const firstRL = num(bmElevation) ?? 100;
  const lastRL2 = result.length ? result[result.length - 1]._rl : firstRL;
  const arithmeticCheck = firstRL + sumBS - sumFS;
  const closureError = lastRL2 - firstRL - (sumBS - sumFS);

  return { rows: result, sumBS, sumFS, firstRL, lastRL: lastRL2, arithmeticCheck, closureError, tpCount };
}

function computeRiseFall(rows, bmElevation) {
  const leveled = computeLeveling(rows, bmElevation);
  const res = leveled.rows.map((r, i) => {
    const prev = leveled.rows[i - 1];
    const rise = prev && r._rl != null && prev._rl != null && r._rl > prev._rl ? r._rl - prev._rl : null;
    const fall = prev && r._rl != null && prev._rl != null && r._rl < prev._rl ? prev._rl - r._rl : null;
    return { ...r, rise, fall };
  });
  return { ...leveled, rows: res };
}

function detectAnomalies(rows, bmElevation) {
  const warnings = [];
  const leveled = computeLeveling(rows, bmElevation);

  rows.forEach((r, i) => {
    const bs = num(r.bs), is = num(r.is), fs = num(r.fs);
    if (bs != null && bs < 0) warnings.push({ row: i, msg: `Negative BS at Station "${r.station || i + 1}" — check reading.`, level: "error" });
    if (fs != null && fs < 0) warnings.push({ row: i, msg: `Negative FS at Station "${r.station || i + 1}" — check reading.`, level: "error" });
    if (bs != null && fs != null && is != null) warnings.push({ row: i, msg: `Station "${r.station || i + 1}" has BS, IS, and FS — unusual. Possible TP entry error.`, level: "warn" });
    if (bs != null && fs != null) warnings.push({ row: i, msg: `Possible Turning Point at Station "${r.station || i + 1}".`, level: "info" });
    if (bs != null && bs > 4.0) warnings.push({ row: i, msg: `BS at Station "${r.station || i + 1}" = ${bs}m — exceeds typical staff range.`, level: "warn" });
    if (fs != null && fs > 4.0) warnings.push({ row: i, msg: `FS at Station "${r.station || i + 1}" = ${fs}m — exceeds typical staff range.`, level: "warn" });
  });

  // Check chainage sequence
  const chainages = rows.map(r => num(r.chainage)).filter(c => c != null);
  for (let i = 1; i < chainages.length; i++) {
    if (chainages[i] < chainages[i - 1]) {
      warnings.push({ row: i, msg: `Chainage sequence error at row ${i + 1} — chainage decreased.`, level: "error" });
    }
  }

  const totalDist = chainages.length > 1 ? (chainages[chainages.length - 1] - chainages[0]) / 1000 : 0;
  const allowable = 12 * Math.sqrt(totalDist || 0.001);
  const actual = Math.abs(leveled.closureError * 1000);
  if (actual > allowable && rows.length > 2) {
    warnings.push({ row: -1, msg: `Closure error ${actual.toFixed(1)}mm exceeds allowable ${allowable.toFixed(1)}mm (12√K). Survey FAILS tolerance.`, level: "error" });
  }

  if (rows.length > 1 && rows.every(r => !num(r.bs) && !num(r.fs))) {
    warnings.push({ row: -1, msg: "No BS or FS readings found — level book appears empty.", level: "warn" });
  }

  return warnings;
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

function Tooltip2({ text, children }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-block">
      <span onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)} onTouchStart={() => setShow(s => !s)}>
        {children}
      </span>
      {show && (
        <span className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-1 w-56 bg-slate-800 text-slate-100 text-xs rounded-lg p-2 shadow-xl border border-slate-600 pointer-events-none">
          {text}
        </span>
      )}
    </span>
  );
}

function Badge({ color = "blue", children }) {
  const colors = {
    blue: "bg-blue-900/60 text-blue-300 border-blue-700",
    green: "bg-green-900/60 text-green-300 border-green-700",
    red: "bg-red-900/60 text-red-300 border-red-700",
    yellow: "bg-yellow-900/60 text-yellow-300 border-yellow-700",
    slate: "bg-slate-700 text-slate-300 border-slate-600",
  };
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-mono border ${colors[color]}`}>{children}</span>;
}

function WizardScreen({ onSelect }) {
  return (
    <div className="flex flex-col h-full bg-slate-950 p-4 gap-4">
      <div className="text-center pt-4 pb-2">
        <div className="text-3xl font-black tracking-tight text-white" style={{ fontFamily: "'Orbitron', monospace" }}>
          SURVEY AI <span className="text-blue-400">PRO X</span>
        </div>
        <div className="text-slate-400 text-sm mt-1 font-mono">Smart Survey Leveling Intelligence Engine</div>
      </div>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4">
        <div className="text-slate-300 font-semibold mb-3 text-sm">⚡ What would you like to do today?</div>
        <div className="grid grid-cols-1 gap-2">
          {SURVEY_TYPES.map(t => (
            <button key={t.id} onClick={() => onSelect(t)}
              className="flex items-center gap-3 p-3 rounded-xl bg-slate-800 hover:bg-blue-900/40 border border-slate-700 hover:border-blue-600 transition-all text-left group">
              <span className="text-2xl">{t.icon}</span>
              <div>
                <div className="text-white font-semibold text-sm group-hover:text-blue-300">{t.label}</div>
                <div className="text-slate-500 text-xs">{t.desc}</div>
              </div>
              <span className="ml-auto text-slate-600 group-hover:text-blue-400">→</span>
            </button>
          ))}
        </div>
      </div>
      <div className="text-center text-slate-600 text-xs">v2.0 • Offline Ready • Professional Grade</div>
    </div>
  );
}

const EMPTY_ROW = () => ({ _id: uid(), station: "", bs: "", is: "", fs: "", chainage: "", distance: "", remarks: "" });

function LevelingModule({ surveyType, beginner, project, onProjectChange }) {
  const [rows, setRows] = useState(project?.rows || [EMPTY_ROW()]);
  const [bm, setBm] = useState(project?.bm ?? "100.000");
  const [method, setMethod] = useState("hi");
  const [activeTab, setActiveTab] = useState("input");
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [designMode, setDesignMode] = useState("flat"); // "flat" | "slope"
  const [designRL, setDesignRL] = useState("");          // flat mode
  const [designStart, setDesignStart] = useState("");    // slope mode start RL
  const [designEnd, setDesignEnd] = useState("");        // slope mode end RL

  const pushHistory = useCallback((newRows) => {
    setHistory(h => [...h.slice(0, histIdx + 1), newRows].slice(-30));
    setHistIdx(i => Math.min(i + 1, 29));
  }, [histIdx]);

  const updateRows = (newRows) => { setRows(newRows); pushHistory(newRows); onProjectChange?.({ rows: newRows, bm }); };
  const undo = () => { if (histIdx > 0) { setRows(history[histIdx - 1]); setHistIdx(i => i - 1); } };
  const redo = () => { if (histIdx < history.length - 1) { setRows(history[histIdx + 1]); setHistIdx(i => i + 1); } };

  const computed = useMemo(() => method === "hi" ? computeLeveling(rows, bm) : computeRiseFall(rows, bm), [rows, bm, method]);
  const warnings = useMemo(() => detectAnomalies(rows, bm), [rows, bm]);
  const chartData = useMemo(() => computed.rows.filter(r => r._rl != null).map((r, i) => ({
    name: r.station || `P${i + 1}`, rl: r._rl, ch: num(r.chainage) ?? i
  })), [computed]);

  const chainages = rows.map(r => num(r.chainage)).filter(c => c != null);
  const totalDist = chainages.length > 1 ? (chainages[chainages.length - 1] - chainages[0]) / 1000 : 0.001;
  const allowableErr = 12 * Math.sqrt(totalDist);
  const actualErr = Math.abs(computed.closureError * 1000);
  const closurePASS = actualErr <= allowableErr;

  const updateCell = (idx, key, val) => {
    const nr = rows.map((r, i) => i === idx ? { ...r, [key]: val } : r);
    updateRows(nr);
  };

  const addRow = () => updateRows([...rows, EMPTY_ROW()]);
  const delRow = (idx) => { if (rows.length > 1) updateRows(rows.filter((_, i) => i !== idx)); };
  const dupRow = (idx) => { const nr = [...rows]; nr.splice(idx + 1, 0, { ...rows[idx], _id: uid() }); updateRows(nr); };

  const exportCSV = () => {
    const header = "Station,BS,IS,FS,HI,RL,Chainage,Distance,Remarks\n";
    const body = computed.rows.map(r =>
      `${r.station},${r.bs},${r.is},${r.fs},${fmt(r._hi)},${fmt(r._rl)},${r.chainage},${r.distance},${r.remarks}`
    ).join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "survey_levelbook.csv"; a.click();
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({ bm, rows, computed: computed.rows }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "survey_data.json"; a.click();
  };

  const exportDXFFile = () => {
    exportDXF(computed.rows, bm, {
      surveyName: project?.name || surveyType?.label || "Survey",
      method: method === "hi" ? "Height of Instrument" : "Rise & Fall",
      closureError: computed.closureError,
      totalDist,
    });
  };
  const exportPDF = () => {
    const win = window.open("", "_blank");
    const now = new Date().toLocaleDateString("en-PK", { year: "numeric", month: "long", day: "2-digit" });

    const rowsHTML = computed.rows.map((r, i) => `
    <tr>
      <td>${r.station || `P${i + 1}`}</td>
      <td class="bs">${r.bs || "—"}</td>
      <td class="is">${r.is || "—"}</td>
      <td class="fs">${r.fs || "—"}</td>
      <td>${fmt(r._hi)}</td>
      <td class="rl">${fmt(r._rl)}</td>
      ${method === "rf" ? `<td class="rise">${r.rise ? fmt(r.rise) : "—"}</td><td class="fall">${r.fall ? fmt(r.fall) : "—"}</td>` : ""}
      <td>${r.chainage || "—"}</td>
      <td>${r.distance || "—"}</td>
      <td>${r.remarks || ""}</td>
    </tr>`).join("");

    win.document.write(`<!DOCTYPE html>
<html>
<head>
  <title>Level Book — ${project?.name || "Survey"}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Courier New', monospace; font-size: 11px; color: #000; padding: 20px; }
    h1 { font-size: 16px; text-align: center; margin-bottom: 2px; }
    .subtitle { text-align: center; font-size: 11px; color: #444; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
    th, td { border: 1px solid #333; padding: 4px 6px; text-align: center; }
    th { background: #222; color: #fff; font-weight: bold; }
    tr:nth-child(even) { background: #f5f5f5; }
    .bs   { color: #166534; font-weight: bold; }
    .is   { color: #854d0e; font-weight: bold; }
    .fs   { color: #991b1b; font-weight: bold; }
    .rl   { color: #1e3a5f; font-weight: bold; }
    .rise { color: #14532d; }
    .fall { color: #7f1d1d; }
    .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
    .card { border: 1px solid #333; padding: 8px; border-radius: 4px; }
    .card-label { font-size: 9px; color: #555; text-transform: uppercase; }
    .card-value { font-size: 13px; font-weight: bold; margin-top: 2px; }
    .pass { color: #166534; } .fail { color: #991b1b; }
    .footer { text-align: center; font-size: 9px; color: #777; margin-top: 10px; border-top: 1px solid #ccc; padding-top: 6px; }
    @media print { body { padding: 10px; } }
  </style>
</head>
<body>
  <h1>FIELD LEVEL BOOK</h1>
  <div class="subtitle">${project?.name || surveyType?.label || "Survey"} &nbsp;|&nbsp; ${now} &nbsp;|&nbsp; Method: ${method === "hi" ? "Height of Instrument" : "Rise & Fall"} &nbsp;|&nbsp; BM: ${bm} m</div>

  <table>
    <thead>
      <tr>
        <th>Station</th><th>BS</th><th>IS</th><th>FS</th><th>HI</th><th>RL</th>
        ${method === "rf" ? "<th>Rise</th><th>Fall</th>" : ""}
        <th>Chainage</th><th>Dist</th><th>Remarks</th>
      </tr>
    </thead>
    <tbody>${rowsHTML}</tbody>
  </table>

  <div class="summary">
    <div class="card"><div class="card-label">ΣBS</div><div class="card-value">${fmt(computed.sumBS)}</div></div>
    <div class="card"><div class="card-label">ΣFS</div><div class="card-value">${fmt(computed.sumFS)}</div></div>
    <div class="card"><div class="card-label">ΣBS − ΣFS</div><div class="card-value">${fmt(computed.sumBS - computed.sumFS)}</div></div>
    <div class="card"><div class="card-label">Closure Error</div><div class="card-value ${closurePASS ? "pass" : "fail"}">${actualErr.toFixed(1)} mm</div></div>
    <div class="card"><div class="card-label">Allowable (12√K)</div><div class="card-value">${allowableErr.toFixed(1)} mm</div></div>
    <div class="card"><div class="card-label">Status</div><div class="card-value ${closurePASS ? "pass" : "fail"}">${closurePASS ? "✓ PASS" : "✗ FAIL"}</div></div>
  </div>

  <div class="footer">Smart Survey AI Pro X &nbsp;|&nbsp; Generated: ${now} &nbsp;|&nbsp; Total Stations: ${computed.rows.length} &nbsp;|&nbsp; Turning Points: ${computed.tpCount}</div>

  <script>window.onload = () => { window.print(); }</script>
</body>
</html>`);
    win.document.close();
  };
  const TABS = ["input", "results", "profile", "analysis", "export"];

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-900 border-b border-slate-800">
        <span className="text-blue-400 text-lg">📏</span>
        <div>
          <div className="text-white font-bold text-sm">{surveyType?.label || "Leveling"}</div>
          <div className="flex gap-1">
            <Badge color={method === "hi" ? "blue" : "slate"}>
              <button onClick={() => setMethod("hi")}>HI Method</button>
            </Badge>
            <Badge color={method === "rf" ? "blue" : "slate"}>
              <button onClick={() => setMethod("rf")}>Rise & Fall</button>
            </Badge>
          </div>
        </div>
        <div className="ml-auto flex gap-1">
          <button onClick={undo} className="p-1.5 text-slate-400 hover:text-white text-xs bg-slate-800 rounded-lg">↩</button>
          <button onClick={redo} className="p-1.5 text-slate-400 hover:text-white text-xs bg-slate-800 rounded-lg">↪</button>
        </div>
      </div>

      {/* BM Row */}
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-900/50 border-b border-slate-800">
        <label className="text-slate-400 text-xs font-mono whitespace-nowrap">
          {beginner ? <Tooltip2 text={GLOSSARY.BM}>BM Elev ℹ</Tooltip2> : "BM Elev"}
        </label>
        <input value={bm} onChange={e => { setBm(e.target.value); onProjectChange?.({ rows, bm: e.target.value }); }}
          className="w-28 bg-slate-800 border border-slate-600 rounded-lg px-2 py-1 text-blue-300 font-mono text-sm focus:outline-none focus:border-blue-500" />
        <span className="text-slate-600 text-xs">m (datum)</span>
        {warnings.length > 0 && (
          <button onClick={() => setActiveTab("analysis")} className="ml-auto text-yellow-400 text-xs bg-yellow-900/30 px-2 py-1 rounded-lg border border-yellow-700 animate-pulse">
            ⚠ {warnings.length} alert{warnings.length > 1 ? "s" : ""}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800 bg-slate-900/30 overflow-x-auto">
        {TABS.map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`flex-shrink-0 px-3 py-2 text-xs font-mono capitalize transition-colors ${activeTab === t ? "text-blue-400 border-b-2 border-blue-400" : "text-slate-500 hover:text-slate-300"}`}>
            {t === "input" ? "📋 Input" : t === "results" ? "📊 Results" : t === "profile" ? "📈 Profile" : t === "analysis" ? "🔍 Analysis" : "💾 Export"}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* INPUT TAB */}
        {activeTab === "input" && (
          <div className="p-2">
            {beginner && (
              <div className="mb-2 p-2 bg-blue-900/20 border border-blue-800 rounded-xl text-xs text-blue-300">
                💡 Enter readings row by row. Use <strong>BS</strong> when setting up, <strong>FS</strong> when moving, <strong>IS</strong> for intermediate points.
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse min-w-max">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-800">
                    {["Station", ...(beginner ?
                      ["BS ℹ", "IS ℹ", "FS ℹ"] :
                      ["BS", "IS", "FS"]),
                      "Chainage", "Dist", "Remarks", ""].map((h, i) => (
                        <th key={i} className="px-1.5 py-1.5 text-left font-mono">
                          {beginner && ["BS ℹ", "IS ℹ", "FS ℹ"].includes(h) ? (
                            <Tooltip2 text={GLOSSARY[h.replace(" ℹ", "")]}>{h}</Tooltip2>
                          ) : h}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => (
                    <tr key={r._id} className={`border-b border-slate-800/50 ${idx % 2 === 0 ? "bg-slate-900/20" : ""}`}>
                      {["station", "bs", "is", "fs", "chainage", "distance", "remarks"].map(k => (
                        <td key={k} className="px-1">
                          <input value={r[k]} onChange={e => updateCell(idx, k, e.target.value)}
                            placeholder={k === "station" ? `P${idx + 1}` : k === "remarks" ? "note" : ""}
                            className={`w-full bg-transparent border-b border-slate-700 focus:border-blue-500 outline-none py-1.5 px-0.5 font-mono text-xs
                              ${k === "bs" ? "text-green-400" : k === "fs" ? "text-red-400" : k === "is" ? "text-yellow-400" : "text-slate-300"}`}
                          />
                        </td>
                      ))}
                      <td className="px-1">
                        <div className="flex gap-0.5">
                          <button onClick={() => dupRow(idx)} className="p-1 text-slate-600 hover:text-blue-400">⊕</button>
                          <button onClick={() => delRow(idx)} className="p-1 text-slate-600 hover:text-red-400">✕</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button onClick={addRow}
              className="mt-3 w-full py-2.5 bg-blue-900/30 hover:bg-blue-800/50 border border-blue-700 rounded-xl text-blue-300 text-sm font-semibold transition-colors">
              + Add Row
            </button>
          </div>
        )}

        {/* RESULTS TAB */}
        {activeTab === "results" && (
          <div className="p-3 space-y-3">
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-xs min-w-max">
                <thead className="bg-slate-800/80">
                  <tr>
                    {["Station", "BS", "IS", "FS", "HI", "RL",
                      ...(method === "rf" ? ["Rise", "Fall"] : []),
                      "Chainage", "Remarks"].map(h => (
                        <th key={h} className={`px-2 py-2 text-left font-mono font-bold
                        ${h === "BS" ? "text-green-400" : h === "FS" ? "text-red-400" : h === "IS" ? "text-yellow-400" :
                            h === "HI" ? "text-purple-400" : h === "RL" ? "text-blue-400" :
                              h === "Rise" ? "text-emerald-400" : h === "Fall" ? "text-orange-400" : "text-slate-400"}`}>
                          {h}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {computed.rows.map((r, i) => (
                    <tr key={r._id} className={`border-t border-slate-800 ${i % 2 === 0 ? "bg-slate-900/30" : ""}`}>
                      <td className="px-2 py-1.5 text-white font-mono">{r.station || `P${i + 1}`}</td>
                      <td className="px-2 py-1.5 text-green-400 font-mono">{r.bs || "—"}</td>
                      <td className="px-2 py-1.5 text-yellow-400 font-mono">{r.is || "—"}</td>
                      <td className="px-2 py-1.5 text-red-400 font-mono">{r.fs || "—"}</td>
                      <td className="px-2 py-1.5 text-purple-300 font-mono">{fmt(r._hi)}</td>
                      <td className="px-2 py-1.5 text-blue-300 font-mono font-bold">{fmt(r._rl)}</td>
                      {method === "rf" && <>
                        <td className="px-2 py-1.5 text-emerald-400 font-mono">{r.rise ? fmt(r.rise) : "—"}</td>
                        <td className="px-2 py-1.5 text-orange-400 font-mono">{r.fall ? fmt(r.fall) : "—"}</td>
                      </>}
                      <td className="px-2 py-1.5 text-slate-500 font-mono">{r.chainage || "—"}</td>
                      <td className="px-2 py-1.5 text-slate-500">{r.remarks || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Arithmetic check */}
            <div className="grid grid-cols-2 gap-2">
              {[
                ["ΣBS", fmt(computed.sumBS), "green"],
                ["ΣFS", fmt(computed.sumFS), "red"],
                ["ΣBS−ΣFS", fmt(computed.sumBS - computed.sumFS), "blue"],
                ["Last RL", fmt(computed.lastRL), "blue"],
              ].map(([label, val, c]) => (
                <div key={label} className="bg-slate-900 border border-slate-700 rounded-xl p-2.5">
                  <div className="text-slate-500 text-xs">{label}</div>
                  <div className={`font-mono font-bold text-${c}-400`}>{val}</div>
                </div>
              ))}
            </div>

            {/* Closure */}
            <div className={`rounded-xl border p-3 ${closurePASS ? "border-green-700 bg-green-900/20" : "border-red-700 bg-red-900/20"}`}>
              <div className="flex justify-between items-center mb-2">
                <span className="text-white font-bold text-sm">Closure Analysis</span>
                <Badge color={closurePASS ? "green" : "red"}>{closurePASS ? "✓ PASS" : "✗ FAIL"}</Badge>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs font-mono">
                <div><div className="text-slate-500">Allowable (12√K)</div><div className="text-yellow-300">{allowableErr.toFixed(1)} mm</div></div>
                <div><div className="text-slate-500">Actual Error</div><div className={closurePASS ? "text-green-400" : "text-red-400"}>{actualErr.toFixed(1)} mm</div></div>
                <div><div className="text-slate-500">Difference</div><div className="text-white">{(allowableErr - actualErr).toFixed(1)} mm</div></div>
              </div>
            </div>
          </div>
        )}

        {/* PROFILE TAB */}
        {/* PROFILE TAB */}
        {activeTab === "profile" && (
          <div className="p-3 space-y-3">
            <div className="text-slate-300 text-sm font-semibold">Longitudinal Profile (L-Section)</div>

            {/* Design RL controls */}
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 space-y-2">
              <div className="text-slate-400 text-xs font-semibold">📐 Design RL</div>
              <div className="flex gap-2">
                <button onClick={() => setDesignMode("flat")}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-mono border transition-colors ${designMode === "flat" ? "bg-blue-900/40 border-blue-600 text-blue-300" : "bg-slate-800 border-slate-600 text-slate-400"}`}>
                  Flat / Horizontal
                </button>
                <button onClick={() => setDesignMode("slope")}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-mono border transition-colors ${designMode === "slope" ? "bg-blue-900/40 border-blue-600 text-blue-300" : "bg-slate-800 border-slate-600 text-slate-400"}`}>
                  Sloped (2 points)
                </button>
              </div>

              {designMode === "flat" && (
                <div className="flex items-center gap-2">
                  <label className="text-slate-500 text-xs whitespace-nowrap">Design RL (m)</label>
                  <input value={designRL} onChange={e => setDesignRL(e.target.value)}
                    placeholder="e.g. 100.500"
                    className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-2 py-1.5 text-orange-300 font-mono text-xs focus:outline-none focus:border-orange-500" />
                  {designRL && <button onClick={() => setDesignRL("")} className="text-slate-500 hover:text-red-400 text-xs">✕</button>}
                </div>
              )}

              {designMode === "slope" && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-slate-500 text-xs block mb-1">Start RL (m)</label>
                    <input value={designStart} onChange={e => setDesignStart(e.target.value)}
                      placeholder="e.g. 100.200"
                      className="w-full bg-slate-800 border border-slate-600 rounded-lg px-2 py-1.5 text-orange-300 font-mono text-xs focus:outline-none focus:border-orange-500" />
                  </div>
                  <div>
                    <label className="text-slate-500 text-xs block mb-1">End RL (m)</label>
                    <input value={designEnd} onChange={e => setDesignEnd(e.target.value)}
                      placeholder="e.g. 101.000"
                      className="w-full bg-slate-800 border border-slate-600 rounded-lg px-2 py-1.5 text-orange-300 font-mono text-xs focus:outline-none focus:border-orange-500" />
                  </div>
                </div>
              )}
            </div>

            {chartData.length < 2 ? (
              <div className="text-slate-500 text-center py-8 text-sm">Add at least 2 rows with RL values to see profile.</div>
            ) : (() => {
              // Build design line data
              const dStart = num(designStart), dEnd = num(designEnd), dFlat = num(designRL);
              const hasDesign = designMode === "flat" ? dFlat != null : (dStart != null && dEnd != null);

              const chartWithDesign = chartData.map((d, i) => {
                let design = null;
                if (hasDesign) {
                  if (designMode === "flat") {
                    design = dFlat;
                  } else {
                    design = dStart + (dEnd - dStart) * (i / Math.max(chartData.length - 1, 1));
                  }
                }
                return { ...d, design };
              });

              // Cut/fill summary
              const cutFill = hasDesign ? chartWithDesign.map(d => ({
                name: d.name,
                cutFill: d.rl != null && d.design != null ? d.rl - d.design : null,
              })) : [];

              return (
                <div className="space-y-3">
                  <div className="bg-slate-900 border border-slate-700 rounded-xl p-2">
                    <ResponsiveContainer width="100%" height={240}>
                      <AreaChart data={chartWithDesign} margin={{ top: 10, right: 10, bottom: 20, left: 0 }}>
                        <defs>
                          <linearGradient id="rlGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 10 }}
                          label={{ value: "Station", position: "insideBottom", offset: -10, fill: "#64748b", fontSize: 10 }} />
                        <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }}
                          label={{ value: "RL (m)", angle: -90, position: "insideLeft", fill: "#64748b", fontSize: 10 }} />
                        <Tooltip
                          contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8 }}
                          labelStyle={{ color: "#94a3b8" }}
                          formatter={(v, name) => [
                            v != null ? Number(v).toFixed(3) + " m" : "—",
                            name === "rl" ? "Ground RL" : name === "design" ? "Design RL" : name
                          ]} />
                        <ReferenceLine y={num(bm) ?? 100} stroke="#f59e0b" strokeDasharray="4 4"
                          label={{ value: "BM", fill: "#f59e0b", fontSize: 10 }} />
                        <Area type="monotone" dataKey="rl" stroke="#3b82f6" strokeWidth={2}
                          fill="url(#rlGrad)" dot={{ fill: "#3b82f6", r: 4 }} activeDot={{ r: 6, fill: "#60a5fa" }}
                          name="rl" />
                        {hasDesign && (
                          <Line type="monotone" dataKey="design" stroke="#f97316" strokeWidth={2}
                            strokeDasharray="6 3" dot={false} name="design" />
                        )}
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Legend */}
                  {hasDesign && (
                    <div className="flex gap-4 text-xs font-mono px-1">
                      <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-blue-500 inline-block"></span> Ground RL</span>
                      <span className="flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-orange-400 inline-block"></span> Design RL</span>
                    </div>
                  )}

                  {/* Stats */}
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    {[
                      ["Max RL", Math.max(...chartData.map(d => d.rl ?? -Infinity)).toFixed(3) + " m", "blue"],
                      ["Min RL", Math.min(...chartData.map(d => d.rl ?? Infinity)).toFixed(3) + " m", "blue"],
                      ["Gradient", chartData.length > 1 ? (((chartData[chartData.length - 1].rl - chartData[0].rl) / Math.max(1, chartData.length - 1)) * 100).toFixed(2) + "%" : "—", "yellow"],
                    ].map(([l, v, c]) => (
                      <div key={l} className={`bg-slate-900 border border-slate-800 rounded-xl p-2`}>
                        <div className="text-slate-500">{l}</div>
                        <div className={`font-mono font-bold text-${c}-400 text-sm`}>{v}</div>
                      </div>
                    ))}
                  </div>

                  {/* Cut / Fill table */}
                  {hasDesign && cutFill.length > 0 && (
                    <div className="bg-slate-900 border border-slate-700 rounded-xl p-3">
                      <div className="text-slate-400 text-xs font-semibold mb-2">⛏️ Cut / Fill Analysis</div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs min-w-max">
                          <thead><tr className="text-slate-500 border-b border-slate-700">
                            <th className="text-left px-2 py-1 font-mono">Station</th>
                            <th className="text-left px-2 py-1 font-mono">Ground RL</th>
                            <th className="text-left px-2 py-1 font-mono">Design RL</th>
                            <th className="text-left px-2 py-1 font-mono">Cut (+)</th>
                            <th className="text-left px-2 py-1 font-mono">Fill (−)</th>
                          </tr></thead>
                          <tbody>
                            {chartWithDesign.map((d, i) => {
                              const diff = d.rl != null && d.design != null ? d.rl - d.design : null;
                              return (
                                <tr key={i} className="border-t border-slate-800">
                                  <td className="px-2 py-1 text-white font-mono">{d.name}</td>
                                  <td className="px-2 py-1 text-blue-400 font-mono">{d.rl?.toFixed(3) ?? "—"}</td>
                                  <td className="px-2 py-1 text-orange-400 font-mono">{d.design?.toFixed(3) ?? "—"}</td>
                                  <td className="px-2 py-1 text-red-400 font-mono">{diff != null && diff > 0 ? diff.toFixed(3) : "—"}</td>
                                  <td className="px-2 py-1 text-green-400 font-mono">{diff != null && diff < 0 ? Math.abs(diff).toFixed(3) : "—"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* ANALYSIS TAB */}
        {activeTab === "analysis" && (
          <div className="p-3 space-y-3">
            <div className="text-slate-300 text-sm font-semibold">🤖 AI Survey Intelligence Report</div>
            {warnings.length === 0 ? (
              <div className="bg-green-900/20 border border-green-700 rounded-xl p-4 text-center">
                <div className="text-green-400 text-lg mb-1">✓</div>
                <div className="text-green-300 font-semibold">No issues detected</div>
                <div className="text-green-600 text-xs mt-1">Survey data looks clean and valid.</div>
              </div>
            ) : (
              <div className="space-y-2">
                {warnings.map((w, i) => (
                  <div key={i} className={`rounded-xl border p-3 text-sm flex gap-2 items-start
                    ${w.level === "error" ? "border-red-700 bg-red-900/20 text-red-300" :
                      w.level === "warn" ? "border-yellow-700 bg-yellow-900/20 text-yellow-300" :
                        "border-blue-700 bg-blue-900/20 text-blue-300"}`}>
                    <span>{w.level === "error" ? "🔴" : w.level === "warn" ? "🟡" : "🔵"}</span>
                    <span>{w.msg}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="bg-slate-900 border border-slate-700 rounded-xl p-3">
              <div className="text-slate-400 text-xs font-semibold mb-2">📐 ADJUSTMENT — Equal Distribution</div>
              {computed.rows.length > 0 && (() => {
                const adj = computed.closureError / computed.rows.length;
                return (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs min-w-max">
                      <thead><tr className="text-slate-500 border-b border-slate-700">
                        <th className="text-left px-2 py-1">Station</th>
                        <th className="text-left px-2 py-1">RL</th>
                        <th className="text-left px-2 py-1">Correction</th>
                        <th className="text-left px-2 py-1">Adj. RL</th>
                      </tr></thead>
                      <tbody>
                        {computed.rows.map((r, i) => (
                          <tr key={r._id} className="border-t border-slate-800">
                            <td className="px-2 py-1 text-white font-mono">{r.station || `P${i + 1}`}</td>
                            <td className="px-2 py-1 text-blue-400 font-mono">{fmt(r._rl)}</td>
                            <td className="px-2 py-1 text-yellow-400 font-mono">{adj ? fmt(-adj * (i + 1), 4) : "—"}</td>
                            <td className="px-2 py-1 text-green-400 font-mono font-bold">
                              {r._rl != null ? fmt(r._rl - adj * (i + 1)) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>

            {/* Glossary for beginners */}
            {beginner && (
              <div className="bg-slate-900 border border-slate-700 rounded-xl p-3">
                <div className="text-slate-400 text-xs font-semibold mb-2">📚 Surveying Glossary</div>
                <div className="space-y-1.5">
                  {Object.entries(GLOSSARY).map(([k, v]) => (
                    <div key={k} className="text-xs">
                      <span className="text-blue-400 font-mono font-bold">{k}</span>
                      <span className="text-slate-400"> — {v}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* EXPORT TAB */}
        {activeTab === "export" && (
          <div className="p-3 space-y-2">
            <div className="text-slate-300 text-sm font-semibold mb-3">💾 Export Survey Data</div>
            {[
              { label: "Export CSV", icon: "📊", desc: "Spreadsheet-ready level book", fn: exportCSV, color: "green" },
              { label: "Export JSON", icon: "🗂️", desc: "Full data for re-import", fn: exportJSON, color: "blue" },
              { label: "Export AutoCAD DXF", icon: "📐", desc: "Profile drawing — AutoCAD/Civil 3D", fn: exportDXFFile, color: "yellow" },
              { label: "Export PDF", icon: "📄", desc: "Printable field level book", fn: exportPDF, color: "purple" },
            ].map(e => (
              <button key={e.label} onClick={e.fn}
                className={`w-full flex items-center gap-3 p-3 bg-slate-900 hover:bg-${e.color}-900/30 border border-slate-700 hover:border-${e.color}-600 rounded-xl transition-all text-left`}>
                <span className="text-2xl">{e.icon}</span>
                <div>
                  <div className="text-white font-semibold text-sm">{e.label}</div>
                  <div className="text-slate-500 text-xs">{e.desc}</div>
                </div>
              </button>
            ))}
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 mt-4">
              <div className="text-slate-400 text-xs font-semibold mb-2">📋 Survey Summary</div>
              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <div className="text-slate-500">Total Stations</div><div className="text-white">{computed.rows.length}</div>
                <div className="text-slate-500">Turning Points</div><div className="text-white">{computed.tpCount}</div>
                <div className="text-slate-500">BM Elevation</div><div className="text-blue-400">{bm} m</div>
                <div className="text-slate-500">Closure Error</div><div className={closurePASS ? "text-green-400" : "text-red-400"}>{actualErr.toFixed(1)} mm</div>
                <div className="text-slate-500">Method</div><div className="text-white">{method === "hi" ? "Height of Instrument" : "Rise & Fall"}</div>
                <div className="text-slate-500">Status</div><Badge color={closurePASS ? "green" : "red"}>{closurePASS ? "PASS" : "FAIL"}</Badge>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolkitModule() {
  const [tool, setTool] = useState("unit");
  const [unitVal, setUnitVal] = useState(""); const [fromUnit, setFromUnit] = useState("m"); const [toUnit, setToUnit] = useState("ft");
  const [slopeH, setSlopeH] = useState(""); const [slopeV, setSlopeV] = useState("");
  const [areaW, setAreaW] = useState(""); const [areaL, setAreaL] = useState("");
  const [bearingDeg, setBearingDeg] = useState(""); const [bearingMin, setBearingMin] = useState(""); const [bearingSec, setBearingSec] = useState("");

  const unitResult = useMemo(() => {
    if (!unitVal || !UNIT_FACTORS[fromUnit] || !UNIT_FACTORS[toUnit]) return null;
    return (parseFloat(unitVal) * UNIT_FACTORS[fromUnit] / UNIT_FACTORS[toUnit]).toFixed(6);
  }, [unitVal, fromUnit, toUnit]);

  const slopeGrade = useMemo(() => {
    const h = parseFloat(slopeH), v = parseFloat(slopeV);
    if (!h || !v) return null;
    const grade = (v / h) * 100;
    const angle = Math.atan(v / h) * 180 / Math.PI;
    const ratio = `1:${(h / v).toFixed(1)}`;
    return { grade: grade.toFixed(3), angle: angle.toFixed(4), ratio };
  }, [slopeH, slopeV]);

  const areaResult = useMemo(() => {
    const w = parseFloat(areaW), l = parseFloat(areaL);
    if (!w || !l) return null;
    return { m2: (w * l).toFixed(3), ha: (w * l / 10000).toFixed(6), ac: (w * l / 4046.86).toFixed(6) };
  }, [areaW, areaL]);

  const bearingResult = useMemo(() => {
    const d = parseFloat(bearingDeg) || 0, m = parseFloat(bearingMin) || 0, s = parseFloat(bearingSec) || 0;
    const dd = d + m / 60 + s / 3600;
    const rad = (dd * Math.PI) / 180;
    return { dd: dd.toFixed(6), rad: rad.toFixed(6), dms: `${d}° ${m}' ${s}"` };
  }, [bearingDeg, bearingMin, bearingSec]);

  const TOOLS = [
    { id: "unit", label: "Unit Conv.", icon: "⇄" },
    { id: "slope", label: "Slope", icon: "⛰" },
    { id: "area", label: "Area", icon: "⬛" },
    { id: "bearing", label: "Bearing", icon: "🧭" },
  ];

  return (
    <div className="flex flex-col h-full bg-slate-950">
      <div className="px-3 py-2 bg-slate-900 border-b border-slate-800">
        <div className="text-white font-bold text-sm">🔧 Survey Toolkit</div>
        <div className="text-slate-500 text-xs">Field calculation tools</div>
      </div>
      <div className="flex border-b border-slate-800">
        {TOOLS.map(t => (
          <button key={t.id} onClick={() => setTool(t.id)}
            className={`flex-1 py-2 text-xs font-mono transition-colors ${tool === t.id ? "text-blue-400 border-b-2 border-blue-400 bg-blue-900/10" : "text-slate-500"}`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {tool === "unit" && (
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 space-y-3">
            <div className="text-white font-semibold text-sm">Unit Converter</div>
            <input value={unitVal} onChange={e => setUnitVal(e.target.value)} placeholder="Enter value"
              className="w-full bg-slate-800 border border-slate-600 rounded-xl px-3 py-2.5 text-white font-mono focus:outline-none focus:border-blue-500" />
            <div className="flex gap-2">
              {["from", "to"].map((dir, i) => (
                <select key={dir} value={i === 0 ? fromUnit : toUnit} onChange={e => i === 0 ? setFromUnit(e.target.value) : setToUnit(e.target.value)}
                  className="flex-1 bg-slate-800 border border-slate-600 rounded-xl px-2 py-2.5 text-white focus:outline-none">
                  {Object.keys(UNIT_FACTORS).map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              ))}
            </div>
            {unitResult != null && (
              <div className="bg-blue-900/30 border border-blue-700 rounded-xl p-3">
                <div className="text-slate-400 text-xs">Result</div>
                <div className="text-blue-300 font-mono font-bold text-xl">{unitResult} <span className="text-blue-500">{toUnit}</span></div>
                <div className="text-slate-500 text-xs mt-1">{unitVal} {fromUnit} = {unitResult} {toUnit}</div>
              </div>
            )}
          </div>
        )}
        {tool === "slope" && (
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 space-y-3">
            <div className="text-white font-semibold text-sm">Slope / Grade Calculator</div>
            {[["Horizontal Distance (m)", slopeH, setSlopeH], ["Vertical Difference (m)", slopeV, setSlopeV]].map(([label, val, set]) => (
              <div key={label}>
                <label className="text-slate-400 text-xs mb-1 block">{label}</label>
                <input value={val} onChange={e => set(e.target.value)} placeholder="0.000"
                  className="w-full bg-slate-800 border border-slate-600 rounded-xl px-3 py-2.5 text-white font-mono focus:outline-none focus:border-blue-500" />
              </div>
            ))}
            {slopeGrade && (
              <div className="grid grid-cols-3 gap-2 mt-2">
                {[["Grade %", slopeGrade.grade + "%", "yellow"], ["Angle", slopeGrade.angle + "°", "blue"], ["Ratio", slopeGrade.ratio, "green"]].map(([l, v, c]) => (
                  <div key={l} className={`bg-${c}-900/30 border border-${c}-800 rounded-xl p-2 text-center`}>
                    <div className="text-slate-500 text-xs">{l}</div>
                    <div className={`text-${c}-300 font-mono font-bold`}>{v}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {tool === "area" && (
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 space-y-3">
            <div className="text-white font-semibold text-sm">Area Calculator (Rectangle)</div>
            {[["Width (m)", areaW, setAreaW], ["Length (m)", areaL, setAreaL]].map(([label, val, set]) => (
              <div key={label}>
                <label className="text-slate-400 text-xs mb-1 block">{label}</label>
                <input value={val} onChange={e => set(e.target.value)} placeholder="0.000"
                  className="w-full bg-slate-800 border border-slate-600 rounded-xl px-3 py-2.5 text-white font-mono focus:outline-none focus:border-blue-500" />
              </div>
            ))}
            {areaResult && (
              <div className="space-y-2">
                {[["Square Metres", areaResult.m2 + " m²", "blue"], ["Hectares", areaResult.ha + " ha", "green"], ["Acres", areaResult.ac + " ac", "yellow"]].map(([l, v, c]) => (
                  <div key={l} className={`bg-${c}-900/30 border border-${c}-800 rounded-xl p-2.5 flex justify-between`}>
                    <span className="text-slate-400 text-xs">{l}</span>
                    <span className={`text-${c}-300 font-mono font-bold`}>{v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {tool === "bearing" && (
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 space-y-3">
            <div className="text-white font-semibold text-sm">Bearing / Azimuth Converter</div>
            <div className="text-slate-400 text-xs">Enter DMS (Degrees-Minutes-Seconds)</div>
            <div className="grid grid-cols-3 gap-2">
              {[["°", bearingDeg, setBearingDeg, "Degrees"], ["'", bearingMin, setBearingMin, "Minutes"], ['"', bearingSec, setBearingSec, "Seconds"]].map(([sym, val, set, ph]) => (
                <div key={sym}>
                  <label className="text-slate-500 text-xs block mb-1">{ph}</label>
                  <div className="flex items-center gap-1">
                    <input value={val} onChange={e => set(e.target.value)} placeholder="0"
                      className="w-full bg-slate-800 border border-slate-600 rounded-xl px-2 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-blue-500" />
                    <span className="text-slate-400 text-sm">{sym}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              {[["Decimal Degrees", bearingResult.dd + "°", "blue"], ["Radians", bearingResult.rad + " rad", "purple"]].map(([l, v, c]) => (
                <div key={l} className={`bg-${c}-900/30 border border-${c}-800 rounded-xl p-2.5 flex justify-between`}>
                  <span className="text-slate-400 text-xs">{l}</span>
                  <span className={`text-${c}-300 font-mono`}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectsModule({ projects, onNew, onLoad, onDelete, onExportAll, onImport, onExportCurrent, currentProject }) {
  return (
    <div className="flex flex-col h-full bg-slate-950">
      <div className="px-3 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-white font-bold text-sm">📁 Projects</div>
          <div className="text-slate-500 text-xs">{projects.length} saved project{projects.length !== 1 ? "s" : ""}</div>
        </div>
        <button onClick={onNew} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-white text-xs font-semibold">+ New</button>
      </div>

      {/* Backup / Restore bar */}
      <div className="flex gap-2 px-3 py-2 bg-slate-900/50 border-b border-slate-800">
        <button onClick={onExportAll}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-slate-800 hover:bg-blue-900/40 border border-slate-700 hover:border-blue-600 rounded-xl text-xs text-slate-300 hover:text-blue-300 transition-all">
          ⬇ Backup All
        </button>
        <label className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-slate-800 hover:bg-green-900/40 border border-slate-700 hover:border-green-600 rounded-xl text-xs text-slate-300 hover:text-green-300 transition-all cursor-pointer">
          ⬆ Restore
          <input type="file" accept=".json" onChange={onImport} className="hidden" />
        </label>
        {currentProject && (
          <button onClick={onExportCurrent}
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-slate-800 hover:bg-yellow-900/40 border border-slate-700 hover:border-yellow-600 rounded-xl text-xs text-slate-300 hover:text-yellow-300 transition-all">
            📤 Export Current
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {projects.length === 0 ? (
          <div className="text-center py-12 text-slate-600">
            <div className="text-4xl mb-3">📋</div>
            <div className="text-sm">No projects yet</div>
            <div className="text-xs mt-1">Start a new survey to create one</div>
          </div>
        ) : projects.map(p => (
          <div key={p.id} className="bg-slate-900 border border-slate-700 rounded-xl p-3 flex items-center gap-3">
            <div className="flex-1">
              <div className="text-white font-semibold text-sm">{p.name}</div>
              <div className="text-slate-500 text-xs">{p.type} • {p.rows?.length || p.legs?.length || 0} stations • {new Date(p.updated).toLocaleDateString()}</div>
            </div>
            <button onClick={() => onLoad(p)} className="px-2 py-1 text-blue-400 bg-blue-900/30 border border-blue-700 rounded-lg text-xs">Open</button>
            <button onClick={() => onDelete(p.id)} className="px-2 py-1 text-red-400 bg-red-900/30 border border-red-700 rounded-lg text-xs">Del</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsModule({ beginner, setBeginner, darkMode, setDarkMode, autoSave, setAutoSave }) {
  return (
    <div className="flex flex-col h-full bg-slate-950">
      <div className="px-3 py-2 bg-slate-900 border-b border-slate-800">
        <div className="text-white font-bold text-sm">⚙️ Settings</div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {[
          { label: "Beginner Mode", desc: "Show tooltips, explanations and guides", val: beginner, set: setBeginner },
          { label: "Auto Save", desc: "Save survey data automatically", val: autoSave, set: setAutoSave },
          { label: "Dark Mode", desc: "Dark interface (recommended for field use)", val: darkMode, set: setDarkMode },
        ].map(s => (
          <div key={s.label} className="bg-slate-900 border border-slate-700 rounded-xl p-3 flex items-center justify-between">
            <div>
              <div className="text-white text-sm font-semibold">{s.label}</div>
              <div className="text-slate-500 text-xs">{s.desc}</div>
            </div>
            <button onClick={() => s.set(v => !v)}
              className={`w-12 h-6 rounded-full transition-all relative ${s.val ? "bg-blue-600" : "bg-slate-700"}`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${s.val ? "left-6" : "left-0.5"}`} />
            </button>
          </div>
        ))}

        <div className="bg-slate-900 border border-slate-700 rounded-xl p-3">
          <div className="text-white text-sm font-semibold mb-2">About</div>
          <div className="space-y-1 text-xs font-mono">
            <div className="flex justify-between"><span className="text-slate-500">App</span><span className="text-white">Smart Survey AI Pro X</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Version</span><span className="text-blue-400">2.0.0</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Engine</span><span className="text-white">Survey Intelligence v2</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Standard</span><span className="text-white">12√K mm closure</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Storage</span><span className="text-green-400">Offline (localStorage)</span></div>
          </div>
        </div>

        <div className="bg-blue-900/20 border border-blue-800 rounded-xl p-3 text-xs text-blue-300">
          <strong>Deploy as PWA:</strong> For full offline support and installability, deploy this app using Vite + vite-plugin-pwa to Vercel or Netlify.
        </div>
      </div>
    </div>
  );
}
function ComingSoonModule({ type }) {
  return (
    <div className="flex flex-col h-full bg-slate-950 items-center justify-center p-6 gap-4">
      <div className="text-5xl">{type?.icon}</div>
      <div className="text-white font-bold text-xl text-center">{type?.label}</div>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5 text-center max-w-xs">
        <div className="text-yellow-400 text-sm font-semibold mb-2">🚧 Coming Soon</div>
        <div className="text-slate-400 text-xs leading-relaxed">
          This module is under development. Currently supported survey types are{" "}
          <span className="text-blue-400">Simple</span>,{" "}
          <span className="text-blue-400">Differential</span>,
          <span className="text-blue-400">Traverse Survey</span>,
          and {" "}
          <span className="text-blue-400">Profile Leveling</span>.
        </div>
      </div>
      <div className="text-slate-600 text-xs">v2.0 — Smart Survey AI Pro X</div>
    </div>
  );
}
// ─── TRAVERSE SURVEY MODULE ───────────────────────────────────────────────────
// Bowditch (Compass Rule) adjustment
// Add this entire block to App.jsx before the App() function

const uid2 = () => Math.random().toString(36).slice(2, 9);
const num2 = (v) => isFinite(parseFloat(v)) ? parseFloat(v) : null;
const fmt2 = (v, d = 3) => v != null && isFinite(v) ? Number(v).toFixed(d) : "—";

const EMPTY_LEG = () => ({
  _id: uid2(),
  station: "",
  bearing: "",   // DD.MMSS format e.g. 45.3020 = 45°30'20"
  distance: "",
  remarks: "",
});

// Convert DD.MMSS → decimal degrees
function dmsToDecimal(dms) {
  const d = num2(dms);
  if (d == null) return null;
  const deg = Math.floor(Math.abs(d));
  const min = Math.floor((Math.abs(d) - deg) * 100);
  const sec = Math.round((((Math.abs(d) - deg) * 100) - min) * 100);
  return (deg + min / 60 + sec / 3600) * (d < 0 ? -1 : 1);
}

// Decimal degrees → DMS string
function decimalToDMS(dd) {
  if (dd == null || !isFinite(dd)) return "—";
  const d = Math.floor(Math.abs(dd));
  const mFull = (Math.abs(dd) - d) * 60;
  const m = Math.floor(mFull);
  const s = Math.round((mFull - m) * 60);
  return `${d}° ${String(m).padStart(2, "0")}' ${String(s).padStart(2, "0")}"`;
}

function computeTraverse(legs) {
  const results = [];
  let sumLat = 0, sumDep = 0, sumDist = 0;
  let x = 0, y = 0;
  const coords = [{ x: 0, y: 0, station: legs[0]?.station || "P1" }];

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const bearingDD = dmsToDecimal(leg.bearing);
    const dist = num2(leg.distance);

    if (bearingDD == null || dist == null) {
      results.push({ ...leg, lat: null, dep: null, adjLat: null, adjDep: null, x: null, y: null });
      continue;
    }

    const bearingRad = (bearingDD * Math.PI) / 180;
    const lat = dist * Math.cos(bearingRad);
    const dep = dist * Math.sin(bearingRad);

    sumLat += lat;
    sumDep += dep;
    sumDist += dist;

    x += dep;
    y += lat;

    const nextStation = legs[i + 1]?.station || `P${i + 2}`;
    coords.push({ x, y, station: nextStation });
    results.push({ ...leg, bearingDD, dist, lat, dep, x, y });
  }

  // Closure error
  const closureError = Math.sqrt(sumLat ** 2 + sumDep ** 2);
  const precision = sumDist > 0 ? sumDist / (closureError || 0.0001) : 0;

  // Bowditch correction
  const corrected = results.map(r => {
    if (r.lat == null) return r;
    const adjLat = r.lat - (r.dist / sumDist) * sumLat;
    const adjDep = r.dep - (r.dist / sumDist) * sumDep;
    return { ...r, adjLat, adjDep, corrLat: -(r.dist / sumDist) * sumLat, corrDep: -(r.dist / sumDist) * sumDep };
  });

  // Adjusted coordinates
  let ax = 0, ay = 0;
  const adjCoords = [{ x: 0, y: 0, station: legs[0]?.station || "P1" }];
  corrected.forEach((r, i) => {
    if (r.adjLat != null) {
      ay += r.adjLat;
      ax += r.adjDep;
    }
    adjCoords.push({ x: ax, y: ay, station: legs[i + 1]?.station || `P${i + 2}` });
  });

  return {
    rows: corrected,
    sumLat, sumDep, sumDist,
    closureError, precision,
    coords, adjCoords,
  };
}

function TraverseMap({ coords, adjCoords, width = 280, height = 220 }) {
  const allX = adjCoords.map(c => c.x);
  const allY = adjCoords.map(c => c.y);
  const minX = Math.min(...allX), maxX = Math.max(...allX);
  const minY = Math.min(...allY), maxY = Math.max(...allY);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const PAD = 30;
  const scaleX = (width - PAD * 2) / rangeX;
  const scaleY = (height - PAD * 2) / rangeY;
  const scale = Math.min(scaleX, scaleY);

  const toSvgX = x => PAD + (x - minX) * scale;
  const toSvgY = y => height - PAD - (y - minY) * scale;

  const pathD = adjCoords.map((c, i) =>
    `${i === 0 ? "M" : "L"} ${toSvgX(c.x).toFixed(1)} ${toSvgY(c.y).toFixed(1)}`
  ).join(" ") + " Z";

  // Unadjusted (ghost) path
  const ghostD = coords.map((c, i) =>
    `${i === 0 ? "M" : "L"} ${toSvgX(c.x).toFixed(1)} ${toSvgY(c.y).toFixed(1)}`
  ).join(" ") + " Z";

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      className="bg-slate-900 rounded-xl border border-slate-700">
      {/* Ghost unadjusted traverse */}
      <path d={ghostD} fill="none" stroke="#475569" strokeWidth="1" strokeDasharray="4 3" />
      {/* Adjusted traverse */}
      <path d={pathD} fill="rgba(59,130,246,0.08)" stroke="#3b82f6" strokeWidth="2" />
      {/* Station dots + labels */}
      {adjCoords.map((c, i) => (
        <g key={i}>
          <circle cx={toSvgX(c.x)} cy={toSvgY(c.y)} r="4" fill={i === 0 ? "#f59e0b" : "#3b82f6"} />
          <text x={toSvgX(c.x) + 5} y={toSvgY(c.y) - 5}
            fontSize="9" fill="#94a3b8" fontFamily="monospace">
            {c.station}
          </text>
        </g>
      ))}
      {/* Legend */}
      <line x1="8" y1={height - 14} x2="22" y2={height - 14} stroke="#3b82f6" strokeWidth="2" />
      <text x="25" y={height - 10} fontSize="8" fill="#64748b" fontFamily="monospace">Adjusted</text>
      <line x1="80" y1={height - 14} x2="94" y2={height - 14} stroke="#475569" strokeWidth="1" strokeDasharray="4 3" />
      <text x="97" y={height - 10} fontSize="8" fill="#64748b" fontFamily="monospace">Original</text>
    </svg>
  );
}

export function TraverseModule({ surveyType, beginner, project, onProjectChange }) {
  const [legs, setLegs] = useState(project?.legs || [EMPTY_LEG(), EMPTY_LEG(), EMPTY_LEG()]);
  const [activeTab, setActiveTab] = useState("input");

  const updateLegs = (newLegs) => {
    setLegs(newLegs);
    onProjectChange?.({ legs: newLegs });
  };

  const updateCell = (idx, key, val) => {
    updateLegs(legs.map((r, i) => i === idx ? { ...r, [key]: val } : r));
  };

  const addLeg = () => updateLegs([...legs, EMPTY_LEG()]);
  const delLeg = (idx) => { if (legs.length > 2) updateLegs(legs.filter((_, i) => i !== idx)); };

  const computed = useMemo(() => computeTraverse(legs), [legs]);

  const precisionStr = computed.precision > 0
    ? `1 : ${Math.round(computed.precision).toLocaleString()}`
    : "—";

  const closureOK = computed.precision >= 3000; // 1:3000 typical minimum

  const exportCSV = () => {
    const header = "Station,Bearing(DMS),Distance,Latitude,Departure,Corr.Lat,Corr.Dep,Adj.Lat,Adj.Dep,Easting,Northing\n";
    const body = computed.rows.map((r, i) =>
      `${r.station || `P${i + 1}`},${decimalToDMS(r.bearingDD)},${fmt2(r.dist)},${fmt2(r.lat)},${fmt2(r.dep)},${fmt2(r.corrLat, 4)},${fmt2(r.corrDep, 4)},${fmt2(r.adjLat)},${fmt2(r.adjDep)},${fmt2(r.x)},${fmt2(r.y)}`
    ).join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "traverse_survey.csv"; a.click();
  };

  const TABS = ["input", "results", "map", "export"];

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-900 border-b border-slate-800">
        <span className="text-blue-400 text-lg">🔺</span>
        <div>
          <div className="text-white font-bold text-sm">Traverse Survey</div>
          <div className="text-slate-500 text-xs font-mono">Bowditch (Compass Rule) Adjustment</div>
        </div>
        <div className="ml-auto">
          <span className={`text-xs font-mono px-2 py-1 rounded-lg border ${closureOK ? "text-green-400 border-green-700 bg-green-900/20" : "text-red-400 border-red-700 bg-red-900/20"}`}>
            {precisionStr}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800 bg-slate-900/30">
        {TABS.map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`flex-1 px-2 py-2 text-xs font-mono capitalize transition-colors ${activeTab === t ? "text-blue-400 border-b-2 border-blue-400" : "text-slate-500 hover:text-slate-300"}`}>
            {t === "input" ? "📋 Input" : t === "results" ? "📊 Results" : t === "map" ? "🗺️ Map" : "💾 Export"}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">

        {/* INPUT TAB */}
        {activeTab === "input" && (
          <div className="p-2">
            {beginner && (
              <div className="mb-2 p-2 bg-blue-900/20 border border-blue-800 rounded-xl text-xs text-blue-300">
                💡 Enter each leg of the traverse. <strong>Bearing</strong> in DD.MMSS format (e.g. <code>45.3020</code> = 45°30'20"). <strong>Distance</strong> in metres.
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse min-w-max">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-800">
                    {["From", "Bearing (DD.MMSS)", "Distance (m)", "Remarks", ""].map((h, i) => (
                      <th key={i} className="px-1.5 py-1.5 text-left font-mono">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {legs.map((r, idx) => (
                    <tr key={r._id} className={`border-b border-slate-800/50 ${idx % 2 === 0 ? "bg-slate-900/20" : ""}`}>
                      <td className="px-1">
                        <input value={r.station} onChange={e => updateCell(idx, "station", e.target.value)}
                          placeholder={`P${idx + 1}`}
                          className="w-16 bg-transparent border-b border-slate-700 focus:border-blue-500 outline-none py-1.5 px-0.5 font-mono text-xs text-white" />
                      </td>
                      <td className="px-1">
                        <input value={r.bearing} onChange={e => updateCell(idx, "bearing", e.target.value)}
                          placeholder="45.3020"
                          className="w-24 bg-transparent border-b border-slate-700 focus:border-blue-500 outline-none py-1.5 px-0.5 font-mono text-xs text-yellow-400" />
                      </td>
                      <td className="px-1">
                        <input value={r.distance} onChange={e => updateCell(idx, "distance", e.target.value)}
                          placeholder="0.000"
                          className="w-20 bg-transparent border-b border-slate-700 focus:border-blue-500 outline-none py-1.5 px-0.5 font-mono text-xs text-green-400" />
                      </td>
                      <td className="px-1">
                        <input value={r.remarks} onChange={e => updateCell(idx, "remarks", e.target.value)}
                          placeholder="note"
                          className="w-20 bg-transparent border-b border-slate-700 focus:border-blue-500 outline-none py-1.5 px-0.5 font-mono text-xs text-slate-400" />
                      </td>
                      <td className="px-1">
                        <button onClick={() => delLeg(idx)} className="p-1 text-slate-600 hover:text-red-400">✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button onClick={addLeg}
              className="mt-3 w-full py-2.5 bg-blue-900/30 hover:bg-blue-800/50 border border-blue-700 rounded-xl text-blue-300 text-sm font-semibold transition-colors">
              + Add Leg
            </button>
          </div>
        )}

        {/* RESULTS TAB */}
        {activeTab === "results" && (
          <div className="p-3 space-y-3">
            {/* Summary cards */}
            <div className="grid grid-cols-2 gap-2">
              {[
                ["Total Distance", fmt2(computed.sumDist) + " m", "blue"],
                ["Closure Error", fmt2(computed.closureError * 1000, 1) + " mm", closureOK ? "green" : "red"],
                ["Precision", precisionStr, closureOK ? "green" : "red"],
                ["Legs", computed.rows.length, "slate"],
              ].map(([label, val, c]) => (
                <div key={label} className={`bg-slate-900 border border-${c}-800/50 rounded-xl p-2.5`}>
                  <div className="text-slate-500 text-xs">{label}</div>
                  <div className={`font-mono font-bold text-${c}-400`}>{val}</div>
                </div>
              ))}
            </div>

            {/* Main table */}
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-xs min-w-max">
                <thead className="bg-slate-800/80">
                  <tr>
                    {["Stn", "Bearing", "Dist", "Lat", "Dep", "Corr.L", "Corr.D", "Adj.Lat", "Adj.Dep", "E", "N"].map(h => (
                      <th key={h} className="px-2 py-2 text-left font-mono text-slate-400">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {computed.rows.map((r, i) => (
                    <tr key={r._id} className={`border-t border-slate-800 ${i % 2 === 0 ? "bg-slate-900/30" : ""}`}>
                      <td className="px-2 py-1.5 text-white font-mono">{r.station || `P${i + 1}`}</td>
                      <td className="px-2 py-1.5 text-yellow-400 font-mono">{decimalToDMS(r.bearingDD)}</td>
                      <td className="px-2 py-1.5 text-green-400 font-mono">{fmt2(r.dist)}</td>
                      <td className={`px-2 py-1.5 font-mono ${r.lat >= 0 ? "text-blue-300" : "text-orange-300"}`}>{fmt2(r.lat)}</td>
                      <td className={`px-2 py-1.5 font-mono ${r.dep >= 0 ? "text-blue-300" : "text-orange-300"}`}>{fmt2(r.dep)}</td>
                      <td className="px-2 py-1.5 text-slate-400 font-mono text-xs">{fmt2(r.corrLat, 4)}</td>
                      <td className="px-2 py-1.5 text-slate-400 font-mono text-xs">{fmt2(r.corrDep, 4)}</td>
                      <td className="px-2 py-1.5 text-emerald-400 font-mono">{fmt2(r.adjLat)}</td>
                      <td className="px-2 py-1.5 text-emerald-400 font-mono">{fmt2(r.adjDep)}</td>
                      <td className="px-2 py-1.5 text-purple-400 font-mono">{fmt2(r.x)}</td>
                      <td className="px-2 py-1.5 text-purple-400 font-mono">{fmt2(r.y)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-800/50 border-t-2 border-slate-600">
                  <tr>
                    <td className="px-2 py-1.5 text-slate-400 font-mono font-bold">Σ</td>
                    <td></td>
                    <td className="px-2 py-1.5 text-green-400 font-mono font-bold">{fmt2(computed.sumDist)}</td>
                    <td className="px-2 py-1.5 text-red-400 font-mono">{fmt2(computed.sumLat)}</td>
                    <td className="px-2 py-1.5 text-red-400 font-mono">{fmt2(computed.sumDep)}</td>
                    <td colSpan={6}></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Adjusted coordinates */}
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-3">
              <div className="text-slate-400 text-xs font-semibold mb-2">📍 Adjusted Coordinates</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-max">
                  <thead><tr className="text-slate-500 border-b border-slate-700">
                    <th className="text-left px-2 py-1 font-mono">Station</th>
                    <th className="text-left px-2 py-1 font-mono">Easting (E)</th>
                    <th className="text-left px-2 py-1 font-mono">Northing (N)</th>
                  </tr></thead>
                  <tbody>
                    {computed.adjCoords.map((c, i) => (
                      <tr key={i} className="border-t border-slate-800">
                        <td className="px-2 py-1 text-white font-mono">{c.station}</td>
                        <td className="px-2 py-1 text-purple-400 font-mono">{fmt2(c.x)}</td>
                        <td className="px-2 py-1 text-purple-400 font-mono">{fmt2(c.y)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Closure status */}
            <div className={`rounded-xl border p-3 ${closureOK ? "border-green-700 bg-green-900/20" : "border-red-700 bg-red-900/20"}`}>
              <div className="flex justify-between items-center">
                <span className="text-white font-bold text-sm">Closure Check</span>
                <span className={`text-xs font-mono px-2 py-0.5 rounded-full border ${closureOK ? "text-green-400 border-green-700" : "text-red-400 border-red-700"}`}>
                  {closureOK ? "✓ PASS (≥ 1:3000)" : "✗ FAIL (< 1:3000)"}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs font-mono mt-2">
                <div><div className="text-slate-500">ΣLat error</div><div className="text-yellow-300">{fmt2(computed.sumLat)} m</div></div>
                <div><div className="text-slate-500">ΣDep error</div><div className="text-yellow-300">{fmt2(computed.sumDep)} m</div></div>
                <div><div className="text-slate-500">Linear error</div><div className="text-yellow-300">{fmt2(computed.closureError)} m</div></div>
              </div>
            </div>
          </div>
        )}

        {/* MAP TAB */}
        {activeTab === "map" && (
          <div className="p-3 space-y-3">
            <div className="text-slate-300 text-sm font-semibold">Traverse Plot</div>
            <div className="flex justify-center">
              <TraverseMap coords={computed.coords} adjCoords={computed.adjCoords} width={300} height={240} />
            </div>
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 text-xs text-slate-400 space-y-1">
              <div className="flex gap-3 items-center"><span className="w-6 h-0.5 bg-blue-500 inline-block"></span> Adjusted traverse</div>
              <div className="flex gap-3 items-center"><span className="w-6 border-t border-dashed border-slate-500 inline-block"></span> Original (unadjusted)</div>
              <div className="flex gap-3 items-center"><span className="w-3 h-3 rounded-full bg-yellow-400 inline-block"></span> Start point</div>
            </div>
            <div className="text-slate-600 text-xs text-center">Origin = first station (0, 0). Units in metres.</div>
          </div>
        )}

        {/* EXPORT TAB */}
        {activeTab === "export" && (
          <div className="p-3 space-y-2">
            <div className="text-slate-300 text-sm font-semibold mb-3">💾 Export Traverse Data</div>
            <button onClick={exportCSV}
              className="w-full flex items-center gap-3 p-3 bg-slate-900 hover:bg-green-900/30 border border-slate-700 hover:border-green-600 rounded-xl transition-all text-left">
              <span className="text-2xl">📊</span>
              <div>
                <div className="text-white font-semibold text-sm">Export CSV</div>
                <div className="text-slate-500 text-xs">Full traverse table with adjusted coordinates</div>
              </div>
            </button>
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 mt-3">
              <div className="text-slate-400 text-xs font-semibold mb-2">📋 Survey Summary</div>
              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <div className="text-slate-500">Total Legs</div><div className="text-white">{computed.rows.length}</div>
                <div className="text-slate-500">Total Distance</div><div className="text-blue-400">{fmt2(computed.sumDist)} m</div>
                <div className="text-slate-500">Closure Error</div><div className="text-yellow-400">{fmt2(computed.closureError * 1000, 1)} mm</div>
                <div className="text-slate-500">Precision</div><div className={closureOK ? "text-green-400" : "text-red-400"}>{precisionStr}</div>
                <div className="text-slate-500">Method</div><div className="text-white">Bowditch Rule</div>
                <div className="text-slate-500">Status</div>
                <div className={closureOK ? "text-green-400" : "text-red-400"}>{closureOK ? "✓ PASS" : "✗ FAIL"}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("wizard"); // wizard | survey | toolkit | projects | settings
  const [surveyType, setSurveyType] = useState(null);
  const [beginner, setBeginner] = useState(true);
  const [activeNav, setActiveNav] = useState("home");
  const [projects, setProjects] = useState(() => DB.load("projects") || []);
  const [currentProject, setCurrentProject] = useState(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [darkMode, setDarkMode] = useState(() => DB.load("darkMode") ?? true);
  const [autoSave, setAutoSave] = useState(() => DB.load("autoSave") ?? true);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  useEffect(() => { if (autoSave) DB.save("projects", projects); }, [projects, autoSave]);
  // Dark mode effect
  useEffect(() => {
    document.documentElement.classList.toggle("light-mode", !darkMode);
    DB.save("darkMode", darkMode);
  }, [darkMode]);

  // Auto save effect — when disabled, clear saved projects
  useEffect(() => {
    DB.save("autoSave", autoSave);
    if (autoSave) {
      DB.save("projects", projects);
    }
  }, [autoSave]);
  const handleWizardSelect = (type) => {
    setSurveyType(type);
    const proj = { id: uid(), name: `${type.label} — ${new Date().toLocaleDateString()}`, type: type.id, rows: [], bm: "100.000", updated: Date.now() };
    setCurrentProject(proj);
    setScreen("survey");
    setActiveNav("survey");
  };

  const handleProjectChange = (data) => {
    if (!currentProject) return;
    const updated = { ...currentProject, ...data, updated: Date.now() };
    setCurrentProject(updated);
    setProjects(ps => {
      const idx = ps.findIndex(p => p.id === updated.id);
      return idx >= 0 ? ps.map(p => p.id === updated.id ? updated : p) : [...ps, updated];
    });
  };
  const exportAllProjects = () => {
    const blob = new Blob([JSON.stringify({ version: "2.0", exported: new Date().toISOString(), projects }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `survey_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };

  const importProjects = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        const imported = data.projects ?? (Array.isArray(data) ? data : []);
        if (!imported.length) { alert("No projects found in this file."); return; }
        setProjects(prev => {
          const existingIds = new Set(prev.map(p => p.id));
          const newOnes = imported.filter(p => !existingIds.has(p.id));
          const merged = [...prev, ...newOnes];
          alert(`✓ Imported ${newOnes.length} new project(s). ${imported.length - newOnes.length} duplicate(s) skipped.`);
          return merged;
        });
      } catch {
        alert("Invalid backup file. Please use a file exported from Survey AI.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const exportCurrentProject = () => {
    if (!currentProject) return;
    const blob = new Blob([JSON.stringify({ version: "2.0", exported: new Date().toISOString(), projects: [currentProject] }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${currentProject.name.replace(/\s+/g, "_")}.json`;
    a.click();
  };

  const NAV = [
    { id: "home", label: "Home", icon: "🏠" },
    { id: "survey", label: "Survey", icon: "📏" },
    { id: "toolkit", label: "Toolkit", icon: "🔧" },
    { id: "projects", label: "Projects", icon: "📁" },
    { id: "settings", label: "Settings", icon: "⚙️" },
  ];

  const handleNav = (id) => {
    setActiveNav(id);
    if (id === "home") setScreen("wizard");
    else if (id === "survey") setScreen(currentProject ? "survey" : "wizard");
    else setScreen(id);
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-white overflow-hidden" style={{ fontFamily: "'Share Tech Mono', 'Courier New', monospace", maxWidth: 480, margin: "0 auto", boxShadow: "0 0 60px rgba(0,0,0,0.8)" }}>
      {/* Status Bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-950 border-b border-slate-800/50">
        <span className="text-blue-400 font-black text-xs tracking-widest" style={{ fontFamily: "'Orbitron', monospace" }}>SURVEY AI</span>
        <div className="flex items-center gap-2">
          {beginner && <Badge color="yellow">BEGINNER</Badge>}
          <span className={`flex items-center gap-1 text-xs font-mono ${online ? "text-green-400" : "text-red-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${online ? "bg-green-400" : "bg-red-400"}`} />
            {online ? "ONLINE" : "OFFLINE"}
          </span>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-hidden">
        {screen === "wizard" && <WizardScreen onSelect={handleWizardSelect} />}
        {screen === "survey" && currentProject && (
          <>
            {(surveyType?.id === "simple" || surveyType?.id === "differential" || surveyType?.id === "profile") && (
              <LevelingModule surveyType={surveyType} beginner={beginner} project={currentProject} onProjectChange={handleProjectChange} />
            )}
            {surveyType?.id === "crosssection" && <ComingSoonModule type={surveyType} />}
            {surveyType?.id === "traverse" && (
              <TraverseModule surveyType={surveyType} beginner={beginner} project={currentProject} onProjectChange={handleProjectChange} />
            )}
            {surveyType?.id === "area" && <ComingSoonModule type={surveyType} />}
          </>
        )}
        {screen === "survey" && !currentProject && <WizardScreen onSelect={handleWizardSelect} />}
        {screen === "toolkit" && <ToolkitModule />}
        {screen === "projects" && (
          <ProjectsModule
            projects={projects}
            onNew={() => { setScreen("wizard"); setActiveNav("home"); }}
            onLoad={(p) => { setCurrentProject(p); setSurveyType(SURVEY_TYPES.find(t => t.id === p.type)); setScreen("survey"); setActiveNav("survey"); }}
            onDelete={(id) => setProjects(ps => ps.filter(p => p.id !== id))}
            onExportAll={exportAllProjects}
            onImport={importProjects}
            onExportCurrent={exportCurrentProject}
            currentProject={currentProject}
          />
        )}
        {screen === "settings" && (
          <SettingsModule
            beginner={beginner} setBeginner={setBeginner}
            darkMode={darkMode} setDarkMode={setDarkMode}
            autoSave={autoSave} setAutoSave={setAutoSave}
          />
        )}
      </div>

      {/* Bottom Navigation */}
      <div className="flex border-t border-slate-800 bg-slate-900/90 backdrop-blur-md">
        {NAV.map(n => (
          <button key={n.id} onClick={() => handleNav(n.id)}
            className={`flex-1 flex flex-col items-center py-2.5 gap-0.5 transition-all ${activeNav === n.id ? "text-blue-400" : "text-slate-600 hover:text-slate-400"}`}>
            <span className="text-lg">{n.icon}</span>
            <span className="text-xs font-mono">{n.label}</span>
            {activeNav === n.id && <span className="w-4 h-0.5 rounded-full bg-blue-400" />}
          </button>
        ))}
      </div>
    </div>
  );
}
