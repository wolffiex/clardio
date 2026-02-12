import { SSEClient } from "./sse-client";
import { UIController } from "./ui";
import { handlePlan, initTimeline } from "./handlers";
import { TimelineController } from "./timeline";
import type { CoachEvent, MetricsEvent, TargetEvent } from "../shared/types";

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
  ui.startTimer();

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
        { name: "Easy Spin",      zone: "Z1", duration_s: 300, position: "seated",   cadence: "70-80" },
        { name: "Build",          zone: "Z2", duration_s: 300, position: "seated",   cadence: "80-90" },
        { name: "Opener",         zone: "Z4", duration_s: 120, position: "seated",   cadence: "90-95" },
        { name: "Recovery",       type: "recovery", min_duration_s: 60, max_duration_s: 180, position: "seated", cadence: "70-80" },
        { name: "Threshold 1",    zone: "Z4", duration_s: 240, position: "seated",   cadence: "85-95" },
        { name: "Standing Surge", zone: "Z5", duration_s: 60,  position: "standing", cadence: "60-70" },
        { name: "Recovery",       type: "recovery", min_duration_s: 60, max_duration_s: 180, position: "seated", cadence: "70-80" },
        { name: "Sweet Spot",     zone: "Sweet Spot", duration_s: 300, position: "seated", cadence: "85-95" },
        { name: "Threshold 2",    zone: "Z4", duration_s: 240, position: "seated",   cadence: "85-95" },
        { name: "Recovery",       type: "recovery", min_duration_s: 60, max_duration_s: 120, position: "seated", cadence: "70-80" },
        { name: "Cooldown",       zone: "Z1", duration_s: 300, position: "seated",   cadence: "65-75" },
      ],
    };
    handlePlan(samplePlan);

    // Set current phase info
    const currentPhase = samplePlan.phases[phaseIndex];
    const phaseTotal = currentPhase
      ? (currentPhase.type === "recovery" ? (currentPhase.max_duration_s ?? 180) : (currentPhase.duration_s ?? 60))
      : 60;

    timeline.updatePhase({
      phaseIndex,
      phaseName: currentPhase?.name,
      phaseElapsed,
      phaseTotal,
      isRecovery: currentPhase?.type === "recovery",
    });
  }

  const targetPower = params.get("target_power");
  const targetCadence = params.get("target_cadence");
  if (targetPower && targetCadence) {
    ui.updateTarget({
      power: parseInt(targetPower),
      cadence: targetCadence,
      position: null,
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
      elapsed: 10,
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
      elapsed: 20,
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
