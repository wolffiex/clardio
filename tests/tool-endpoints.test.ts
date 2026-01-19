import { describe, test, expect, beforeAll, afterAll, mock, spyOn } from "bun:test";
import type { Server } from "bun";

let server: Server;
let baseUrl: string;

// We'll spy on the SSE module's broadcast function
let broadcastSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  // Spy on the sse module's emitter
  const sseModule = await import("../src/server/sse");
  broadcastSpy = spyOn(sseModule, "broadcast");

  const mod = await import("../src/server/index");
  server = mod.createServer();
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop();
});

describe("POST /api/metrics - sensor data", () => {
  test("accepts valid metrics payload and broadcasts SSE", async () => {
    broadcastSpy.mockClear();
    const payload = { power: 200, hr: 145, cadence: 90, elapsed: 300 };

    const res = await fetch(`${baseUrl}/api/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(broadcastSpy).toHaveBeenCalledWith("metrics", payload);
  });

  test("rejects payload with missing power field", async () => {
    const res = await fetch(`${baseUrl}/api/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hr: 145, cadence: 90, elapsed: 300 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBeDefined();
  });

  test("rejects payload with missing hr field", async () => {
    const res = await fetch(`${baseUrl}/api/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ power: 200, cadence: 90, elapsed: 300 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects payload with missing cadence field", async () => {
    const res = await fetch(`${baseUrl}/api/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ power: 200, hr: 145, elapsed: 300 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects payload with missing elapsed field", async () => {
    const res = await fetch(`${baseUrl}/api/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ power: 200, hr: 145, cadence: 90 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects payload with non-number power", async () => {
    const res = await fetch(`${baseUrl}/api/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ power: "200", hr: 145, cadence: 90, elapsed: 300 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects payload with non-number hr", async () => {
    const res = await fetch(`${baseUrl}/api/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ power: 200, hr: "145", cadence: 90, elapsed: 300 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects payload with non-number cadence", async () => {
    const res = await fetch(`${baseUrl}/api/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ power: 200, hr: 145, cadence: "90", elapsed: 300 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects payload with non-number elapsed", async () => {
    const res = await fetch(`${baseUrl}/api/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ power: 200, hr: 145, cadence: 90, elapsed: "300" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects invalid JSON", async () => {
    const res = await fetch(`${baseUrl}/api/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects non-POST methods", async () => {
    const res = await fetch(`${baseUrl}/api/metrics`, {
      method: "GET",
    });

    expect(res.status).toBe(405);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });
});
