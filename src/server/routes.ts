import type { ActionPayload, ActionResponse, CoachEvent, SetTargetPayload, TargetEvent, WorkoutEndEvent } from "../shared/types";
import { broadcast } from "./sse";

// Tool endpoint response type
interface ToolResponse {
  ok: boolean;
  error?: string;
}

// Action handlers - can be extended to notify coach logic
const actionHandlers: ((payload: ActionPayload) => void)[] = [];

export function onAction(handler: (payload: ActionPayload) => void): void {
  actionHandlers.push(handler);
}

function isValidActionPayload(body: unknown): body is ActionPayload {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  return (
    obj.action === "button_pressed" &&
    typeof obj.label === "string" &&
    typeof obj.timestamp === "number"
  );
}

export async function handleAction(req: Request): Promise<Response> {
  // Only allow POST
  if (req.method !== "POST") {
    return Response.json(
      { success: false, message: "Method not allowed" } satisfies ActionResponse,
      { status: 405 }
    );
  }

  try {
    const body = await req.json();

    if (!isValidActionPayload(body)) {
      return Response.json(
        { success: false, message: "Invalid payload" } satisfies ActionResponse,
        { status: 400 }
      );
    }

    // Notify all registered handlers
    for (const handler of actionHandlers) {
      handler(body);
    }

    console.log(`[Action] ${body.action}: "${body.label}" at ${new Date(body.timestamp).toISOString()}`);

    return Response.json({ success: true } satisfies ActionResponse);
  } catch (error) {
    return Response.json(
      { success: false, message: "Invalid JSON" } satisfies ActionResponse,
      { status: 400 }
    );
  }
}

// ============================================================================
// Tool HTTP endpoints (for coach integration)
// ============================================================================

// POST /api/coach - send_message tool
function isValidCoachPayload(body: unknown): body is CoachEvent {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj.text !== "string") return false;
  if (obj.button !== undefined && typeof obj.button !== "string") return false;
  return true;
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
        { ok: false, error: "Invalid payload: text (string) is required, button (string) is optional" } satisfies ToolResponse,
        { status: 400 }
      );
    }

    // Broadcast to all SSE clients
    const event: CoachEvent = { text: body.text };
    if (body.button) {
      event.button = body.button;
    }
    broadcast("coach", event);

    console.log(`[Coach] Message: "${body.text}"${body.button ? ` [${body.button}]` : ""}`);

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
  if (typeof obj.duration !== "number") return false;
  if (obj.power !== undefined && typeof obj.power !== "number") return false;
  if (obj.cadence !== undefined && typeof obj.cadence !== "number") return false;
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
        { ok: false, error: "Invalid payload: duration (number) is required, power (number) and cadence (number) are optional" } satisfies ToolResponse,
        { status: 400 }
      );
    }

    // Build the target event for broadcasting
    // Convert SetTargetPayload (duration) to TargetEvent (remaining) for the UI
    const target: TargetEvent = { remaining: body.duration };
    if (body.power !== undefined) target.power = body.power;
    if (body.cadence !== undefined) target.cadence = body.cadence;

    broadcast("target", target);

    console.log(`[Target] Set: ${JSON.stringify(target)}`);

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
