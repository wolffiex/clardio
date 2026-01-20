import { describe, test, expect, mock } from "bun:test";
import type { CoachEvent, MetricsEvent, TargetEvent } from "../src/shared/types";
import { calculateFillPercent, getProgressColor } from "../src/client/progress";
import { parseSSEEvent, formatTime } from "../src/client/handlers";

describe("parseSSEEvent", () => {
  test("parses coach event", () => {
    const data = '{"text":"Hello rider"}';
    const result = parseSSEEvent<CoachEvent>(data);
    expect(result.text).toBe("Hello rider");
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
    const data = '{"power":180,"cadence":85}';
    const result = parseSSEEvent<TargetEvent>(data);
    expect(result.power).toBe(180);
    expect(result.cadence).toBe(85);
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

describe("SSEClient event handling", () => {
  test("registers and calls event handlers", async () => {
    const { SSEClient } = await import("../src/client/sse-client");
    const client = new SSEClient();

    const coachHandler = mock(() => {});
    const metricsHandler = mock(() => {});

    client.on("coach", coachHandler);
    client.on("metrics", metricsHandler);

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

describe("calculateFillPercent", () => {
  test("returns 0 for zero target", () => {
    expect(calculateFillPercent(100, 0)).toBe(0);
  });

  test("returns 0 for negative target", () => {
    expect(calculateFillPercent(100, -10)).toBe(0);
  });

  test("returns percentage when below target", () => {
    expect(calculateFillPercent(90, 100)).toBe(90);
    expect(calculateFillPercent(50, 200)).toBe(25);
  });

  test("returns 100 when at target", () => {
    expect(calculateFillPercent(100, 100)).toBe(100);
  });

  test("caps at 100 when above target", () => {
    expect(calculateFillPercent(150, 100)).toBe(100);
    expect(calculateFillPercent(200, 100)).toBe(100);
  });

  test("handles fractional percentages", () => {
    const result = calculateFillPercent(165, 180);
    expect(result).toBeCloseTo(91.67, 1);
  });
});

describe("getProgressColor", () => {
  test("returns orange when below target", () => {
    expect(getProgressColor(90, 100)).toBe("orange");
    expect(getProgressColor(50, 100)).toBe("orange");
  });

  test("returns green when at target", () => {
    expect(getProgressColor(100, 100)).toBe("green");
  });

  test("returns green when within grace (default 5)", () => {
    expect(getProgressColor(103, 100)).toBe("green");
    expect(getProgressColor(105, 100)).toBe("green");
  });

  test("returns red when over grace", () => {
    expect(getProgressColor(106, 100)).toBe("red");
    expect(getProgressColor(200, 100)).toBe("red");
  });

  test("handles custom grace value", () => {
    expect(getProgressColor(110, 100, 10)).toBe("green");
    expect(getProgressColor(111, 100, 10)).toBe("red");
  });

  test("handles edge case at exactly target", () => {
    expect(getProgressColor(180, 180)).toBe("green");
    expect(getProgressColor(85, 85)).toBe("green");
  });
});
