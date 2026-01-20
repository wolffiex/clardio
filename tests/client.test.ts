import { describe, test, expect, mock } from "bun:test";
import type { CoachEvent, MetricsEvent, TargetEvent } from "../src/shared/types";
import { RollingAverage, calculateFillPercent, getProgressColor } from "../src/client/rolling-average";

// Test the event handler logic (pure functions, no DOM)
import {
  parseSSEEvent,
  formatTime,
} from "../src/client/handlers";

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

describe("RollingAverage", () => {
  test("returns 0 when empty", () => {
    const ra = new RollingAverage(3);
    expect(ra.average()).toBe(0);
  });

  test("returns single value when only one pushed", () => {
    const ra = new RollingAverage(3);
    expect(ra.push(100)).toBe(100);
    expect(ra.average()).toBe(100);
  });

  test("calculates average of multiple values", () => {
    const ra = new RollingAverage(3);
    ra.push(100);
    ra.push(200);
    expect(ra.average()).toBe(150);
    ra.push(300);
    expect(ra.average()).toBe(200);
  });

  test("maintains window size", () => {
    const ra = new RollingAverage(3);
    ra.push(100);
    ra.push(200);
    ra.push(300);
    // Window is full: [100, 200, 300]
    expect(ra.average()).toBe(200);
    expect(ra.count()).toBe(3);

    // Push 4th value, should drop 100
    ra.push(400);
    // Window now: [200, 300, 400]
    expect(ra.average()).toBe(300);
    expect(ra.count()).toBe(3);
  });

  test("push returns current average", () => {
    const ra = new RollingAverage(3);
    expect(ra.push(100)).toBe(100);
    expect(ra.push(200)).toBe(150);
    expect(ra.push(300)).toBe(200);
    expect(ra.push(400)).toBe(300);
  });

  test("clear resets all values", () => {
    const ra = new RollingAverage(3);
    ra.push(100);
    ra.push(200);
    ra.clear();
    expect(ra.average()).toBe(0);
    expect(ra.count()).toBe(0);
  });

  test("custom window size works", () => {
    const ra = new RollingAverage(5);
    for (let i = 1; i <= 6; i++) {
      ra.push(i * 10);
    }
    // Values: [20, 30, 40, 50, 60] (dropped 10)
    expect(ra.count()).toBe(5);
    expect(ra.average()).toBe(40);
  });

  test("default window size is 3", () => {
    const ra = new RollingAverage();
    ra.push(10);
    ra.push(20);
    ra.push(30);
    ra.push(40);
    // Should have dropped 10
    expect(ra.count()).toBe(3);
    expect(ra.average()).toBe(30);
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
