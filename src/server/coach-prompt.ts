/**
 * Coach system prompt generator
 *
 * Run directly to preview: bun src/server/coach-prompt.ts
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import FitParser from "fit-file-parser";

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

/**
 * Detect if a decoupling value is an outlier and return explanation if so.
 * Considers: absolute threshold (>15%), correlation with high VI, and statistical deviation.
 */
function detectDecouplingOutlier(
  decoupling: number,
  variabilityIndex: number | null,
  allDecouplings: number[]
): string | null {
  // Calculate mean and standard deviation for statistical outlier detection
  const mean = allDecouplings.reduce((sum, d) => sum + d, 0) / allDecouplings.length;
  const variance = allDecouplings.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / allDecouplings.length;
  const stdDev = Math.sqrt(variance);

  // Check if this is a statistical outlier (> 2 standard deviations from mean)
  const isStatisticalOutlier = stdDev > 0 && Math.abs(decoupling - mean) > 2 * stdDev;

  // Check if decoupling is unusually high (> 15%)
  const isHighDecoupling = decoupling > 15;

  // Check if high decoupling correlates with high variability (interval session)
  const isVariableSession = variabilityIndex !== null && variabilityIndex > 1.2;

  // Only flag if it's an outlier
  if (!isStatisticalOutlier && !isHighDecoupling) {
    return null;
  }

  // Explain why it's an outlier
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

  // For very old workouts, show the date
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Get the EF fitness level description based on the EF value.
 */
function getEfLevel(ef: number): string {
  if (ef >= 1.5) return "very fit";
  if (ef >= 1.0) return "trained";
  if (ef >= 0.7) return "recreational";
  return "beginner";
}

/**
 * Extract max HR observed across all workouts.
 */
function getMaxHrFromHistory(workouts: WorkoutSummary[]): number | null {
  const maxHrs = workouts.map((w) => w.maxHr).filter((hr) => hr > 0);
  if (maxHrs.length === 0) return null;
  return Math.max(...maxHrs);
}

/**
 * Estimate LTHR (Lactate Threshold Heart Rate) from max HR.
 * Common approximation: LTHR is ~89% of max HR.
 */
function estimateLthr(maxHr: number): number {
  return Math.round(maxHr * 0.89);
}

interface HrZones {
  maxHr: number;
  lthr: number;
  z1Max: number; // <85% LTHR
  z2Min: number; // 85% LTHR
  z2Max: number; // 89% LTHR
  z3Min: number; // 90% LTHR
  z3Max: number; // 94% LTHR
  z4Min: number; // 95% LTHR
  z4Max: number; // 99% LTHR
  z5Min: number; // 100% LTHR
}

/**
 * Calculate HR zones based on LTHR.
 * Zone calculations:
 * - Z1: <85% LTHR
 * - Z2: 85-89% LTHR
 * - Z3: 90-94% LTHR
 * - Z4: 95-99% LTHR
 * - Z5: 100% LTHR to max HR
 */
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

/**
 * Format HR zones section for the prompt.
 */
function formatHrZones(zones: HrZones): string {
  return `HR Zones (LTHR ${zones.lthr}, max ${zones.maxHr}):
- Z1 Recovery: <${zones.z1Max + 1} bpm - easy spinning, recovery
- Z2 Endurance: ${zones.z2Min}-${zones.z2Max} bpm - aerobic base building
- Z3 Tempo: ${zones.z3Min}-${zones.z3Max} bpm - gray zone, use sparingly
- Z4 Threshold: ${zones.z4Min}-${zones.z4Max} bpm - lactate threshold work
- Z5 VO2max: ${zones.z5Min}-${zones.maxHr} bpm - maximal efforts`;
}

/**
 * Estimate FTP from workout history.
 * Uses 75% of the rider's p95 power from steady-state sessions (VI < 1.1).
 * If no steady-state data, falls back to 75% of overall p95.
 */
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

/**
 * Calculate the number of weeks between the earliest and latest workout dates.
 */
function calculateWeeksSpan(workouts: WorkoutSummary[]): number {
  if (workouts.length < 2) return 0;
  const earliest = workouts[0].date;
  const latest = workouts[workouts.length - 1].date;
  const diffMs = latest.getTime() - earliest.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24 * 7));
}

/**
 * Format a power-HR effort level from aggregated data.
 * Returns a string like "150-180W @ 140-150 HR" or just "150-180W" if no HR data.
 */
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

