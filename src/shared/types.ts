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

// target event - current target from coach
export interface TargetEvent {
  power: number;
  cadence: number;
}

// workout_end event - workout completion
export interface WorkoutEndEvent {
  summary: string;
  stats: {
    duration: number; // seconds
    work_kj: number; // kilojoules
    avg_power: number; // watts
    avg_hr: number; // bpm
  };
}

// Union type for all SSE events
export type SSEEventType = "coach" | "metrics" | "target" | "connected" | "workout_end";

export interface SSEMessage<T = unknown> {
  event: SSEEventType;
  data: T;
}

