import { EventEmitter } from "node:events";
import type { CoachEvent, MetricsEvent, TargetEvent, SetTargetPayload, WorkoutEndEvent, SSEEventType } from "../shared/types";

const encoder = new TextEncoder();
const emitter = new EventEmitter();
emitter.setMaxListeners(100); // Support multiple connections

function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function handleSSE(req: Request): Response {
  let controllerRef: ReadableStreamDefaultController | null = null;

  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;

      // Send retry interval
      controller.enqueue(encoder.encode("retry: 3000\n\n"));

      // Send connected event
      controller.enqueue(
        encoder.encode(formatSSE("connected", { timestamp: Date.now() }))
      );

      // Handler for broadcast events
      const handler = (eventType: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(formatSSE(eventType, data)));
        } catch {
          // Stream closed
        }
      };

      emitter.on("broadcast", handler);

      // Clean up on abort
      req.signal.addEventListener("abort", () => {
        emitter.off("broadcast", handler);
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },

    cancel() {
      // Connection closed by client
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// Public API for broadcasting events to all connected clients
export function broadcastCoach(data: CoachEvent): void {
  emitter.emit("broadcast", "coach", data);
}

export function broadcastMetrics(data: MetricsEvent): void {
  emitter.emit("broadcast", "metrics", data);
}

export function broadcastTarget(data: TargetEvent | null): void {
  emitter.emit("broadcast", "target", data);
}

export function broadcastSetTarget(data: SetTargetPayload | null): void {
  emitter.emit("broadcast", "target", data);
}

export function broadcastWorkoutEnd(data: WorkoutEndEvent): void {
  emitter.emit("broadcast", "workout_end", data);
}

export function broadcast(eventType: SSEEventType, data: unknown): void {
  emitter.emit("broadcast", eventType, data);
}
