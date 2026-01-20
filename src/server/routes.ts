import type { MetricsEvent, MetricsBroadcast } from "../shared/types";
import { broadcast } from "./sse";
import { addMetrics, getElapsed } from "./workout";
import { log } from "./log";

// Tool endpoint response type
interface ToolResponse {
  ok: boolean;
  error?: string;
}

// POST /api/metrics - sensor data from Bluetooth bridge
function isValidMetricsPayload(body: unknown): body is MetricsEvent {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj.power !== "number") return false;
  if (typeof obj.hr !== "number") return false;
  if (typeof obj.cadence !== "number") return false;
  return true;
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
        { ok: false, error: "Invalid payload: power (number), hr (number), and cadence (number) are required" } satisfies ToolResponse,
        { status: 400 }
      );
    }

    // Add server-side elapsed time and broadcast to all SSE clients
    const broadcastData: MetricsBroadcast = { ...body, elapsed: getElapsed() };
    broadcast("metrics", broadcastData);

    // Buffer for coach
    addMetrics(body);

    log(`POST /api/metrics → power:${body.power} hr:${body.hr} cadence:${body.cadence}`);

    return Response.json({ ok: true } satisfies ToolResponse);
  } catch (error) {
    return Response.json(
      { ok: false, error: "Invalid JSON" } satisfies ToolResponse,
      { status: 400 }
    );
  }
}
