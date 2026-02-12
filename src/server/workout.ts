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
} from "./coach-prompt";
import { planWorkout, sendCoachMessage } from "./coach";
import { savePlan, getRecentPlans, saveSample, saveCoachTick } from "./db";
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

// Coach notes (persistent memory across ticks)
let coachNotes: Array<{ elapsed: string; note: string }> = [];

// Cached zones text (computed once at workout start, never recalculated mid-workout)
let cachedZonesText: string = "";

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
  currentPhaseIndex = 0;
  phaseStartTimes = [];
  lastPowerChangeTime = 0;
  currentPowerTarget = null;
  coachNotes = [];
  currentPlan = null;
  currentPlanId = null;

  try {
    // 0. Cache zones BEFORE any samples are saved (avoids warmup data polluting zones)
    cachedZonesText = getZonesText();

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
            position: phase.position,
          };
        }
        return {
          name: phase.name,
          duration_s: phase.duration_s,
          zone: phase.zone,
          position: phase.position,
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
  coachHistory = [];
  samples = [];
  lastSampleTime = null;
  currentPhaseIndex = 0;
  phaseStartTimes = [];
  lastPowerChangeTime = 0;
  currentPowerTarget = null;
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

  // Workout timestamp at the very top
  sections.push(`WORKOUT TIME: ${elapsedStr}`);
  sections.push("");

  // Plan and current phase
  if (currentPlan) {
    const { currentPhase, phaseElapsed, phaseRemaining } =
      getCurrentPhaseInfo(elapsed);

    // Full plan overview (compact)
    sections.push("## Plan");
    sections.push(currentPlan.summary);
    for (let i = 0; i < currentPlan.phases.length; i++) {
      const phase = currentPlan.phases[i];
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

  // Coach notes (persistent memory)
  if (coachNotes.length > 0) {
    sections.push("");
    sections.push("## Coach Notes");
    for (const n of coachNotes) {
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
    const hrBelowTarget = latestHr !== null && latestHr <= phase.target_hr;

    if (maxElapsed) {
      shouldAdvance = true;
      log(`Recovery phase "${phase.name}" force-advanced (max duration reached)`);
    } else if (minElapsed && hrBelowTarget) {
      shouldAdvance = true;
      log(`Recovery phase "${phase.name}" advanced (HR ${latestHr} <= target ${phase.target_hr})`);
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
    log(`Phase advanced to: ${currentPlan.phases[currentPhaseIndex].name}`);
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
  const { currentPhase } = getCurrentPhaseInfo(getElapsedMs());
  const phaseCadence = currentPhase ? currentPhase.cadence : null;
  const phasePosition = currentPhase ? currentPhase.position : null;

  broadcast("target", {
    power: effectivePower,
    cadence: phaseCadence,
    position: phasePosition,
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
