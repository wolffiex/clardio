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
  type HrZones,
  isRecoveryPhase,
  buildPlanningSystemPrompt,
  buildPlanningUserPrompt,
  buildCoachingSystemPrompt,
  getZonesText,
  getHrZoneLabel,
  loadRiderData,
  loadSessionsFromDb,
  buildRiderProfileFromDb,
  buildCompactTrends,
} from "./coach-prompt";
import { planWorkout, sendCoachMessage } from "./coach";
import { savePlan, getRecentPlans, saveSample, saveCoachTick } from "./db";
import { broadcast } from "./sse";
import { log } from "./log";
import { loadReplayData, startReplay, stopReplay } from "./replay";
import { replayPlanId, replaySpeed, isReplay } from "./replay-config";

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

// Form cue rotation: cycles through cues one per tick, resets on phase change
let formCueIndex: number = 0;

// Phase tracking for dynamic (recovery) phases
let currentPhaseIndex: number = 0;
let phaseStartTimes: number[] = []; // ms timestamp when each phase started

// Power change throttling
let lastPowerChangeTime: number = 0;
let currentPowerTarget: number | null = null;

// Recovery HR gate debounce: tracks when HR first dropped below target
// HR must stay below target for 15s sustained before advancing
let recoveryGateClearedAt: number | null = null;

// Coach note (single baton pass from previous tick)
let previousCoachNote: string | null = null;

// Cached zones text (computed once at workout start, never recalculated mid-workout)
let cachedZonesText: string = "";

// Cached HR zones for zone label annotations
let cachedHrZones: HrZones | null = null;

// Cached rider profile text (computed once at workout start)
let cachedRiderProfile: string = "";

