/**
 * Workout session manager
 *
 * Lifecycle: startWorkout -> plan (Opus) -> coach loop (Sonnet) -> stopWorkout
 * Buffers metrics, tracks plan phases, calls coach every 10 seconds
 */

import {
  type Phase,
  type WorkoutPlan,
  type CoachResponse,
  buildPlanningPrompt,
  buildCoachingPrompt,
} from "./coach-prompt";
import { planWorkout, sendCoachMessage } from "./coach";
import { savePlan, getRecentPlans, completePlan, saveSample } from "./db";
import { broadcast } from "./sse";
import { log } from "./log";

const COACH_INTERVAL_MS = 10_000;

// Latency tracking
let lastLatencyMs: number | null = null;

// Workout state
let workoutActive = false;
let coachTimer: ReturnType<typeof setInterval> | null = null;
let workoutStartTime: number = 0;

// Plan state
let currentPlan: WorkoutPlan | null = null;
let currentPlanId: number | null = null;
let coachingPrompt: string = "";

// Coach history (last N messages for context)
let coachHistory: Array<{
  elapsed: string;
  message: string;
  power: number;
  cadence: number;
}> = [];
const MAX_COACH_HISTORY = 5;

// Phase transition tracking
let lastPhaseName: string | null = null;
let lastPhasePosition: string | null = null;

// Metrics buffer
type Sample = { power: number; hr: number; cadence: number; receivedAt: number };
let samples: Sample[] = [];
let lastSampleTime: number | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a workout session
 */
export async function startWorkout(): Promise<void> {
  if (workoutActive) return;
  workoutActive = true;
  workoutStartTime = Date.now();
  samples = [];
  coachHistory = [];
  lastSampleTime = null;
  lastLatencyMs = null;
  lastPhaseName = null;
  lastPhasePosition = null;
  currentPlan = null;
  currentPlanId = null;

  try {
    // 1. Build planning prompt with recent plans from SQLite
    const recentPlans = getRecentPlans(5);
    const previousPlansText =
      recentPlans.length === 0
        ? "No previous plans."
        : recentPlans
            .map((p) => {
              const phases = JSON.parse(p.phases);
              const phaseNames = phases
                .map((ph: Phase) => ph.name)
                .join(", ");
              return `${p.created_at}: ${phaseNames}${p.summary ? ` — ${p.summary}` : ""}`;
            })
            .join("\n");

    const planningPrompt = await buildPlanningPrompt(previousPlansText);

    // 2. Call Opus to generate the plan
    console.log("--- Planning System Prompt ---");
    console.log(planningPrompt);
    console.log("--- End Planning System Prompt ---");

    log("Generating workout plan...");
    const planStart = Date.now();
    currentPlan = await planWorkout(planningPrompt, "Design today's workout.");
    console.log(`Plan generated in ${Date.now() - planStart}ms`);
    log(`Plan: ${currentPlan.summary}`);
    log(
      `Phases: ${currentPlan.phases.map((p) => `${p.name} (${p.duration_minutes}min ${p.zone})`).join(" -> ")}`
    );
    console.log("--- Full Plan ---");
    console.log(JSON.stringify(currentPlan, null, 2));
    console.log("--- End Full Plan ---");

    // 3. Save plan to SQLite
    currentPlanId = savePlan(JSON.stringify(currentPlan.phases));

    // 4. Build coaching prompt (done once, reused every tick)
    coachingPrompt = await buildCoachingPrompt();

    // 5. Send initial coach message
    const initialMessage = buildUserMessage(true);
    console.log("--- Coach Input ---");
    console.log(initialMessage);
    console.log("--- End Coach Input ---");
    const initialCallStart = Date.now();
    const response = await sendCoachMessage(coachingPrompt, initialMessage);
    lastLatencyMs = Date.now() - initialCallStart;
    console.log(`Coach response in ${lastLatencyMs}ms`);
    if (response) {
      updateCoachHistory(response);
      broadcast("coach", { text: response.message });
      broadcast("target", { power: response.power, cadence: response.cadence });
      log(
        `Coach: "${response.message}" | ${response.power}W ${response.cadence}rpm`
      );
    }

    // 6. Start the 10-second coaching loop
    coachTimer = setInterval(onCoachTick, COACH_INTERVAL_MS);
  } catch (err) {
    console.error("Failed to start workout:", err);
    workoutActive = false;
  }
}

