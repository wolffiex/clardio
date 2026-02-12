import { EventEmitter } from "node:events";
import type { SSEEventType } from "../shared/types";
import { startWorkout, stopWorkout } from "./workout";
import { log } from "./log";
import { spawnSensorBridge, killSensorBridge } from "./sensor-process";

const encoder = new TextEncoder();
const emitter = new EventEmitter();
emitter.setMaxListeners(100); // Support multiple connections

// Track connected clients for logging
let clientCount = 0;

// Bridge control
let bridgeEnabled = true;

export function setBridgeEnabled(enabled: boolean): void {
  bridgeEnabled = enabled;
}

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

      // Start workout session and sensor bridge
      startWorkout();
      if (bridgeEnabled) {
        spawnSensorBridge();
      }

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

        // Only stop workout and bridge when the last client disconnects.
        // During a browser refresh, the new connection arrives before the old
        // one aborts, so clientCount stays > 0 and the workout survives.
        if (clientCount <= 0) {
          stopWorkout();
          if (bridgeEnabled) {
            killSensorBridge();
          }
        }
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

export function broadcast(eventType: SSEEventType, data: unknown): void {
  emitter.emit("broadcast", eventType, data);
}
