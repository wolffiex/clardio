/**
 * Coach prompt system
 *
 * Split into static (system) and dynamic (user) parts for prompt caching:
 * - Planning: buildPlanningSystemPrompt() + buildPlanningUserPrompt()
 * - Coaching: buildCoachingSystemPrompt() + getZonesText() (zones go in user message)
 *
 * Run scripts/dump-prompt.ts to preview both prompts.
 */

import { getDb, getProductionDb, type PlanRow } from "./db";
import { log } from "./log";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimedPhase = {
  name: string;
  zone: string;
  duration_s: number;
  cadence: string;
  position: string;
  hr_target?: string;
  form_cues?: string[];
};

export type RecoveryPhase = {
  name: string;
  type: "recovery";
  target_hr: number;
  min_duration_s: number;
  max_duration_s: number;
  cadence: string;
  position: string;
};

export type Phase = TimedPhase | RecoveryPhase;

export function isRecoveryPhase(phase: Phase): phase is RecoveryPhase {
  return "type" in phase && (phase as RecoveryPhase).type === "recovery";
}

export type WorkoutPlan = {
  summary: string;
  phases: Phase[];
};

export type CoachResponse = {
  message: string;
  power: number | null;
  note: string | null;
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
        anyOf: [
          {
            type: "object",
            description: "Timed phase with fixed duration",
            properties: {
              name: { type: "string" },
              zone: { type: "string", description: "e.g. Z1, Z2, Z4, Sweet Spot" },
              duration_s: { type: "number", description: "Duration in seconds, minimum 60" },
              cadence: { type: "string", description: "RPM range, e.g. '85-95'" },
              position: { type: "string", description: "seated or standing" },
              hr_target: { type: "string", description: "Informational HR range, e.g. '128-134'" },
              form_cues: {
                type: "array",
                items: { type: "string" },
                description: "Form cues to deliver during this phase",
              },
            },
            required: ["name", "zone", "duration_s", "cadence", "position"],
            additionalProperties: false,
          },
          {
            type: "object",
            description: "Recovery phase that advances when HR drops below target",
            properties: {
              name: { type: "string" },
              type: { type: "string", const: "recovery", description: "Must be 'recovery'" },
              target_hr: { type: "number", description: "Advance when HR drops below this" },
              min_duration_s: { type: "number", description: "Minimum duration in seconds, at least 60" },
              max_duration_s: { type: "number", description: "Maximum duration cap in seconds" },
              cadence: { type: "string", description: "RPM range, e.g. '70-80'" },
              position: { type: "string", description: "Usually 'seated'" },
            },
            required: ["name", "type", "target_hr", "min_duration_s", "max_duration_s", "cadence", "position"],
            additionalProperties: false,
          },
        ],
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
      description: "What to say to the rider. NEVER include specific numbers (no watts, BPM, RPM, percentages, zone numbers, or time durations).",
    },
    power: {
      type: ["number", "null"],
      description: "Target power in watts, or null to keep current target",
    },
    note: {
      type: ["string", "null"],
      description:
        "Optional internal note about workout trajectory. Not shown to rider. Use for observations about fatigue, HR trends, plan adjustments. Only write when something meaningful changes.",
    },
  },
  required: ["message", "power", "note"],
  additionalProperties: false,
} as const;

// Keep backward compat -- old code imports responseSchema
export const responseSchema = coachSchema;

// ---------------------------------------------------------------------------
// Structured zone power ranges (for cross-referencing in user messages)
// ---------------------------------------------------------------------------

export type ZonePowerRange = { min: number; max: number };

/**
 * Return a map of zone name -> power range in watts.
 * Uses cached FTP from DB history (or default for new riders).
 * Keys: "Z1", "Z2", "Z3", "Z4", "Z5", "Sweet Spot"
 */