/**
 * Stop the workout session
 */
export function stopWorkout(): void {
  if (!workoutActive) return;
  workoutActive = false;

  if (coachTimer) {
    clearInterval(coachTimer);
    coachTimer = null;
  }

  // Compute summary from samples and update plan
  if (currentPlanId && samples.length > 0) {
    const avgPower =
      samples.reduce((s, x) => s + x.power, 0) / samples.length;
    const avgHr = samples.reduce((s, x) => s + x.hr, 0) / samples.length;
    const avgCadence =
      samples.reduce((s, x) => s + x.cadence, 0) / samples.length;
    const duration = Math.round((Date.now() - workoutStartTime) / 1000);
    const summary = `${Math.floor(duration / 60)}min, avg ${Math.round(avgPower)}W ${Math.round(avgHr)}bpm ${Math.round(avgCadence)}rpm`;
    completePlan(currentPlanId, summary);
    log(`Workout complete: ${summary}`);
  }

  // Reset state
  currentPlan = null;
  currentPlanId = null;
  coachingPrompt = "";
  coachHistory = [];
  samples = [];
  lastSampleTime = null;
}

/**
 * Add metrics to the buffer and save to SQLite
 */
export function addMetrics(metrics: {
  power: number;
  hr: number;
  cadence: number;
}): void {
  if (!workoutActive) return;

  const now = Date.now();
  const durationMs = lastSampleTime ? now - lastSampleTime : 0;
  lastSampleTime = now;

  samples.push({ ...metrics, receivedAt: now });

  // Save to SQLite (skip first sample since durationMs is 0)
  if (currentPlanId && durationMs > 0) {
    saveSample(
      currentPlanId,
      now,
      durationMs,
      metrics.power,
      metrics.hr,
      metrics.cadence
    );
  }
}

/**
 * Check if workout is active
 */
export function isWorkoutActive(): boolean {
  return workoutActive;
}

/**
 * Get elapsed time in seconds since workout started
 */
export function getElapsed(): number {
  if (!workoutActive) return 0;
  return Math.floor((Date.now() - workoutStartTime) / 1000);
}

// ---------------------------------------------------------------------------
// Coach tick
// ---------------------------------------------------------------------------

async function onCoachTick(): Promise<void> {
  if (!workoutActive || !currentPlan || samples.length === 0) return;

  const userMessage = buildUserMessage(false);
  console.log("--- Coach Input ---");
  console.log(userMessage);
  console.log("--- End Coach Input ---");

  try {
    const callStart = Date.now();
    const response = await sendCoachMessage(coachingPrompt, userMessage);
    lastLatencyMs = Date.now() - callStart;
    console.log(`Coach response in ${lastLatencyMs}ms`);
    if (response) {
      updateCoachHistory(response);
      broadcast("coach", { text: response.message });
      broadcast("target", {
        power: response.power,
        cadence: response.cadence,
      });
      log(
        `Coach: "${response.message}" | ${response.power}W ${response.cadence}rpm`
      );
    }
  } catch (err) {
    console.error("Coach tick error:", err);
  }
}

// ---------------------------------------------------------------------------
// User message builder (what the coach sees each tick)
// ---------------------------------------------------------------------------

