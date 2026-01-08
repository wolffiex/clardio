// SSE Event Types (Server -> Client)

// coach event - from Claude
export interface CoachEvent {
  text: string;
  button?: string; // Optional button label
}

// metrics event - live data
export interface MetricsEvent {
  power: number;
  hr: number;
  cadence: number;
  elapsed: number;
}

// target event - current interval target
export interface TargetEvent {
  power?: number;
  cadence?: number;
  remaining: number;
}

// Union type for all SSE events
export type SSEEventType = "coach" | "metrics" | "target" | "connected";

export interface SSEMessage<T = unknown> {
  event: SSEEventType;
  data: T;
}

// POST payload (Client -> Server)
export interface ActionPayload {
  action: "button_pressed";
  label: string;
  timestamp: number;
}

export interface ActionResponse {
  success: boolean;
  message?: string;
}