export function getZonePowerRanges(): Record<string, ZonePowerRange> | null {
  const { zones } = loadRiderData();
  if (zones.estimatedFtp === null) return null;
  const ftp = zones.estimatedFtp;
  return {
    "Z1": { min: 0, max: Math.round(ftp * 0.55) - 1 },
    "Z2": { min: Math.round(ftp * 0.55), max: Math.round(ftp * 0.75) },
    "Z3": { min: Math.round(ftp * 0.76), max: Math.round(ftp * 0.90) },
    "Z4": { min: Math.round(ftp * 0.91), max: Math.round(ftp * 1.05) },
    "Z5": { min: Math.round(ftp * 1.06), max: Math.round(ftp * 1.20) },
    "Sweet Spot": { min: Math.round(ftp * 0.88), max: Math.round(ftp * 0.94) },
  };
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

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

interface PercentileStats {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

function calculatePercentileStats(values: number[]): PercentileStats | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  return {
    p25: Math.round(percentile(sorted, 25)),
    p50: Math.round(percentile(sorted, 50)),
    p75: Math.round(percentile(sorted, 75)),
    p95: Math.round(percentile(sorted, 95)),
  };
}

/**
 * Calculate normalized power from power samples.
 * Uses 30-second rolling average, raised to 4th power, averaged, then 4th root.
 * sampleIntervalSec is the time each sample represents.
 */
function calculateNormalizedPower(
  powerValues: number[],
  sampleIntervalSec: number
): number | null {
  const windowSamples = Math.round(30 / sampleIntervalSec);
  if (powerValues.length < windowSamples) return null;

  const rollingAvgs: number[] = [];
  for (let i = windowSamples - 1; i < powerValues.length; i++) {
    let sum = 0;
    for (let j = i - windowSamples + 1; j <= i; j++) {
      sum += powerValues[j];
    }
    rollingAvgs.push(sum / windowSamples);
  }

  if (rollingAvgs.length === 0) return null;

  const avgFourthPower =
    rollingAvgs.reduce((sum, v) => sum + Math.pow(v, 4), 0) /
    rollingAvgs.length;
  return Math.pow(avgFourthPower, 0.25);
}

// ---------------------------------------------------------------------------
// DB-based workout summary
// ---------------------------------------------------------------------------

interface SessionSummary {
  planId: number;
  date: Date;
  planSummary: string | null;
  durationMinutes: number;
  avgPower: number;
  maxPower: number;
  normalizedPower: number | null;
  avgHr: number;
  maxHr: number;
  avgCadence: number;
  powerStats: PercentileStats | null;
  hrStats: PercentileStats | null;
  cadenceStats: PercentileStats | null;
  efficiencyFactor: number | null;
  variabilityIndex: number | null;
}

type SampleRow = {
  timestamp_ms: number;
  duration_ms: number;
  power: number | null;
  hr: number | null;
  cadence: number | null;
};

function summarizeSession(plan: PlanRow, samples: SampleRow[]): SessionSummary | null {
  if (samples.length === 0) return null;

  const powerValues = samples
    .map((s) => s.power)
    .filter((v): v is number => v !== null && v > 0);
  const hrValues = samples
    .map((s) => s.hr)
    .filter((v): v is number => v !== null && v > 0);
  const cadenceValues = samples
    .map((s) => s.cadence)
    .filter((v): v is number => v !== null && v > 0);

  // Total duration from samples
  const totalMs = samples.reduce((sum, s) => sum + s.duration_ms, 0);
  const durationMinutes = Math.round(totalMs / 60000);

  if (durationMinutes < 1) return null;

  const avgPower =
    powerValues.length > 0
      ? Math.round(powerValues.reduce((s, v) => s + v, 0) / powerValues.length)
      : 0;
  const maxPower =
    powerValues.length > 0 ? Math.max(...powerValues) : 0;
  const avgHr =
    hrValues.length > 0
      ? Math.round(hrValues.reduce((s, v) => s + v, 0) / hrValues.length)
      : 0;
  const maxHr =
    hrValues.length > 0 ? Math.max(...hrValues) : 0;
  const avgCadence =
    cadenceValues.length > 0
      ? Math.round(cadenceValues.reduce((s, v) => s + v, 0) / cadenceValues.length)
      : 0;

  // Typical sample interval in seconds
  const sampleIntervalSec =
    samples.length > 0
      ? samples.reduce((s, r) => s + r.duration_ms, 0) / samples.length / 1000
      : 3;

  const np = calculateNormalizedPower(powerValues, sampleIntervalSec);
  const efficiencyFactor = np && avgHr > 0 ? np / avgHr : null;
  const variabilityIndex = np && avgPower > 0 ? np / avgPower : null;

  return {
    planId: plan.id,
    date: new Date(plan.created_at + "Z"),
    planSummary: plan.summary,
    durationMinutes,
    avgPower,
    maxPower,
    normalizedPower: np,
    avgHr,
    maxHr,
    avgCadence,
    powerStats: calculatePercentileStats(powerValues),
    hrStats: calculatePercentileStats(hrValues),
    cadenceStats: calculatePercentileStats(cadenceValues),
    efficiencyFactor,
    variabilityIndex,
  };
}

export function loadSessionsFromDb(): SessionSummary[] {
  const db = getDb();

  // Prefer production DB for rider profile -- real rides live there.
  // Only fall back to current (dev) DB if production has no sessions.
  let plans: PlanRow[] = [];
  let useDb = db;

  try {
    const prodDb = getProductionDb();
    const prodPlans = prodDb
      .query(
        `SELECT p.* FROM plans p
         WHERE EXISTS (SELECT 1 FROM samples s WHERE s.plan_id = p.id)
         ORDER BY p.created_at ASC`
      )
      .all() as PlanRow[];

    if (prodPlans.length > 0) {
      log("[coach] Using production DB for rider profile");
      plans = prodPlans;
      useDb = prodDb;
    } else {
      prodDb.close();
    }
  } catch {
    // Production DB may not exist; that's fine
  }

  // Fall back to current DB if production had no sessions
  if (plans.length === 0) {
    plans = db
      .query(
        `SELECT p.* FROM plans p
         WHERE EXISTS (SELECT 1 FROM samples s WHERE s.plan_id = p.id)
         ORDER BY p.created_at ASC`
      )
      .all() as PlanRow[];

    if (plans.length > 0) {
      log("[coach] Using dev DB for rider profile (no production data)");
    }
  }

  const sessions: SessionSummary[] = [];
  for (const plan of plans) {
    const samples = useDb
      .query(
        "SELECT timestamp_ms, duration_ms, power, hr, cadence FROM samples WHERE plan_id = ? ORDER BY timestamp_ms"
      )
      .all(plan.id) as SampleRow[];

    const summary = summarizeSession(plan, samples);
    if (summary) {
      sessions.push(summary);
    }
  }

  // Close prod DB if we opened one
  if (useDb !== db) {
    try {
      useDb.close();
    } catch {}
  }

  return sessions;
}

// ---------------------------------------------------------------------------
// Rider profile synthesis from DB
// ---------------------------------------------------------------------------

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );
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

function formatEffortLevel(
  powerLow: number,
  powerHigh: number,
  hrLow?: number,
  hrHigh?: number
): string {
  const powerRange = `${powerLow}-${powerHigh}W`;
  if (
    hrLow !== undefined &&
    hrHigh !== undefined &&
    hrLow > 0 &&
    hrHigh > 0
  ) {
    return `${powerRange} @ ${hrLow}-${hrHigh} HR`;
  }
  return powerRange;
}

function calculateWeeksSpan(sessions: SessionSummary[]): number {
  if (sessions.length < 2) return 0;
  const earliest = sessions[0].date;
  const latest = sessions[sessions.length - 1].date;
  const diffMs = latest.getTime() - earliest.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24 * 7));
}

/**
 * Compute the best rolling-average power over a given window for a single plan's samples.
 * Returns the maximum rolling average found, or null if not enough data.
 * Uses duration-weighted averaging to handle irregular sample intervals.
 */
function bestRollingAvgPower(
  samples: SampleRow[],
  windowMs: number
): number | null {
  // Filter to samples with valid power
  const valid = samples.filter((s) => s.power !== null && s.power > 0);
  if (valid.length === 0) return null;

  // Check if we have enough total duration
  const totalMs = valid.reduce((sum, s) => sum + s.duration_ms, 0);
  if (totalMs < windowMs) return null;

  // Sliding window using cumulative time
  let best = 0;
  let windowPowerSum = 0;
  let windowDurationMs = 0;
  let left = 0;

  for (let right = 0; right < valid.length; right++) {
    windowPowerSum += valid[right].power! * valid[right].duration_ms;
    windowDurationMs += valid[right].duration_ms;

    // Shrink window from left while it exceeds the target
    while (windowDurationMs - valid[left].duration_ms >= windowMs) {
      windowPowerSum -= valid[left].power! * valid[left].duration_ms;
      windowDurationMs -= valid[left].duration_ms;
      left++;
    }

    // Only consider windows that span at least windowMs
    if (windowDurationMs >= windowMs) {
      const avg = windowPowerSum / windowDurationMs;
      if (avg > best) best = avg;
    }
  }

  return best > 0 ? best : null;
}

/**
 * Load raw samples per plan from the DB for rolling-average FTP computation.
 * Prefers production DB (real rides), falls back to current DB.
 */
