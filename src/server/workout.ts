/**
 * Workout session manager
 *
 * startWorkout -> plan (Opus) -> coach loop (Sonnet) -> stopWorkout
 * Buffers metrics, tracks plan phases, calls coach every 10 seconds
 */

import {
  type Phase,
  type WorkoutPlan,
  type CoachResponse,
  isRecoveryPhase,
  buildPlanningSystemPrompt,
  buildPlanningUserPrompt,
  buildCoachingSystemPrompt,
  getZonesText,
  getZonePowerRanges,
} from "./coach-prompt";
import { planWorkout, sendCoachMessage } from "./coach";
import { savePlan, getRecentPlans, saveSample, saveCoachTick } from "./db";
import { broadcast } from "./sse";
import { log } from "./log";

const COACH_INTERVAL_MS = 10_000;

// Latency tracking
let lastLatencyMs: number | null = null;
let tickLatencies: number[] = [];

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
  power: number | null;
}> = [];
const MAX_COACH_HISTORY = 10;

// Phase transition tracking
let lastPhaseName: string | null = null;
let lastPhasePosition: string | null = null;

// Phase tracking for dynamic (recovery) phases
let currentPhaseIndex: number = 0;
let phaseStartTimes: number[] = []; // ms timestamp when each phase started

// Power change throttling
let lastPowerChangeTime: number = 0;
let currentPowerTarget: number | null = null;

// Recovery HR gate debounce: tracks when HR first dropped below target
// HR must stay below target for 15s sustained before advancing
let recoveryGateClearedAt: number | null = null;

// Coach notes (persistent memory across ticks)
let coachNotes: Array<{ elapsed: string; note: string }> = [];

// Cached zones text (computed once at workout start, never recalculated mid-workout)
let cachedZonesText: string = "";

