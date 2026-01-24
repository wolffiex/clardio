import type { MetricsEvent, MetricsBroadcast } from "../shared/types";
import { broadcast } from "./sse";
import { addMetrics, getElapsed } from "./workout";
import { log } from "./log";

// Tool endpoint response type
interface ToolResponse {
  ok: boolean;
  error?: string;
}

// Partial metrics from sensors (each property optional)
interface PartialMetrics {
  power?: number;
  hr?: number;
  cadence?: number;
}

// Track last known values for each metric
const lastKnown: MetricsEvent = { power: 0, hr: 0, cadence: 0 };

// POST /api/metrics - sensor data from Bluetooth bridge
function isValidMetricsPayload(body: unknown): body is PartialMetrics {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  // At least one metric must be present
  const hasPower = obj.power === undefined || typeof obj.power === "number";
  const hasHr = obj.hr === undefined || typeof obj.hr === "number";
  const hasCadence = obj.cadence === undefined || typeof obj.cadence === "number";
  const hasAtLeastOne = obj.power !== undefined || obj.hr !== undefined || obj.cadence !== undefined;
  return hasPower && hasHr && hasCadence && hasAtLeastOne;
}

export function resetLastKnown(): void {
  lastKnown.power = 0;
  lastKnown.hr = 0;
  lastKnown.cadence = 0;
}

export async function handleMetrics(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json(
      { ok: false, error: "Method not allowed" } satisfies ToolResponse,
      { status: 405 }
    );
  }

  try {
    const text = await req.text();
    if (!text) {
      return Response.json(
        { ok: false, error: "Request body required" } satisfies ToolResponse,
        { status: 400 }
      );
    }

    const body = JSON.parse(text);

    if (!isValidMetricsPayload(body)) {
      return Response.json(
        { ok: false, error: "Invalid payload: at least one of power, hr, cadence (numbers) required" } satisfies ToolResponse,
        { status: 400 }
      );
    }

    // Merge with last known values
    if (body.power !== undefined) lastKnown.power = body.power;
    if (body.hr !== undefined) lastKnown.hr = body.hr;
    if (body.cadence !== undefined) lastKnown.cadence = body.cadence;

    // Add server-side elapsed time and broadcast to all SSE clients
    const broadcastData: MetricsBroadcast = { ...lastKnown, elapsed: getElapsed() };
    broadcast("metrics", broadcastData);

    // Buffer for coach
    addMetrics(lastKnown);

    log(`POST /api/metrics → power:${lastKnown.power} hr:${lastKnown.hr} cadence:${lastKnown.cadence}`);

    return Response.json({ ok: true } satisfies ToolResponse);
  } catch (error) {
    return Response.json(
      { ok: false, error: "Invalid JSON" } satisfies ToolResponse,
      { status: 400 }
    );
  }
}
