// SSE Event Types (Server -> Client)

// coach event - from Claude
export interface CoachEvent {
  text: string;
}

// metrics event - live data
export interface MetricsEvent {
  power: number;
  hr: number;
  cadence: number;
  elapsed: number;
}

// target event - current interval target (from UI countdown)
export interface TargetEvent {
  power?: number;
  cadence?: number;
  remaining: number;
}

// target set by coach tool (POST /api/target)
export interface SetTargetPayload {
  power?: number;
  cadence?: number;
  duration: number;
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

