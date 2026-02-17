// SSE Event Types (Server -> Client)

// Phase change event - sent on phase transitions
export interface PhaseEvent {
  phaseIndex: number;
  ends_at: number | null;  // workout elapsed SECONDS when phase ends, null for recovery
}

// Coach message event - sent every tick, scheduled on client clock
export interface CoachEvent {
  message: string;
  power: number;
  displayAt: number;  // workout elapsed SECONDS when to display
}

// metrics event - POST payload from sensors (no elapsed - server tracks it)
export interface MetricsEvent {
  power: number;
  hr: number;
  cadence: number;
}

// Union type for all SSE events
export type SSEEventType = "connected" | "coach" | "metrics" | "phase" | "plan";
