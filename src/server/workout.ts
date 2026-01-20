/**
 * Workout session manager
 *
 * Buffers metrics, runs timer, calls coach every interval
 */

import type { MetricsEvent, CoachEvent, TargetEvent } from "../shared/types";
import { initCoach, sendStart, sendMetrics, resetCoach } from "./coach";
import { broadcast } from "./sse";
import { log } from "./log";

const COACH_INTERVAL_MS = 20_000; // 20 seconds

interface TimestampedMetrics extends MetricsEvent {
  receivedAt: number; // Date.now() when received
}

interface MetricsBuffer {
  samples: TimestampedMetrics[];
  startTime: number;
  lastSeenIndex: number; // Index of last sample shown to coach
}

let buffer: MetricsBuffer | null = null;
let coachTimer: Timer | null = null;
let workoutActive = false;

/**
 * Build coach prompt from buffered metrics
 * Format:
 *   Xs ago: hr:X cadence:Y power:Z
 *   Ys ago: hr:X cadence:Y power:Z
 *   hr 45s: X→Y (trend)
 *
 * @param newSamples - samples to display (since last coach tick)
 * @param allSamples - all samples for HR trend calculation
 */
function buildCoachPrompt(newSamples: TimestampedMetrics[], allSamples: TimestampedMetrics[]): string {
  if (newSamples.length === 0) {
    return "No metrics yet.";
  }

  const now = Date.now();
  const lines: string[] = [];

  // Individual new samples with "Xs ago"
  for (const sample of newSamples) {
    const secsAgo = Math.round((now - sample.receivedAt) / 1000);
    lines.push(`${secsAgo}s ago: hr:${sample.hr} cadence:${sample.cadence} power:${sample.power}`);
  }

  // HR trend over last 45 seconds (using all samples)
  const cutoff = now - 45_000;
  const recentSamples = allSamples.filter(s => s.receivedAt >= cutoff);
  if (recentSamples.length >= 2) {
    const firstHr = recentSamples[0].hr;
    const lastHr = recentSamples[recentSamples.length - 1].hr;
    const diff = lastHr - firstHr;

    let hrDescription: string;
    if (Math.abs(diff) <= 3) {
      hrDescription = "heart rate steady";
    } else if (diff > 10) {
      hrDescription = "heart rate climbing quickly";
    } else if (diff > 3) {
      hrDescription = "heart rate climbing";
    } else if (diff < -10) {
      hrDescription = "heart rate falling quickly";
    } else {
      hrDescription = "heart rate falling";
    }
    lines.push(hrDescription);
  }

  // Add elapsed time in mm:ss
  const elapsed = getElapsed();
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  lines.push(`elapsed: ${mins}:${secs.toString().padStart(2, "0")}`);

  return lines.join("\n");
}

function getTrend(first: number, second: number, threshold: number): string {
  const diff = second - first;
  if (diff > threshold) return "↑";
  if (diff < -threshold) return "↓";
  return "";
}

/**
 * Called every COACH_INTERVAL_MS
 */
async function onCoachTick() {
  if (!buffer || !workoutActive) return;

  // Get new samples since last seen
  const newSamples = buffer.samples.slice(buffer.lastSeenIndex);

  if (newSamples.length === 0) {
    log("Coach tick: no new samples, skipping");
    return;
  }

  // Update last seen index
  buffer.lastSeenIndex = buffer.samples.length;

  // Build prompt with new samples, but pass all samples for HR trend
  const prompt = buildCoachPrompt(newSamples, buffer.samples);
  log(`Coach tick: ${newSamples.length} new samples (${buffer.samples.length} total)`);

  try {
    const response = await sendMetrics(prompt);

    log(`Coach: "${response.message}"`);

    // Broadcast coach message
    broadcast("coach", { text: response.message } satisfies CoachEvent);

    // Broadcast target
    const targetEvent: TargetEvent = {
      power: response.target.power,
      cadence: response.target.cadence,
    };
    broadcast("target", targetEvent);
    log(`Target: ${targetEvent.power}W ${targetEvent.cadence}rpm`);
  } catch (err) {
    log(`Coach error: ${err}`);
  }
}

/**
 * Start a workout session
 */
export async function startWorkout(): Promise<void> {
  if (workoutActive) {
    log("Workout already active");
    return;
  }

  log("Starting workout session...");

  // Init coach (loads system prompt with workout history)
  await initCoach();

  // Init buffer
  buffer = {
    samples: [],
    startTime: Date.now(),
    lastSeenIndex: 0,
  };

  workoutActive = true;

  // Start timer
  coachTimer = setInterval(onCoachTick, COACH_INTERVAL_MS);

  log(`Workout started, coach interval: ${COACH_INTERVAL_MS / 1000}s`);

  // Get initial greeting from coach
  try {
    const response = await sendStart();
    log(`Coach: "${response.message}"`);
    broadcast("coach", { text: response.message } satisfies CoachEvent);

    const targetEvent: TargetEvent = {
      power: response.target.power,
      cadence: response.target.cadence,
    };
    broadcast("target", targetEvent);
    log(`Target: ${targetEvent.power}W ${targetEvent.cadence}rpm`);
  } catch (err) {
    log(`Coach start error: ${err}`);
  }
}

/**
 * Stop the workout session
 */
export function stopWorkout(): void {
  if (!workoutActive) return;

  if (coachTimer) {
    clearInterval(coachTimer);
    coachTimer = null;
  }

  buffer = null;
  workoutActive = false;
  resetCoach();

  log("Workout stopped");
}

/**
 * Add metrics to the buffer
 */
export function addMetrics(metrics: MetricsEvent): void {
  if (!buffer || !workoutActive) return;
  buffer.samples.push({ ...metrics, receivedAt: Date.now() });
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
  if (!buffer || !workoutActive) return 0;
  return Math.floor((Date.now() - buffer.startTime) / 1000);
}
