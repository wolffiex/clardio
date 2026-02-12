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
  phaseIndex?: number;
  phaseName?: string;
  phaseElapsed?: number;  // seconds elapsed in current phase
  phaseTotal?: number;    // total duration of current phase (or max_duration_s for recovery)
  isRecovery?: boolean;
  targetHr?: number;      // for recovery phases: HR must drop below this to advance
  phaseMinDuration?: number; // for recovery phases: minimum seconds before HR check
}

// workout_complete event - workout ended (final recovery HR gate cleared or max duration)
export interface WorkoutCompleteEvent {
  reason: "hr_cleared" | "max_duration";
  message: string;
}

// Union type for all SSE events
export type SSEEventType = "coach" | "metrics" | "target" | "connected" | "plan" | "workout_complete";

