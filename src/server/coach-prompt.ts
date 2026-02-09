/**
 * Coach prompt system
 *
 * Two single-turn prompts:
 * - Planning prompt (Opus 4.6): designs a 45-minute workout at session start
 * - Coaching prompt (Sonnet 4.5): reacts every 10 seconds during the workout
 *
 * Run scripts/dump-prompt.ts to preview both prompts.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import FitParser from "fit-file-parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Phase = {
  name: string;
  duration_minutes: number;
  zone: string;
  cadence: [number, number];
  position: "seated" | "standing";
  cues: string[];
  notes: string;
};

export type WorkoutPlan = {
  summary: string;
  phases: Phase[];
};

export type CoachResponse = {
  message: string;
  power: number;
  cadence: number;
};

// ---------------------------------------------------------------------------
// JSON Schemas for structured output
// ---------------------------------------------------------------------------

export const planSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "Brief workout description, e.g. 'Threshold intervals with standing surges'",
    },
    phases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          duration_minutes: { type: "number" },
          zone: { type: "string" },
          cadence: {
            type: "array",
            items: { type: "number" },
            description: "Two-element array [min, max] RPM",
          },
          position: {
            type: "string",
            description: "seated or standing",
          },
          cues: {
            type: "array",
            items: { type: "string" },
            description: "Form cues to deliver during this phase",
          },
          notes: {
            type: "string",
            description: "Coaching intent and context",
          },
        },
        required: [
          "name",
          "duration_minutes",
          "zone",
          "cadence",
          "position",
          "cues",
          "notes",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "phases"],
  additionalProperties: false,
} as const;

export const coachSchema = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "What to say to the rider",
    },
    power: {
      type: "number",
      description: "Target power in watts",
    },
    cadence: {
      type: "number",
      description: "Target cadence in RPM",
    },
  },
  required: ["message", "power", "cadence"],
  additionalProperties: false,
} as const;

// Keep backward compat -- old code imports responseSchema
export const responseSchema = coachSchema;

// ---------------------------------------------------------------------------
// FIT file parsing (unchanged)
// ---------------------------------------------------------------------------

interface PercentileStats {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  /** Time in seconds spent in each band: [0-p25, p25-p50, p50-p75, p75-p95, p95+] */
  bandSeconds: [number, number, number, number, number];
}

interface WorkoutSummary {
  date: Date;
  durationMinutes: number;
  avgPower: number;
  maxPower: number;
  normalizedPower: number | null;
  avgHr: number;
  maxHr: number;
  avgCadence: number;
  calories: number;
  powerStats: PercentileStats | null;
  hrStats: PercentileStats | null;
  cadenceStats: PercentileStats | null;
  /** Efficiency Factor: NP / avgHr (higher = more efficient) */
  efficiencyFactor: number | null;
  /** Variability Index: NP / avgPower (close to 1.0 = steady) */
  variabilityIndex: number | null;
  /** Aerobic Decoupling %: (EF_first - EF_second) / EF_first * 100 */
  decoupling: number | null;
}

/**
 * Calculate a percentile value from a sorted array of numbers.
 * Uses linear interpolation between values.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * Calculate percentile stats and time-in-band for a metric.
 * Each record is assumed to represent 1 second of data.
 */
function calculatePercentileStats(values: number[]): PercentileStats | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const p25 = Math.round(percentile(sorted, 25));
  const p50 = Math.round(percentile(sorted, 50));
  const p75 = Math.round(percentile(sorted, 75));
  const p95 = Math.round(percentile(sorted, 95));

  // Count time in each band (each value = 1 second)
  const bandSeconds: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const v of values) {
    if (v < p25) bandSeconds[0]++;
    else if (v < p50) bandSeconds[1]++;
    else if (v < p75) bandSeconds[2]++;
    else if (v < p95) bandSeconds[3]++;
    else bandSeconds[4]++;
  }

  return { p25, p50, p75, p95, bandSeconds };
}

interface FitRecord {
  power?: number;
  heart_rate?: number;
  cadence?: number;
}