function loadRawSamplesPerPlan(): Map<number, SampleRow[]> {
  const db = getDb();

  // Prefer production DB for FTP calculation -- real rides live there.
  // Only fall back to current (dev) DB if production has no sessions.
  let planIds: { id: number }[] = [];
  let useDb = db;

  try {
    const prodDb = getProductionDb();
    const prodPlanIds = prodDb
      .query(
        `SELECT DISTINCT p.id FROM plans p
         WHERE EXISTS (SELECT 1 FROM samples s WHERE s.plan_id = p.id)
         ORDER BY p.id`
      )
      .all() as { id: number }[];

    if (prodPlanIds.length > 0) {
      planIds = prodPlanIds;
      useDb = prodDb;
    } else {
      prodDb.close();
    }
  } catch {
    // Production DB may not exist
  }

  // Fall back to current DB if production had no sessions
  if (planIds.length === 0) {
    planIds = db
      .query(
        `SELECT DISTINCT p.id FROM plans p
         WHERE EXISTS (SELECT 1 FROM samples s WHERE s.plan_id = p.id)
         ORDER BY p.id`
      )
      .all() as { id: number }[];
  }

  const result = new Map<number, SampleRow[]>();
  for (const { id } of planIds) {
    const samples = useDb
      .query(
        "SELECT timestamp_ms, duration_ms, power, hr, cadence FROM samples WHERE plan_id = ? ORDER BY timestamp_ms"
      )
      .all(id) as SampleRow[];
    result.set(id, samples);
  }

  if (useDb !== db) {
    try {
      useDb.close();
    } catch {}
  }

  return result;
}

function estimateFtpFromSessions(sessions: SessionSummary[]): number | null {
  // Try rolling-average best-effort methods first
  const samplesPerPlan = loadRawSamplesPerPlan();

  let best5min: number | null = null;
  let best20min: number | null = null;

  for (const [, samples] of samplesPerPlan) {
    const avg5 = bestRollingAvgPower(samples, 5 * 60 * 1000);
    if (avg5 !== null && (best5min === null || avg5 > best5min)) {
      best5min = avg5;
    }

    const avg20 = bestRollingAvgPower(samples, 20 * 60 * 1000);
    if (avg20 !== null && (best20min === null || avg20 > best20min)) {
      best20min = avg20;
    }
  }

  // FTP = max of (best 20-min x 0.95) and (best 5-min x 0.75)
  const candidates: number[] = [];
  if (best20min !== null) candidates.push(best20min * 0.95);
  if (best5min !== null) candidates.push(best5min * 0.75);

  if (candidates.length > 0) {
    return Math.round(Math.max(...candidates));
  }

  // Fallback: old p95 x 0.75 method
  const sessionsWithPower = sessions.filter((s) => s.powerStats !== null);
  if (sessionsWithPower.length > 0) {
    const p95Values = sessionsWithPower.map((s) => s.powerStats!.p95);
    const maxP95 = Math.max(...p95Values);
    return Math.round(maxP95 * 0.75);
  }

  return null;
}

function getMaxHrFromSessions(sessions: SessionSummary[]): number | null {
  const maxHrs = sessions.map((s) => s.maxHr).filter((hr) => hr > 0);
  if (maxHrs.length === 0) return null;
  return Math.max(...maxHrs);
}

