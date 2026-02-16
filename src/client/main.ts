import { SSEClient } from "./sse-client";
import { UIController } from "./ui";
import { handlePlan, initTimeline } from "./handlers";
import { TimelineController } from "./timeline";
import type { CoachEvent, MetricsEvent, TargetEvent } from "../shared/types";

// Screen Wake Lock - prevent device from sleeping during workout
let wakeLock: WakeLockSentinel | null = null;

async function requestWakeLock() {
  if (!navigator.wakeLock) {
    console.log("[WakeLock] Not available (requires HTTPS)");
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    console.log('[WakeLock] Acquired');
    wakeLock.addEventListener('release', () => {
      console.log('[WakeLock] Released');
    });
  } catch (err) {
    console.log('[WakeLock] Failed:', err);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestWakeLock();
  }
});

requestWakeLock();

// Initialize
const sse = new SSEClient();
const ui = new UIController();
const timeline = new TimelineController();
initTimeline(timeline);

// Check for test params in URL
const params = new URLSearchParams(window.location.search);
const testMode = params.has("power") || params.has("target_power");

if (testMode) {
  // Test mode: use URL params instead of SSE
  console.log("[App] Test mode enabled via URL params");
  ui.setConnectionStatus("connected");

  // Compute a reasonable elapsed time from phase info
  let timerOffset = 0;
  const phaseIndexParam = params.get("phase_index");
  const phaseElapsedParam = params.get("phase_elapsed");
  if (phaseIndexParam !== null && phaseElapsedParam !== null) {
    const pi = parseInt(phaseIndexParam);
    const pe = parseInt(phaseElapsedParam);
    // Sum durations of all phases before the current one
    const sampleDurations = [300, 300, 120, 180, 240, 60, 180, 300, 240, 120, 300];
    for (let i = 0; i < pi && i < sampleDurations.length; i++) {
      timerOffset += sampleDurations[i];
    }
    timerOffset += pe;
  }
  ui.startTimer(timerOffset);

  const message = params.get("message");
  if (message) {
    ui.updateCoach({ text: message });
  }

  // Test mode plan: create a sample plan for timeline testing
  const phaseIndex = params.has("phase_index") ? parseInt(params.get("phase_index")!) : -1;
  const phaseElapsed = params.has("phase_elapsed") ? parseInt(params.get("phase_elapsed")!) : 0;

  if (phaseIndex >= 0) {
    // Provide a sample plan for timeline testing
    const samplePlan = {
      summary: "Threshold intervals with standing surges",
      phases: [
        { name: "Easy Spin",      zone: "Z1", duration_s: 300, position: "seated",   cadence: 75 },
        { name: "Build",          zone: "Z2", duration_s: 300, position: "seated",   cadence: 85 },
        { name: "Opener",         zone: "Z4", duration_s: 120, position: "seated",   cadence: 92 },
        { name: "Recovery",       type: "recovery", target_hr: 130, max_duration_s: 180, position: "seated", cadence: 75 },
        { name: "Threshold 1",    zone: "Z4", duration_s: 240, position: "seated",   cadence: 90 },
        { name: "Standing Surge", zone: "Z5", duration_s: 60,  position: "standing", cadence: 65 },
        { name: "Recovery",       type: "recovery", target_hr: 125, max_duration_s: 180, position: "seated", cadence: 75 },
        { name: "Sweet Spot",     zone: "Sweet Spot", duration_s: 300, position: "seated", cadence: 90 },
        { name: "Threshold 2",    zone: "Z4", duration_s: 240, position: "seated",   cadence: 90 },
        { name: "Recovery",       type: "recovery", target_hr: 120, max_duration_s: 120, position: "seated", cadence: 75 },
        { name: "Cooldown",       zone: "Z1", duration_s: 300, position: "seated",   cadence: 70 },
      ],
    };
    handlePlan(samplePlan);

    // Set current phase info
    const currentPhase = samplePlan.phases[phaseIndex];
    const isRecoveryPhase = currentPhase?.type === "recovery";
    const phaseDuration = currentPhase
      ? (isRecoveryPhase ? null : (currentPhase.duration_s ?? 60))
      : 60;

    // Simulate server timestamps: phase started phaseElapsed seconds ago
    const now = Date.now();
    const fakePhaseStartedAt = now - phaseElapsed * 1000;

    timeline.updatePhase({
      phaseIndex,
      phaseName: currentPhase?.name ?? "",
      phaseStartedAt: fakePhaseStartedAt,
      phaseDuration,
      isRecovery: isRecoveryPhase,
      targetHr: isRecoveryPhase ? currentPhase?.target_hr : undefined,
      serverTimestamp: now,
    });
  }

  const targetPower = params.get("target_power");
  const targetCadence = params.get("target_cadence");
  if (targetPower || targetCadence) {
    const testNow = Date.now();
    ui.updateTarget({
      power: targetPower ? parseInt(targetPower) : null,
      cadence: targetCadence ? parseInt(targetCadence) : null,
      position: null,
      phaseIndex: 0,
      phaseName: "",
      phaseStartedAt: testNow,
      phaseDuration: null,
      isRecovery: false,
      serverTimestamp: testNow,
    });
  }

  const power = params.get("power");
  const cadence = params.get("cadence");
  const hr = params.get("hr");
  if (power && cadence) {
    ui.updateMetrics({
      power: parseInt(power),
      hr: hr ? parseInt(hr) : 120,
      cadence: parseInt(cadence),
    });
  }

  // Support second update for testing state transitions
  const power2 = params.get("power2");
  const cadence2 = params.get("cadence2");
  if (power2 && cadence2) {
    ui.updateMetrics({
      power: parseInt(power2),
      hr: hr ? parseInt(hr) : 120,
      cadence: parseInt(cadence2),
    });
  }
} else {
  // Normal mode: connect to SSE
  sse.on("connected", () => {
    console.log("[App] SSE connected event received");
    ui.setConnectionStatus("connected");
    ui.startTimer();
  });

  sse.on("coach", (data) => {
    ui.updateCoach(data as CoachEvent);
  });

  sse.on("metrics", (data) => {
    ui.updateMetrics(data as MetricsEvent);
  });

  sse.on("target", (data) => {
    ui.updateTarget(data as TargetEvent | null);
  });

  sse.on("plan", (data) => {
    handlePlan(data);
  });

  sse.on("_connected", () => {
    ui.setConnectionStatus("connecting");
  });

  sse.on("_error", () => {
    ui.setConnectionStatus("disconnected");
    ui.stopTimer();
  });

  sse.connect();
}

console.log("[App] Clardio UI initialized");