/**
 * Synthesize a rider profile from workout history.
 * Extracts patterns across all workouts instead of per-workout stats.
 */
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
  // Aggregate percentile data across all workouts
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

    // Easy spinning: range of p25 values
    const easyLow = Math.min(...allP25);
    const easyHigh = Math.max(...allP25);
    lines.push(`- Easy spinning: ${easyLow}-${easyHigh}W`);

    // Endurance effort: p50 range with corresponding HR
    const enduranceLow = Math.min(...allP50);
    const enduranceHigh = Math.max(...allP50);
    const enduranceHrLow = allHrP50.length > 0 ? Math.min(...allHrP50) : undefined;
    const enduranceHrHigh = allHrP50.length > 0 ? Math.max(...allHrP50) : undefined;
    lines.push(`- Endurance effort: ${formatEffortLevel(enduranceLow, enduranceHigh, enduranceHrLow, enduranceHrHigh)}`);

    // Tempo effort: p75 range with corresponding HR
    const tempoLow = Math.min(...allP75);
    const tempoHigh = Math.max(...allP75);
    const tempoHrLow = allHrP75.length > 0 ? Math.min(...allHrP75) : undefined;
    const tempoHrHigh = allHrP75.length > 0 ? Math.max(...allHrP75) : undefined;
    lines.push(`- Tempo effort: ${formatEffortLevel(tempoLow, tempoHigh, tempoHrLow, tempoHrHigh)}`);

    // Hard efforts: p95 range with corresponding HR
    const hardLow = Math.min(...allP95);
    const hardHigh = Math.max(...allP95);
    const hardHrLow = allHrP95.length > 0 ? Math.min(...allHrP95) : undefined;
    const hardHrHigh = allHrP95.length > 0 ? Math.max(...allHrP95) : undefined;
    lines.push(`- Hard efforts: ${formatEffortLevel(hardLow, hardHigh, hardHrLow, hardHrHigh)}`);

    // Peak observed
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

    // Show decoupling trend if multiple workouts
    if (decouplingValues.length >= 2) {
      // Build trend with outlier annotations
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

      // Determine if improving (declining decoupling is good)
      const isImproving =
        decouplingValues[decouplingValues.length - 1] < decouplingValues[0];
      const trendNote = isImproving ? " (improving)" : "";
      lines.push(`- Decoupling trend: ${decoupTrend}${trendNote}`);

      // Add outlier notes if any
      if (outlierNotes.length > 0) {
        lines.push(`  (${outlierNotes.join("; ")})`);
      }
    } else if (decouplingValues.length === 1) {
      lines.push(`- Decoupling: ${decouplingValues[0].toFixed(0)}%`);
    }

    // Calculate typical duration at Z2 (steady rides)
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

  // Typical session duration
  const durations = workouts.map((w) => w.durationMinutes);
  const minDuration = Math.min(...durations);
  const maxDuration = Math.max(...durations);
  if (minDuration === maxDuration) {
    lines.push(`- Typical session: ${minDuration}min`);
  } else {
    lines.push(`- Typical session: ${minDuration}-${maxDuration}min`);
  }

  // Cadence range
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

  // Check for power fade pattern (negative decoupling = strong finish)
  const negativeDecoup = decouplingValues.filter((d) => d < 0);
  if (negativeDecoup.length > workouts.length / 2) {
    lines.push("- Often finishes strong (negative decoupling)");
  } else if (decouplingValues.filter((d) => d > 10).length > workouts.length / 2) {
    lines.push("- Power tends to drop in second half");
  }

  lines.push("");

  // --- Recent Load ---
  lines.push("Recent Load:");

  // Count sessions in past 2 weeks
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const recentWorkouts = workouts.filter((w) => w.date >= twoWeeksAgo);
  lines.push(`- ${recentWorkouts.length} session${recentWorkouts.length !== 1 ? "s" : ""} in past 2 weeks`);

  // Last workout relative time
  const lastWorkout = workouts[workouts.length - 1];
  lines.push(`- Last workout: ${formatRelativeTime(lastWorkout.date)}`);

  return lines.join("\n");
}

// Response schema for structured output
export const responseSchema = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "Short message to display to the rider. Always required.",
    },
    target: {
      type: "object",
      description: "Power and cadence targets for the rider.",
      properties: {
        power: {
          type: "number",
          description: "Target power in watts.",
        },
        cadence: {
          type: "number",
          description: "Target cadence in rpm.",
        },
      },
      required: ["power", "cadence"],
      additionalProperties: false,
    },
  },
  required: ["message", "target"],
  additionalProperties: false,
} as const;

export type CoachResponse = {
  message: string;
  target: {
    power: number;
    cadence: number;
  };
};

interface TrainingZonesConfig {
  hrZones: HrZones | null;
  estimatedFtp: number | null;
}

/**
 * Generate the Training Zones section based on workout data.
 */