function buildUserMessage(isStart: boolean): string {
  const elapsed = getElapsedMs();
  const elapsedStr = formatElapsed(elapsed);
  const sections: string[] = [];

  // Current phase (derived from elapsed time)
  if (currentPlan) {
    const { currentPhase, phaseElapsed, phaseRemaining } =
      getCurrentPhase(elapsed);

    sections.push("## Current Phase");
    if (currentPhase) {
      // Detect phase transition
      const isNewPhase = lastPhaseName !== null && currentPhase.name !== lastPhaseName;
      if (isNewPhase) {
        const positionChanged = lastPhasePosition !== null && currentPhase.position !== lastPhasePosition;
        sections.push(
          `\u{1F504} NEW PHASE \u2014 was "${lastPhaseName}", now entering "${currentPhase.name}"`
        );
        sections.push(
          `${currentPhase.name} | ${currentPhase.zone} | ${currentPhase.position} | ${currentPhase.cadence[0]}-${currentPhase.cadence[1]}rpm`
        );
        sections.push(
          `Phase time: ${formatElapsed(phaseElapsed)} elapsed, ${formatElapsed(phaseRemaining)} remaining`
        );
        if (positionChanged) {
          sections.push(
            `Position change: YES \u2014 was ${lastPhasePosition}, now ${currentPhase.position.toUpperCase()}`
          );
        } else {
          sections.push(
            `Position change: NO (both ${currentPhase.position})`
          );
        }
      } else {
        sections.push(
          `${currentPhase.name} | ${currentPhase.zone} | ${currentPhase.position} | ${currentPhase.cadence[0]}-${currentPhase.cadence[1]}rpm`
        );
        sections.push(
          `Phase time: ${formatElapsed(phaseElapsed)} elapsed, ${formatElapsed(phaseRemaining)} remaining`
        );
      }

      // Upcoming phase preview when nearing end of current phase
      if (phaseRemaining <= 30_000) {
        const nextPhase = getNextPhase(currentPhase);
        if (nextPhase) {
          sections.push(
            `\u23ED NEXT: ${nextPhase.name} | ${nextPhase.zone} | ${nextPhase.position} | ${nextPhase.cadence[0]}-${nextPhase.cadence[1]}rpm`
          );
        }
      }

      if (currentPhase.cues.length > 0) {
        sections.push(`Cues: ${currentPhase.cues.join(", ")}`);
      }
      if (currentPhase.notes) {
        sections.push(`Notes: ${currentPhase.notes}`);
      }

      // Update tracking state after building the message
      lastPhaseName = currentPhase.name;
      lastPhasePosition = currentPhase.position;
    } else {
      sections.push("Workout complete — cool down.");
    }

    // Full plan overview (compact)
    sections.push("");
    sections.push("## Plan");
    sections.push(currentPlan.summary);
    let accumulated = 0;
    for (const phase of currentPlan.phases) {
      const marker =
        accumulated <= elapsed / 1000 / 60 &&
        elapsed / 1000 / 60 < accumulated + phase.duration_minutes
          ? "->"
          : "  ";
      sections.push(
        `${marker} ${phase.name}: ${phase.duration_minutes}min ${phase.zone} ${phase.position} ${phase.cadence[0]}-${phase.cadence[1]}rpm`
      );
      accumulated += phase.duration_minutes;
    }
  }

  // Status: on target or not
  if (!isStart && samples.length > 0) {
    sections.push("");
    sections.push("## Status");
    const statusSamples = getRecentSamples(30_000);
    if (statusSamples.length > 0) {
      const { currentPhase } = getCurrentPhase(elapsed);
      if (currentPhase) {
        const avgPwr = Math.round(
          statusSamples.reduce((s, x) => s + x.power, 0) / statusSamples.length
        );
        const avgHrVal = Math.round(
          statusSamples.reduce((s, x) => s + x.hr, 0) / statusSamples.length
        );
        const avgCad = Math.round(
          statusSamples.reduce((s, x) => s + x.cadence, 0) / statusSamples.length
        );
        sections.push(
          `Current zone: ${currentPhase.zone} | Rider avg: ${avgPwr}W ${avgHrVal}bpm ${avgCad}rpm`
        );
      }
    }
  }

  // Recent coach messages
  if (coachHistory.length > 0) {
    sections.push("");
    sections.push("## Recent Coach Messages");
    for (const h of coachHistory) {
      sections.push(`[${h.elapsed}] "${h.message}" -> ${h.power}W ${h.cadence}rpm`);
    }
  }

  // Metrics summary (full workout)
  if (samples.length > 0) {
    const avgPower = Math.round(
      samples.reduce((s, x) => s + x.power, 0) / samples.length
    );
    const avgHr = Math.round(
      samples.reduce((s, x) => s + x.hr, 0) / samples.length
    );
    const avgCadence = Math.round(
      samples.reduce((s, x) => s + x.cadence, 0) / samples.length
    );
    const maxHr = Math.max(...samples.map((s) => s.hr));
    sections.push("");
    sections.push("## Workout Summary");
    sections.push(
      `Avg: ${avgPower}W ${avgHr}bpm ${avgCadence}rpm | Max HR: ${maxHr} | Elapsed: ${elapsedStr}`
    );

    // Timing info so the coach knows data staleness
    const lastResponseStr = lastLatencyMs !== null
      ? `${(lastLatencyMs / 1000).toFixed(1)}s`
      : "first call";
    const mostRecentSample = samples[samples.length - 1];
    const dataAgeMs = Date.now() - mostRecentSample.receivedAt;
    const dataAgeStr = `~${Math.round(dataAgeMs / 1000)}s`;
    sections.push("");
    sections.push("## Timing");
    sections.push(
      `Coach interval: 10s | Last response: ${lastResponseStr} | Data age: ${dataAgeStr}`
    );
  }

  // Recent metrics (last 30s) - compact summary
  if (!isStart) {
    sections.push("");
    const recentSamples = getRecentSamples(30_000);
    if (recentSamples.length > 0) {
      const powers = recentSamples.map((s) => s.power);
      const hrs = recentSamples.map((s) => s.hr);
      const cadences = recentSamples.map((s) => s.cadence);

      const avg = (arr: number[]) =>
        Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);

      sections.push("## Recent Metrics (last 30s)");
      sections.push(
        `Power: avg ${avg(powers)}W, range ${Math.min(...powers)}-${Math.max(...powers)}W`
      );
      sections.push(
        `HR: avg ${avg(hrs)}bpm, range ${Math.min(...hrs)}-${Math.max(...hrs)}bpm`
      );
      sections.push(
        `Cadence: avg ${avg(cadences)}rpm, range ${Math.min(...cadences)}-${Math.max(...cadences)}rpm`
      );
    } else {
      sections.push("## Recent Metrics (last 30s)");
      sections.push("No samples in last 30s");
    }

    // HR trend (last 45s)
    const trendSamples = getRecentSamples(45_000);
    if (trendSamples.length >= 2) {
      const firstHr =
        trendSamples.slice(0, 3).reduce((s, x) => s + x.hr, 0) /
        Math.min(3, trendSamples.length);
      const lastHr =
        trendSamples.slice(-3).reduce((s, x) => s + x.hr, 0) /
        Math.min(3, trendSamples.length);
      const diff = lastHr - firstHr;
      let trend = "heart rate steady";
      if (diff > 10) trend = "heart rate climbing quickly";
      else if (diff > 3) trend = "heart rate climbing";
      else if (diff < -10) trend = "heart rate falling quickly";
      else if (diff < -3) trend = "heart rate falling";
      sections.push(`Trend: ${trend}`);
    }

    sections.push(`Elapsed: ${elapsedStr}`);
  } else {
    sections.push("");
    sections.push(
      "Workout starting. Greet the rider and set initial warmup targets."
    );
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getElapsedMs(): number {
  return Date.now() - workoutStartTime;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function getCurrentPhase(elapsedMs: number): {
  currentPhase: Phase | null;
  phaseElapsed: number;
  phaseRemaining: number;
} {
  if (!currentPlan)
    return { currentPhase: null, phaseElapsed: 0, phaseRemaining: 0 };

  const elapsedMin = elapsedMs / 1000 / 60;
  let accumulated = 0;

  for (const phase of currentPlan.phases) {
    if (elapsedMin < accumulated + phase.duration_minutes) {
      const phaseElapsedMin = elapsedMin - accumulated;
      return {
        currentPhase: phase,
        phaseElapsed: phaseElapsedMin * 60 * 1000,
        phaseRemaining:
          (phase.duration_minutes - phaseElapsedMin) * 60 * 1000,
      };
    }
    accumulated += phase.duration_minutes;
  }

  return { currentPhase: null, phaseElapsed: 0, phaseRemaining: 0 };
}

function getNextPhase(currentPhase: Phase): Phase | null {
  if (!currentPlan) return null;
  const idx = currentPlan.phases.indexOf(currentPhase);
  if (idx === -1 || idx >= currentPlan.phases.length - 1) return null;
  return currentPlan.phases[idx + 1];
}

function getRecentSamples(windowMs: number): Sample[] {
  const cutoff = Date.now() - windowMs;
  return samples.filter((s) => s.receivedAt >= cutoff);
}

function updateCoachHistory(response: CoachResponse): void {
  const elapsed = formatElapsed(getElapsedMs());
  coachHistory.push({
    elapsed,
    message: response.message,
    power: response.power,
    cadence: response.cadence,
  });
  if (coachHistory.length > MAX_COACH_HISTORY) {
    coachHistory.shift();
  }
}
