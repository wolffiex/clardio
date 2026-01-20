import { SSEClient } from "./sse-client";
import { UIController } from "./ui";
import type { CoachEvent, MetricsEvent, TargetEvent } from "../shared/types";

// Initialize
const sse = new SSEClient();
const ui = new UIController();

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

  const targetPower = params.get("target_power");
  const targetCadence = params.get("target_cadence");
  if (targetPower && targetCadence) {
    ui.updateTarget({
      power: parseInt(targetPower),
      cadence: parseInt(targetCadence),
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
