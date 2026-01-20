import { EventEmitter } from "node:events";
import type { MetricsEvent, SSEEventType } from "../shared/types";
import { startWorkout, stopWorkout, isWorkoutActive } from "./workout";
import { log } from "./log";

const encoder = new TextEncoder();
const emitter = new EventEmitter();
emitter.setMaxListeners(100); // Support multiple connections

// Track connected clients for logging
let clientCount = 0;

function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function handleSSE(req: Request): Response {
  let controllerRef: ReadableStreamDefaultController | null = null;

  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      clientCount++;
      log(`SSE client connected (total: ${clientCount})`);

      // Start workout session
      startWorkout();

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
        clientCount--;
        log(`SSE client disconnected (total: ${clientCount})`);

        // Stop workout session
        stopWorkout();
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
export function broadcastMetrics(data: MetricsEvent): void {
  emitter.emit("broadcast", "metrics", data);
}

export function broadcast(eventType: SSEEventType, data: unknown): void {
  emitter.emit("broadcast", eventType, data);
}
