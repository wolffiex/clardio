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
 */
export function formatTargetDisplay(target: TargetEvent | null): string {
  if (!target) return "";

  const parts: string[] = [];

  if (target.power !== undefined && target.cadence !== undefined) {
    parts.push(`${target.power}W @ ${target.cadence}rpm`);
  } else if (target.power !== undefined) {
    parts.push(`${target.power}W`);
  } else if (target.cadence !== undefined) {
    parts.push(`${target.cadence}rpm`);
  }

  if (parts.length > 0) {
    parts.push(`for ${formatRemaining(target.remaining)}`);
  }

  return parts.join(" ");
}
