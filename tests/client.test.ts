import { describe, test, expect, mock } from "bun:test";
import {
  calculateFillPercent,
  getColorFromDistance,
  POWER_MIN,
  POWER_MAX,
  POWER_GRACE_ZONE,
  POWER_MAX_DISTANCE,
} from "../src/client/progress";
import { formatTime } from "../src/client/handlers";

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
  // Using fixed scale: POWER_MIN=0, POWER_MAX=300
  test("returns 0 when at or below min", () => {
    expect(calculateFillPercent(0, POWER_MIN, POWER_MAX)).toBe(0);
    expect(calculateFillPercent(-10, POWER_MIN, POWER_MAX)).toBe(0);
  });

  test("returns 100 when at or above max", () => {
    expect(calculateFillPercent(300, POWER_MIN, POWER_MAX)).toBe(100);
    expect(calculateFillPercent(500, POWER_MIN, POWER_MAX)).toBe(100);
  });

  test("calculates percentage within range", () => {
    // 150 is midpoint of 0-300 range
    expect(calculateFillPercent(150, POWER_MIN, POWER_MAX)).toBe(50);
  });

  test("handles typical power values", () => {
    // 100W in 0-300 range = 100/300 = ~33.33%
    const result = calculateFillPercent(100, POWER_MIN, POWER_MAX);
    expect(result).toBeCloseTo(33.33, 1);
  });
});

describe("calculateFillPercent for target position", () => {
  test("returns 0 when at or below min", () => {
    expect(calculateFillPercent(0, POWER_MIN, POWER_MAX)).toBe(0);
    expect(calculateFillPercent(-10, POWER_MIN, POWER_MAX)).toBe(0);
  });

  test("returns 100 when at or above max", () => {
    expect(calculateFillPercent(300, POWER_MIN, POWER_MAX)).toBe(100);
    expect(calculateFillPercent(500, POWER_MIN, POWER_MAX)).toBe(100);
  });

  test("calculates position within range", () => {
    // 180W target in 0-300 range = 180/300 = 60%
    const result = calculateFillPercent(180, POWER_MIN, POWER_MAX);
    expect(result).toBeCloseTo(60, 1);
  });
});

describe("getColorFromDistance", () => {
  // Using POWER_GRACE_ZONE=10, POWER_MAX_DISTANCE=50

  test("returns gray when target is null", () => {
    const color = getColorFromDistance(150, null, POWER_GRACE_ZONE, POWER_MAX_DISTANCE);
    expect(color).toBe("rgb(107, 114, 128)");
  });

  test("returns green when within grace zone", () => {
    // Exactly at target
    const atTarget = getColorFromDistance(180, 180, POWER_GRACE_ZONE, POWER_MAX_DISTANCE);
    expect(atTarget).toBe("rgb(34, 197, 94)");

    // 5W below target (within 10W grace)
    const below = getColorFromDistance(175, 180, POWER_GRACE_ZONE, POWER_MAX_DISTANCE);
    expect(below).toBe("rgb(34, 197, 94)");

    // 10W above target (edge of grace)
    const above = getColorFromDistance(190, 180, POWER_GRACE_ZONE, POWER_MAX_DISTANCE);
    expect(above).toBe("rgb(34, 197, 94)");
  });

  test("returns red when at or beyond max distance", () => {
    // 50W below target
    const farBelow = getColorFromDistance(130, 180, POWER_GRACE_ZONE, POWER_MAX_DISTANCE);
    expect(farBelow).toBe("rgb(239, 68, 68)");

    // 60W above target (beyond 50W max distance)
    const farAbove = getColorFromDistance(240, 180, POWER_GRACE_ZONE, POWER_MAX_DISTANCE);
    expect(farAbove).toBe("rgb(239, 68, 68)");
  });

  test("interpolates colors between grace and max distance", () => {
    // 30W from target (between 10W grace and 50W max)
    // This should be yellow-orange range
    const color = getColorFromDistance(150, 180, POWER_GRACE_ZONE, POWER_MAX_DISTANCE);
    // Not green, not red - should be an interpolated value
    expect(color).not.toBe("rgb(34, 197, 94)");
    expect(color).not.toBe("rgb(239, 68, 68)");
    expect(color).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });
});