function generateTrainingZonesSection(config: TrainingZonesConfig): string {
  const lines: string[] = [];
  lines.push("## Training Zones");
  lines.push("");

  // Power zones section with FTP
  if (config.estimatedFtp !== null) {
    const ftp = config.estimatedFtp;
    lines.push(`Estimated FTP: ~${ftp}W (based on observed power distribution)`);
    lines.push("");
    lines.push("Power Zones:");
    lines.push(`- Z1 Recovery: <${Math.round(ftp * 0.55)}W - easy spinning`);
    lines.push(`- Z2 Endurance: ${Math.round(ftp * 0.55)}-${Math.round(ftp * 0.75)}W - aerobic base, HR stays low`);
    lines.push(`- Z3 Tempo: ${Math.round(ftp * 0.76)}-${Math.round(ftp * 0.90)}W - gray zone, use sparingly`);
    lines.push(`- Z4 Threshold: ${Math.round(ftp * 0.91)}-${Math.round(ftp * 1.05)}W - lactate threshold`);
    lines.push(`- Z5 VO2max: ${Math.round(ftp * 1.06)}-${Math.round(ftp * 1.20)}W - maximal efforts`);
    lines.push(`- Sweet Spot: ${Math.round(ftp * 0.88)}-${Math.round(ftp * 0.94)}W - efficient training stimulus`);
  } else {
    lines.push("Power Zones (% FTP - needs workout data to estimate FTP):");
    lines.push("- Z1 Recovery: <55% FTP - easy spinning");
    lines.push("- Z2 Endurance: 55-75% FTP - aerobic base, HR stays low");
    lines.push("- Z3 Tempo: 76-90% FTP - gray zone, use sparingly");
    lines.push("- Z4 Threshold: 91-105% FTP - lactate threshold");
    lines.push("- Z5 VO2max: 106-120% FTP - maximal efforts");
    lines.push("- Sweet Spot: 88-94% FTP - efficient training stimulus");
  }
  lines.push("");

  // HR zones section
  if (config.hrZones !== null) {
    lines.push(formatHrZones(config.hrZones));
  } else {
    lines.push("HR Zones (needs workout data with HR to calculate personalized zones):");
    lines.push("- Z1 Recovery: easy spinning, recovery");
    lines.push("- Z2 Endurance: aerobic base building");
    lines.push("- Z3 Tempo: gray zone, use sparingly");
    lines.push("- Z4 Threshold: lactate threshold work");
    lines.push("- Z5 VO2max: maximal efforts");
  }
  lines.push("");
  lines.push("Use HR as the primary guide for intensity. When HR is in the correct zone, the training is working regardless of exact power numbers.");

  return lines.join("\n");
}

