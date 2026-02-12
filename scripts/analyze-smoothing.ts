/**
 * Analyze optimal smoothing windows for reporting sensor metrics to the AI coach.
 *
 * Loads Plan 2 data from ~/.clardio/clardio.db and evaluates rolling average windows
 * of various sizes for power, HR, and cadence — measuring both stability (noise
 * reduction) and responsiveness (lag after real transitions).
 */

import { Database } from "bun:sqlite";

// ─── Configuration ───────────────────────────────────────────────────────────

const PLAN_ID = 2;
const DB_PATH = `${process.env.HOME}/.clardio/clardio.db`;
const WINDOW_SIZES_S = [10, 15, 20, 30, 45, 60];

// False alarm thresholds (per tick)
const POWER_FALSE_ALARM_PCT = 0.20;  // 20% change
const HR_FALSE_ALARM_BPM = 5;        // 5 bpm change
const CADENCE_FALSE_ALARM_RPM = 8;   // 8 rpm change

// Transition detection
const POWER_TRANSITION_THRESHOLD = 50; // W sustained shift
const TRANSITION_SUSTAIN_SAMPLES = 5;  // Must sustain for ~20s (5 samples x 4s)

// Responsiveness targets
const POWER_LAG_TARGET_S = 15;
const HR_LAG_TARGET_S = 30;

// ─── Load Data ───────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: true });

interface Sample {
  timestamp_ms: number;
  duration_ms: number;
  power: number;
  hr: number;
  cadence: number;
}

const samples: Sample[] = db
  .query("SELECT timestamp_ms, duration_ms, power, hr, cadence FROM samples WHERE plan_id = ? ORDER BY timestamp_ms")
  .all(PLAN_ID) as Sample[];

console.log(`Loaded ${samples.length} samples for plan ${PLAN_ID}`);
const totalDuration = (samples[samples.length - 1].timestamp_ms - samples[0].timestamp_ms) / 1000;
console.log(`Duration: ${(totalDuration / 60).toFixed(1)} minutes`);
const avgInterval = totalDuration / (samples.length - 1);
console.log(`Average sample interval: ${avgInterval.toFixed(2)}s`);
console.log();

// ─── Compute elapsed time for each sample (seconds from start) ──────────────

const t0 = samples[0].timestamp_ms;
const elapsed_s = samples.map(s => (s.timestamp_ms - t0) / 1000);

// ─── Rolling Average ─────────────────────────────────────────────────────────

function rollingAverage(values: number[], windowSizeS: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const tEnd = elapsed_s[i];
    const tStart = tEnd - windowSizeS;
    let sum = 0;
    let count = 0;
    // Walk backwards from i to find samples within window
    for (let j = i; j >= 0; j--) {
      if (elapsed_s[j] < tStart) break;
      sum += values[j];
      count++;
    }
    result.push(count > 0 ? sum / count : values[i]);
  }
  return result;
}

// ─── Stability Metrics ───────────────────────────────────────────────────────

