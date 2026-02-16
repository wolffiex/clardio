/**
 * Replay mode: play back a recorded session's sensor data in real time.
 *
 * Loads samples from the PRODUCTION DB, feeds them through the normal
 * metrics pipeline at original timing (adjusted by speed factor), so
 * the coaching system runs fresh against historical sensor data.
 */

import { getProductionDb, getPlanById, getSamplesForPlanFrom } from "./db";
import { broadcast } from "./sse";
import { addMetrics } from "./workout";
import { log } from "./log";

// Track last known values (mirrors routes.ts behavior)
const lastKnown = { power: 0, hr: 0, cadence: 0 };

let replayTimer: ReturnType<typeof setTimeout> | null = null;
let replayActive = false;

export type ReplayPlan = {
  phases: string; // JSON string
  summary: string | null;
};

/**
 * Load the plan and its samples from the production DB.
 * Returns null if the plan or samples don't exist.
 */
export function loadReplayData(planId: number): {
  plan: ReplayPlan;
  samples: Array<{
    timestamp_ms: number;
    duration_ms: number;
    power: number | null;
    hr: number | null;
    cadence: number | null;
  }>;
} | null {
  const prodDb = getProductionDb();
  try {
    const plan = getPlanById(planId, prodDb);
    if (!plan) {
      log(`[replay] Plan ${planId} not found in production DB`);
      return null;
    }

    const samples = getSamplesForPlanFrom(planId, prodDb);
    if (samples.length === 0) {
      log(`[replay] No samples found for plan ${planId}`);
      return null;
    }

    log(`[replay] Loaded plan ${planId}: ${samples.length} samples`);
    return { plan: { phases: plan.phases, summary: plan.summary }, samples };
  } finally {
    prodDb.close();
  }
}

/**
 * Start replaying samples at the given speed factor.
 * Each sample is fed through addMetrics() and broadcast() just like live data.
 */
export function startReplay(
  samples: Array<{
    timestamp_ms: number;
    duration_ms: number;
    power: number | null;
    hr: number | null;
    cadence: number | null;
  }>,
  speed: number
): void {
  if (replayActive) return;
  replayActive = true;

  const totalDurationMs = samples.reduce((sum, s) => sum + s.duration_ms, 0);
  const totalMinutes = (totalDurationMs / 60_000).toFixed(1);
  log(`[replay] Starting playback: ${samples.length} samples, ${totalMinutes} min, ${speed}x speed`);

  let index = 0;

  function feedNext() {
    if (!replayActive || index >= samples.length) {
      replayActive = false;
      log(`[replay] Playback complete (${samples.length} samples fed)`);
      return;
    }

    const sample = samples[index];
    const power = sample.power ?? 0;
    const hr = sample.hr ?? 0;
    const cadence = sample.cadence ?? 0;

    // Merge into lastKnown (same as routes.ts handleMetrics)
    if (power > 0) lastKnown.power = power;
    if (hr > 0) lastKnown.hr = hr;
    if (cadence > 0) lastKnown.cadence = cadence;

    // Broadcast to SSE clients
    broadcast("metrics", { ...lastKnown });

    // Buffer for coach
    addMetrics({ ...lastKnown });

    // Progress log every 30 samples (~30s of data)
    if (index % 30 === 0) {
      const elapsedReplayMs = samples
        .slice(0, index + 1)
        .reduce((sum, s) => sum + s.duration_ms, 0);
      const elapsedMin = Math.floor(elapsedReplayMs / 60_000);
      const elapsedSec = Math.floor((elapsedReplayMs % 60_000) / 1000);
      const totalMin = Math.floor(totalDurationMs / 60_000);
      const totalSec = Math.floor((totalDurationMs % 60_000) / 1000);
      log(
        `[replay] ${elapsedMin}:${String(elapsedSec).padStart(2, "0")} / ${totalMin}:${String(totalSec).padStart(2, "0")} | P:${lastKnown.power}W HR:${lastKnown.hr} C:${lastKnown.cadence}rpm`
      );
    }

    index++;

    // Schedule next sample using the NEXT sample's duration_ms as the delay
    // (duration_ms = time since previous sample)
    if (index < samples.length) {
      const delayMs = Math.max(1, samples[index].duration_ms / speed);
      replayTimer = setTimeout(feedNext, delayMs);
    } else {
      // Last sample done
      replayActive = false;
      log(`[replay] Playback complete (${samples.length} samples fed)`);
    }
  }

  // Feed the first sample immediately
  feedNext();
}

/**
 * Stop an active replay.
 */
export function stopReplay(): void {
  if (replayTimer) {
    clearTimeout(replayTimer);
    replayTimer = null;
  }
  replayActive = false;
}
