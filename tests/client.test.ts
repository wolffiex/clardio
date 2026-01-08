import { describe, test, expect, beforeEach, mock, afterEach, jest } from "bun:test";
import type { CoachEvent, MetricsEvent, TargetEvent } from "../src/shared/types";
import { CountdownTimer, formatRemaining, formatTargetText } from "../src/client/countdown";

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

  test("formats 150W power target with 60 second duration", () => {
    // Regression test: server converts duration -> remaining
    // Before fix: { power: 150, duration: 60 } caused "150W | NaN:NaN"
    // After fix: { power: 150, remaining: 60 } shows "150W for 1:00"
    const target: TargetEvent = { power: 150, remaining: 60 };
    expect(formatTargetDisplay(target)).toBe("150W for 1:00");
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

describe("formatRemaining", () => {
  test("formats 0 seconds", () => {
    expect(formatRemaining(0)).toBe("0:00");
  });

  test("formats seconds only", () => {
    expect(formatRemaining(45)).toBe("0:45");
  });

  test("formats minutes and seconds", () => {
    expect(formatRemaining(167)).toBe("2:47");
  });

  test("formats 10 minutes", () => {
    expect(formatRemaining(600)).toBe("10:00");
  });

  test("formats large durations", () => {
    expect(formatRemaining(3661)).toBe("61:01");
  });
});

describe("formatTargetText", () => {
  test("formats power only", () => {
    expect(formatTargetText({ power: 180 })).toBe("180W");
  });

  test("formats cadence only", () => {
    expect(formatTargetText({ cadence: 95 })).toBe("95rpm");
  });

  test("formats power and cadence", () => {
    expect(formatTargetText({ power: 180, cadence: 85 })).toBe("180W / 85rpm");
  });

  test("returns empty for no values", () => {
    expect(formatTargetText({})).toBe("");
  });
});

describe("CountdownTimer", () => {
  let timer: CountdownTimer;
  let callbackMock: ReturnType<typeof mock>;

  beforeEach(() => {
    jest.useFakeTimers();
    callbackMock = mock(() => {});
    timer = new CountdownTimer(callbackMock);
  });

  afterEach(() => {
    timer.clear();
    jest.useRealTimers();
  });

  test("calls callback immediately with display on setTarget", () => {
    timer.setTarget({ power: 180, remaining: 60 });

    expect(callbackMock).toHaveBeenCalledTimes(1);
    expect(callbackMock).toHaveBeenCalledWith({ text: "180W", time: "1:00" });
    expect(timer.isActive()).toBe(true);
  });

  test("calls callback with null for null target", () => {
    timer.setTarget(null);

    expect(callbackMock).toHaveBeenCalledTimes(1);
    expect(callbackMock).toHaveBeenCalledWith(null);
    expect(timer.isActive()).toBe(false);
  });

  test("calls callback with null for zero duration", () => {
    timer.setTarget({ power: 180, remaining: 0 });

    expect(callbackMock).toHaveBeenCalledTimes(1);
    expect(callbackMock).toHaveBeenCalledWith(null);
    expect(timer.isActive()).toBe(false);
  });

  test("decrements remaining each second", () => {
    timer.setTarget({ power: 180, remaining: 3 });

    expect(timer.getRemaining()).toBe(3);
    expect(callbackMock).toHaveBeenCalledWith({ text: "180W", time: "0:03" });

    // Advance 1 second
    jest.advanceTimersByTime(1000);
    expect(timer.getRemaining()).toBe(2);
    expect(callbackMock).toHaveBeenCalledWith({ text: "180W", time: "0:02" });

    // Advance another second
    jest.advanceTimersByTime(1000);
    expect(timer.getRemaining()).toBe(1);
    expect(callbackMock).toHaveBeenCalledWith({ text: "180W", time: "0:01" });
  });

  test("clears display when countdown reaches 0", () => {
    timer.setTarget({ power: 180, remaining: 2 });

    // Initial call
    expect(callbackMock).toHaveBeenCalledTimes(1);
    expect(callbackMock).toHaveBeenCalledWith({ text: "180W", time: "0:02" });

    // Advance 1 second - still counting
    jest.advanceTimersByTime(1000);
    expect(callbackMock).toHaveBeenCalledWith({ text: "180W", time: "0:01" });
    expect(timer.isActive()).toBe(true);

    // Advance another second - should reach 0 and clear
    jest.advanceTimersByTime(1000);
    expect(callbackMock).toHaveBeenLastCalledWith(null);
    expect(timer.isActive()).toBe(false);
  });

  test("new target replaces old countdown", () => {
    timer.setTarget({ power: 180, remaining: 60 });
    expect(timer.getRemaining()).toBe(60);

    // Advance a bit
    jest.advanceTimersByTime(2000);
    expect(timer.getRemaining()).toBe(58);

    // Set new target - should reset
    timer.setTarget({ power: 200, cadence: 90, remaining: 120 });
    expect(timer.getRemaining()).toBe(120);
    expect(callbackMock).toHaveBeenLastCalledWith({ text: "200W / 90rpm", time: "2:00" });
  });

  test("null target clears active countdown", () => {
    timer.setTarget({ power: 180, remaining: 60 });
    expect(timer.isActive()).toBe(true);

    timer.setTarget(null);
    expect(timer.isActive()).toBe(false);
    expect(timer.getRemaining()).toBe(0);
    expect(callbackMock).toHaveBeenLastCalledWith(null);
  });

  test("rapid target changes do not leak intervals", () => {
    // Set multiple targets rapidly
    for (let i = 0; i < 10; i++) {
      timer.setTarget({ power: 100 + i, remaining: 60 });
    }

    // Only one timer should be active
    expect(timer.isActive()).toBe(true);
    expect(timer.getRemaining()).toBe(60);

    // Advance time - should only decrement once per second, not 10x
    jest.advanceTimersByTime(1000);
    expect(timer.getRemaining()).toBe(59);

    // Clear and verify no interval remains
    timer.clear();
    expect(timer.isActive()).toBe(false);
  });

  test("formats display with power and cadence", () => {
    timer.setTarget({ power: 180, cadence: 85, remaining: 167 });

    expect(callbackMock).toHaveBeenCalledWith({ text: "180W / 85rpm", time: "2:47" });
  });

  test("formats display with cadence only", () => {
    timer.setTarget({ cadence: 95, remaining: 30 });

    expect(callbackMock).toHaveBeenCalledWith({ text: "95rpm", time: "0:30" });
  });

  test("updates display on each tick", () => {
    timer.setTarget({ power: 150, remaining: 5 });

    // Initial display
    expect(callbackMock).toHaveBeenNthCalledWith(1, { text: "150W", time: "0:05" });

    // Tick through each second
    jest.advanceTimersByTime(1000);
    expect(callbackMock).toHaveBeenNthCalledWith(2, { text: "150W", time: "0:04" });

    jest.advanceTimersByTime(1000);
    expect(callbackMock).toHaveBeenNthCalledWith(3, { text: "150W", time: "0:03" });

    jest.advanceTimersByTime(1000);
    expect(callbackMock).toHaveBeenNthCalledWith(4, { text: "150W", time: "0:02" });

    jest.advanceTimersByTime(1000);
    expect(callbackMock).toHaveBeenNthCalledWith(5, { text: "150W", time: "0:01" });

    // Final tick clears display
    jest.advanceTimersByTime(1000);
    expect(callbackMock).toHaveBeenNthCalledWith(6, null);
    expect(timer.isActive()).toBe(false);
  });

  test("long duration formats correctly", () => {
    timer.setTarget({ power: 200, remaining: 600 }); // 10 minutes

    expect(callbackMock).toHaveBeenCalledWith({ text: "200W", time: "10:00" });
  });
});