// Cached compact session trends (computed once at workout start)
let cachedSessionTrends: string = "";

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
  formCueIndex = 0;
  currentPhaseIndex = 0;
  phaseStartTimes = [];
  lastPowerChangeTime = 0;
  currentPowerTarget = null;
  recoveryGateClearedAt = null;
  previousCoachNote = null;
  currentPlan = null;
  currentPlanId = null;

  // Replay data loaded outside try so it's available for the replay start below
  let replayData: ReturnType<typeof loadReplayData> = null;

  try {
    // 0. Cache zones, HR zones, rider profile, and session trends BEFORE any
    //    samples are saved (avoids warmup data polluting zones)
    cachedZonesText = getZonesText();
    const riderData = loadRiderData();
    cachedHrZones = riderData.zones.hrZones;
    cachedRiderProfile = buildRiderProfileFromDb();
    const sessions = loadSessionsFromDb();
    cachedSessionTrends = buildCompactTrends(sessions);

    if (replayPlanId !== null) {
      // --- REPLAY MODE: load plan + samples from production DB ---
      replayData = loadReplayData(replayPlanId);
      if (!replayData) {
        throw new Error(`Replay: plan ${replayPlanId} not found or has no samples`);
      }

      const phases: Phase[] = JSON.parse(replayData.plan.phases);
      currentPlan = {
        summary: replayData.plan.summary ?? `Replay of plan ${replayPlanId}`,
        phases,
      };
      log(`[replay] Using plan: ${currentPlan.summary}`);
    } else {
      // --- NORMAL MODE: generate fresh plan ---
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
    }
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

    // 3. Save plan to SQLite (skip in replay mode)
    if (!isReplay) {
      currentPlanId = savePlan(JSON.stringify(currentPlan.phases));
    }

    // 3.5 Broadcast plan to SSE clients for timeline rendering
    broadcast("plan", {
      summary: currentPlan.summary,
      phases: currentPlan.phases.map(phase => {
        if (isRecoveryPhase(phase)) {
          return {
            name: phase.name,
            type: "recovery",
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

    // 5.5 Save initial coach tick (skip in replay mode)
    if (!isReplay && currentPlanId) {
      const elapsedS = getElapsedMs() / 1000;
      saveCoachTick(currentPlanId, elapsedS, "[initial]", response, lastLatencyMs);
    }

    // 6. Start the 10-second coaching loop (adjusted by replay speed)
    const coachIntervalMs = replayPlanId !== null
      ? COACH_INTERVAL_MS / replaySpeed
      : COACH_INTERVAL_MS;
    coachTimer = setInterval(onCoachTick, coachIntervalMs);

    // 7. If replay mode, start feeding samples
    if (replayPlanId !== null && replayData) {
      startReplay(replayData.samples, replaySpeed);
    }
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

  // Stop replay if active
  stopReplay();

  log("Workout stopped.");

  // Reset state
  currentPlan = null;
  currentPlanId = null;
  coachingPrompt = "";
  cachedZonesText = "";
  cachedHrZones = null;
  cachedRiderProfile = "";
  cachedSessionTrends = "";
  coachHistory = [];
  samples = [];
  lastSampleTime = null;
  currentPhaseIndex = 0;
  phaseStartTimes = [];
  lastPowerChangeTime = 0;
  currentPowerTarget = null;
  recoveryGateClearedAt = null;
  formCueIndex = 0;
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

  // Save to SQLite (skip first sample since durationMs is 0, skip in replay mode)
  if (!isReplay && currentPlanId && durationMs > 0) {
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

    // Save coach tick to DB (skip in replay mode)
    if (!isReplay && currentPlanId) {
      const elapsedS = getElapsedMs() / 1000;
      saveCoachTick(currentPlanId, elapsedS, userMessage, response, lastLatencyMs);
    }
  } catch (err) {
    console.error("Coach tick error:", err);
    // Save failed tick to DB (skip in replay mode)
    if (!isReplay && currentPlanId) {
      const elapsedS = getElapsedMs() / 1000;
      saveCoachTick(currentPlanId, elapsedS, userMessage ?? "", null, null);
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

  // Compute avg latency for use in closing section
  let avgLatencyMs = 0;
  if (!isStart && tickLatencies.length > 0) {
    const recentLatencies = tickLatencies.slice(-5);
    avgLatencyMs =
      recentLatencies.reduce((s, x) => s + x, 0) / recentLatencies.length;
  }

  // Pre-compute phase info (used by multiple sections below)
  let phaseInfo: { currentPhase: Phase | null; phaseElapsed: number; phaseRemaining: number } =
    { currentPhase: null, phaseElapsed: 0, phaseRemaining: 0 };
  if (currentPlan) {
    phaseInfo = getCurrentPhaseInfo(elapsed);
  }

  // =========================================================================
  // 1. RIDER PROFILE — Background: who is this rider
  // =========================================================================

  // Rider profile (cached at workout start)
  if (cachedRiderProfile) {
    sections.push("## Rider Profile");
    sections.push(cachedRiderProfile);
  }

  // =========================================================================
  // 2. SESSION TRENDS — Background: how they've been doing across sessions
  // =========================================================================

  // Session trends (cached at workout start)
  if (cachedSessionTrends) {
    sections.push("");
    sections.push("## Session Trends");
    sections.push(cachedSessionTrends);
  }

  // =========================================================================
  // 3. ZONES — Background: HR zones and FTP reference
  // =========================================================================

  // Zones (cached at workout start -- never recalculated mid-workout)
  sections.push("");
  sections.push("## Zones");
  sections.push(cachedZonesText);

  // =========================================================================
  // 4. PLAN OVERVIEW — Today's workout: the full plan with phases
  // =========================================================================

  if (currentPlan) {
    // Plan overview (current + next 2 phases, with remaining count)
    // During recovery phases, hide next-phase details to prevent premature announcements
    sections.push("");
    sections.push("## Plan");
    sections.push(currentPlan.summary);
    const planPhases = currentPlan.phases;
    const currentIsRecovery = isRecoveryPhase(planPhases[currentPhaseIndex]);
    const visibleEnd = Math.min(currentPhaseIndex + 3, planPhases.length);
    for (let i = currentPhaseIndex; i < visibleEnd; i++) {
      const phase = planPhases[i];
      const marker = i === currentPhaseIndex ? "->" : "  ";
      if (i > currentPhaseIndex && currentIsRecovery) {
        // During recovery, only show that more phases exist, not their details
        sections.push(`${marker} (next phase begins when recovery conditions are met)`);
        break; // Don't show any further phases
      } else if (isRecoveryPhase(phase)) {
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
    if (remainingAfterVisible > 0 && !currentIsRecovery) {
      sections.push(`   (+${remainingAfterVisible} more phase${remainingAfterVisible === 1 ? "" : "s"})`);
    }
  }

  // =========================================================================
  // 5. RECENT COACH MESSAGES — Recent past: what coach said recently
  // =========================================================================

  // Recent coach messages
  if (coachHistory.length > 0) {
    sections.push("");
    sections.push("## Recent Coach Messages");
    for (const h of coachHistory) {
      sections.push(`[${h.elapsed}] "${h.message}"`);
    }
  }

  // =========================================================================
  // 6. CURRENT PHASE — Right now: what phase we're in, elapsed/remaining, cues
  // =========================================================================

  if (currentPlan) {
    const { currentPhase, phaseElapsed, phaseRemaining } = phaseInfo;

    sections.push("");
    sections.push("## Current Phase (AUTHORITATIVE — do not override)");
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
          sections.push(getPreviousPhaseDescription());
          sections.push(
            `Recovery -- target HR: ${currentPhase.target_hr}, elapsed: ${Math.round(phaseElapsed / 1000)}s, max: ${currentPhase.max_duration_s}s`
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
            `Recovery -- target HR: ${currentPhase.target_hr}, elapsed: ${Math.round(phaseElapsed / 1000)}s, max: ${currentPhase.max_duration_s}s`
          );
          sections.push(`${currentPhase.name} | recovery | ${currentPhase.position} | ${currentPhase.cadence}rpm`);

          // HR proximity indicator for recovery phases
          if (latestHr !== null) {
            const gap = latestHr - currentPhase.target_hr;
            if (gap > 0 && gap <= 5) {
              sections.push(`\u26A1 HR approaching target — next phase imminent`);
            } else if (gap > 5 && gap <= 10) {
              sections.push(`HR trending toward target`);
            }
          }
        }
      } else {
        // Timed phase display
        if (isNewPhase) {
          const positionChanged = lastPhasePosition !== null && currentPhase.position !== lastPhasePosition;
          sections.push(
            `\u{1F504} NEW PHASE -- was "${lastPhaseName}", now entering "${currentPhase.name}"`
          );
          sections.push(getPreviousPhaseDescription());
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
        // Reset cue index on phase change
        if (lastPhaseName !== null && currentPhase.name !== lastPhaseName) {
          formCueIndex = 0;
        }
        // Show each cue exactly once; after all delivered, omit the cue line
        if (formCueIndex < cues.length) {
          sections.push(`Cue: ${cues[formCueIndex]}`);
          sections.push(`(${formCueIndex + 1} of ${cues.length} phase cues)`);
        }
        // If formCueIndex >= cues.length, no cue line — coach is free to observe, push, or stay quiet
        formCueIndex++;
      }

      // Update tracking state after building the message
      lastPhaseName = currentPhase.name;
      lastPhasePosition = currentPhase.position;
    }
  }

  // =========================================================================
  // 7. RECENT METRICS + HR TRAJECTORY — Right now: latest sensor data and HR trend
  // =========================================================================

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

      const hrZoneLabel = cachedHrZones ? ` (${getHrZoneLabel(curHr, cachedHrZones)})` : "";
      sections.push("## Recent Metrics (15s avg)");
      sections.push(
        `Power ${curPower}W${powerTrend} | HR ${curHr}${hrZoneLabel}${hrTrend} | Cadence ${curCadence}${cadenceTrend}`
      );
    } else {
      sections.push("## Recent Metrics (15s avg)");
      sections.push("No samples in last 15s");
    }

    // HR trajectory (current HR + trend, grouped with recent metrics)
    const hrTrajectory = buildHrTrajectory();
    if (hrTrajectory) {
      sections.push("");
      sections.push("## HR Trajectory");
      sections.push(hrTrajectory);
    }
  }

  // =========================================================================
  // 8. CURRENT TARGET — What was last set: power and cadence targets
  // =========================================================================

  // Current targets (power only, from most recent coach response)
  sections.push("");
  sections.push("## Current Target");
  if (currentPowerTarget !== null) {
    sections.push(`Power: ${currentPowerTarget}W`);
  } else {
    sections.push("No target set yet.");
  }

  // =========================================================================
  // 9. NOTE FROM PREVIOUS TICK — Baton pass: the coach's note to itself
  // =========================================================================

  // Single note from previous tick (baton pass)
  if (previousCoachNote) {
    sections.push("");
    sections.push("## Note from previous tick");
    sections.push(previousCoachNote);
  }

  // =========================================================================
  // 10. WHEN THIS ARRIVES — Timing: latency-adjusted timing context (always last)
  // =========================================================================

  if (!isStart) {
    sections.push("");
    sections.push("## When This Arrives");

    // Latency-adjusted phase timing: project forward by avg latency
    const { currentPhase: closingPhase, phaseElapsed: closingPhaseElapsed, phaseRemaining: closingPhaseRemaining } =
      getCurrentPhaseInfo(elapsed);
    const adjustedElapsed = elapsed + avgLatencyMs;
    const adjustedPhaseElapsed = closingPhaseElapsed + avgLatencyMs;
    const adjustedPhaseRemaining = Math.max(0, closingPhaseRemaining - avgLatencyMs);
    const avgLatencySec = avgLatencyMs / 1000;

    sections.push(
      `Workout elapsed: ${formatElapsed(adjustedElapsed)} | Phase: ${formatElapsed(adjustedPhaseElapsed)} elapsed, ${formatElapsed(adjustedPhaseRemaining)} remaining`
    );
    sections.push(
      `Avg response time: ${avgLatencySec.toFixed(1)}s | Your message displays at ~${formatElapsed(adjustedElapsed)}`
    );

    // Phase averages and max HR
    const maxHr = samples.length > 0
      ? Math.max(...samples.map((s) => s.hr))
      : 0;
    const { phaseElapsed: statusPhaseElapsed } = getCurrentPhaseInfo(elapsed);
    let phaseSamples = statusPhaseElapsed > 0
      ? samples.filter((s) => s.receivedAt >= Date.now() - statusPhaseElapsed)
      : [];

    // Right after a phase transition, phaseElapsed is near 0 so no samples
    // exist yet for the new phase. Fall back to the last 15s of samples
    // (spanning the phase boundary) so the coach never sees "Phase avg: --".
    if (phaseSamples.length === 0) {
      phaseSamples = getRecentSamples(15_000);
    }

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
        `Phase avg: ${avgPower}W ${avgHr}bpm ${avgCadence}rpm | Max HR: ${maxHr}`
      );
    } else {
      sections.push(
        `Phase avg: -- | Max HR: ${maxHr}`
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
    const maxElapsed = phaseElapsedMs >= phase.max_duration_s * 1000;
    const latestHr = getLatestHr();
    const hrBelowTarget = latestHr !== null && latestHr < phase.target_hr;

    if (maxElapsed) {
      shouldAdvance = true;
      recoveryGateClearedAt = null;
      log(`Recovery phase "${phase.name}" force-advanced (max duration reached)`);
    } else if (hrBelowTarget) {
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
    broadcast("target", {
      power: currentPowerTarget,
      cadence: newPhase.cadence,
      position: newPhase.position,
      phaseIndex: currentPhaseIndex,
      phaseName: newPhase.name,
      phaseStartedAt: phaseStartTimes[currentPhaseIndex],
      phaseDuration: isRecoveryPhase(newPhase) ? null : newPhase.duration_s,
      isRecovery: isRecoveryPhase(newPhase),
      targetHr: isRecoveryPhase(newPhase) ? newPhase.target_hr : undefined,
      serverTimestamp: Date.now(),
    });
  }
}

function getNextPhase(): Phase | null {
  if (!currentPlan) return null;
  if (currentPhaseIndex >= currentPlan.phases.length - 1) return null;
  return currentPlan.phases[currentPhaseIndex + 1];
}

function getPreviousPhaseDescription(): string {
  if (!currentPlan || currentPhaseIndex === 0) return "";
  const prev = currentPlan.phases[currentPhaseIndex - 1];
  if (isRecoveryPhase(prev)) {
    return `Transitioned from: ${prev.name} (HR-gated recovery)`;
  }
  return `Transitioned from: ${prev.name} (${prev.zone}, ${Math.round(prev.duration_s / 60)}min)`;
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
    phaseIndex: currentPhaseIndex,
    phaseName: currentPhase?.name ?? "",
    phaseStartedAt: phaseStartTimes[currentPhaseIndex] ?? workoutStartTime,
    phaseDuration: currentPhase
      ? (isRecoveryPhase(currentPhase) ? null : currentPhase.duration_s)
      : null,
    isRecovery: currentPhase ? isRecoveryPhase(currentPhase) : false,
    targetHr: currentPhase && isRecoveryPhase(currentPhase) ? currentPhase.target_hr : undefined,
    serverTimestamp: Date.now(),
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
 * Build a simplified HR trajectory: current HR with zone label and a brief trend.
 * Compares current 15s average against 2-minute-ago average to determine direction.
 */
function buildHrTrajectory(): string | null {
  const now = Date.now();

  // "now" bucket: average HR from last 15 seconds
  const nowSamples = samples.filter((s) => s.hr > 0 && now - s.receivedAt <= 15_000);
  if (nowSamples.length === 0) return null;

  const avg = (arr: number[]) =>
    Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);

  const nowHr = avg(nowSamples.map((s) => s.hr));
  const zoneLabel = cachedHrZones ? ` (${getHrZoneLabel(nowHr, cachedHrZones)})` : "";

  // Compare against ~2 minutes ago for trend
  const twoMinAgoSamples = samples.filter(
    (s) => s.hr > 0 && Math.abs(s.receivedAt - (now - 120_000)) <= 15_000
  );

  if (twoMinAgoSamples.length === 0) {
    return `HR ${nowHr}${zoneLabel}`;
  }

  const twoMinAgoHr = avg(twoMinAgoSamples.map((s) => s.hr));
  const change = nowHr - twoMinAgoHr;

  let trend: string;
  if (Math.abs(change) <= 2) {
    trend = "stable";
  } else if (change > 0) {
    trend = "rising";
  } else {
    trend = "falling";
  }

  return `HR ${nowHr}${zoneLabel} — ${trend}`;
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
    previousCoachNote = response.note;
  }
}
