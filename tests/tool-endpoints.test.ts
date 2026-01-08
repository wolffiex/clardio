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

describe("POST /api/coach - send_message tool", () => {
  test("accepts valid payload with text only", async () => {
    broadcastSpy.mockClear();
    const payload = { text: "Great work! Keep it up!" };

    const res = await fetch(`${baseUrl}/api/coach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    // Verify broadcast was called with correct event
    expect(broadcastSpy).toHaveBeenCalledWith("coach", { text: "Great work! Keep it up!" });
  });

  test("accepts valid payload with text and button", async () => {
    broadcastSpy.mockClear();
    const payload = { text: "Ready to start?", button: "Let's go!" };

    const res = await fetch(`${baseUrl}/api/coach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(broadcastSpy).toHaveBeenCalledWith("coach", {
      text: "Ready to start?",
      button: "Let's go!",
    });
  });

  test("rejects payload without text", async () => {
    const res = await fetch(`${baseUrl}/api/coach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ button: "Click me" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBeDefined();
  });

  test("rejects payload with non-string text", async () => {
    const res = await fetch(`${baseUrl}/api/coach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: 123 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects payload with non-string button", async () => {
    const res = await fetch(`${baseUrl}/api/coach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello", button: 123 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects empty body", async () => {
    const res = await fetch(`${baseUrl}/api/coach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    expect(res.status).toBe(400);
  });

  test("rejects invalid JSON", async () => {
    const res = await fetch(`${baseUrl}/api/coach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });

  test("rejects non-POST methods", async () => {
    const res = await fetch(`${baseUrl}/api/coach`, {
      method: "GET",
    });

    expect(res.status).toBe(405);
  });
});

describe("POST /api/target - set_target tool", () => {
  test("accepts target with power and duration", async () => {
    broadcastSpy.mockClear();
    const payload = { power: 200, duration: 300 };

    const res = await fetch(`${baseUrl}/api/target`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(broadcastSpy).toHaveBeenCalledWith("target", { power: 200, remaining: 300 });
  });

  test("accepts target with cadence and duration", async () => {
    broadcastSpy.mockClear();
    const payload = { cadence: 90, duration: 120 };

    const res = await fetch(`${baseUrl}/api/target`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(broadcastSpy).toHaveBeenCalledWith("target", { cadence: 90, remaining: 120 });
  });

  test("accepts target with power, cadence, and duration", async () => {
    broadcastSpy.mockClear();
    const payload = { power: 180, cadence: 85, duration: 600 };

    const res = await fetch(`${baseUrl}/api/target`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(broadcastSpy).toHaveBeenCalledWith("target", {
      power: 180,
      cadence: 85,
      remaining: 600,
    });
  });

  test("accepts null to clear target", async () => {
    broadcastSpy.mockClear();

    const res = await fetch(`${baseUrl}/api/target`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(broadcastSpy).toHaveBeenCalledWith("target", null);
  });

  test("accepts empty body to clear target", async () => {
    broadcastSpy.mockClear();

    const res = await fetch(`${baseUrl}/api/target`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(broadcastSpy).toHaveBeenCalledWith("target", null);
  });

  test("rejects target without duration", async () => {
    const res = await fetch(`${baseUrl}/api/target`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ power: 200 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBeDefined();
  });

  test("rejects target with non-number power", async () => {
    const res = await fetch(`${baseUrl}/api/target`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ power: "200", duration: 300 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects target with non-number cadence", async () => {
    const res = await fetch(`${baseUrl}/api/target`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cadence: "90", duration: 300 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects target with non-number duration", async () => {
    const res = await fetch(`${baseUrl}/api/target`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ power: 200, duration: "300" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects non-POST methods", async () => {
    const res = await fetch(`${baseUrl}/api/target`, {
      method: "GET",
    });

    expect(res.status).toBe(405);
  });
});

describe("POST /api/end - end_workout tool", () => {
  test("accepts valid workout end payload", async () => {
    broadcastSpy.mockClear();
    const payload = {
      summary: "Great workout! You hit all your targets.",
      stats: {
        duration: 3600,
        work_kj: 750,
        avg_power: 185,
        avg_hr: 145,
      },
    };

    const res = await fetch(`${baseUrl}/api/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(broadcastSpy).toHaveBeenCalledWith("workout_end", payload);
  });

  test("rejects payload without summary", async () => {
    const res = await fetch(`${baseUrl}/api/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stats: { duration: 3600, work_kj: 750, avg_power: 185, avg_hr: 145 },
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBeDefined();
  });

  test("rejects payload with non-string summary", async () => {
    const res = await fetch(`${baseUrl}/api/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: 123,
        stats: { duration: 3600, work_kj: 750, avg_power: 185, avg_hr: 145 },
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects payload without stats", async () => {
    const res = await fetch(`${baseUrl}/api/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "Great workout!" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects payload with missing stats fields", async () => {
    const res = await fetch(`${baseUrl}/api/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Great workout!",
        stats: { duration: 3600, work_kj: 750 }, // missing avg_power and avg_hr
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects payload with non-number stats fields", async () => {
    const res = await fetch(`${baseUrl}/api/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Great workout!",
        stats: { duration: "3600", work_kj: 750, avg_power: 185, avg_hr: 145 },
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("rejects empty body", async () => {
    const res = await fetch(`${baseUrl}/api/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    expect(res.status).toBe(400);
  });

  test("rejects invalid JSON", async () => {
    const res = await fetch(`${baseUrl}/api/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });

  test("rejects non-POST methods", async () => {
    const res = await fetch(`${baseUrl}/api/end`, {
      method: "GET",
    });

    expect(res.status).toBe(405);
  });
});