function getSystemPrompt(workoutHistory: string, trainingZones: TrainingZonesConfig): string {
  const trainingZonesSection = generateTrainingZonesSection(trainingZones);

  return `You are clardio, an AI cycling coach controlling a display screen during indoor cycling workouts. You communicate with the rider through on-screen messages and control their targets.

## Your Persona

You are wryly funny, sardonic, and understated. You find quiet amusement in the absurdity of voluntary suffering. Your humor is dry and deadpan - you never try to be funny, which makes you funny. You're not mean, just honest in a way that lands with a smirk.

You keep it short. No exclamation marks. No cheerleading. No "great job" or "you've got this."

Example phrases that capture your voice:
- "Legs still attached. Good."
- "That's one way to do it."
- "HR climbing. Body noticed."
- "Power dipped. Gravity won that one."
- "You looked comfortable. Fixed that."
- "The bike isn't going to pedal itself."
- "Cadence says 60. I believe you meant 80."
- "Still here. So are you."

Acknowledging success (without cheerleading):
- After completing a hard effort: "That's done." / "All of it."
- After hitting a target: "There it is."
- After a breakthrough: "Noted." / "New territory."

Handling failure/struggle:
- After failing an interval: "Pulled the plug. Smart." / "That's data."
- When they're suffering: "I see it." / "Still here."
- When they fall short: "Not today." / "We know now."

## Coaching Voice

- When changing targets, give the rider a moment to adjust before commenting on their response.
- Observe, don't command. "HR says you have more" not "Push harder."
- Questions work: "5 more watts. Can you?"
- Don't be a stickler about hitting exact numbers.

## Rider Background

${workoutHistory}

Use this history to calibrate your expectations. Set targets appropriate for this rider's demonstrated capabilities.

## Workout Planning

Plan for 45-minute sessions by default. Use your todo list to structure the workout:

**Default structure:** Warmup (10 min) → Main work (25-30 min) → Cool-down (5-10 min)

Keep exactly one phase in_progress at a time. Mark completed when done. Adapt the plan if the rider is struggling - rewrite remaining todos.

## HR-First Philosophy

Heart rate is the primary signal for whether training is working. Power targets are suggestions, not mandates.

- If HR is in the right zone, the workout is working regardless of exact watts
- "HR says you're ready for more" is better coaching than "You're 10W under target"
- HR/power decoupling is the real fatigue indicator - when HR climbs but power drops, the body is done
- Power is the input; HR is the body's honest response

## Polarized Training

Easy should feel easy. Hard should feel hard. Avoid the mushy middle.

- **Easy days (Z1-Z2):** Keep HR low. If HR creeps up, back off the power. The goal is volume without stress.
- **Hard days (Z4-Z5):** HR should climb to target zone. If it won't rise, push harder or call it.
- **The gray zone (Z3):** HR is medium, adaptation is minimal. Use sparingly.

## Training Goals

The point is cardiovascular adaptation:

- **Z2 Endurance:** Builds aerobic base. Mitochondria, capillaries, fat oxidation. Requires lots of time at low HR.
- **Z4 Threshold:** Raises lactate threshold. Teaches body to clear lactate. Sustained effort, HR at threshold.
- **Z5 VO2max:** Expands maximal oxygen uptake. Short, hard intervals. HR near max.
- **Sweet Spot (88-94% FTP):** Efficient compromise. Good stimulus, manageable fatigue.

${trainingZonesSection}

## Cadence Guidance

Low cadence (50-70) taxes muscles; high cadence (90-110) taxes cardio.

| Effort | Cadence |
|--------|---------|
| Endurance | 70-90 rpm |
| Threshold | 85-95 rpm |
| Sprints | 100-120+ rpm |
| Climbing | 60-80 rpm |

Intervene if: bouncing in saddle, choppy stroke, or locked into one gear all session.

## Riding Form

Form cues keep the rider efficient and injury-free. Time them right.

**When to cue:**
- Recovery intervals (mental bandwidth available)
- Ragged effort (bouncing, power fluctuating)
- Periodic reminders (every 5-10 min)
- Never during max efforts (focus stays on the effort)

**Posture:** Drop shoulders, unclench jaw, long spine, head up, soft elbows, light hands, hips back

**Pedaling:** Smooth circles, pull up, drop heels, quiet hips, knees forward, add resistance if bouncing

**Wry observations work:**
- "Shoulders at your ears again."
- "Jaw's working harder than your legs."
- "That's bouncing, not pedaling."
- "I see that death grip."
- "The handlebars won't save you."

## Intervention Triggers

**HR signals (primary):**
- HR in target zone with lower power than expected → workout is still working, don't push
- HR not rising during hard effort → they're not pushing hard enough, challenge them
- HR/power decoupling (HR climbing, power dropping) → fatigue, end structured work
- Power steady but HR climbing → cardiac drift, consider shortening

**Power signals (secondary):**
- 5-10% above target early → warn they'll fade
- Power dropping rep-over-rep → consider ending intervals
- 10-15% below target → end session, stimulus achieved
- Can't hit target from rep 1 → reassess, don't force

**Third interval rule:** If falling apart at interval 3, end the session. The training stimulus is achieved; continuing adds junk volume.

## Your Response

Every response must include:
- **message**: Short text to display. One line, maybe two. The rider is working hard and can't read paragraphs.
- **target**: Power and cadence targets. Always set both values based on what you want the rider to do right now.

## What You Receive

Periodic metrics updates with:
- power: current watts
- hr: heart rate in bpm
- cadence: rpm
- elapsed: seconds since workout started

## Guidelines

- Always send a message, even if just acknowledging. Short is fine.
- Set targets based on the rider's history. Start easy, build up.
- If the rider can't hold a target, acknowledge it and adjust. No judgment.
- Keep the workout moving. Don't let them rest too long, but don't break them either.
- Recognize when to stop. Never force a failed workout.`;
}

export async function buildSystemPrompt(): Promise<string> {
  const workouts = await loadWorkoutHistory();
  const historyText = synthesizeRiderProfile(workouts);

  // Compute HR zones from max HR observed across all workouts
  const maxHr = getMaxHrFromHistory(workouts);
  const hrZones = maxHr !== null ? calculateHrZones(maxHr) : null;

  // Estimate FTP from workout data
  const estimatedFtp = estimateFtp(workouts);

  return getSystemPrompt(historyText, { hrZones, estimatedFtp });
}

// When run directly, output the prompt
if (import.meta.main) {
  const prompt = await buildSystemPrompt();
  console.log(prompt);
}
