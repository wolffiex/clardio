import { SSEClient } from "./sse-client";
import { UIController } from "./ui";
import type { CoachEvent, MetricsEvent, TargetEvent } from "../shared/types";

// Initialize
const sse = new SSEClient();
const ui = new UIController();

// Connect SSE events to UI
sse.on("connected", () => {
  console.log("[App] SSE connected event received");
  ui.setConnectionStatus("connected");
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

// Handle internal connection events
sse.on("_connected", () => {
  ui.setConnectionStatus("connecting");
});

sse.on("_error", () => {
  ui.setConnectionStatus("disconnected");
});

// Start SSE connection
sse.connect();

console.log("[App] Clardio UI initialized");
