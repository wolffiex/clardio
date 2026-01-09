import type { CoachEvent, MetricsEvent, SetTargetPayload, TargetEvent, WorkoutEndEvent } from "../shared/types";
import { broadcast } from "./sse";

// Tool endpoint response type
interface ToolResponse {
  ok: boolean;
  error?: string;
}

// ============================================================================
// Tool HTTP endpoints (for coach integration)
// ============================================================================

// POST /api/coach - send_message tool
function isValidCoachPayload(body: unknown): body is CoachEvent {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  return typeof obj.text === "string";
}

export async function handleCoach(req: Request): Promise<Response> {
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

    if (!isValidCoachPayload(body)) {
      return Response.json(
        { ok: false, error: "Invalid payload: text (string) is required" } satisfies ToolResponse,
        { status: 400 }
      );
    }

    // Broadcast to all SSE clients
    broadcast("coach", { text: body.text });

    console.log(`[Coach] Message: "${body.text}"`);

    return Response.json({ ok: true } satisfies ToolResponse);
  } catch (error) {
    return Response.json(
      { ok: false, error: "Invalid JSON" } satisfies ToolResponse,
      { status: 400 }
    );
  }
}

// POST /api/metrics - sensor data
function isValidMetricsPayload(body: unknown): body is MetricsEvent {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj.power !== "number") return false;
  if (typeof obj.hr !== "number") return false;
  if (typeof obj.cadence !== "number") return false;
  if (typeof obj.elapsed !== "number") return false;
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
        { ok: false, error: "Invalid payload: power (number), hr (number), cadence (number), and elapsed (number) are required" } satisfies ToolResponse,
        { status: 400 }
      );
    }

    // Broadcast to all SSE clients
    broadcast("metrics", body);

    return Response.json({ ok: true } satisfies ToolResponse);
  } catch (error) {
    return Response.json(
      { ok: false, error: "Invalid JSON" } satisfies ToolResponse,
      { status: 400 }
    );
  }
}

// POST /api/target - set_target tool
function isValidTargetPayload(body: unknown): body is SetTargetPayload {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  // power and cadence are REQUIRED
  if (typeof obj.power !== "number") return false;
  if (typeof obj.cadence !== "number") return false;
  // duration is optional - if absent, it's a baseline target
  if (obj.duration !== undefined && typeof obj.duration !== "number") return false;
  return true;
}

export async function handleTarget(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json(
      { ok: false, error: "Method not allowed" } satisfies ToolResponse,
      { status: 405 }
    );
  }

  try {
    const text = await req.text();

    // Empty body or null clears the target
    if (!text || text === "null") {
      broadcast("target", null);
      console.log("[Target] Cleared");
      return Response.json({ ok: true } satisfies ToolResponse);
    }

    const body = JSON.parse(text);

    if (!isValidTargetPayload(body)) {
      return Response.json(
        { ok: false, error: "Invalid payload: power (number) and cadence (number) are required, duration (number) is optional" } satisfies ToolResponse,
        { status: 400 }
      );
    }

    // Build the target event for broadcasting
    // If duration is present, include remaining for active target with countdown
    // If duration is absent, it's a baseline target (no remaining field)
    const target: TargetEvent = {
      power: body.power,
      cadence: body.cadence,
    };
    if (body.duration !== undefined) {
      target.remaining = body.duration;
    }

    broadcast("target", target);

    const targetType = body.duration !== undefined ? "active" : "baseline";
    console.log(`[Target] Set ${targetType}: ${JSON.stringify(target)}`);

    return Response.json({ ok: true } satisfies ToolResponse);
  } catch (error) {
    return Response.json(
      { ok: false, error: "Invalid JSON" } satisfies ToolResponse,
      { status: 400 }
    );
  }
}

// POST /api/end - end_workout tool
function isValidWorkoutEndPayload(body: unknown): body is WorkoutEndEvent {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj.summary !== "string") return false;
  if (typeof obj.stats !== "object" || obj.stats === null) return false;

  const stats = obj.stats as Record<string, unknown>;
  if (typeof stats.duration !== "number") return false;
  if (typeof stats.work_kj !== "number") return false;
  if (typeof stats.avg_power !== "number") return false;
  if (typeof stats.avg_hr !== "number") return false;

  return true;
}

export async function handleEnd(req: Request): Promise<Response> {
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

    if (!isValidWorkoutEndPayload(body)) {
      return Response.json(
        { ok: false, error: "Invalid payload: summary (string) and stats (object with duration, work_kj, avg_power, avg_hr as numbers) are required" } satisfies ToolResponse,
        { status: 400 }
      );
    }

    broadcast("workout_end", body);

    console.log(`[WorkoutEnd] Summary: "${body.summary}", Duration: ${body.stats.duration}s`);

    return Response.json({ ok: true } satisfies ToolResponse);
  } catch (error) {
    return Response.json(
      { ok: false, error: "Invalid JSON" } satisfies ToolResponse,
      { status: 400 }
    );
  }
}