function stddev(arr: number[]): number {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function maxTickChange(arr: number[]): number {
  let max = 0;
  for (let i = 1; i < arr.length; i++) {
    max = Math.max(max, Math.abs(arr[i] - arr[i - 1]));
  }
  return max;
}

function countFalseAlarms(
  arr: number[],
  mode: "pct" | "abs",
  threshold: number
): number {
  let count = 0;
  for (let i = 1; i < arr.length; i++) {
    if (mode === "pct") {
      const base = arr[i - 1];
      if (base > 10 && Math.abs(arr[i] - base) / base > threshold) count++;
    } else {
      if (Math.abs(arr[i] - arr[i - 1]) > threshold) count++;
    }
  }
  return count;
}

// ─── Detect Real Phase Transitions ──────────────────────────────────────────

interface Transition {
  index: number;       // sample index where transition starts
  time_s: number;      // elapsed time
  from_power: number;  // average power before
  to_power: number;    // average power after
  delta: number;       // signed change
  from_hr: number;     // average HR before
  to_hr: number;       // average HR after
  hr_delta: number;
  from_cadence: number;
  to_cadence: number;
  cadence_delta: number;
}

function detectTransitions(): Transition[] {
  // Use a 20s moving average to find sustained power changes
  const smoothed = rollingAverage(samples.map(s => s.power), 20);
  const transitions: Transition[] = [];

  // Look for points where smoothed power changes by >50W over 20s
  const lookAhead = Math.ceil(20 / avgInterval);
  const lookBack = Math.ceil(20 / avgInterval);

  let lastTransitionIdx = -999;

  for (let i = lookBack; i < smoothed.length - lookAhead; i++) {
    const before = smoothed[i - Math.floor(lookBack / 2)];
    const after = smoothed[i + Math.floor(lookAhead / 2)];
    const delta = after - before;

    if (Math.abs(delta) > POWER_TRANSITION_THRESHOLD && i - lastTransitionIdx > lookAhead * 2) {
      // Found a transition. Compute pre/post averages over ~20s windows
      const preStart = Math.max(0, i - lookBack);
      const postEnd = Math.min(samples.length, i + lookAhead);

      const prePower = samples.slice(preStart, i).reduce((s, v) => s + v.power, 0) / (i - preStart);
      const postPower = samples.slice(i, postEnd).reduce((s, v) => s + v.power, 0) / (postEnd - i);

      const preHR = samples.slice(preStart, i).reduce((s, v) => s + v.hr, 0) / (i - preStart);
      // For HR, look further ahead since it lags — use 60s post window
      const hrPostEnd = Math.min(samples.length, i + Math.ceil(60 / avgInterval));
      const hrPostWindow = samples.slice(i + lookAhead, hrPostEnd);
      const postHR = hrPostWindow.length > 0
        ? hrPostWindow.reduce((s, v) => s + v.hr, 0) / hrPostWindow.length
        : preHR;

      const preCad = samples.slice(preStart, i).reduce((s, v) => s + v.cadence, 0) / (i - preStart);
      const postCad = samples.slice(i, postEnd).reduce((s, v) => s + v.cadence, 0) / (postEnd - i);

      transitions.push({
        index: i,
        time_s: elapsed_s[i],
        from_power: prePower,
        to_power: postPower,
        delta: postPower - prePower,
        from_hr: preHR,
        to_hr: postHR,
        hr_delta: postHR - preHR,
        from_cadence: preCad,
        to_cadence: postCad,
        cadence_delta: postCad - preCad,
      });

      lastTransitionIdx = i;
    }
  }

  return transitions;
}

// ─── Measure Lag After Transitions ──────────────────────────────────────────

function measureLag(
  rollingAvg: number[],
  transitions: Transition[],
  metric: "power" | "hr" | "cadence"
): number[] {
  const lags: number[] = [];

  for (const t of transitions) {
    let fromVal: number, toVal: number;
    if (metric === "power") {
      fromVal = t.from_power;
      toVal = t.to_power;
    } else if (metric === "hr") {
      fromVal = t.from_hr;
      toVal = t.to_hr;
    } else {
      fromVal = t.from_cadence;
      toVal = t.to_cadence;
    }

    const delta = toVal - fromVal;
    if (Math.abs(delta) < 3) {
      // Skip if the metric barely changes for this transition
      continue;
    }

    const target80 = fromVal + delta * 0.8;
    const transitionTime = elapsed_s[t.index];

    // Search forward from transition point
    let foundLag = false;
    for (let j = t.index; j < rollingAvg.length; j++) {
      const reached = delta > 0
        ? rollingAvg[j] >= target80
        : rollingAvg[j] <= target80;
      if (reached) {
        lags.push(elapsed_s[j] - transitionTime);
        foundLag = true;
        break;
      }
    }
    if (!foundLag) {
      // Never reached 80% — record as max time remaining
      lags.push(elapsed_s[elapsed_s.length - 1] - transitionTime);
    }
  }

  return lags;
}

// ─── Main Analysis ──────────────────────────────────────────────────────────

// First, print raw data stats
console.log("═══════════════════════════════════════════════════════════════");
console.log("RAW DATA CHARACTERISTICS");
console.log("═══════════════════════════════════════════════════════════════");

const rawPower = samples.map(s => s.power);
const rawHR = samples.map(s => s.hr);
const rawCadence = samples.map(s => s.cadence);

console.log(`Power:   mean=${(rawPower.reduce((a,b)=>a+b,0)/rawPower.length).toFixed(1)}W  stddev=${stddev(rawPower).toFixed(1)}W  range=[${Math.min(...rawPower)}, ${Math.max(...rawPower)}]`);
console.log(`HR:      mean=${(rawHR.reduce((a,b)=>a+b,0)/rawHR.length).toFixed(1)}bpm  stddev=${stddev(rawHR).toFixed(1)}bpm  range=[${Math.min(...rawHR)}, ${Math.max(...rawHR)}]`);
console.log(`Cadence: mean=${(rawCadence.reduce((a,b)=>a+b,0)/rawCadence.length).toFixed(1)}rpm  stddev=${stddev(rawCadence).toFixed(1)}rpm  range=[${Math.min(...rawCadence)}, ${Math.max(...rawCadence)}]`);
console.log();

// Detect transitions
const transitions = detectTransitions();
console.log("═══════════════════════════════════════════════════════════════");
console.log(`DETECTED PHASE TRANSITIONS (${transitions.length} found)`);
console.log("═══════════════════════════════════════════════════════════════");
for (const t of transitions) {
  const min = Math.floor(t.time_s / 60);
  const sec = Math.floor(t.time_s % 60);
  console.log(
    `  ${String(min).padStart(2)}:${String(sec).padStart(2, "0")}  ` +
    `Power: ${t.from_power.toFixed(0)}W -> ${t.to_power.toFixed(0)}W (${t.delta > 0 ? "+" : ""}${t.delta.toFixed(0)}W)  ` +
    `HR: ${t.from_hr.toFixed(0)} -> ${t.to_hr.toFixed(0)} (${t.hr_delta > 0 ? "+" : ""}${t.hr_delta.toFixed(0)})  ` +
    `Cad: ${t.from_cadence.toFixed(0)} -> ${t.to_cadence.toFixed(0)} (${t.cadence_delta > 0 ? "+" : ""}${t.cadence_delta.toFixed(0)})`
  );
}
console.log();

// Compute metrics for each window size
interface WindowResult {
  windowS: number;
  stddev: number;
  maxDelta: number;
  falseAlarms: number;
  medianLag: number;
  meanLag: number;
}

function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function analyzeMetric(
  values: number[],
  falseAlarmMode: "pct" | "abs",
  falseAlarmThreshold: number,
  metricName: "power" | "hr" | "cadence"
): WindowResult[] {
  const results: WindowResult[] = [];

  // Also show raw (no smoothing)
  const rawFA = countFalseAlarms(values, falseAlarmMode, falseAlarmThreshold);
  const rawMaxDelta = maxTickChange(values);
  const rawStdDev = stddev(values);

  // For raw, measure lag = 0 by definition (no smoothing delay)
  results.push({
    windowS: 0,
    stddev: rawStdDev,
    maxDelta: rawMaxDelta,
    falseAlarms: rawFA,
    medianLag: 0,
    meanLag: 0,
  });

  for (const ws of WINDOW_SIZES_S) {
    const ra = rollingAverage(values, ws);
    const sd = stddev(ra);
    const md = maxTickChange(ra);
    const fa = countFalseAlarms(ra, falseAlarmMode, falseAlarmThreshold);
    const lags = measureLag(ra, transitions, metricName);

    results.push({
      windowS: ws,
      stddev: sd,
      maxDelta: md,
      falseAlarms: fa,
      medianLag: median(lags),
      meanLag: lags.length > 0 ? lags.reduce((a, b) => a + b, 0) / lags.length : NaN,
    });
  }

  return results;
}

function printTable(title: string, results: WindowResult[], unit: string, lagTarget: number) {
  console.log("═══════════════════════════════════════════════════════════════════════════════════");
  console.log(title);
  console.log("═══════════════════════════════════════════════════════════════════════════════════");

  const hdr = [
    "Window".padEnd(8),
    `StdDev(${unit})`.padStart(12),
    `Max Δ(${unit})`.padStart(12),
    "False Alarms".padStart(14),
    "Med Lag(s)".padStart(12),
    "Mean Lag(s)".padStart(12),
    "Verdict".padStart(10),
  ];
  console.log(hdr.join(" │ "));
  console.log("─".repeat(hdr.join(" │ ").length));

  for (const r of results) {
    const windowLabel = r.windowS === 0 ? "raw" : `${r.windowS}s`;
    const verdict = r.falseAlarms === 0 && r.medianLag <= lagTarget ? " <<<" :
                    r.falseAlarms === 0 ? " (slow)" : "";
    console.log([
      windowLabel.padEnd(8),
      r.stddev.toFixed(1).padStart(12),
      r.maxDelta.toFixed(1).padStart(12),
      String(r.falseAlarms).padStart(14),
      (isNaN(r.medianLag) ? "N/A" : r.medianLag.toFixed(1)).padStart(12),
      (isNaN(r.meanLag) ? "N/A" : r.meanLag.toFixed(1)).padStart(12),
      verdict.padStart(10),
    ].join(" │ "));
  }
  console.log();
}

// Run analysis
const powerResults = analyzeMetric(rawPower, "pct", POWER_FALSE_ALARM_PCT, "power");
const hrResults = analyzeMetric(rawHR, "abs", HR_FALSE_ALARM_BPM, "hr");
const cadenceResults = analyzeMetric(rawCadence, "abs", CADENCE_FALSE_ALARM_RPM, "cadence");

printTable(`POWER ANALYSIS (false alarm = >20% change per tick, lag target = ${POWER_LAG_TARGET_S}s)`, powerResults, "W", POWER_LAG_TARGET_S);
printTable(`HR ANALYSIS (false alarm = >5bpm change per tick, lag target = ${HR_LAG_TARGET_S}s)`, hrResults, "bpm", HR_LAG_TARGET_S);
printTable(`CADENCE ANALYSIS (false alarm = >8rpm change per tick, lag target = ${HR_LAG_TARGET_S}s)`, cadenceResults, "rpm", HR_LAG_TARGET_S);

// ─── Tick-to-tick distribution analysis ─────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════");
console.log("TICK-TO-TICK CHANGE DISTRIBUTION (raw data)");
console.log("═══════════════════════════════════════════════════════════════");

function tickDistribution(values: number[], name: string, unit: string) {
  const deltas: number[] = [];
  for (let i = 1; i < values.length; i++) {
    deltas.push(Math.abs(values[i] - values[i - 1]));
  }
  deltas.sort((a, b) => a - b);
  const p50 = deltas[Math.floor(deltas.length * 0.5)];
  const p90 = deltas[Math.floor(deltas.length * 0.9)];
  const p95 = deltas[Math.floor(deltas.length * 0.95)];
  const p99 = deltas[Math.floor(deltas.length * 0.99)];
  const max = deltas[deltas.length - 1];
  console.log(`${name}: p50=${p50.toFixed(1)}${unit}  p90=${p90.toFixed(1)}${unit}  p95=${p95.toFixed(1)}${unit}  p99=${p99.toFixed(1)}${unit}  max=${max.toFixed(1)}${unit}`);
}

tickDistribution(rawPower, "Power  ", "W");
tickDistribution(rawHR, "HR     ", "bpm");
tickDistribution(rawCadence, "Cadence", "rpm");
console.log();

// ─── Per-transition lag breakdown ───────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════════════════════════");
console.log("PER-TRANSITION LAG BREAKDOWN (seconds to reach 80% of change)");
console.log("═══════════════════════════════════════════════════════════════════════════════════");

for (const t of transitions) {
  const min = Math.floor(t.time_s / 60);
  const sec = Math.floor(t.time_s % 60);
  console.log(`\nTransition at ${min}:${String(sec).padStart(2, "0")} — Power ${t.from_power.toFixed(0)}W -> ${t.to_power.toFixed(0)}W (${t.delta > 0 ? "+" : ""}${t.delta.toFixed(0)}W)`);

  const hdr = ["Window".padEnd(8), "Power Lag".padStart(12), "HR Lag".padStart(12), "Cadence Lag".padStart(14)];
  console.log(hdr.join(" │ "));
  console.log("─".repeat(hdr.join(" │ ").length));

  for (const ws of WINDOW_SIZES_S) {
    const pRA = rollingAverage(rawPower, ws);
    const hRA = rollingAverage(rawHR, ws);
    const cRA = rollingAverage(rawCadence, ws);

    function singleLag(ra: number[], fromVal: number, toVal: number): string {
      const delta = toVal - fromVal;
      if (Math.abs(delta) < 3) return "N/A (small)";
      const target80 = fromVal + delta * 0.8;
      for (let j = t.index; j < ra.length; j++) {
        const reached = delta > 0 ? ra[j] >= target80 : ra[j] <= target80;
        if (reached) return `${(elapsed_s[j] - t.time_s).toFixed(1)}s`;
      }
      return "never";
    }

    console.log([
      `${ws}s`.padEnd(8),
      singleLag(pRA, t.from_power, t.to_power).padStart(12),
      singleLag(hRA, t.from_hr, t.to_hr).padStart(12),
      singleLag(cRA, t.from_cadence, t.to_cadence).padStart(14),
    ].join(" │ "));
  }
}

console.log();

// ─── Recommendation ─────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════════════════════════");
console.log("RECOMMENDATION");
console.log("═══════════════════════════════════════════════════════════════════════════════════");
console.log();

// Find optimal window for each metric
function findOptimal(results: WindowResult[], lagTarget: number): WindowResult | null {
  // Smallest window with 0 false alarms and lag <= target
  for (const r of results) {
    if (r.windowS === 0) continue; // skip raw
    if (r.falseAlarms === 0 && r.medianLag <= lagTarget) return r;
  }
  // If none meets both, find smallest with 0 false alarms
  for (const r of results) {
    if (r.windowS === 0) continue;
    if (r.falseAlarms === 0) return r;
  }
  // If none has 0, find fewest false alarms
  let best = results[1]; // first non-raw
  for (const r of results.slice(2)) {
    if (r.falseAlarms < best.falseAlarms) best = r;
  }
  return best;
}

const optPower = findOptimal(powerResults, POWER_LAG_TARGET_S);
const optHR = findOptimal(hrResults, HR_LAG_TARGET_S);
const optCadence = findOptimal(cadenceResults, HR_LAG_TARGET_S);

console.log(`Power:   ${optPower ? `${optPower.windowS}s window` : "??"}  (${optPower?.falseAlarms} false alarms, ${optPower?.medianLag.toFixed(1)}s median lag)`);
console.log(`HR:      ${optHR ? `${optHR.windowS}s window` : "??"}  (${optHR?.falseAlarms} false alarms, ${optHR?.medianLag.toFixed(1)}s median lag)`);
console.log(`Cadence: ${optCadence ? `${optCadence.windowS}s window` : "??"}  (${optCadence?.falseAlarms} false alarms, ${optCadence?.medianLag.toFixed(1)}s median lag)`);
console.log();

// Should they differ?
console.log("SHOULD METRICS USE DIFFERENT WINDOWS?");
console.log();
console.log("Power is the noisiest metric — each pedal stroke creates variation, and the");
console.log("Cycling Power BLE characteristic reports instantaneous power averaged over");
console.log("the crank revolution. Needs the most smoothing.");
console.log();
console.log("HR is inherently smooth (cardiac output changes slowly) but lags effort by");
console.log("10-30s physiologically. Additional smoothing window adds on top of that");
console.log("physiological lag, so less smoothing is better — the signal is already clean.");
console.log();
console.log("Cadence is moderately noisy (pedal stroke counting) but less so than power.");
console.log("It changes quickly with rider intent, so we want responsiveness.");
console.log();

// Final recommendation based on analysis
if (optPower && optHR && optCadence) {
  const allSame = optPower.windowS === optHR.windowS && optHR.windowS === optCadence.windowS;
  if (allSame) {
    console.log(`VERDICT: All three metrics can use the same ${optPower.windowS}s window.`);
  } else {
    console.log(`VERDICT: Use different windows per metric:`);
    console.log(`  Power   -> ${optPower.windowS}s (noisy signal needs more smoothing)`);
    console.log(`  HR      -> ${optHR.windowS}s (already smooth, minimize added lag)`);
    console.log(`  Cadence -> ${optCadence.windowS}s`);
  }
}

db.close();