export function buildRiderProfileFromDb(): string {
  const sessions = loadSessionsFromDb();

  if (sessions.length === 0) {
    return "New rider -- no history available.";
  }

  const lines: string[] = [];
  const weeksSpan = calculateWeeksSpan(sessions);
  const weeksText =
    weeksSpan > 0
      ? ` over ${weeksSpan} week${weeksSpan > 1 ? "s" : ""}`
      : "";

  lines.push(
    `## Rider Profile (from ${sessions.length} session${sessions.length > 1 ? "s" : ""}${weeksText})`
  );
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

  for (const s of sessions) {
    if (s.powerStats) {
      allP25.push(s.powerStats.p25);
      allP50.push(s.powerStats.p50);
      allP75.push(s.powerStats.p75);
      allP95.push(s.powerStats.p95);
    }
    if (s.hrStats) {
      allHrP25.push(s.hrStats.p25);
      allHrP50.push(s.hrStats.p50);
      allHrP75.push(s.hrStats.p75);
      allHrP95.push(s.hrStats.p95);
    }
  }

  const maxPowerEver = Math.max(...sessions.map((s) => s.maxPower));

  if (allP25.length > 0) {
    lines.push("Power Capabilities:");

    const easyLow = Math.min(...allP25);
    const easyHigh = Math.max(...allP25);
    lines.push(`- Easy spinning: ${easyLow}-${easyHigh}W`);

    const enduranceLow = Math.min(...allP50);
    const enduranceHigh = Math.max(...allP50);
    const enduranceHrLow =
      allHrP50.length > 0 ? Math.min(...allHrP50) : undefined;
    const enduranceHrHigh =
      allHrP50.length > 0 ? Math.max(...allHrP50) : undefined;
    lines.push(
      `- Endurance effort: ${formatEffortLevel(enduranceLow, enduranceHigh, enduranceHrLow, enduranceHrHigh)}`
    );

    const tempoLow = Math.min(...allP75);
    const tempoHigh = Math.max(...allP75);
    const tempoHrLow =
      allHrP75.length > 0 ? Math.min(...allHrP75) : undefined;
    const tempoHrHigh =
      allHrP75.length > 0 ? Math.max(...allHrP75) : undefined;
    lines.push(
      `- Tempo effort: ${formatEffortLevel(tempoLow, tempoHigh, tempoHrLow, tempoHrHigh)}`
    );

    const hardLow = Math.min(...allP95);
    const hardHigh = Math.max(...allP95);
    const hardHrLow =
      allHrP95.length > 0 ? Math.min(...allHrP95) : undefined;
    const hardHrHigh =
      allHrP95.length > 0 ? Math.max(...allHrP95) : undefined;
    lines.push(
      `- Hard efforts: ${formatEffortLevel(hardLow, hardHigh, hardHrLow, hardHrHigh)}`
    );

    lines.push(`- Peak observed: ${maxPowerEver}W`);
    lines.push("");
  }

  // --- Aerobic Fitness ---
  const efValues = sessions
    .map((s) => s.efficiencyFactor)
    .filter((ef): ef is number => ef !== null);

  if (efValues.length > 0) {
    lines.push("Aerobic Fitness:");

    const efMin = Math.min(...efValues);
    const efMax = Math.max(...efValues);
    const efLevel = getEfLevel((efMin + efMax) / 2);
    lines.push(
      `- EF range: ${efMin.toFixed(1)}-${efMax.toFixed(1)} (${efLevel} level)`
    );

    const steadySessions = sessions.filter(
      (s) => s.variabilityIndex !== null && s.variabilityIndex < 1.1
    );
    if (steadySessions.length > 0) {
      const avgSteadyDuration = Math.round(
        steadySessions.reduce((sum, s) => sum + s.durationMinutes, 0) /
          steadySessions.length
      );
      lines.push(`- Handles ${avgSteadyDuration}min steady efforts`);
    }

    lines.push("");
  }

  // --- Observed Patterns ---
  lines.push("Observed Patterns:");

  const durations = sessions.map((s) => s.durationMinutes);
  const minDuration = Math.min(...durations);
  const maxDuration = Math.max(...durations);
  if (minDuration === maxDuration) {
    lines.push(`- Typical session: ${minDuration}min`);
  } else {
    lines.push(`- Typical session: ${minDuration}-${maxDuration}min`);
  }

  const allCadenceP25: number[] = [];
  const allCadenceP75: number[] = [];
  for (const s of sessions) {
    if (s.cadenceStats) {
      allCadenceP25.push(s.cadenceStats.p25);
      allCadenceP75.push(s.cadenceStats.p75);
    }
  }
  if (allCadenceP25.length > 0) {
    const cadenceLow = Math.min(...allCadenceP25);
    const cadenceHigh = Math.max(...allCadenceP75);
    lines.push(`- Cadence: ${cadenceLow}-${cadenceHigh} rpm`);
  }

  lines.push("");

  // --- Recent Load ---
  lines.push("Recent Load:");

  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const sessionsLastWeek = sessions.filter((s) => s.date >= oneWeekAgo);
  const sessionsLast2Weeks = sessions.filter((s) => s.date >= twoWeeksAgo);
  lines.push(
    `- ${sessionsLastWeek.length} session${sessionsLastWeek.length !== 1 ? "s" : ""} in past week, ${sessionsLast2Weeks.length} in past 2 weeks`
  );

  const lastSession = sessions[sessions.length - 1];
  lines.push(`- Last workout: ${formatRelativeTime(lastSession.date)}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Training zones
// ---------------------------------------------------------------------------

export interface HrZones {
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
  const lthr = Math.round(maxHr * 0.89);
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
 * Return a zone label for a given HR value, e.g. "Z3 Tempo".
 */
export function getHrZoneLabel(hr: number, hrZones: HrZones): string {
  if (hr >= hrZones.z5Min) return "Z5 VO2max";
  if (hr >= hrZones.z4Min) return "Z4 Threshold";
  if (hr >= hrZones.z3Min) return "Z3 Tempo";
  if (hr >= hrZones.z2Min) return "Z2 Endurance";
  return "Z1 Recovery";
}

function formatHrZones(zones: HrZones): string {
  return `HR Zones (LTHR ${zones.lthr}, max ${zones.maxHr}):
- Z1 Recovery: <${zones.z1Max + 1} bpm
- Z2 Endurance: ${zones.z2Min}-${zones.z2Max} bpm
- Z3 Tempo: ${zones.z3Min}-${zones.z3Max} bpm
- Z4 Threshold: ${zones.z4Min}-${zones.z4Max} bpm
- Z5 VO2max: ${zones.z5Min}-${zones.maxHr} bpm`;
}

interface TrainingZonesConfig {
  hrZones: HrZones | null;
  estimatedFtp: number | null;
  isDefault: boolean;
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
 * Planning-specific training zones: HR zones only (no power zones).
 * The planner prescribes effort via HR zones, not power.
 */
function generatePlanningZonesSection(config: TrainingZonesConfig): string {
  const lines: string[] = [];
  if (config.isDefault) {
    lines.push("## Training Zones (estimated defaults -- will update from workout data)");
  } else {
    lines.push("## Training Zones");
  }
  lines.push("");

  if (config.hrZones !== null) {
    lines.push(formatHrZones(config.hrZones));
  } else {
    lines.push(formatHrZonesGeneric());
  }

  return lines.join("\n");
}

function generateCompactZones(config: TrainingZonesConfig): string {
  const defaultTag = config.isDefault ? " (estimated defaults)" : "";

  // Single line: FTP as reference point + HR zones
  if (config.hrZones !== null) {
    const z = config.hrZones;
    const ftpPart = config.estimatedFtp !== null
      ? `Estimated FTP: ~${config.estimatedFtp}W | `
      : "";
    return `${ftpPart}LTHR: ${z.lthr}${defaultTag} | Z1 <${z.z1Max + 1} | Z2 ${z.z2Min}-${z.z2Max} | Z3 ${z.z3Min}-${z.z3Max} | Z4 ${z.z4Min}-${z.z4Max} | Z5 ${z.z5Min}-${z.maxHr}`;
  }

  // Fallback: no HR zones available
  const ftpPart = config.estimatedFtp !== null
    ? `Estimated FTP: ~${config.estimatedFtp}W | `
    : "";
  return `${ftpPart}HR zones unavailable (no workout data with HR)`;
}

// ---------------------------------------------------------------------------
// Session trend analysis
// ---------------------------------------------------------------------------

/**
 * Format a date as "Mon DD" (e.g. "Feb 10").
 */
function formatShortDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Build detailed session trend analysis for the planning prompt.
 */
export function buildSessionTrendsSection(sessions: SessionSummary[]): string {
  if (sessions.length < 2) return "";

  const lines: string[] = [];
  lines.push("## Session Trends");
  lines.push("");

  // (a) EF trend
  const efEntries = sessions
    .filter((s) => s.efficiencyFactor !== null)
    .map((s) => ({ ef: s.efficiencyFactor!, date: s.date }));

  if (efEntries.length >= 2) {
    const efParts = efEntries.map(
      (e) => `${e.ef.toFixed(2)} (${formatShortDate(e.date)})`
    );
    const first = efEntries[0].ef;
    const last = efEntries[efEntries.length - 1].ef;
    const trend =
      last > first + 0.02
        ? "trending up"
        : last < first - 0.02
          ? "trending down"
          : "stable";
    lines.push(`EF trend: ${efParts.join(" -> ")} -- ${trend}`);
    lines.push("");
  }

  // (b) FTP trend (rolling-average based, per session)
  const samplesPerPlan = loadRawSamplesPerPlan();
  const ftpEntries: { ftp: number; date: Date }[] = [];
  for (const s of sessions) {
    const samples = samplesPerPlan.get(s.planId);
    if (!samples) continue;
    const best5 = bestRollingAvgPower(samples, 5 * 60 * 1000);
    if (best5 !== null) {
      ftpEntries.push({ ftp: Math.round(best5 * 0.75), date: s.date });
    }
  }
  if (ftpEntries.length >= 2) {
    const ftpParts = ftpEntries.map(
      (e) => `~${e.ftp}W (${formatShortDate(e.date)})`
    );
    const first = ftpEntries[0].ftp;
    const last = ftpEntries[ftpEntries.length - 1].ftp;
    const trend =
      last > first + 5
        ? "improving"
        : last < first - 5
          ? "declining"
          : "stable";
    lines.push(`FTP trend: ${ftpParts.join(" -> ")} -- ${trend}`);
    lines.push("");
  }

  // (c) Recovery quality -- compare HR recovery patterns from coach_ticks
  try {
    const db = getDb();
    const recoveryData: { planId: number; avgRecoveryHr: number }[] = [];
    for (const s of sessions) {
      const ticks = db
        .query(
          "SELECT response_power FROM coach_ticks WHERE plan_id = ? AND response_power IS NOT NULL ORDER BY elapsed_s"
        )
        .all(s.planId) as { response_power: number }[];
      const recoveryThreshold = s.avgPower * 0.55;
      const recoveryTicks = ticks.filter(
        (t) => t.response_power > 0 && t.response_power < recoveryThreshold
      );
      if (recoveryTicks.length > 0 && s.hrStats) {
        recoveryData.push({ planId: s.planId, avgRecoveryHr: s.hrStats.p25 });
      }
    }
    if (recoveryData.length >= 2) {
      const first = recoveryData[0].avgRecoveryHr;
      const last = recoveryData[recoveryData.length - 1].avgRecoveryHr;
      if (last < first - 3) {
        lines.push("Recovery: HR recovers faster in recent sessions -- good sign.");
      } else if (last > first + 3) {
        lines.push(
          "Recovery: HR recovery slower in recent sessions -- possible accumulated fatigue."
        );
      }
      lines.push("");
    }
  } catch {
    // coach_ticks table may not exist in all DBs
  }

  // (d) Warmup HR comparison -- avg HR in first 5 minutes across sessions
  const warmupHrs: { hr: number; date: Date }[] = [];
  for (const s of sessions) {
    const samples = samplesPerPlan.get(s.planId);
    if (!samples || samples.length === 0) continue;
    const firstTs = samples[0].timestamp_ms;
    const warmupSamples = samples.filter(
      (sample) =>
        sample.timestamp_ms - firstTs < 300_000 &&
        sample.hr !== null &&
        sample.hr > 0
    );
    if (warmupSamples.length > 0) {
      const avgWarmupHr = Math.round(
        warmupSamples.reduce((sum, sample) => sum + sample.hr!, 0) /
          warmupSamples.length
      );
      warmupHrs.push({ hr: avgWarmupHr, date: s.date });
    }
  }
  if (warmupHrs.length >= 2) {
    const first = warmupHrs[0].hr;
    const last = warmupHrs[warmupHrs.length - 1].hr;
    const warmupParts = warmupHrs.map(
      (w) => `${w.hr} (${formatShortDate(w.date)})`
    );
    let warmupNote = "";
    if (last > first + 5) {
      warmupNote = " -- rising warmup HR, possible overtraining";
    } else if (last < first - 5) {
      warmupNote = " -- lower warmup HR, improving fitness";
    }
    lines.push(`Warmup HR (first 5 min): ${warmupParts.join(" -> ")}${warmupNote}`);
    lines.push("");
  }

  // (e) Per-zone performance -- analyze samples against plan phases
  const zonePerf: Record<
    string,
    { powers: number[]; hrs: number[]; sessionCount: Set<number> }
  > = {};

  for (const s of sessions) {
    const samples = samplesPerPlan.get(s.planId);
    if (!samples || samples.length === 0 || s.avgPower === 0) continue;

    // Load plan phases to map time -> zone
    let planPhases: Phase[] | null = null;
    try {
      const db = getDb();
      const planRow = db
        .query("SELECT phases FROM plans WHERE id = ?")
        .get(s.planId) as { phases: string } | null;
      if (!planRow) {
        try {
          const prodDb = getProductionDb();
          const prodRow = prodDb
            .query("SELECT phases FROM plans WHERE id = ?")
            .get(s.planId) as { phases: string } | null;
          if (prodRow) planPhases = JSON.parse(prodRow.phases) as Phase[];
          prodDb.close();
        } catch {}
      } else {
        planPhases = JSON.parse(planRow.phases) as Phase[];
      }
    } catch {}

    if (!planPhases) continue;

    // Build a time-to-zone map from phases
    const firstTs = samples[0].timestamp_ms;
    let phaseStartMs = 0;
    const timeZoneMap: { startMs: number; endMs: number; zone: string }[] = [];

    for (const phase of planPhases) {
      const durationMs = isRecoveryPhase(phase)
        ? phase.max_duration_s * 1000
        : phase.duration_s * 1000;
      const zone = isRecoveryPhase(phase) ? "Z1" : phase.zone;
      timeZoneMap.push({
        startMs: phaseStartMs,
        endMs: phaseStartMs + durationMs,
        zone,
      });
      phaseStartMs += durationMs;
    }

    // Map each sample to its zone
    for (const sample of samples) {
      const elapsedMs = sample.timestamp_ms - firstTs;
      const phaseEntry = timeZoneMap.find(
        (tz) => elapsedMs >= tz.startMs && elapsedMs < tz.endMs
      );
      if (!phaseEntry) continue;

      const zone = phaseEntry.zone;
      if (!zonePerf[zone]) {
        zonePerf[zone] = { powers: [], hrs: [], sessionCount: new Set() };
      }
      if (sample.power !== null && sample.power > 0) {
        zonePerf[zone].powers.push(sample.power);
      }
      if (sample.hr !== null && sample.hr > 0) {
        zonePerf[zone].hrs.push(sample.hr);
      }
      zonePerf[zone].sessionCount.add(s.planId);
    }
  }

  const zoneOrder = ["Z1", "Z2", "Z3", "Sweet Spot", "Z4", "Z5"];
  const zoneLines: string[] = [];
  for (const zone of zoneOrder) {
    const perf = zonePerf[zone];
    if (!perf || perf.powers.length < 5) continue;

    const sortedPower = [...perf.powers].sort((a, b) => a - b);
    const pLow = Math.round(percentile(sortedPower, 25));
    const pHigh = Math.round(percentile(sortedPower, 75));
    const sessionCount = perf.sessionCount.size;

    let hrPart = "";
    if (perf.hrs.length >= 5) {
      const sortedHr = [...perf.hrs].sort((a, b) => a - b);
      const hrLow = Math.round(percentile(sortedHr, 25));
      const hrHigh = Math.round(percentile(sortedHr, 75));
      hrPart = ` @ ${hrLow}-${hrHigh} HR`;
    }

    zoneLines.push(
      `  ${zone}: ${pLow}-${pHigh}W${hrPart} (${sessionCount} session${sessionCount > 1 ? "s" : ""})`
    );
  }

  if (zoneLines.length > 0) {
    lines.push("Typical performance by zone:");
    lines.push(...zoneLines);
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Compact trends for inclusion in per-tick coaching messages (3-4 lines max).
 */
export function buildCompactTrends(sessions: SessionSummary[]): string {
  if (sessions.length < 2) return "";

  const lines: string[] = [];

  // EF trend (one line)
  const efEntries = sessions
    .filter((s) => s.efficiencyFactor !== null)
    .map((s) => ({ ef: s.efficiencyFactor!, date: s.date }));

  if (efEntries.length >= 2) {
    const first = efEntries[0].ef;
    const last = efEntries[efEntries.length - 1].ef;
    const trend =
      last > first + 0.02
        ? "up"
        : last < first - 0.02
          ? "down"
          : "stable";
    lines.push(`EF: ${first.toFixed(2)} -> ${last.toFixed(2)} (${trend})`);
  }

  // Warmup HR trend (one line)
  const samplesPerPlan = loadRawSamplesPerPlan();
  const warmupHrs: number[] = [];
  for (const s of sessions) {
    const samples = samplesPerPlan.get(s.planId);
    if (!samples || samples.length === 0) continue;
    const firstTs = samples[0].timestamp_ms;
    const warmupSamples = samples.filter(
      (sample) =>
        sample.timestamp_ms - firstTs < 300_000 &&
        sample.hr !== null &&
        sample.hr > 0
    );
    if (warmupSamples.length > 0) {
      warmupHrs.push(
        Math.round(
          warmupSamples.reduce((sum, sample) => sum + sample.hr!, 0) /
            warmupSamples.length
        )
      );
    }
  }
  if (warmupHrs.length >= 2) {
    const first = warmupHrs[0];
    const last = warmupHrs[warmupHrs.length - 1];
    if (Math.abs(last - first) > 3) {
      lines.push(
        `Warmup HR: ${first} -> ${last}${last > first + 5 ? " (watch fatigue)" : ""}`
      );
    }
  }

  // FTP estimate trend (one line)
  const ftpEntries: number[] = [];
  for (const s of sessions) {
    const samples = samplesPerPlan.get(s.planId);
    if (!samples) continue;
    const best5 = bestRollingAvgPower(samples, 5 * 60 * 1000);
    if (best5 !== null) ftpEntries.push(Math.round(best5 * 0.75));
  }
  if (ftpEntries.length >= 2) {
    const first = ftpEntries[0];
    const last = ftpEntries[ftpEntries.length - 1];
    if (Math.abs(last - first) > 3) {
      lines.push(`FTP est: ~${first}W -> ~${last}W`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Shared data loader
// ---------------------------------------------------------------------------

// Cold-start fallback values for riders with zero session history.
// Only used when there is NO observed data at all.
const COLD_START_MAX_HR = 170;
const COLD_START_FTP = 200;

export function loadRiderData(): {
  riderProfile: string;
  zones: TrainingZonesConfig;
} {
  const sessions = loadSessionsFromDb();
  const riderProfile = buildRiderProfileFromDb();

  // Compute zones from DB data; cold-start fallbacks only when no data exists
  const maxHr = getMaxHrFromSessions(sessions);
  const ftpEstimate = estimateFtpFromSessions(sessions);

  const hasDbData = maxHr !== null || ftpEstimate !== null;

  const hrZones = calculateHrZones(maxHr ?? COLD_START_MAX_HR);
  const estimatedFtp = ftpEstimate ?? COLD_START_FTP;

  return {
    riderProfile,
    zones: { hrZones, estimatedFtp, isDefault: !hasDbData },
  };
}

// ---------------------------------------------------------------------------
// Planning prompt — static system + dynamic user
// ---------------------------------------------------------------------------

/**
 * Static planning system prompt. Never changes between calls.
 * Contains workout structure, interval formats, cadence ranges, form cues, etc.
 */
export function buildPlanningSystemPrompt(): string {
  return `You are a cycling workout planner. Design a single 45-minute indoor cycling workout.

## Your Role vs The Coach

You design the STRUCTURE: phases, zones, cadence, position, form cues, HR targets. You do NOT set power targets. The coach decides power in real-time based on the rider's HR response and the zone you specify.

## Phase Types

### Timed Phases
Fixed-duration phases with a target zone. Duration in seconds (minimum 60s).

### Recovery Phases
HR-gated recovery between hard efforts. They advance when:
1. At least min_duration_s has elapsed, AND
2. HR has dropped below target_hr
3. OR max_duration_s has been reached (forced advance)

Recovery phases should follow hard efforts. Set target_hr based on the preceding effort -- typically 10-15 bpm below LTHR for short recovery, or below Z2 ceiling for full recovery. min_duration_s should be at least 60s.

## Polarized Training Principle

80% easy, 20% hard. Avoid the gray zone (Z3/Tempo).

- Easy work (Z1-Z2): keep HR low. Volume without stress.
- Hard work (Z4-Z5): HR should climb to target zone. Short, purposeful efforts.
- Z3 Tempo: feels productive but accumulates fatigue without proportional benefit. Use sparingly.

If the rider cannot hit hard targets, simplify. Drop to endurance pace with occasional light surges. Keep them moving.

## Workout Structure

45-minute template: 10-15 min warmup, 20-25 min main set, 5-10 min cooldown.

### Warmup Protocol
1. Z1 easy spinning (5 min)
2. Build to Z2 (5-10 min)
3. 1-2 minute opener efforts to prime the legs
4. Brief recovery before main set

### Final Recovery Phase
End the workout with a recovery phase for cooling down. Set the target_hr low enough to indicate full recovery (e.g., below 110-120 bpm). Do not include a separate cooldown phase after the recovery -- the recovery IS the cooldown. The last phase of every plan must be a recovery phase. The workout continues until the rider disconnects.

## Interval Formats

### High-Intensity Intervals
| Format | Work | Rest | Reps | Sets | Total Work |
|--------|------|------|------|------|------------|
| Norwegian 4x4 | 4 min @ 85-95% HRmax | 3 min | 4 | 1 | 16 min |

### Threshold Intervals
| Format | Work | Rest | Reps | Notes |
|--------|------|------|------|-------|
| Sweet Spot | 20 min @ upper Z3/lower Z4 HR | 5-10 min | 2 | Core threshold workout |
| Over-Unders | 2 min above LTHR / 2 min just below LTHR | - | 10-20 min blocks | Teaches lactate management |
| Tempo Blocks | 15-20 min @ Z3 HR | 5 min | 2-3 | Gray zone -- use sparingly |

### Cadence Ranges by Effort
| Effort | Cadence |
|--------|---------|
| Endurance | 70-90 RPM |
| Threshold | 85-95 RPM |
| High-cadence drills | 95-110 RPM |
| Climbing | 60-80 RPM |

## Position Variety

Include standing efforts during appropriate phases (surges, climbing intervals, transitions). Alternate between seated and standing to reduce fatigue and add variety. Standing efforts work well for:
- Power surges and climbing intervals (1-2 minutes)
- Low-cadence strength efforts
- Transitions between effort levels

## Form Cues

Include 2-4 form cues per phase. Be specific and varied — avoid repeating the same cues across phases. Examples include but are not limited to:

**Posture:** drop shoulders away from ears, unclench jaw, long spine tall through crown, soft elbows slightly bent, light hands relaxed grip, hips back on saddle, sit bones centered, stack shoulders over hips, hinge from hip crease not waist, neutral wrist position, tuck chin slightly, engage lats to stabilize upper body

**Breathing:** deep belly breaths expand on inhale, exhale on the downstroke, rhythmic breathing matched to cadence, nasal breathing during recovery, exhale through pursed lips at high intensity, box breathing during recovery (inhale-hold-exhale-hold)

**Pedaling:** smooth circles not pistons, pull through at 6 o'clock, drop heels at bottom of stroke, quiet hips no rocking, knees tracking straight forward, weight through big toe, lighten the dead spot at top, scrape mud off shoe at bottom, push knees slightly inward

**Standing:** shift weight back as you rise, lead with hips not shoulders, let arms absorb the bike motion, light grip let the bike sway naturally, drive forward with hips each stroke

**Fatigue management:** if shoulders creep up reset them, check jaw tension and release, wiggle fingers to release grip, shift hand position on bars, stand briefly to reset posture, shake out one hand then the other

**Recovery:** shake out hands one at a time, roll neck gently side to side, unclench everything — jaw hands shoulders, deep slow breaths let HR settle

Vary your selections across phases and across workouts. Do not default to the same set every time.

Time cues appropriately: recovery intervals (mental bandwidth available), ragged effort (bouncing, power fluctuating), periodic reminders. Never during max efforts.

## Instructions

Every phase must be at least 60 seconds. The coach adjusts power every 10 seconds based on HR response. Phases must be at least 60 seconds so the coach has time to observe HR and adjust. The coach cannot prescribe micro-intervals within a phase (e.g. '10s sprint + 50s recovery'). Every phase must have ONE consistent effort level. If you want variety, use separate phases -- each at least 60 seconds. Standing efforts, cadence changes, and intensity changes should each be their own phase.

Design a 45-minute workout. Vary the format from previous plans shown above. Specify zones (not power targets), cadence ranges, position, and form cues for each phase. Use recovery phases after hard efforts with appropriate HR targets.`;
}

/**
 * Dynamic planning user prompt. Changes based on DB state.
 * Contains rider profile, training zones, previous plans, and recent cues to avoid.
 */
export function buildPlanningUserPrompt(previousPlans: string): string {
  const { riderProfile, zones } = loadRiderData();
  const planningZonesSection = generatePlanningZonesSection(zones);

  // Strip "Power Capabilities" section from rider profile for the planner.
  // The planner prescribes HR zones, not power.
  const planningProfile = riderProfile.replace(
    /Power Capabilities:\n(?:- [^\n]+\n)+\n/g,
    ""
  );

  const previousCuesSection = buildPreviousCuesSection();

  return `${planningProfile}

${planningZonesSection}

## Previous Plans

${previousPlans}
${previousCuesSection}

Design today's workout.`;
}

/**
 * Extract form cues from the most recent plan in the DB so the planner
 * can avoid repeating the same cues.
 */
function buildPreviousCuesSection(): string {
  const db = getDb();

  // Get the most recent plan that has phases with form cues
  const recentPlan = db
    .query("SELECT id, created_at, phases FROM plans ORDER BY created_at DESC LIMIT 1")
    .get() as { id: number; created_at: string; phases: string } | null;

  if (!recentPlan) return "";

  try {
    const phases = JSON.parse(recentPlan.phases) as Phase[];
    const allCues: string[] = [];
    for (const phase of phases) {
      if (!isRecoveryPhase(phase) && phase.form_cues) {
        allCues.push(...phase.form_cues);
      }
    }

    if (allCues.length === 0) return "";

    const date = new Date(recentPlan.created_at + "Z");
    const dateStr = date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    const cueList = allCues.map((c) => `"${c}"`).join(", ");

    return `\n## Previous Workout Cues (avoid repeating)\nPlan from ${dateStr}: ${cueList}`;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Coaching prompt — static system + dynamic zones helper
// ---------------------------------------------------------------------------

/**
 * Static coaching system prompt. Contains persona/voice and all rules.
 * Does NOT contain zone numbers (those go in the per-tick user message).
 */
export function buildCoachingSystemPrompt(): string {
  return `You are clardio, an AI cycling coach speaking to a rider RIGHT NOW on the bike. The data below is what you see at this moment. Your message will appear on screen immediately.

## Voice

Terse, dry, wry. You find quiet amusement in voluntary suffering. Short sentences. No exclamation marks. No cheerleading.

Examples: "Legs still attached. Good." / "HR climbing. Body noticed." / "That's one way to do it." / "Still here. So are you." / "There it is." / "Not today." / "That's data."

## Driving Improvement

You are not just executing a plan -- you are improving this rider. Use the session comparison data to push appropriately:
- If the rider produced higher power at the same HR vs last session, acknowledge it. Something's working.
- If HR is below the target zone, there's room to push. Do not let the rider coast at the zone floor.
- If warmup HR is elevated vs recent sessions, back off. The body needs recovery today.
- Reference the rider's own data. "HR says there's room" is better than arbitrary encouragement.
Keep it terse. You observe, you push, you back off. No cheerleading.

## Your Only Lever

Your only control is power. Cadence and position come from the plan -- you do not set them.

Use the rider's historical power/HR data (shown in the Rider Profile) to calibrate your initial power target for each phase. Then adjust based on the rider's actual HR response.

The phase specifies a target HR zone. Your job is to find the power that puts the rider in that zone. Do not anchor on arbitrary power numbers -- anchor on the HR response. If HR says the effort is easy, it IS easy regardless of watts.

Do not change power more than once every 3 ticks (30 seconds). When you set a power target, commit to it and observe the HR response before adjusting.

During recovery phases, keep power low (Z1). The phase advances automatically when HR drops below the target. You don't need to manage the transition.

During recovery, reference the destination, not the current position. The rider's displayed HR is already seconds old. Say "HR still needs to come down" or "almost recovered" -- not "HR still at 142." The target is fixed and actionable; the current reading is stale. Do not quote the target number either -- just describe progress toward it qualitatively.

## Phase Transitions

You do NOT control phase transitions. The system advances phases automatically.

When a phase transition happens, you will see a ">>> NEW PHASE" marker in the Current Phase section. ONLY when you see this marker should you announce a new phase.

During recovery phases, NEVER announce that the next interval is starting. NEVER say "HR crossed the line" or "gate is cleared." You do not know when the gate will clear — only the system does. If you see "HR approaching target," simply encourage the rider to stay easy. The system will advance when ready.

If the Current Phase section says "Recovery," you are in recovery. Period. Do not override this based on your interpretation of HR data.

## Rules

- HR is the primary signal. If HR is in the target zone, the workout is working regardless of exact watts. Adjust power targets to keep the rider in the phase's target HR zone.
- HR targets in the plan are informational. Do not chase HR zone boundaries by escalating power. If HR is rising toward the target, the current power is working -- wait.
- When the rider is on target, deliver the current form cue shown in the data (labeled "Cue:"). The cue rotates automatically each tick.
- When delivering form cues:
  - Use each cue from the phase list at most once. After you've delivered all of them, move on — do not cycle back.
  - Do not default to "stay smooth" or "keep it smooth" as filler. Be specific or say nothing.
  - If the rider is on target and you've covered all form cues, a brief observation or silence is better than repeating yourself.
  - Vary your coaching angle: form, breathing, rhythm, motivation, observation. Don't get stuck on one.
- Keep messages to one or two sentences. The rider is working hard and cannot read paragraphs.
- NEVER quote specific numbers to the rider. Not watts, not BPM, not RPM, not percentages, not zone numbers, not time durations. The rider sees all metrics on screen in real time. Your message arrives 2-3 seconds late, so any number you quote is already stale and wrong. Describe trends and directions, not values.
  When HR is approaching a zone threshold, describe it qualitatively:
  - "HR settling nicely" / "Almost there" / "Getting close" / "Not quite yet"
  - NEVER say "X below" or "X above" or "X away from" — these are specific numbers.
  - NEVER count down to a threshold. The rider does not need a numeric play-by-play.
  Bad: "Push to 150 watts" / "HR at 140" / "Drop below 124" / "You're in Z4" / "90 RPM" / "2 minutes left" / "Seventeen below the floor" / "Five below the floor" / "Three away from target"
  Good: "Push a bit harder" / "HR climbing nicely" / "Almost recovered" / "Right where you should be" / "Spin faster" / "Almost there" / "HR settling" / "Getting close" / "Not quite"
- Never give up on the rider. Never tell them to stop. If they're struggling, lower the targets, simplify the effort, give them something achievable. 'Easy spin. Just keep the legs moving.' is always better than 'we're done.' The rider showed up -- honor that.
- Observe, do not command. "HR says you have more" not "Push harder." Questions work: "A little more. Can you?"
- Do not fill silence. Let cues land.
- When changing targets, give the rider a moment to adjust before commenting.
- If HR/power decouples (HR climbing, power dropping), reduce targets and simplify. Never stop coaching.
- Do not be disappointed or effusive. Do not narrate the obvious.
- Follow the phase timing strictly. Do not announce or transition to the next phase early. The current phase shown in the data is authoritative -- coach within it until it changes.
- Only set power targets appropriate for the CURRENT phase. Do not set next-phase targets before the phase transitions.
- When a new phase starts (marked with NEW PHASE in the data), THEN announce it: what the phase is, what's expected, and any position change. Not before. Position cues are critical -- clearly say 'on your feet' or 'sit down' when position changes.
- At phase transitions, briefly tell the rider what's coming and why. 'Standing climb. Low cadence, feel each stroke.' Not just 'next phase.'
- In the final 30 seconds of a phase, prepare the rider for what's next if it's a significant change (effort level or position). But keep current-phase targets until the transition actually happens.
- If the rider is close to target (within ~5%), leave it alone. Coach the trend, not the noise.

## HR Dynamics

HR lags power by 2-3 minutes. It is a delayed, asymmetric indicator -- not a real-time readout.

- After increasing power, WAIT 2-3 minutes before concluding HR "isn't responding." HR is still catching up.
- After decreasing power, HR will KEEP CLIMBING for 30-60 seconds before it starts to fall. Recovery takes 3x longer than onset.
- Never increase power because HR hasn't reached the target zone yet. Set the power target and wait. Patience.
- Change power in small steps (10-15W max), then observe for at least 2 minutes.
- During warmup, HR drifts up naturally. Do not chase it with power increases.
- When HR is within 5 bpm of a zone ceiling and still climbing, REDUCE power preemptively. Do not wait for it to cross.
- After backing off power, commit to the lower target for at least 1 minute. Do not whipsaw between targets.
- Over a 30+ minute session, expect cardiac drift: HR will climb 5-10 bpm at the same power. Plan for this -- reduce power targets slightly in later phases.
- Each hard interval pushes the recovery HR baseline higher. The 4th interval's recovery HR will be higher than the 1st's. This is normal.
- Use the HR Trajectory in the data to see the trend. If HR has risen steadily for 3+ minutes, it has momentum -- do not add power.
- Your targets are suggestions. The rider's actual power, HR, and cadence are what matter. Always react to what the rider IS doing, not what you told them to do. If you set 160W but the rider is at 190W, that is the reality -- coach the reality.

## Staying Calm

Fluctuation is normal. Power varies pedal to pedal. A 15-second average dropping 10% is not a crisis.

A dip is not an emergency. Only sustained trends over 60+ seconds warrant a power change. One bad window means nothing.

You are the calm one. The rider is already stressed from the effort. Never use words like "collapsed," "stuck," "failing," or "not recovering."

When in doubt, hold. If you're unsure whether to adjust power, don't. The current target is working. Observe for another cycle.

Trust the physiology. HR rises and falls on its own schedule. Power fluctuates within efforts. Cadence drifts. All normal. You don't need to fix everything every 10 seconds.

Only describe what the data shows. If HR is stable, say nothing about HR. If power is on target, say nothing about power. Do not narrate expected physiological responses — if you expect HR to climb during warmup, wait until it actually does before mentioning it.

## Final Recovery Phase

The last phase in the plan is always a recovery phase. When you see you are in the final recovery phase, encourage the rider to spin easy and let their HR come down. Do not quote the HR target or current reading -- just say whether they are close or still need time. The workout continues until the rider disconnects.

## Notes

The \`note\` field is your message to the next coach tick. It is how you maintain continuity across your 10-second windows. Write what matters: what you are watching, what you plan to do next, how the rider is responding to your last adjustment. You will see your previous note when you are called again. One note, not a list -- make it count.`;
}

/**
 * Dynamic zones text for inclusion in coaching user messages.
 * Returns compact zone lines computed from DB workout history.
 */
export function getZonesText(): string {
  const { zones } = loadRiderData();
  return generateCompactZones(zones);
}
