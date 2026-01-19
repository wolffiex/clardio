# Clardio UI Implementation Plan

A minimal, focused cycling coach UI optimized for iPad horizontal orientation.

## Stack Overview

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun.serve | Native HTTP server, SSE support, TypeScript bundling |
| Styling | Tailwind CSS (CLI) | Utility-first, no build step complexity |
| Templating | Template literals | No framework overhead, simple string interpolation |
| Client TS | Bun bundler | `bun build --target browser` for client modules |
| Server->Client | SSE | One-way stream, auto-reconnect, simple protocol |
| Client->Server | HTTP POST | Tool endpoints (metrics, coach commands) |

---

## File Structure

```
clardio/
├── src/
│   ├── server/
│   │   ├── index.ts          # Main Bun.serve entry point
│   │   ├── sse.ts            # SSE connection manager
│   │   └── routes.ts         # Route handlers
│   ├── client/
│   │   ├── main.ts           # Client entry point
│   │   ├── sse-client.ts     # EventSource handler
│   │   └── ui.ts             # DOM manipulation
│   └── shared/
│       └── types.ts          # Shared event/message types
├── public/
│   ├── index.html            # Main HTML shell
│   └── styles.css            # Compiled Tailwind output
├── tailwind/
│   └── input.css             # Tailwind source (minimal)
├── dist/                     # Built client assets
│   └── main.js               # Bundled client code
├── package.json
├── tailwind.config.js
└── tsconfig.json
```

---

## How Each Piece Works Together

### 1. Server (Bun.serve)

The server handles three concerns:

1. **Static files**: Serve `public/` and `dist/` directories
2. **SSE endpoint**: Keep connection open, push coach messages
3. **POST endpoints**: Receive metrics and tool commands

```typescript
// src/server/index.ts
import { handleSSE, broadcast } from "./sse";

const server = Bun.serve({
  port: 3000,

  routes: {
    // Serve the main HTML page
    "/": Bun.file("./public/index.html"),
    "/styles.css": Bun.file("./public/styles.css"),
    "/main.js": Bun.file("./dist/main.js"),

    // SSE endpoint
    "/events": (req) => handleSSE(req),
  },

  // Fallback for unmatched routes
  fetch(req) {
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Clardio running at http://localhost:${server.port}`);
```

### 2. SSE Connection Manager

Maintains active connections and broadcasts events to all clients.

```typescript
// src/server/sse.ts
import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
emitter.setMaxListeners(100); // Support multiple connections

