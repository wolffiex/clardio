import type { TargetEvent } from "../shared/types";

/**
 * Parse JSON data from SSE event
 */
export function parseSSEEvent<T>(data: string): T {
  return JSON.parse(data);
}

/**
 * Format seconds as time string (MM:SS or H:MM:SS)
 */
export function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Format remaining seconds as M:SS
 */
function formatRemaining(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Format target event for display
 * For active targets (with remaining), shows: "180W @ 85rpm for 2:47"
 * For baseline targets (without remaining), shows: "80W @ 70rpm"
 */
export function formatTargetDisplay(target: TargetEvent | null): string {
  if (!target) return "";

  const parts: string[] = [];

  // Format power and cadence
  parts.push(`${target.power}W @ ${target.cadence}rpm`);

  // Only add duration for active targets
  if (target.remaining !== undefined) {
    parts.push(`for ${formatRemaining(target.remaining)}`);
  }

  return parts.join(" ");
}