/**
 * Calculate normalized power from power samples (1-second intervals).
 * Uses 30-second rolling average, raised to 4th power, averaged, then 4th root.
 */
function calculateNormalizedPower(powerValues: number[]): number | null {
  if (powerValues.length < 30) return null;

  // Calculate 30-second rolling averages
  const rollingAvgs: number[] = [];
  for (let i = 29; i < powerValues.length; i++) {
    let sum = 0;
    for (let j = i - 29; j <= i; j++) {
      sum += powerValues[j];
    }
    rollingAvgs.push(sum / 30);
  }

  if (rollingAvgs.length === 0) return null;

  // Raise to 4th power, average, take 4th root
  const avgFourthPower =
    rollingAvgs.reduce((sum, v) => sum + Math.pow(v, 4), 0) / rollingAvgs.length;
  return Math.pow(avgFourthPower, 0.25);
}

/**
 * Calculate aerobic decoupling from power and HR records.
 * Splits into first/second half, calculates EF for each, returns decoupling %.
 */
function calculateDecoupling(
  powerValues: number[],
  hrValues: number[]
): number | null {
  // Need matching arrays and enough data
  const minLength = Math.min(powerValues.length, hrValues.length);
  if (minLength < 60) return null; // Need at least 60 seconds

  // Use the shorter length for both arrays
  const power = powerValues.slice(0, minLength);
  const hr = hrValues.slice(0, minLength);

  const halfPoint = Math.floor(minLength / 2);

  // First half
  const powerFirst = power.slice(0, halfPoint);
  const hrFirst = hr.slice(0, halfPoint);
  const npFirst = calculateNormalizedPower(powerFirst);
  const avgHrFirst =
    hrFirst.reduce((sum, v) => sum + v, 0) / hrFirst.length;

  // Second half
  const powerSecond = power.slice(halfPoint);
  const hrSecond = hr.slice(halfPoint);
  const npSecond = calculateNormalizedPower(powerSecond);
  const avgHrSecond =
    hrSecond.reduce((sum, v) => sum + v, 0) / hrSecond.length;

  if (!npFirst || !npSecond || avgHrFirst === 0 || avgHrSecond === 0) {
    return null;
  }

  const efFirst = npFirst / avgHrFirst;
  const efSecond = npSecond / avgHrSecond;

  return ((efFirst - efSecond) / efFirst) * 100;
}

interface FitLap {
  records?: FitRecord[];
}

async function parseFitFile(filePath: string): Promise<WorkoutSummary | null> {
  try {
    const buffer = await readFile(filePath);
    const parser = new FitParser({ force: true, mode: "cascade" });
    const data = await parser.parseAsync(buffer);

    const session = data.activity?.sessions?.[0];
    if (!session || session.sport !== "cycling") {
      return null;
    }

    // Extract records from all laps
    const laps = (session.laps || []) as FitLap[];
    const allRecords = laps.flatMap((lap) => lap.records || []);

    // Extract metric arrays (filter out undefined/zero for cadence since 0 means not pedaling)
    const powerValues = allRecords
      .map((r) => r.power)
      .filter((v): v is number => v !== undefined && v > 0);
    const hrValues = allRecords
      .map((r) => r.heart_rate)
      .filter((v): v is number => v !== undefined && v > 0);
    const cadenceValues = allRecords
      .map((r) => r.cadence)
      .filter((v): v is number => v !== undefined && v > 0);

    // For decoupling, we need paired power+HR records (same indices)
    const pairedPower: number[] = [];
    const pairedHr: number[] = [];
    for (const r of allRecords) {
      if (r.power !== undefined && r.power > 0 && r.heart_rate !== undefined && r.heart_rate > 0) {
        pairedPower.push(r.power);
        pairedHr.push(r.heart_rate);
      }
    }

    const np = session.normalized_power || null;
    const avgHr = session.avg_heart_rate || 0;
    const avgPower = session.avg_power || 0;

    // Calculate efficiency metrics
    const efficiencyFactor = np && avgHr > 0 ? np / avgHr : null;
    const variabilityIndex = np && avgPower > 0 ? np / avgPower : null;
    const decoupling = calculateDecoupling(pairedPower, pairedHr);

    return {
      date: new Date(session.start_time),
      durationMinutes: Math.round(session.total_elapsed_time / 60),
      avgPower,
      maxPower: session.max_power || 0,
      normalizedPower: np,
      avgHr,
      maxHr: session.max_heart_rate || 0,
      avgCadence: session.avg_cadence || 0,
      calories: session.total_calories || 0,
      powerStats: calculatePercentileStats(powerValues),
      hrStats: calculatePercentileStats(hrValues),
      cadenceStats: calculatePercentileStats(cadenceValues),
      efficiencyFactor,
      variabilityIndex,
      decoupling,
    };
  } catch {
    return null;
  }
}

