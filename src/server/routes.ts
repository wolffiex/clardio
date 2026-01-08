import type { ActionPayload, ActionResponse } from "../shared/types";

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
