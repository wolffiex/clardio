/**
 * Workout session manager
 *
 * Buffers metrics, runs timer, calls coach every interval
 */

import type { MetricsEvent, CoachEvent, TargetEvent } from "../shared/types";
import { initCoach, sendStart, sendMetrics, resetCoach } from "./coach";
import { broadcast } from "./sse";

const COACH_INTERVAL_MS = 20_000; // 20 seconds

interface MetricsBuffer {
  samples: MetricsEvent[];
  startTime: number;
}

let buffer: MetricsBuffer | null = null;
let coachTimer: Timer | null = null;
let workoutActive = false;

function log(message: string) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${time}] ${message}`);
}

/**
 * Summarize buffered metrics with micro trends
 */
function summarizeMetrics(samples: MetricsEvent[]): string {
  if (samples.length === 0) {
    return "No metrics yet.";
  }

  const latest = samples[samples.length - 1];

  // Calculate averages
  const avgPower = Math.round(samples.reduce((s, m) => s + m.power, 0) / samples.length);
  const avgHr = Math.round(samples.reduce((s, m) => s + m.hr, 0) / samples.length);
  const avgCadence = Math.round(samples.reduce((s, m) => s + m.cadence, 0) / samples.length);

  // Calculate trends (compare first half to second half)
  const mid = Math.floor(samples.length / 2);
  if (samples.length >= 4) {
    const firstHalf = samples.slice(0, mid);
    const secondHalf = samples.slice(mid);

    const firstPower = firstHalf.reduce((s, m) => s + m.power, 0) / firstHalf.length;
    const secondPower = secondHalf.reduce((s, m) => s + m.power, 0) / secondHalf.length;

    const firstHr = firstHalf.reduce((s, m) => s + m.hr, 0) / firstHalf.length;
    const secondHr = secondHalf.reduce((s, m) => s + m.hr, 0) / secondHalf.length;

    const firstCadence = firstHalf.reduce((s, m) => s + m.cadence, 0) / firstHalf.length;
    const secondCadence = secondHalf.reduce((s, m) => s + m.cadence, 0) / secondHalf.length;

    const powerTrend = getTrend(firstPower, secondPower, 5);
    const hrTrend = getTrend(firstHr, secondHr, 3);
    const cadenceTrend = getTrend(firstCadence, secondCadence, 3);

    return `elapsed:${getElapsed()}s | power:${avgPower}W${powerTrend} hr:${avgHr}bpm${hrTrend} cadence:${avgCadence}rpm${cadenceTrend} (${samples.length} samples)`;
  }

  // Not enough for trends
  return `elapsed:${getElapsed()}s | power:${avgPower}W hr:${avgHr}bpm cadence:${avgCadence}rpm (${samples.length} samples)`;
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

  const samples = buffer.samples;
  buffer.samples = []; // Clear for next interval

  if (samples.length === 0) {
    log("Coach tick: no samples, skipping");
    return;
  }

  const summary = summarizeMetrics(samples);
  log(`Coach tick: ${summary}`);

  try {
    // Build a fake MetricsEvent with the latest values for the coach
    const latest = samples[samples.length - 1];
    const response = await sendMetrics(latest);

    log(`Coach: "${response.message}"`);

    // Broadcast coach message
    broadcast("coach", { text: response.message } satisfies CoachEvent);

    // Broadcast target if set
    if (response.target) {
      const targetEvent: TargetEvent = {
        power: response.target.power,
        cadence: response.target.cadence,
      };
      broadcast("target", targetEvent);
      log(`Target: ${targetEvent.power}W ${targetEvent.cadence}rpm`);
    }
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

    if (response.target) {
      const targetEvent: TargetEvent = {
        power: response.target.power,
        cadence: response.target.cadence,
      };
      broadcast("target", targetEvent);
      log(`Target: ${targetEvent.power}W ${targetEvent.cadence}rpm`);
    }
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
  buffer.samples.push(metrics);
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