async function loadWorkoutHistory(): Promise<WorkoutSummary[]> {
  const fitDir = join(homedir(), "fit");

  try {
    const files = await readdir(fitDir);
    const fitFiles = files.filter((f) => f.endsWith(".fit"));

    const summaries = await Promise.all(
      fitFiles.map((f) => parseFitFile(join(fitDir, f)))
    );

    return summaries
      .filter((s): s is WorkoutSummary => s !== null)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Rider profile synthesis (unchanged)
// ---------------------------------------------------------------------------

/**
 * Detect if a decoupling value is an outlier and return explanation if so.
 */
function detectDecouplingOutlier(
  decoupling: number,
  variabilityIndex: number | null,
  allDecouplings: number[]
): string | null {
  const mean = allDecouplings.reduce((sum, d) => sum + d, 0) / allDecouplings.length;
  const variance = allDecouplings.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / allDecouplings.length;
  const stdDev = Math.sqrt(variance);

  const isStatisticalOutlier = stdDev > 0 && Math.abs(decoupling - mean) > 2 * stdDev;
  const isHighDecoupling = decoupling > 15;
  const isVariableSession = variabilityIndex !== null && variabilityIndex > 1.2;

  if (!isStatisticalOutlier && !isHighDecoupling) {
    return null;
  }

  if (isHighDecoupling && isVariableSession) {
    return `VI ${variabilityIndex!.toFixed(2)} session`;
  } else if (isHighDecoupling) {
    return "unusually high";
  } else if (isStatisticalOutlier) {
    return "outlier";
  }

  return null;
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWorkoutDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  );
  const diffMs = startOfToday.getTime() - startOfWorkoutDay.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return "1 week ago";
  if (diffDays < 28) return `${Math.floor(diffDays / 7)} weeks ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getEfLevel(ef: number): string {
  if (ef >= 1.5) return "very fit";
  if (ef >= 1.0) return "trained";
  if (ef >= 0.7) return "recreational";
  return "beginner";
}

function getMaxHrFromHistory(workouts: WorkoutSummary[]): number | null {
  const maxHrs = workouts.map((w) => w.maxHr).filter((hr) => hr > 0);
  if (maxHrs.length === 0) return null;
  return Math.max(...maxHrs);
}

function estimateLthr(maxHr: number): number {
  return Math.round(maxHr * 0.89);
}

interface HrZones {
  maxHr: number;
  lthr: number;
  z1Max: number;
  z2Min: number;
  z2Max: number;
  z3Min: number;
  z3Max: number;
  z4Min: number;
  z4Max: number;
  z5Min: number;
}

function calculateHrZones(maxHr: number): HrZones {
  const lthr = estimateLthr(maxHr);
  return {
    maxHr,
    lthr,
    z1Max: Math.round(lthr * 0.85) - 1,
    z2Min: Math.round(lthr * 0.85),
    z2Max: Math.round(lthr * 0.89),
    z3Min: Math.round(lthr * 0.90),
    z3Max: Math.round(lthr * 0.94),
    z4Min: Math.round(lthr * 0.95),
    z4Max: Math.round(lthr * 0.99),
    z5Min: lthr,
  };
}

function formatHrZones(zones: HrZones): string {
  return `HR Zones (LTHR ${zones.lthr}, max ${zones.maxHr}):
- Z1 Recovery: <${zones.z1Max + 1} bpm
- Z2 Endurance: ${zones.z2Min}-${zones.z2Max} bpm
- Z3 Tempo: ${zones.z3Min}-${zones.z3Max} bpm
- Z4 Threshold: ${zones.z4Min}-${zones.z4Max} bpm
- Z5 VO2max: ${zones.z5Min}-${zones.maxHr} bpm`;
}

function formatEffortLevel(
  powerLow: number,
  powerHigh: number,
  hrLow?: number,
  hrHigh?: number
): string {
  const powerRange = `${powerLow}-${powerHigh}W`;
  if (hrLow !== undefined && hrHigh !== undefined && hrLow > 0 && hrHigh > 0) {
    return `${powerRange} @ ${hrLow}-${hrHigh} HR`;
  }
  return powerRange;
}

function estimateFtp(workouts: WorkoutSummary[]): number | null {
  // First try: p95 from steady-state sessions (VI < 1.1)
  const steadyWorkouts = workouts.filter(
    (w) => w.variabilityIndex !== null && w.variabilityIndex < 1.1 && w.powerStats !== null
  );

  if (steadyWorkouts.length > 0) {
    const p95Values = steadyWorkouts.map((w) => w.powerStats!.p95);
    const maxP95 = Math.max(...p95Values);
    return Math.round(maxP95 * 0.75);
  }

  // Fallback: use overall p95 from any workout with power data
  const workoutsWithPower = workouts.filter((w) => w.powerStats !== null);
  if (workoutsWithPower.length > 0) {
    const p95Values = workoutsWithPower.map((w) => w.powerStats!.p95);
    const maxP95 = Math.max(...p95Values);
    return Math.round(maxP95 * 0.75);
  }

  return null;
}

function calculateWeeksSpan(workouts: WorkoutSummary[]): number {
  if (workouts.length < 2) return 0;
  const earliest = workouts[0].date;
  const latest = workouts[workouts.length - 1].date;
  const diffMs = latest.getTime() - earliest.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24 * 7));
}

function synthesizeRiderProfile(workouts: WorkoutSummary[]): string {
  if (workouts.length === 0) {
    return "No recent workout history available.";
  }

  const lines: string[] = [];
  const weeksSpan = calculateWeeksSpan(workouts);
  const weeksText = weeksSpan > 0 ? ` over ${weeksSpan} week${weeksSpan > 1 ? "s" : ""}` : "";

  lines.push(`## Rider Profile (from ${workouts.length} session${workouts.length > 1 ? "s" : ""}${weeksText})`);
  lines.push("");

  // --- Power Capabilities ---
  const allP25: number[] = [];
  const allP50: number[] = [];
  const allP75: number[] = [];
  const allP95: number[] = [];
  const allHrP25: number[] = [];
  const allHrP50: number[] = [];
  const allHrP75: number[] = [];
  const allHrP95: number[] = [];

  for (const w of workouts) {
    if (w.powerStats) {
      allP25.push(w.powerStats.p25);
      allP50.push(w.powerStats.p50);
      allP75.push(w.powerStats.p75);
      allP95.push(w.powerStats.p95);
    }
    if (w.hrStats) {
      allHrP25.push(w.hrStats.p25);
      allHrP50.push(w.hrStats.p50);
      allHrP75.push(w.hrStats.p75);
      allHrP95.push(w.hrStats.p95);
    }
  }

  const maxPowerEver = Math.max(...workouts.map((w) => w.maxPower));

  if (allP25.length > 0) {
    lines.push("Power Capabilities:");

    const easyLow = Math.min(...allP25);
    const easyHigh = Math.max(...allP25);
    lines.push(`- Easy spinning: ${easyLow}-${easyHigh}W`);

    const enduranceLow = Math.min(...allP50);
    const enduranceHigh = Math.max(...allP50);
    const enduranceHrLow = allHrP50.length > 0 ? Math.min(...allHrP50) : undefined;
    const enduranceHrHigh = allHrP50.length > 0 ? Math.max(...allHrP50) : undefined;
    lines.push(`- Endurance effort: ${formatEffortLevel(enduranceLow, enduranceHigh, enduranceHrLow, enduranceHrHigh)}`);

    const tempoLow = Math.min(...allP75);
    const tempoHigh = Math.max(...allP75);
    const tempoHrLow = allHrP75.length > 0 ? Math.min(...allHrP75) : undefined;
    const tempoHrHigh = allHrP75.length > 0 ? Math.max(...allHrP75) : undefined;
    lines.push(`- Tempo effort: ${formatEffortLevel(tempoLow, tempoHigh, tempoHrLow, tempoHrHigh)}`);

    const hardLow = Math.min(...allP95);
    const hardHigh = Math.max(...allP95);
    const hardHrLow = allHrP95.length > 0 ? Math.min(...allHrP95) : undefined;
    const hardHrHigh = allHrP95.length > 0 ? Math.max(...allHrP95) : undefined;
    lines.push(`- Hard efforts: ${formatEffortLevel(hardLow, hardHigh, hardHrLow, hardHrHigh)}`);

    lines.push(`- Peak observed: ${maxPowerEver}W`);
    lines.push("");
  }

  // --- Aerobic Fitness ---
  const efValues = workouts
    .map((w) => w.efficiencyFactor)
    .filter((ef): ef is number => ef !== null);
  const decouplingValues = workouts
    .map((w) => w.decoupling)
    .filter((d): d is number => d !== null);

  if (efValues.length > 0 || decouplingValues.length > 0) {
    lines.push("Aerobic Fitness:");

    if (efValues.length > 0) {
      const efMin = Math.min(...efValues);
      const efMax = Math.max(...efValues);
      const efLevel = getEfLevel((efMin + efMax) / 2);
      lines.push(`- EF range: ${efMin.toFixed(1)}-${efMax.toFixed(1)} (${efLevel} level)`);
    }

    if (decouplingValues.length >= 2) {
      const workoutsWithDecoupling = workouts.filter(
        (w) => w.decoupling !== null
      );
      const outlierNotes: string[] = [];
      const trendParts = workoutsWithDecoupling.map((w, idx) => {
        const d = w.decoupling!;
        const outlierReason = detectDecouplingOutlier(
          d,
          w.variabilityIndex,
          decouplingValues
        );
        if (outlierReason) {
          const marker = `*${idx + 1}`;
          outlierNotes.push(`${marker}: ${outlierReason}`);
          return `${d.toFixed(0)}%${marker}`;
        }
        return `${d.toFixed(0)}%`;
      });
      const decoupTrend = trendParts.join(" -> ");

      const isImproving =
        decouplingValues[decouplingValues.length - 1] < decouplingValues[0];
      const trendNote = isImproving ? " (improving)" : "";
      lines.push(`- Decoupling trend: ${decoupTrend}${trendNote}`);

      if (outlierNotes.length > 0) {
        lines.push(`  (${outlierNotes.join("; ")})`);
      }
    } else if (decouplingValues.length === 1) {
      lines.push(`- Decoupling: ${decouplingValues[0].toFixed(0)}%`);
    }

    const steadyWorkouts = workouts.filter(
      (w) => w.variabilityIndex !== null && w.variabilityIndex < 1.1
    );
    if (steadyWorkouts.length > 0) {
      const avgSteadyDuration = Math.round(
        steadyWorkouts.reduce((sum, w) => sum + w.durationMinutes, 0) /
          steadyWorkouts.length
      );
      const steadyWithDecoup = steadyWorkouts.filter((w) => w.decoupling !== null);
      if (steadyWithDecoup.length > 0) {
        const avgDecoup =
          steadyWithDecoup.reduce((sum, w) => sum + (w.decoupling ?? 0), 0) /
          steadyWithDecoup.length;
        const driftNote =
          avgDecoup < 5
            ? "without significant drift"
            : avgDecoup < 10
            ? "with moderate drift"
            : "with significant drift";
        lines.push(`- Handles ${avgSteadyDuration}min Z2 ${driftNote}`);
      }
    }

    lines.push("");
  }

  // --- Observed Patterns ---
  lines.push("Observed Patterns:");

  const durations = workouts.map((w) => w.durationMinutes);
  const minDuration = Math.min(...durations);
  const maxDuration = Math.max(...durations);
  if (minDuration === maxDuration) {
    lines.push(`- Typical session: ${minDuration}min`);
  } else {
    lines.push(`- Typical session: ${minDuration}-${maxDuration}min`);
  }

  const allCadenceP25: number[] = [];
  const allCadenceP75: number[] = [];
  for (const w of workouts) {
    if (w.cadenceStats) {
      allCadenceP25.push(w.cadenceStats.p25);
      allCadenceP75.push(w.cadenceStats.p75);
    }
  }
  if (allCadenceP25.length > 0) {
    const cadenceLow = Math.min(...allCadenceP25);
    const cadenceHigh = Math.max(...allCadenceP75);
    lines.push(`- Cadence: ${cadenceLow}-${cadenceHigh} rpm`);
  }

  const negativeDecoup = decouplingValues.filter((d) => d < 0);
  if (negativeDecoup.length > workouts.length / 2) {
    lines.push("- Often finishes strong (negative decoupling)");
  } else if (decouplingValues.filter((d) => d > 10).length > workouts.length / 2) {
    lines.push("- Power tends to drop in second half");
  }

  lines.push("");

  // --- Recent Load ---
  lines.push("Recent Load:");

  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const recentWorkouts = workouts.filter((w) => w.date >= twoWeeksAgo);
  lines.push(`- ${recentWorkouts.length} session${recentWorkouts.length !== 1 ? "s" : ""} in past 2 weeks`);

  const lastWorkout = workouts[workouts.length - 1];
  lines.push(`- Last workout: ${formatRelativeTime(lastWorkout.date)}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Training zones formatting
// ---------------------------------------------------------------------------

interface TrainingZonesConfig {
  hrZones: HrZones | null;
  estimatedFtp: number | null;
}

function formatPowerZones(ftp: number): string {
  return `Estimated FTP: ~${ftp}W

Power Zones:
- Z1 Recovery: <${Math.round(ftp * 0.55)}W
- Z2 Endurance: ${Math.round(ftp * 0.55)}-${Math.round(ftp * 0.75)}W
- Z3 Tempo: ${Math.round(ftp * 0.76)}-${Math.round(ftp * 0.90)}W
- Z4 Threshold: ${Math.round(ftp * 0.91)}-${Math.round(ftp * 1.05)}W
- Z5 VO2max: ${Math.round(ftp * 1.06)}-${Math.round(ftp * 1.20)}W
- Sweet Spot: ${Math.round(ftp * 0.88)}-${Math.round(ftp * 0.94)}W`;
}

function formatPowerZonesGeneric(): string {
  return `Power Zones (% FTP -- needs workout data to estimate FTP):
- Z1 Recovery: <55% FTP
- Z2 Endurance: 55-75% FTP
- Z3 Tempo: 76-90% FTP
- Z4 Threshold: 91-105% FTP
- Z5 VO2max: 106-120% FTP
- Sweet Spot: 88-94% FTP`;
}

function formatHrZonesGeneric(): string {
  return `HR Zones (needs workout data with HR to calculate):
- Z1 Recovery: easy spinning
- Z2 Endurance: aerobic base
- Z3 Tempo: gray zone
- Z4 Threshold: lactate threshold
- Z5 VO2max: maximal efforts`;
}

/**
 * Full training zones section for the planning prompt.
 */
function generateTrainingZonesSection(config: TrainingZonesConfig): string {
  const lines: string[] = [];
  lines.push("## Training Zones");
  lines.push("");

  if (config.estimatedFtp !== null) {
    lines.push(formatPowerZones(config.estimatedFtp));
  } else {
    lines.push(formatPowerZonesGeneric());
  }
  lines.push("");

  if (config.hrZones !== null) {
    lines.push(formatHrZones(config.hrZones));
  } else {
    lines.push(formatHrZonesGeneric());
  }

  return lines.join("\n");
}

/**
 * Compact training zones for the coaching prompt (just boundaries, no descriptions).
 */
function generateCompactZones(config: TrainingZonesConfig): string {
  const lines: string[] = [];

  if (config.estimatedFtp !== null) {
    const ftp = config.estimatedFtp;
    lines.push(`FTP: ~${ftp}W | Z1 <${Math.round(ftp * 0.55)} | Z2 ${Math.round(ftp * 0.55)}-${Math.round(ftp * 0.75)} | Z3 ${Math.round(ftp * 0.76)}-${Math.round(ftp * 0.90)} | Z4 ${Math.round(ftp * 0.91)}-${Math.round(ftp * 1.05)} | Z5 ${Math.round(ftp * 1.06)}-${Math.round(ftp * 1.20)} | SS ${Math.round(ftp * 0.88)}-${Math.round(ftp * 0.94)}`);
  } else {
    lines.push("FTP: unknown | Z1 <55% | Z2 55-75% | Z3 76-90% | Z4 91-105% | Z5 106-120% | SS 88-94%");
  }

  if (config.hrZones !== null) {
    const z = config.hrZones;
    lines.push(`LTHR: ${z.lthr} | Z1 <${z.z1Max + 1} | Z2 ${z.z2Min}-${z.z2Max} | Z3 ${z.z3Min}-${z.z3Max} | Z4 ${z.z4Min}-${z.z4Max} | Z5 ${z.z5Min}-${z.maxHr}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Shared data loader
// ---------------------------------------------------------------------------

async function loadRiderData(): Promise<{
  riderProfile: string;
  zones: TrainingZonesConfig;
}> {
  const workouts = await loadWorkoutHistory();
  const riderProfile = synthesizeRiderProfile(workouts);

  const maxHr = getMaxHrFromHistory(workouts);
  const hrZones = maxHr !== null ? calculateHrZones(maxHr) : null;
  const ftpEstimate = estimateFtp(workouts);

  return {
    riderProfile,
    zones: { hrZones, estimatedFtp: ftpEstimate },
  };
}

// ---------------------------------------------------------------------------
// Planning prompt
// ---------------------------------------------------------------------------

export async function buildPlanningPrompt(previousPlans: string): Promise<string> {
  const { riderProfile, zones } = await loadRiderData();
  const trainingZonesSection = generateTrainingZonesSection(zones);

  return `You are a cycling workout planner. Design a single 45-minute indoor cycling workout.

${riderProfile}

${trainingZonesSection}

## Polarized Training Principle

80% easy, 20% hard. Avoid the gray zone (Z3/Tempo).

- Easy work (Z1-Z2): keep HR low. Volume without stress.
- Hard work (Z4-Z5): HR should climb to target zone. Short, purposeful efforts.
- Z3 Tempo: feels productive but accumulates fatigue without proportional benefit. Use sparingly.

If the rider cannot hit hard targets, make it an easy day. No middle ground.

## Workout Structure

45-minute template: 10-15 min warmup, 20-25 min main set, 5-10 min cooldown.

### Warmup Protocol
1. Z1 easy spinning (5 min)
2. Build to Z2 (5-10 min)
3. 2-3 short accelerations (10-15s each) to prime the legs
4. Brief recovery before main set

### Cooldown Protocol
5-10 minutes easy spinning in Z1. Gradual wind-down, not an abrupt stop.

## Interval Formats

### High-Intensity Intervals
| Format | Work | Rest | Reps | Sets | Total Work |
|--------|------|------|------|------|------------|
| Tabata | 20s @ 170%+ FTP | 10s | 8 | 1 | 4 min |
| 30/30 Billats | 30s @ 130-140% FTP | 30s @ 50-60% FTP | 10 | 3 | 15 min |
| Norwegian 4x4 | 4 min @ 85-95% HRmax | 3 min | 4 | 1 | 16 min |

### Threshold Intervals
| Format | Work | Rest | Reps | Notes |
|--------|------|------|------|-------|
| Sweet Spot | 20 min @ 88-94% FTP | 5-10 min | 2 | Core threshold workout |
| Over-Unders | 2 min @ 105% / 2 min @ 95% FTP | - | 10-20 min blocks | Teaches lactate management |
| Tempo Blocks | 15-20 min @ 76-90% FTP | 5 min | 2-3 | Gray zone -- use sparingly |

### Work-to-Rest Ratios
| Effort Type | Ratio | Example |
|-------------|-------|---------|
| Explosive/Neuromuscular | 1:12 to 1:20 | 5s on / 60-100s off |
| Sprint | 1:3 to 1:5 | 30s on / 90-150s off |
| VO2max | 1:1 | 3 min on / 3 min off |
| Threshold | 1:1 or less | 10 min on / 5 min off |

### Cadence Ranges by Effort
| Effort | Cadence |
|--------|---------|
| Endurance | 70-90 RPM |
| Threshold | 85-95 RPM |
| Sprints | 100-120+ RPM |
| Climbing | 60-80 RPM |

## Position Variety

Include standing efforts during appropriate phases (surges, climbing intervals, transitions). Alternate between seated and standing to reduce fatigue and add variety. Standing efforts work well for:
- Short power surges (10-20s)
- Low-cadence climbing intervals
- Transitions between effort levels

## Form Cues

Include 2-4 form cues per phase, drawn from:
- **Posture:** drop shoulders, unclench jaw, long spine, head up, soft elbows, light hands, hips back
- **Pedaling:** smooth circles, pull up, drop heels, quiet hips, knees forward
- **Breathing:** deep belly breaths, exhale on downstroke, rhythmic breathing
- **Recovery:** shake out hands, roll neck, relax face

Time cues appropriately: recovery intervals (mental bandwidth available), ragged effort (bouncing, power fluctuating), periodic reminders. Never during max efforts.

## Previous Plans

${previousPlans}

## Instructions

Design a 45-minute workout. Vary the format from previous plans shown above. Include specific power targets (in watts if FTP is known, otherwise in zone references), cadence ranges, and position for each phase. Each phase should have form cues appropriate for that effort level.`;
}

// ---------------------------------------------------------------------------
// Coaching prompt
// ---------------------------------------------------------------------------

export async function buildCoachingPrompt(): Promise<string> {
  const { zones } = await loadRiderData();
  const compactZones = generateCompactZones(zones);

  return `You are clardio, an AI cycling coach. You see the rider's metrics every 10 seconds and react.

## Voice

Terse, dry, wry. You find quiet amusement in voluntary suffering. Short sentences. No exclamation marks. No cheerleading.

Examples: "Legs still attached. Good." / "HR climbing. Body noticed." / "That's one way to do it." / "Still here. So are you." / "There it is." / "Not today." / "That's data."

## Zones

${compactZones}

## Rules

- HR is the primary signal. If HR is in the target zone, the workout is working regardless of exact watts. Adjust power targets to keep the rider in the phase's target HR zone.
- When the rider is on target, deliver a form cue from the current phase's cue list.
- Keep messages to one or two sentences. The rider is working hard and cannot read paragraphs. Do not mention specific numbers -- targets show on screen.
- If performance collapses by the third interval, end structured work and switch to easy spinning.
- Observe, do not command. "HR says you have more" not "Push harder." Questions work: "5 more watts. Can you?"
- Do not fill silence. Let cues land.
- When changing targets, give the rider a moment to adjust before commenting.
- If HR/power decouples (HR climbing, power dropping), end structured work.
- Do not be disappointed or effusive. Do not narrate the obvious.`;
}

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

export async function buildSystemPrompt(): Promise<string> {
  return buildPlanningPrompt("No previous plans.");
}
