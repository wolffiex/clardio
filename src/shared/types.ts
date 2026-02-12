// SSE Event Types (Server -> Client)

// coach event - from Claude
export interface CoachEvent {
  text: string;
}

// metrics event - POST payload from sensors (no elapsed - server tracks it)
export interface MetricsEvent {
  power: number;
  hr: number;
  cadence: number;
}

// metrics event broadcast to clients (includes server-calculated elapsed)
export interface MetricsBroadcast extends MetricsEvent {
  elapsed: number;
}

// target event - power from coach, cadence + position from plan phase
export interface TargetEvent {
  power: number | null;
  cadence: string | null;
  position: string | null;
}

// Union type for all SSE events
export type SSEEventType = "coach" | "metrics" | "target" | "connected" | "plan";

