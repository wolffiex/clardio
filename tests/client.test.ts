import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { CoachEvent, MetricsEvent, TargetEvent } from "../src/shared/types";

// Test the event handler logic (pure functions, no DOM)
import {
  parseSSEEvent,
  formatTime,
  formatTargetDisplay,
} from "../src/client/handlers";

describe("parseSSEEvent", () => {
  test("parses coach event", () => {
    const data = '{"text":"Hello rider","button":"Start"}';
    const result = parseSSEEvent<CoachEvent>(data);
    expect(result.text).toBe("Hello rider");
    expect(result.button).toBe("Start");
  });

  test("parses metrics event", () => {
    const data = '{"power":200,"hr":145,"cadence":90,"elapsed":3600}';
    const result = parseSSEEvent<MetricsEvent>(data);
    expect(result.power).toBe(200);
    expect(result.hr).toBe(145);
    expect(result.cadence).toBe(90);
    expect(result.elapsed).toBe(3600);
  });

  test("parses target event", () => {
    const data = '{"power":180,"remaining":167}';
    const result = parseSSEEvent<TargetEvent>(data);
    expect(result.power).toBe(180);
    expect(result.remaining).toBe(167);
  });

  test("parses null target event", () => {
    const data = "null";
    const result = parseSSEEvent<TargetEvent | null>(data);
    expect(result).toBeNull();
  });

  test("throws on invalid JSON", () => {
    expect(() => parseSSEEvent("invalid json")).toThrow();
  });
});

describe("formatTime", () => {
  test("formats 0 seconds", () => {
    expect(formatTime(0)).toBe("00:00");
  });

  test("formats seconds only", () => {
    expect(formatTime(45)).toBe("00:45");
  });

  test("formats minutes and seconds", () => {
    expect(formatTime(125)).toBe("02:05");
  });

  test("formats hours", () => {
    expect(formatTime(3661)).toBe("1:01:01");
  });

  test("formats large hours", () => {
    expect(formatTime(7200)).toBe("2:00:00");
  });
});

describe("formatTargetDisplay", () => {
  test("formats power target", () => {
    const target: TargetEvent = { power: 180, remaining: 167 };
    expect(formatTargetDisplay(target)).toBe("180W for 2:47");
  });

  test("formats cadence target", () => {
    const target: TargetEvent = { cadence: 95, remaining: 60 };
    expect(formatTargetDisplay(target)).toBe("95rpm for 1:00");
  });

  test("formats power and cadence target", () => {
    const target: TargetEvent = { power: 200, cadence: 90, remaining: 120 };
    expect(formatTargetDisplay(target)).toBe("200W @ 90rpm for 2:00");
  });

  test("returns empty for null", () => {
    expect(formatTargetDisplay(null)).toBe("");
  });
});

describe("SSEClient event handling", () => {
  test("registers and calls event handlers", async () => {
    const { SSEClient } = await import("../src/client/sse-client");
    const client = new SSEClient();

    const coachHandler = mock(() => {});
    const metricsHandler = mock(() => {});

    client.on("coach", coachHandler);
    client.on("metrics", metricsHandler);

    // Simulate receiving events
    client.emit("coach", { text: "Test message" });
    client.emit("metrics", { power: 200, hr: 140, cadence: 85, elapsed: 100 });

    expect(coachHandler).toHaveBeenCalledTimes(1);
    expect(coachHandler).toHaveBeenCalledWith({ text: "Test message" });
    expect(metricsHandler).toHaveBeenCalledTimes(1);
  });

  test("supports multiple handlers for same event", async () => {
    const { SSEClient } = await import("../src/client/sse-client");
    const client = new SSEClient();

    const handler1 = mock(() => {});
    const handler2 = mock(() => {});

    client.on("coach", handler1);
    client.on("coach", handler2);

    client.emit("coach", { text: "Test" });

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });
});

describe("Action POST payload", () => {
  test("creates valid payload", async () => {
    const { createActionPayload } = await import("../src/client/handlers");

    const payload = createActionPayload("Start Workout");

    expect(payload.action).toBe("button_pressed");
    expect(payload.label).toBe("Start Workout");
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.timestamp).toBeGreaterThan(0);
  });
});
