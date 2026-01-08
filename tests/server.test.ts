import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";

// We'll import the server module after creating it
let server: Server;
let baseUrl: string;

// Dynamic import for the server creator
let createServer: () => Server;

beforeAll(async () => {
  const mod = await import("../src/server/index");
  createServer = mod.createServer;
  server = createServer();
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop();
});

describe("Static file serving", () => {
  test("serves index.html at /", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("<!DOCTYPE html>");
  });

  test("serves files from public directory", async () => {
    const res = await fetch(`${baseUrl}/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("returns 404 for non-existent files", async () => {
    const res = await fetch(`${baseUrl}/nonexistent.xyz`);
    expect(res.status).toBe(404);
  });
});

describe("SSE endpoint /api/events", () => {
  test("returns event-stream content type", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");

    controller.abort();
  });

  test("sends connected event on connection", async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Check if we received the connected event
        if (buffer.includes("event: connected")) {
          expect(buffer).toContain("event: connected");
          expect(buffer).toContain("data:");
          break;
        }
      }
    } catch (e) {
      // AbortError is expected
    }

    clearTimeout(timeoutId);
    controller.abort();
  });
});