// Cached zone power ranges for cross-referencing in Current Phase section
let cachedZonePowerRanges: Record<string, { min: number; max: number }> | null = null;

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
  tickLatencies = [];
  lastPhaseName = null;
  lastPhasePosition = null;
  currentPhaseIndex = 0;
  phaseStartTimes = [];
  lastPowerChangeTime = 0;
  currentPowerTarget = null;
  recoveryGateClearedAt = null;
  coachNotes = [];
  currentPlan = null;
  currentPlanId = null;

  try {
    // 0. Cache zones BEFORE any samples are saved (avoids warmup data polluting zones)
    cachedZonesText = getZonesText();
    cachedZonePowerRanges = getZonePowerRanges();

    // 1. Build planning prompts (static system + dynamic user)
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

    const planningSystemPrompt = buildPlanningSystemPrompt();
    const planningUserPrompt = buildPlanningUserPrompt(previousPlansText);

    // 2. Call Opus to generate the plan
    console.log("--- Planning System Prompt ---");
    console.log(planningSystemPrompt);
    console.log("--- End Planning System Prompt ---");
    console.log("--- Planning User Prompt ---");
    console.log(planningUserPrompt);
    console.log("--- End Planning User Prompt ---");

    log("Generating workout plan...");
    const planStart = Date.now();
    currentPlan = await planWorkout(planningSystemPrompt, planningUserPrompt);
    console.log(`Plan generated in ${Date.now() - planStart}ms`);
    log(`Plan: ${currentPlan.summary}`);
    log(
      `Phases: ${currentPlan.phases.map((p) => {
        if (isRecoveryPhase(p)) {
          return `${p.name} (recovery, HR<${p.target_hr})`;
        }
        return `${p.name} (${Math.round(p.duration_s / 60)}min ${p.zone})`;
      }).join(" -> ")}`
    );

    // Initialize phase tracking
    phaseStartTimes = [workoutStartTime];
    currentPhaseIndex = 0;
    console.log("--- Full Plan ---");
    console.log(JSON.stringify(currentPlan, null, 2));
    console.log("--- End Full Plan ---");

    // 3. Save plan to SQLite
    currentPlanId = savePlan(JSON.stringify(currentPlan.phases));

    // 3.5 Broadcast plan to SSE clients for timeline rendering
    broadcast("plan", {
      summary: currentPlan.summary,
      phases: currentPlan.phases.map(phase => {
        if (isRecoveryPhase(phase)) {
          return {
            name: phase.name,
            type: "recovery",
            min_duration_s: phase.min_duration_s,
            max_duration_s: phase.max_duration_s,
            target_hr: phase.target_hr,
            position: phase.position,
            cadence: phase.cadence,
          };
        }
        return {
          name: phase.name,
          duration_s: phase.duration_s,
          zone: phase.zone,
          position: phase.position,
          cadence: phase.cadence,
        };
      })
    });

    // 4. Build coaching system prompt (done once, reused every tick — static)
    coachingPrompt = buildCoachingSystemPrompt();

    // 5. Send initial coach message
    const initialMessage = buildUserMessage(true);
    console.log("--- Coach Input ---");
    console.log(initialMessage);
    console.log("--- End Coach Input ---");
    const initialCallStart = Date.now();
    const response = await sendCoachMessage(coachingPrompt, initialMessage);
    lastLatencyMs = Date.now() - initialCallStart;
    tickLatencies.push(lastLatencyMs);
    console.log(`Coach response in ${lastLatencyMs}ms`);
    if (response) {
      handleCoachResponse(response);
    }

    // 5.5 Save initial coach tick
    if (currentPlanId) {
      const elapsedS = getElapsedMs() / 1000;
      saveCoachTick(currentPlanId, elapsedS, initialMessage, response, lastLatencyMs);
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

  log("Workout stopped.");

  // Reset state
  currentPlan = null;
  currentPlanId = null;
  coachingPrompt = "";
  cachedZonesText = "";
  cachedZonePowerRanges = null;
  coachHistory = [];
  samples = [];
  lastSampleTime = null;
  currentPhaseIndex = 0;
  phaseStartTimes = [];
  lastPowerChangeTime = 0;
  currentPowerTarget = null;
  recoveryGateClearedAt = null;
}

/**
 * Add metrics to the buffer and save to SQLite
 */
export function addMetrics(metrics: {
  power: number;
  hr: number;
  cadence: number;
}): boolean {
  if (!workoutActive) return false;

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

  return true;
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

  // Check for phase advancement (recovery phases may advance based on HR)
  advancePhaseIfNeeded();

  const userMessage = buildUserMessage(false);
  console.log("--- Coach Input ---");
  console.log(userMessage);
  console.log("--- End Coach Input ---");

  try {
    const callStart = Date.now();
    const response = await sendCoachMessage(coachingPrompt, userMessage);
    lastLatencyMs = Date.now() - callStart;
    tickLatencies.push(lastLatencyMs);
    console.log(`Coach response in ${lastLatencyMs}ms`);
    if (response) {
      handleCoachResponse(response);
    }

    // Save coach tick to DB
    if (currentPlanId) {
      const elapsedS = getElapsedMs() / 1000;
      saveCoachTick(currentPlanId, elapsedS, userMessage, response, lastLatencyMs);
    }
  } catch (err) {
    console.error("Coach tick error:", err);
    // Save failed tick to DB (response=null)
    if (currentPlanId) {
      const elapsedS = getElapsedMs() / 1000;
      saveCoachTick(currentPlanId, elapsedS, userMessage, null, null);
    }
  }
}

// ---------------------------------------------------------------------------
// User message builder (what the coach sees each tick)
// ---------------------------------------------------------------------------

function buildUserMessage(isStart: boolean): string {
  const elapsed = getElapsedMs();
  const elapsedStr = formatElapsed(elapsed);
  const sections: string[] = [];

  // Timing info at the very top
  sections.push(`WORKOUT TIME: ${elapsedStr}`);
  if (!isStart && tickLatencies.length > 0) {
    const recentLatencies = tickLatencies.slice(-5);
    const avgLatencyMs =
      recentLatencies.reduce((s, x) => s + x, 0) / recentLatencies.length;
    const avgLatencySec = avgLatencyMs / 1000;
    const displayTime = elapsed + avgLatencyMs;
    sections.push("");
    sections.push("## Timing");
    sections.push(`Elapsed: ${elapsedStr}`);
    sections.push(`Avg coach latency: ${avgLatencySec.toFixed(1)}s`);
    sections.push(`Your message displays at ~${formatElapsed(displayTime)}`);
  }
  sections.push("");

  // Plan and current phase
  if (currentPlan) {
    const { currentPhase, phaseElapsed, phaseRemaining } =
      getCurrentPhaseInfo(elapsed);

    // Plan overview (current + next 2 phases, with remaining count)
    sections.push("## Plan");
    sections.push(currentPlan.summary);
    const planPhases = currentPlan.phases;
    const visibleEnd = Math.min(currentPhaseIndex + 3, planPhases.length);
    for (let i = currentPhaseIndex; i < visibleEnd; i++) {
      const phase = planPhases[i];
      const marker = i === currentPhaseIndex ? "->" : "  ";
      if (isRecoveryPhase(phase)) {
        sections.push(
          `${marker} ${phase.name}: recovery (HR<${phase.target_hr}) ${phase.position} ${phase.cadence}rpm`
        );
      } else {
        sections.push(
          `${marker} ${phase.name}: ${Math.round(phase.duration_s / 60)}min ${phase.zone} ${phase.position} ${phase.cadence}rpm`
        );
      }
    }
    const remainingAfterVisible = planPhases.length - visibleEnd;
    if (remainingAfterVisible > 0) {
      sections.push(`   (+${remainingAfterVisible} more phase${remainingAfterVisible === 1 ? "" : "s"})`);
    }

    // Zones (cached at workout start -- never recalculated mid-workout)
    sections.push("");
    sections.push("## Zones");
    sections.push(cachedZonesText);

    sections.push("");
    sections.push("## Current Phase");
    if (currentPhase) {
      // Detect phase transition
      const isNewPhase = lastPhaseName !== null && currentPhase.name !== lastPhaseName;

      if (isRecoveryPhase(currentPhase)) {
        // Recovery phase display
        const latestHr = getLatestHr();
        if (isNewPhase) {
          const positionChanged = lastPhasePosition !== null && currentPhase.position !== lastPhasePosition;
          sections.push(
            `\u{1F504} NEW PHASE -- was "${lastPhaseName}", now entering "${currentPhase.name}"`
          );
          sections.push(
            `Recovery -- target HR: ${currentPhase.target_hr}, current HR: ${latestHr ?? "---"}, min: ${currentPhase.min_duration_s}s, max: ${currentPhase.max_duration_s}s, elapsed: ${Math.round(phaseElapsed / 1000)}s`
          );
          sections.push(`${currentPhase.name} | recovery | ${currentPhase.position} | ${currentPhase.cadence}rpm`);
          if (positionChanged) {
            sections.push(
              `Position change: YES -- was ${lastPhasePosition}, now ${currentPhase.position.toUpperCase()}`
            );
          } else {
            sections.push(
              `Position change: NO (both ${currentPhase.position})`
            );
          }
        } else {
          sections.push(
            `Recovery -- target HR: ${currentPhase.target_hr}, current HR: ${latestHr ?? "---"}, min: ${currentPhase.min_duration_s}s, max: ${currentPhase.max_duration_s}s, elapsed: ${Math.round(phaseElapsed / 1000)}s`
          );
          sections.push(`${currentPhase.name} | recovery | ${currentPhase.position} | ${currentPhase.cadence}rpm`);
        }
      } else {
        // Timed phase display
        if (isNewPhase) {
          const positionChanged = lastPhasePosition !== null && currentPhase.position !== lastPhasePosition;
          sections.push(
            `\u{1F504} NEW PHASE -- was "${lastPhaseName}", now entering "${currentPhase.name}"`
          );
          sections.push(
            `${currentPhase.name} | ${currentPhase.zone} | ${currentPhase.position} | ${currentPhase.cadence}rpm`
          );
          const newPhaseRange = lookupZonePowerRange(currentPhase.zone);
          if (newPhaseRange) {
            sections.push(`Power range for ${currentPhase.zone}: ${newPhaseRange}`);
          }
          sections.push(
            `Phase time: ${formatElapsed(phaseElapsed)} elapsed, ${formatElapsed(phaseRemaining)} remaining`
          );
          if (currentPhase.hr_target) {
            sections.push(`HR target: ${currentPhase.hr_target} (informational)`);
          }
          if (positionChanged) {
            sections.push(
              `Position change: YES -- was ${lastPhasePosition}, now ${currentPhase.position.toUpperCase()}`
            );
          } else {
            sections.push(
              `Position change: NO (both ${currentPhase.position})`
            );
          }
        } else {
          sections.push(
            `${currentPhase.name} | ${currentPhase.zone} | ${currentPhase.position} | ${currentPhase.cadence}rpm`
          );
          const ongoingPhaseRange = lookupZonePowerRange(currentPhase.zone);
          if (ongoingPhaseRange) {
            sections.push(`Power range for ${currentPhase.zone}: ${ongoingPhaseRange}`);
          }
          sections.push(
            `Phase time: ${formatElapsed(phaseElapsed)} elapsed, ${formatElapsed(phaseRemaining)} remaining`
          );
          if (currentPhase.hr_target) {
            sections.push(`HR target: ${currentPhase.hr_target} (informational)`);
          }
        }

        // Upcoming phase preview when nearing end of current phase
        if (phaseRemaining <= 30_000) {
          const nextPhase = getNextPhase();
          if (nextPhase) {
            const remainingSec = Math.round(phaseRemaining / 1000);
            if (isRecoveryPhase(nextPhase)) {
              sections.push(
                `\u23ED NEXT (in ${remainingSec}s): ${nextPhase.name} | recovery | ${nextPhase.position} | ${nextPhase.cadence}rpm`
              );
            } else {
              sections.push(
                `\u23ED NEXT (in ${remainingSec}s): ${nextPhase.name} | ${nextPhase.zone} | ${nextPhase.position} | ${nextPhase.cadence}rpm`
              );
            }
          }
        }
      }

      const cues = isRecoveryPhase(currentPhase) ? undefined : currentPhase.form_cues;
      if (cues && cues.length > 0) {
        sections.push(`Cues: ${cues.join(", ")}`);
      }

      // Update tracking state after building the message
      lastPhaseName = currentPhase.name;
      lastPhasePosition = currentPhase.position;
    } else {
      sections.push("Workout complete -- cool down.");
    }
  }

  // Current targets (power only, from most recent coach response)
  sections.push("");
  sections.push("## Current Target");
  if (currentPowerTarget !== null) {
    sections.push(`Power: ${currentPowerTarget}W`);
  } else {
    sections.push("No target set yet.");
  }

  // Recent coach messages
  if (coachHistory.length > 0) {
    sections.push("");
    sections.push("## Recent Coach Messages");
    for (const h of coachHistory) {
      sections.push(`[${h.elapsed}] "${h.message}"`);
    }
  }

  // Coach notes (persistent memory, last 3 only)
  if (coachNotes.length > 0) {
    sections.push("");
    sections.push("## Coach Notes");
    const recentNotes = coachNotes.slice(-3);
    for (const n of recentNotes) {
      sections.push(`[${n.elapsed}] ${n.note}`);
    }
  }

  // HR trajectory (minute-by-minute, before recent metrics)
  if (!isStart) {
    const hrTrajectory = buildHrTrajectory();
    if (hrTrajectory) {
      sections.push("");
      sections.push("## HR Trajectory");
      sections.push(hrTrajectory);
    }
  }

  // Recent metrics (15s rolling averages with trend indicators)
  if (!isStart) {
    sections.push("");
    const currentSamples = getRecentSamples(15_000);
    const previousSamples = getSampleWindow(15_000, 30_000);

    if (currentSamples.length > 0) {
      const avg = (arr: number[]) =>
        Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);

      const curPower = avg(currentSamples.map((s) => s.power));
      const curHr = avg(currentSamples.map((s) => s.hr));
      const curCadence = avg(currentSamples.map((s) => s.cadence));

      // Compute trend indicators by comparing current 15s to previous 15s
      let powerTrend = "\u2192";
      let hrTrend = "\u2192";
      let cadenceTrend = "\u2192";

      if (previousSamples.length > 0) {
        const prevPower = avg(previousSamples.map((s) => s.power));
        const prevHr = avg(previousSamples.map((s) => s.hr));
        const prevCadence = avg(previousSamples.map((s) => s.cadence));

        const powerDiff = curPower - prevPower;
        if (powerDiff > 10) powerTrend = "\u2191";
        else if (powerDiff < -10) powerTrend = "\u2193";

        const hrDiff = curHr - prevHr;
        if (hrDiff > 3) hrTrend = "\u2191";
        else if (hrDiff < -3) hrTrend = "\u2193";

        const cadenceDiff = curCadence - prevCadence;
        if (cadenceDiff > 5) cadenceTrend = "\u2191";
        else if (cadenceDiff < -5) cadenceTrend = "\u2193";
      }

      sections.push("## Recent Metrics (15s avg)");
      sections.push(
        `Power ${curPower}W${powerTrend} | HR ${curHr}${hrTrend} | Cadence ${curCadence}${cadenceTrend}`
      );
    } else {
      sections.push("## Recent Metrics (15s avg)");
      sections.push("No samples in last 15s");
    }

    // Single-line status at the very end
    sections.push("");
    sections.push("## Status");
    const { currentPhase: statusPhase, phaseElapsed: statusPhaseElapsed } =
      getCurrentPhaseInfo(elapsed);
    const maxHr = samples.length > 0
      ? Math.max(...samples.map((s) => s.hr))
      : 0;
    const phaseSamples = statusPhaseElapsed > 0
      ? samples.filter((s) => s.receivedAt >= Date.now() - statusPhaseElapsed)
      : [];

    const zonePart = statusPhase
      ? (isRecoveryPhase(statusPhase) ? "Recovery" : statusPhase.zone)
      : "---";
    if (phaseSamples.length > 0) {
      const avgPower = Math.round(
        phaseSamples.reduce((s, x) => s + x.power, 0) / phaseSamples.length
      );
      const avgHr = Math.round(
        phaseSamples.reduce((s, x) => s + x.hr, 0) / phaseSamples.length
      );
      const avgCadence = Math.round(
        phaseSamples.reduce((s, x) => s + x.cadence, 0) / phaseSamples.length
      );
      sections.push(
        `${zonePart} | Phase avg: ${avgPower}W ${avgHr}bpm ${avgCadence}rpm | Max HR: ${maxHr} | Elapsed: ${elapsedStr}`
      );
    } else {
      sections.push(
        `${zonePart} | Phase avg: -- | Max HR: ${maxHr} | Elapsed: ${elapsedStr}`
      );
    }
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

/**
 * Look up the power range string for a zone name (e.g. "Z4" -> "163-188W").
 * Uses the cached zone power ranges computed at workout start.
 */
function lookupZonePowerRange(zoneName: string): string | null {
  if (!cachedZonePowerRanges) return null;
  const range = cachedZonePowerRanges[zoneName];
  if (!range) return null;
  return `${range.min}-${range.max}W`;
}

function getElapsedMs(): number {
  return Date.now() - workoutStartTime;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function getCurrentPhaseInfo(elapsedMs: number): {
  currentPhase: Phase | null;
  phaseElapsed: number;
  phaseRemaining: number;
} {
  if (!currentPlan || currentPhaseIndex >= currentPlan.phases.length)
    return { currentPhase: null, phaseElapsed: 0, phaseRemaining: 0 };

  const phase = currentPlan.phases[currentPhaseIndex];
  const phaseStartTime = phaseStartTimes[currentPhaseIndex] ?? workoutStartTime;
  const phaseElapsed = Date.now() - phaseStartTime;

  if (isRecoveryPhase(phase)) {
    // For recovery phases, remaining is based on max_duration_s
    const maxDurationMs = phase.max_duration_s * 1000;
    const phaseRemaining = Math.max(0, maxDurationMs - phaseElapsed);
    return { currentPhase: phase, phaseElapsed, phaseRemaining };
  } else {
    const durationMs = phase.duration_s * 1000;
    const phaseRemaining = Math.max(0, durationMs - phaseElapsed);
    return { currentPhase: phase, phaseElapsed, phaseRemaining };
  }
}

function advancePhaseIfNeeded(): void {
  if (!currentPlan || currentPhaseIndex >= currentPlan.phases.length) return;

  const phase = currentPlan.phases[currentPhaseIndex];
  const phaseStartTime = phaseStartTimes[currentPhaseIndex] ?? workoutStartTime;
  const phaseElapsedMs = Date.now() - phaseStartTime;

  let shouldAdvance = false;

  if (isRecoveryPhase(phase)) {
    const minElapsed = phaseElapsedMs >= phase.min_duration_s * 1000;
    const maxElapsed = phaseElapsedMs >= phase.max_duration_s * 1000;
    const latestHr = getLatestHr();
    const hrBelowTarget = latestHr !== null && latestHr < phase.target_hr;

    if (maxElapsed) {
      shouldAdvance = true;
      recoveryGateClearedAt = null;
      log(`Recovery phase "${phase.name}" force-advanced (max duration reached)`);
    } else if (minElapsed && hrBelowTarget) {
      // Debounce: HR must stay below target for 15s sustained before advancing
      const now = Date.now();
      if (recoveryGateClearedAt === null) {
        recoveryGateClearedAt = now;
        log(`Recovery gate: HR ${latestHr} below target ${phase.target_hr}, waiting for 15s sustained`);
      } else if (now - recoveryGateClearedAt >= 15_000) {
        shouldAdvance = true;
        log(`Recovery gate: sustained 15s, advancing (HR ${latestHr} <= target ${phase.target_hr})`);
      }
    } else if (!hrBelowTarget && recoveryGateClearedAt !== null) {
      // HR went back above target, reset the sustained check
      log(`Recovery gate: HR ${latestHr ?? "---"} back above target ${phase.target_hr}, resetting`);
      recoveryGateClearedAt = null;
    }
  } else {
    const durationMs = phase.duration_s * 1000;
    if (phaseElapsedMs >= durationMs) {
      shouldAdvance = true;
    }
  }

  if (shouldAdvance && currentPhaseIndex < currentPlan.phases.length - 1) {
    currentPhaseIndex++;
    phaseStartTimes[currentPhaseIndex] = Date.now();
    recoveryGateClearedAt = null;
    log(`Phase advanced to: ${currentPlan.phases[currentPhaseIndex].name}`);

    // Broadcast target event with new phase info so client timeline updates immediately
    const newPhase = currentPlan.phases[currentPhaseIndex];
    const newPhaseTotal = isRecoveryPhase(newPhase) ? newPhase.max_duration_s : newPhase.duration_s;
    broadcast("target", {
      power: currentPowerTarget,
      cadence: newPhase.cadence,
      position: newPhase.position,
      phaseIndex: currentPhaseIndex,
      phaseName: newPhase.name,
      phaseElapsed: 0,
      phaseTotal: newPhaseTotal,
      isRecovery: isRecoveryPhase(newPhase),
      targetHr: isRecoveryPhase(newPhase) ? newPhase.target_hr : undefined,
      phaseMinDuration: isRecoveryPhase(newPhase) ? newPhase.min_duration_s : undefined,
    });
  }
}

function getNextPhase(): Phase | null {
  if (!currentPlan) return null;
  if (currentPhaseIndex >= currentPlan.phases.length - 1) return null;
  return currentPlan.phases[currentPhaseIndex + 1];
}

function getLatestHr(): number | null {
  // Get the most recent HR from last 15 seconds of samples
  const cutoff = Date.now() - 15_000;
  const recent = samples.filter((s) => s.receivedAt >= cutoff && s.hr > 0);
  if (recent.length === 0) return null;
  return Math.round(
    recent.reduce((sum, s) => sum + s.hr, 0) / recent.length
  );
}

/**
 * Handle a coach response: apply power throttling, broadcast targets from plan + coach
 */
function handleCoachResponse(response: CoachResponse): void {
  const now = Date.now();

  // Apply power throttling: only change power if 30s have passed since last change
  let effectivePower = currentPowerTarget;
  if (response.power !== null && response.power !== currentPowerTarget) {
    if (now - lastPowerChangeTime >= 30_000 || currentPowerTarget === null) {
      effectivePower = response.power;
      currentPowerTarget = response.power;
      lastPowerChangeTime = now;
    } else {
      log(`Power change throttled: coach wanted ${response.power}W, keeping ${currentPowerTarget}W`);
    }
  }

  updateCoachHistory(response);
  broadcast("coach", { text: response.message });

  // Broadcast target: power from coach, cadence + position from plan phase
  const { currentPhase, phaseElapsed, phaseRemaining } = getCurrentPhaseInfo(getElapsedMs());
  const phaseCadence = currentPhase ? currentPhase.cadence : null;
  const phasePosition = currentPhase ? currentPhase.position : null;

  const phaseTotal = currentPhase
    ? (isRecoveryPhase(currentPhase) ? currentPhase.max_duration_s : currentPhase.duration_s)
    : undefined;

  broadcast("target", {
    power: effectivePower,
    cadence: phaseCadence,
    position: phasePosition,
    phaseIndex: currentPhaseIndex,
    phaseName: currentPhase?.name,
    phaseElapsed: Math.round(phaseElapsed / 1000),
    phaseTotal,
    isRecovery: currentPhase ? isRecoveryPhase(currentPhase) : undefined,
    targetHr: currentPhase && isRecoveryPhase(currentPhase) ? currentPhase.target_hr : undefined,
    phaseMinDuration: currentPhase && isRecoveryPhase(currentPhase) ? currentPhase.min_duration_s : undefined,
  });

  log(
    `Coach: "${response.message}" | ${effectivePower ?? "---"}W`
  );
}

function getRecentSamples(windowMs: number): Sample[] {
  const cutoff = Date.now() - windowMs;
  return samples.filter((s) => s.receivedAt >= cutoff);
}

/**
 * Get samples from a window between startAgoMs and endAgoMs in the past.
 * e.g. getSampleWindow(15000, 30000) returns samples from 15-30s ago.
 */
function getSampleWindow(startAgoMs: number, endAgoMs: number): Sample[] {
  const now = Date.now();
  const recentCutoff = now - startAgoMs;
  const oldCutoff = now - endAgoMs;
  return samples.filter((s) => s.receivedAt >= oldCutoff && s.receivedAt < recentCutoff);
}

/**
 * Build a minute-by-minute HR trajectory going back up to 5 minutes.
 * For each minute mark, averages HR samples within a ~10s window.
 * "now" is the average of the last 15 seconds.
 */
function buildHrTrajectory(): string | null {
  const now = Date.now();

  // "now" bucket: average HR from last 15 seconds
  const nowSamples = samples.filter((s) => s.hr > 0 && now - s.receivedAt <= 15_000);
  if (nowSamples.length === 0) return null;

  const avg = (arr: number[]) =>
    Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);

  const nowHr = avg(nowSamples.map((s) => s.hr));

  // Minute-mark buckets (5m, 4m, 3m, 2m, 1m ago) with ~10s window
  const marks: { label: string; minutesAgo: number }[] = [
    { label: "5m ago", minutesAgo: 5 },
    { label: "4m ago", minutesAgo: 4 },
    { label: "3m ago", minutesAgo: 3 },
    { label: "2m ago", minutesAgo: 2 },
    { label: "1m ago", minutesAgo: 1 },
  ];

  const points: { label: string; hr: number; minutesAgo: number }[] = [];

  for (const mark of marks) {
    const targetMs = now - mark.minutesAgo * 60_000;
    const windowSamples = samples.filter(
      (s) => s.hr > 0 && Math.abs(s.receivedAt - targetMs) <= 10_000
    );
    if (windowSamples.length > 0) {
      points.push({
        label: mark.label,
        hr: avg(windowSamples.map((s) => s.hr)),
        minutesAgo: mark.minutesAgo,
      });
    }
  }

  // Need at least 1 historical point plus "now" to be useful
  if (points.length === 0) return null;

  // Build the timeline string
  const parts = points.map((p) => `${p.label}: ${p.hr}`);
  parts.push(`now: ${nowHr}`);
  const timeline = parts.join(" | ");

  // Calculate trend from earliest available point to now
  const earliest = points[0];
  const totalChange = nowHr - earliest.hr;
  const spanMinutes = earliest.minutesAgo;

  let trend: string;
  if (Math.abs(totalChange) <= 2) {
    trend = `Stable (\u00B1${Math.abs(totalChange)} bpm over ${spanMinutes} min)`;
  } else if (totalChange > 0) {
    trend = `Rising +${totalChange} bpm over ${spanMinutes} min`;
  } else {
    trend = `Falling ${totalChange} bpm over ${spanMinutes} min`;
  }

  return `${timeline}\n${trend}`;
}

function updateCoachHistory(response: CoachResponse): void {
  const elapsed = formatElapsed(getElapsedMs());
  coachHistory.push({
    elapsed,
    message: response.message,
    power: response.power,
  });
  if (coachHistory.length > MAX_COACH_HISTORY) {
    coachHistory.shift();
  }
  if (response.note) {
    coachNotes.push({ elapsed, note: response.note });
  }
}
