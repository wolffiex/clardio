/**
 * Coach prompt system
 *
 * Two single-turn prompts:
 * - Planning prompt (Opus 4.6): designs a 45-minute workout at session start
 * - Coaching prompt (Sonnet 4.5): reacts every 10 seconds during the workout
 *
 * Run scripts/dump-prompt.ts to preview both prompts.
 */

import { getDb, type PlanRow } from "./db";

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
  completed: boolean;
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
    completed: plan.completed === 1,
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

function loadSessionsFromDb(): SessionSummary[] {
  const db = getDb();

  // Get plans that have samples (any session we collected data for)
  const plans = db
    .query(
      `SELECT p.* FROM plans p
       WHERE EXISTS (SELECT 1 FROM samples s WHERE s.plan_id = p.id)
       ORDER BY p.created_at ASC`
    )
    .all() as PlanRow[];

  const sessions: SessionSummary[] = [];
  for (const plan of plans) {
    const samples = db
      .query(
        "SELECT timestamp_ms, duration_ms, power, hr, cadence FROM samples WHERE plan_id = ? ORDER BY timestamp_ms"
      )
      .all(plan.id) as SampleRow[];

    const summary = summarizeSession(plan, samples);
    if (summary) {
      sessions.push(summary);
    }
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

function estimateFtpFromSessions(sessions: SessionSummary[]): number | null {
  // First try: p95 from steady-state sessions (VI < 1.1)
  const steadySessions = sessions.filter(
    (s) =>
      s.variabilityIndex !== null &&
      s.variabilityIndex < 1.1 &&
      s.powerStats !== null
  );

  if (steadySessions.length > 0) {
    const p95Values = steadySessions.map((s) => s.powerStats!.p95);
    const maxP95 = Math.max(...p95Values);
    return Math.round(maxP95 * 0.75);
  }

  // Fallback: use overall p95 from any session with power data
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

function buildRiderProfileFromDb(): string {
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

function generateCompactZones(config: TrainingZonesConfig): string {
  const lines: string[] = [];

  if (config.estimatedFtp !== null) {
    const ftp = config.estimatedFtp;
    lines.push(
      `FTP: ~${ftp}W | Z1 <${Math.round(ftp * 0.55)} | Z2 ${Math.round(ftp * 0.55)}-${Math.round(ftp * 0.75)} | Z3 ${Math.round(ftp * 0.76)}-${Math.round(ftp * 0.90)} | Z4 ${Math.round(ftp * 0.91)}-${Math.round(ftp * 1.05)} | Z5 ${Math.round(ftp * 1.06)}-${Math.round(ftp * 1.20)} | SS ${Math.round(ftp * 0.88)}-${Math.round(ftp * 0.94)}`
    );
  } else {
    lines.push(
      "FTP: unknown | Z1 <55% | Z2 55-75% | Z3 76-90% | Z4 91-105% | Z5 106-120% | SS 88-94%"
    );
  }

  if (config.hrZones !== null) {
    const z = config.hrZones;
    lines.push(
      `LTHR: ${z.lthr} | Z1 <${z.z1Max + 1} | Z2 ${z.z2Min}-${z.z2Max} | Z3 ${z.z3Min}-${z.z3Max} | Z4 ${z.z4Min}-${z.z4Max} | Z5 ${z.z5Min}-${z.maxHr}`
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Shared data loader
// ---------------------------------------------------------------------------

function loadRiderData(): {
  riderProfile: string;
  zones: TrainingZonesConfig;
} {
  const sessions = loadSessionsFromDb();
  const riderProfile = buildRiderProfileFromDb();

  // Compute zones from DB data, with defaults for new riders
  const maxHr = getMaxHrFromSessions(sessions);
  const ftpEstimate = estimateFtpFromSessions(sessions);

  let hrZones: HrZones | null = null;
  let estimatedFtp: number | null = null;

  if (maxHr !== null) {
    hrZones = calculateHrZones(maxHr);
  }

  if (ftpEstimate !== null) {
    estimatedFtp = ftpEstimate;
  }

  return {
    riderProfile,
    zones: { hrZones, estimatedFtp },
  };
}

// ---------------------------------------------------------------------------
// Planning prompt
// ---------------------------------------------------------------------------

export async function buildPlanningPrompt(
  previousPlans: string
): Promise<string> {
  const { riderProfile, zones } = loadRiderData();
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
3. 1-2 minute opener efforts to prime the legs
4. Brief recovery before main set

### Cooldown Protocol
5-10 minutes easy spinning in Z1. Gradual wind-down, not an abrupt stop.

## Interval Formats

### High-Intensity Intervals
| Format | Work | Rest | Reps | Sets | Total Work |
|--------|------|------|------|------|------------|
| Norwegian 4x4 | 4 min @ 85-95% HRmax | 3 min | 4 | 1 | 16 min |

### Threshold Intervals
| Format | Work | Rest | Reps | Notes |
|--------|------|------|------|-------|
| Sweet Spot | 20 min @ 88-94% FTP | 5-10 min | 2 | Core threshold workout |
| Over-Unders | 2 min @ 105% / 2 min @ 95% FTP | - | 10-20 min blocks | Teaches lactate management |
| Tempo Blocks | 15-20 min @ 76-90% FTP | 5 min | 2-3 | Gray zone -- use sparingly |

### Cadence Ranges by Effort
| Effort | Cadence |
|--------|---------|
| Endurance | 70-90 RPM |
| Threshold | 85-95 RPM |
| High-cadence drills | 95-110 RPM |
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

Every phase must be at least 1 minute. The coach sets a single power and cadence target every 10 seconds. It cannot prescribe micro-intervals within a phase (e.g. '10s sprint + 50s recovery'). Every phase must have ONE consistent effort level. If you want variety, use separate phases — each at least 1 minute. Standing efforts, cadence changes, and intensity changes should each be their own phase.

Design a 45-minute workout. Vary the format from previous plans shown above. Include specific power targets (in watts if FTP is known, otherwise in zone references), cadence ranges, and position for each phase. Each phase should have form cues appropriate for that effort level.`;
}

// ---------------------------------------------------------------------------
// Coaching prompt
// ---------------------------------------------------------------------------

export async function buildCoachingPrompt(): Promise<string> {
  const { zones } = loadRiderData();
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
- Keep messages to one or two sentences. The rider is working hard and cannot read paragraphs. Do not mention specific watts, BPM, or RPM numbers in your message. The targets and metrics are displayed on screen. Say 'more power' not 'push to 140W'. Say 'higher cadence' not 'bring it to 80'.
- If performance collapses by the third interval, end structured work and switch to easy spinning.
- Observe, do not command. "HR says you have more" not "Push harder." Questions work: "5 more watts. Can you?"
- Do not fill silence. Let cues land.
- When changing targets, give the rider a moment to adjust before commenting.
- If HR/power decouples (HR climbing, power dropping), end structured work.
- Do not be disappointed or effusive. Do not narrate the obvious.
- Follow the phase timing strictly. Do not announce or transition to the next phase early. The current phase shown in the data is authoritative -- coach within it until it changes.
- Only set power and cadence targets appropriate for the CURRENT phase. Do not set next-phase targets before the phase transitions.
- When a new phase starts (marked with NEW PHASE in the data), THEN announce it: what the phase is, what's expected, and any position change. Not before. Position cues are critical -- clearly say 'on your feet' or 'sit down' when position changes.
- At phase transitions, briefly tell the rider what's coming and why. 'Standing climb. Low cadence, feel each stroke.' Not just 'next phase.'
- In the final 30 seconds of a phase, prepare the rider for what's next if it's a significant change (effort level or position). But keep current-phase targets until the transition actually happens.
- If the rider is close to target (within ~5%), leave it alone. Coach the trend, not the noise.`;
}

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

export async function buildSystemPrompt(): Promise<string> {
  return buildPlanningPrompt("No previous plans.");
}
