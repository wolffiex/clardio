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
  cadence: number | null;
  position: string | null;
  phaseIndex: number;
  phaseName: string;
  phaseStartedAt: number;      // server timestamp (Date.now()) when this phase began
  phaseDuration: number | null; // total seconds for timed phases, null for recovery
  isRecovery: boolean;
  targetHr?: number;           // for recovery: HR must drop below this
  serverTimestamp: number;     // Date.now() when this event was built
}

// Union type for all SSE events
export type SSEEventType = "coach" | "metrics" | "target" | "connected" | "plan";

