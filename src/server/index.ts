import type { Server } from "bun";
import { handleSSE, broadcast, broadcastCoach, broadcastMetrics, broadcastTarget } from "./sse";
import { handleAction, onAction } from "./routes";
import { join } from "node:path";

const PUBLIC_DIR = join(import.meta.dir, "../../public");

export function createServer(port: number = 0): Server {
  return Bun.serve({
    port,

    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // API routes
      if (pathname === "/api/events") {
        return handleSSE(req);
      }

      if (pathname === "/api/action") {
        return handleAction(req);
      }

      // Static file serving
      let filePath: string;

      if (pathname === "/") {
        filePath = join(PUBLIC_DIR, "index.html");
      } else if (pathname === "/js/client.js") {
        // Serve bundled client from dist
        filePath = join(PUBLIC_DIR, "js/client.js");
      } else {
        filePath = join(PUBLIC_DIR, pathname);
      }

      const file = Bun.file(filePath);
      const exists = await file.exists();

      if (exists) {
        return new Response(file);
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}

// Export utilities for external use
export { broadcast, broadcastCoach, broadcastMetrics, broadcastTarget, onAction };

// Run server if this file is executed directly
if (import.meta.main) {
  const server = createServer(3000);
  console.log(`Clardio running at http://localhost:${server.port}`);
}
