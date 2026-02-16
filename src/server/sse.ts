import { EventEmitter } from "node:events";
import type { SSEEventType } from "../shared/types";
import { startWorkout, stopWorkout } from "./workout";
import { log } from "./log";
import { spawnSensorBridge, killSensorBridge } from "./sensor-process";

const encoder = new TextEncoder();
const emitter = new EventEmitter();

// Single active client tracking. Only one SSE connection is allowed at a time.
// If a new connection arrives while one is active, the old one is replaced
// (handles browser refresh and tab takeover).
let activeClient: {
  controller: ReadableStreamDefaultController;
  keepaliveTimer: ReturnType<typeof setInterval>;
  handler: (eventType: string, data: unknown) => void;
} | null = null;

// Bridge control
let bridgeEnabled = true;

export function setBridgeEnabled(enabled: boolean): void {
  bridgeEnabled = enabled;
}

function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Close the active SSE client connection, cleaning up its resources.
 * Does NOT stop the workout or sensor bridge.
 */
function closeActiveClient(): void {
  if (!activeClient) return;
  const { controller, keepaliveTimer, handler } = activeClient;
  clearInterval(keepaliveTimer);
  emitter.off("broadcast", handler);
  try {
    controller.close();
  } catch {
    // Already closed
  }
  activeClient = null;
}

export function handleSSE(req: Request): Response {
  // If there's already an active client, close it. This handles browser
  // refreshes (new connection arrives before old one's abort fires) and
  // tab takeovers. The workout continues uninterrupted.
  if (activeClient) {
    log("SSE: replacing existing client connection");
    closeActiveClient();
  }

  const stream = new ReadableStream({
    start(controller) {
      log("SSE client connected");

      // Start workout session and sensor bridge (idempotent if already active)
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

      // Keepalive: send a comment every 15s to prevent connection timeout.
      // SSE comment lines (starting with ':') are ignored by EventSource
      // but keep the TCP connection alive through proxies and firewalls.
      const keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // Stream closed, cleanup will happen via abort handler
          clearInterval(keepaliveTimer);
        }
      }, 15_000);

      // Handler for broadcast events
      const handler = (eventType: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(formatSSE(eventType, data)));
        } catch {
          // Stream closed
        }
      };

      emitter.on("broadcast", handler);

      // Register as the active client
      activeClient = { controller, keepaliveTimer, handler };

      // Clean up on abort
      req.signal.addEventListener("abort", () => {
        // Only act if this connection is still the active one.
        // If it was already replaced by a newer connection, skip cleanup
        // (the replacement already handled it).
        if (activeClient?.controller !== controller) {
          log("SSE: stale client disconnected (already replaced)");
          return;
        }

        closeActiveClient();
        log("SSE client disconnected");

        stopWorkout();
        if (bridgeEnabled) {
          killSensorBridge();
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
