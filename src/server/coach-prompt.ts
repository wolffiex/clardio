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

export async function loadWorkoutHistory(): Promise<WorkoutSummary[]> {
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
 * Format band times as compact string like "12m/8m/6m/4m/2m"
 */
function formatBandTimes(bandSeconds: [number, number, number, number, number]): string {
  return bandSeconds.map((s) => `${Math.round(s / 60)}m`).join("/");
}

/**
 * Format percentile stats for a metric.
 * Example: "Power: 80/120/150/200 (12m/8m/6m/4m/2m)"
 */
function formatPercentiles(
  label: string,
  stats: PercentileStats | null,
  unit: string = ""
): string {
  if (!stats) return "";
  const pvals = `${stats.p25}/${stats.p50}/${stats.p75}/${stats.p95}${unit}`;
  const bands = formatBandTimes(stats.bandSeconds);
  return `  ${label}: ${pvals} (${bands})`;
}

const METRICS_REFERENCE = `### Workout Metrics Reference

- **EF (Efficiency Factor)** = NP/HR - aerobic efficiency
  Typical ranges: 0.4-0.6 beginner | 0.7-1.0 recreational | 1.0-1.5 trained | 1.5+ very fit
  Higher = more power per heartbeat. Track the trend over weeks/months.

- **VI (Variability Index)** = NP/avgPower - workout steadiness
  ~1.0 = steady-state | 1.05-1.1 = some variation | >1.1 = intervals/variable
  When VI>1.1, EF and Decoupling are less meaningful (expected with intervals).

- **Decoup (Aerobic Decoupling)** = cardiac drift over the workout
  <5% = good aerobic fitness | 5-10% = acceptable | >10% = needs base work
  Negative = HR dropped or power rose (pacing issue or warmup artifact)

### Interpreting Trends

- **Declining EF** over recent workouts may indicate accumulated fatigue or overtraining
- **Rising EF** at similar HR indicates improving aerobic fitness
- **High decoupling** (>10%) in Z2 rides suggests weak aerobic base - prescribe more easy volume
- **Low decoupling** (<5%) means they can handle longer steady efforts`;

function formatWorkoutHistory(workouts: WorkoutSummary[]): string {
  if (workouts.length === 0) {
    return "No recent workout history available.";
  }

  const lines = workouts.map((w) => {
    const relativeTime = formatRelativeTime(w.date);

    // Build efficiency metrics string (EF, VI, Decoup)
    const efficiencyParts: string[] = [];
    if (w.efficiencyFactor !== null) {
      efficiencyParts.push(`EF:${w.efficiencyFactor.toFixed(2)}`);
    }
    if (w.variabilityIndex !== null) {
      efficiencyParts.push(`VI:${w.variabilityIndex.toFixed(2)}`);
    }
    if (w.decoupling !== null) {
      efficiencyParts.push(`Decoup:${w.decoupling.toFixed(1)}%`);
    }
    const efficiencyStr = efficiencyParts.length > 0 ? ` | ${efficiencyParts.join(" ")}` : "";

    // Main summary line
    let summary = `- ${relativeTime}: ${w.durationMinutes}min${efficiencyStr}`;

    // Add percentile stats if available (indented under main line)
    const percentileLines: string[] = [];
    if (w.powerStats) {
      percentileLines.push(formatPercentiles("Power", w.powerStats, "W"));
    }
    if (w.hrStats) {
      percentileLines.push(formatPercentiles("HR", w.hrStats, "bpm"));
    }
    if (w.cadenceStats) {
      percentileLines.push(formatPercentiles("Cadence", w.cadenceStats, "rpm"));
    }

    if (percentileLines.length > 0) {
      summary += "\n" + percentileLines.join("\n");
    }

    return summary;
  });

  // Calculate some aggregate stats
  const avgOfAvgPower = Math.round(
    workouts.reduce((sum, w) => sum + w.avgPower, 0) / workouts.length
  );
  const maxPowerEver = Math.max(...workouts.map((w) => w.maxPower));
  const avgDuration = Math.round(
    workouts.reduce((sum, w) => sum + w.durationMinutes, 0) / workouts.length
  );

  return `${METRICS_REFERENCE}

### Recent Workouts (${workouts.length} sessions)

Percentiles show p25/p50/p75/p95 with time in each band (low to high)

${lines.join("\n")}

Patterns: avg session ${avgDuration}min, typical power ${avgOfAvgPower}W, peak ${maxPowerEver}W`;
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

export function getSystemPrompt(workoutHistory: string): string {
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

- Cue 4-5 seconds before action needed. Not earlier (anxiety), not later (no time).
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

## Training Zones

Power Zones (% FTP):
- Z1 Recovery: <55% FTP - easy spinning
- Z2 Endurance: 55-75% FTP - aerobic base, HR stays low
- Z3 Tempo: 76-90% FTP - gray zone, use sparingly
- Z4 Threshold: 91-105% FTP - lactate threshold
- Z5 VO2max: 106-120% FTP - maximal efforts
- Sweet Spot: 88-94% FTP - efficient training stimulus

HR Zones (LTHR 150, max 168):
- Z1 Recovery: <128 bpm - easy spinning, recovery
- Z2 Endurance: 128-134 bpm - aerobic base building
- Z3 Tempo: 135-141 bpm - gray zone, use sparingly
- Z4 Threshold: 143-149 bpm - lactate threshold work
- Z5 VO2max: 150-168 bpm - maximal efforts

Use HR as the primary guide for intensity. When HR is in the correct zone, the training is working regardless of exact power numbers.

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
  const historyText = formatWorkoutHistory(workouts);
  return getSystemPrompt(historyText);
}

// When run directly, output the prompt
if (import.meta.main) {
  const prompt = await buildSystemPrompt();
  console.log(prompt);
}