export function handleSSE(req: Request): Response {
  const stream = new ReadableStream({
    start(controller) {
      // Send retry interval on connect
      controller.enqueue(encoder.encode("retry: 3000\n\n"));

      // Send initial connection event
      sendEvent(controller, "connected", { timestamp: Date.now() });
    },

    pull(controller) {
      const handler = (eventType: string, data: unknown) => {
        sendEvent(controller, eventType, data);
      };

      emitter.on("broadcast", handler);

      // Clean up on disconnect
      req.signal.addEventListener("abort", () => {
        emitter.off("broadcast", handler);
      });

      // Keep stream open indefinitely
      return new Promise(() => {});
    },

    cancel() {
      // Connection closed by client
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
}

const encoder = new TextEncoder();

function sendEvent(controller: ReadableStreamDefaultController, event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  controller.enqueue(encoder.encode(payload));
}

// Called by coach logic to send messages to all clients
export function broadcast(eventType: string, data: unknown) {
  emitter.emit("broadcast", eventType, data);
}
```

### 3. Tailwind CSS Integration

Use the Tailwind CLI for simplicity. No PostCSS or complex build chain needed.

```bash
# Install
bun add -D tailwindcss @tailwindcss/cli

# Build (one-time or watch mode)
bun run tailwindcss -i ./tailwind/input.css -o ./public/styles.css --watch
```

**tailwind/input.css:**
```css
@import "tailwindcss";
```

**tailwind.config.js:**
```javascript
export default {
  content: [
    "./public/**/*.html",
    "./src/client/**/*.ts",
  ],
  theme: {
    extend: {
      // Custom colors for Clardio branding if needed
    },
  },
};
```

### 4. Client-Side TypeScript Bundling

Bun bundles TypeScript to browser-compatible JavaScript.

```bash
# Build client code
bun build ./src/client/main.ts --outdir ./dist --target browser

# Watch mode for development
bun build ./src/client/main.ts --outdir ./dist --target browser --watch
```

**package.json scripts:**
```json
{
  "scripts": {
    "dev": "bun --hot src/server/index.ts",
    "build:client": "bun build ./src/client/main.ts --outdir ./dist --target browser",
    "build:css": "bun run tailwindcss -i ./tailwind/input.css -o ./public/styles.css",
    "build": "bun run build:client && bun run build:css",
    "dev:all": "concurrently \"bun run dev\" \"bun run build:client --watch\" \"bun run build:css --watch\""
  }
}
```

### 5. HTML Template

Single HTML file with all layout structure. No templating engine needed.

```html
<!-- public/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Clardio</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="bg-black text-white h-screen overflow-hidden select-none touch-manipulation">

  <!-- Main container: fills viewport, centered content -->
  <div id="app" class="h-full flex flex-col justify-between p-8">

    <!-- Coach message area: large, centered -->
    <div id="coach-section" class="flex-1 flex items-center justify-center">
      <p id="coach-message" class="text-5xl font-light text-center leading-tight max-w-4xl">
        Connecting...
      </p>
    </div>

    <!-- Metrics bar: always visible at bottom -->
    <div id="metrics-section" class="flex justify-around items-end text-center">
      <div class="metric">
        <span id="metric-power" class="text-6xl font-bold tabular-nums">---</span>
        <span class="text-xl text-gray-400 block">watts</span>
      </div>
      <div class="metric">
        <span id="metric-hr" class="text-6xl font-bold tabular-nums">---</span>
        <span class="text-xl text-gray-400 block">bpm</span>
      </div>
      <div class="metric">
        <span id="metric-cadence" class="text-6xl font-bold tabular-nums">---</span>
        <span class="text-xl text-gray-400 block">rpm</span>
      </div>
      <div class="metric">
        <span id="metric-time" class="text-6xl font-bold tabular-nums">00:00</span>
        <span class="text-xl text-gray-400 block">elapsed</span>
      </div>
    </div>

    <!-- Target overlay: shown when active -->
    <div id="target-overlay" class="hidden absolute top-8 right-8 bg-yellow-500/20 border-2 border-yellow-500 rounded-xl px-6 py-4">
      <span id="target-text" class="text-2xl font-semibold text-yellow-400">180W for 2:47</span>
    </div>

  </div>

  <script type="module" src="/main.js"></script>
</body>
</html>
```

---

## SSE Event Types (Server -> Client)

All events follow the SSE format: `event: <type>\ndata: <json>\n\n`

| Event Type | Payload | Purpose |
|------------|---------|---------|
| `connected` | `{ timestamp: number }` | Confirm connection established |
| `coach` | `{ message: string }` | Update coach message |
| `metrics` | `{ power?: number, hr?: number, cadence?: number, elapsed?: number }` | Update live metrics display |
| `target` | `{ text: string } \| null` | Show/hide target overlay |

### Event Payload Types

```typescript
// src/shared/types.ts

export interface CoachEvent {
  message: string;
}

export interface MetricsEvent {
  power?: number;    // watts
  hr?: number;       // bpm
  cadence?: number;  // rpm
  elapsed?: number;  // seconds
}

export interface TargetEvent {
  text: string;      // e.g., "180W for 2:47"
}

// Union type for all SSE events
export type SSEEvent =
  | { type: "connected"; data: { timestamp: number } }
  | { type: "coach"; data: CoachEvent }
  | { type: "metrics"; data: MetricsEvent }
  | { type: "target"; data: TargetEvent | null };
```

### Example SSE Messages

```
event: coach
data: {"message":"Ready for a 30-minute endurance ride?"}

event: metrics
data: {"power":175,"hr":142,"cadence":88,"elapsed":847}

event: target
data: {"text":"180W for 2:47"}

event: target
data: null
```

---

## Client-Side Implementation

### SSE Client

```typescript
// src/client/sse-client.ts

type EventHandler = (data: unknown) => void;

export class SSEClient {
  private eventSource: EventSource | null = null;
  private handlers: Map<string, EventHandler[]> = new Map();

  connect(url: string = "/events") {
    this.eventSource = new EventSource(url);

    this.eventSource.onopen = () => {
      console.log("SSE connected");
    };

    this.eventSource.onerror = (err) => {
      console.error("SSE error, will auto-reconnect", err);
    };

    // Listen for all custom event types
    ["connected", "coach", "metrics", "target"].forEach(type => {
      this.eventSource!.addEventListener(type, (event: MessageEvent) => {
        const data = JSON.parse(event.data);
        this.emit(type, data);
      });
    });
  }

  on(event: string, handler: EventHandler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  private emit(event: string, data: unknown) {
    this.handlers.get(event)?.forEach(handler => handler(data));
  }

  disconnect() {
    this.eventSource?.close();
    this.eventSource = null;
  }
}
```

### UI Controller

```typescript
// src/client/ui.ts

import type { CoachEvent, MetricsEvent, TargetEvent } from "../shared/types";

export class UIController {
  private elements: {
    coachMessage: HTMLElement;
    power: HTMLElement;
    hr: HTMLElement;
    cadence: HTMLElement;
    time: HTMLElement;
    targetOverlay: HTMLElement;
    targetText: HTMLElement;
  };

  constructor() {
    this.elements = {
      coachMessage: document.getElementById("coach-message")!,
      power: document.getElementById("metric-power")!,
      hr: document.getElementById("metric-hr")!,
      cadence: document.getElementById("metric-cadence")!,
      time: document.getElementById("metric-time")!,
      targetOverlay: document.getElementById("target-overlay")!,
      targetText: document.getElementById("target-text")!,
    };
  }

  updateCoach(event: CoachEvent) {
    this.elements.coachMessage.textContent = event.message;
  }

  updateMetrics(event: MetricsEvent) {
    if (event.power !== undefined) {
      this.elements.power.textContent = event.power.toString();
    }
    if (event.hr !== undefined) {
      this.elements.hr.textContent = event.hr.toString();
    }
    if (event.cadence !== undefined) {
      this.elements.cadence.textContent = event.cadence.toString();
    }
    if (event.elapsed !== undefined) {
      this.elements.time.textContent = this.formatTime(event.elapsed);
    }
  }

  updateTarget(event: TargetEvent | null) {
    if (event) {
      this.elements.targetText.textContent = event.text;
      this.elements.targetOverlay.classList.remove("hidden");
    } else {
      this.elements.targetOverlay.classList.add("hidden");
    }
  }

  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
}
```

### Main Entry Point

```typescript
// src/client/main.ts

import { SSEClient } from "./sse-client";
import { UIController } from "./ui";
import type { CoachEvent, MetricsEvent, TargetEvent } from "../shared/types";

const sse = new SSEClient();
const ui = new UIController();

// Connect SSE events to UI
sse.on("coach", (data) => ui.updateCoach(data as CoachEvent));
sse.on("metrics", (data) => ui.updateMetrics(data as MetricsEvent));
sse.on("target", (data) => ui.updateTarget(data as TargetEvent | null));
sse.on("connected", () => ui.updateCoach({ message: "Connected. Warming up..." }));

// Start connection
sse.connect();
```

---

## iPad Optimization

### Viewport Configuration

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
```

### CSS Considerations

```css
/* Prevent text selection during interaction */
body {
  -webkit-user-select: none;
  user-select: none;
}

/* Prevent pull-to-refresh and overscroll */
body {
  overscroll-behavior: none;
  overflow: hidden;
}

/* Optimize touch handling */
body {
  touch-action: manipulation;  /* Allows panning/scrolling, disables double-tap zoom */
}

/* Ensure full viewport usage */
html, body {
  height: 100%;
  height: 100dvh;  /* Dynamic viewport height for iOS */
}

/* Safe area insets for notched devices */
.p-safe {
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
  padding-bottom: env(safe-area-inset-bottom);
}

/* Tabular numbers for metrics (no width jumping) */
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
```

### Touch Target Sizes

All interactive elements should have minimum touch targets of 44x44 points (Apple HIG).

### Landscape Optimization

Target resolution: 1024x768 (iPad landscape) or similar aspect ratios.

```css
/* Force landscape layout */
@media (orientation: portrait) {
  body::before {
    content: "Please rotate to landscape";
    /* Overlay message */
  }
}
```

---

## Development Workflow

### Start Development

```bash
# Terminal 1: Run server with hot reload
bun --hot src/server/index.ts

# Terminal 2: Watch client TypeScript
bun build ./src/client/main.ts --outdir ./dist --target browser --watch

# Terminal 3: Watch Tailwind CSS
bun run tailwindcss -i ./tailwind/input.css -o ./public/styles.css --watch
```

Or use a single command with `concurrently`:

```bash
bun add -D concurrently
bun run dev:all
```

### Production Build

```bash
bun run build
bun src/server/index.ts
```

---

## Testing SSE Manually

Use curl to test the SSE endpoint:

```bash
curl -N http://localhost:3000/events
```

Or test from the server:

```typescript
// In server code, simulate coach messages
import { broadcast } from "./sse";

// After 5 seconds, send a coach message
setTimeout(() => {
  broadcast("coach", {
    message: "Ready for a 30-minute endurance ride?"
  });
}, 5000);
```

---

## Future Considerations

1. **Connection status indicator**: Show when SSE is disconnected/reconnecting
2. **Audio feedback**: Optional sounds for events (if coach logic requests)
3. **Haptic feedback**: Vibration on events (via Vibration API)
4. **PWA manifest**: For "Add to Home Screen" capability
5. **Offline handling**: Graceful degradation when connection lost

---

## Summary

This plan creates a minimal, focused cycling coach UI with:

- **Server**: Bun.serve with routes for HTML, static files, SSE, and POST
- **Styling**: Tailwind CSS via CLI (no complex build chain)
- **Client**: TypeScript bundled by Bun for browser
- **Communication**: SSE pushes coach messages/metrics to client
- **iPad optimized**: Full viewport, touch-friendly, landscape-oriented

The architecture keeps complexity low while providing real-time coach interaction through a clean, distraction-free interface.
