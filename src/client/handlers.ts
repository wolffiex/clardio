import { TimelineController } from "./timeline";

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

// ---------------------------------------------------------------------------
// Plan state
// ---------------------------------------------------------------------------

let currentPlan: any = null;
let timeline: TimelineController | null = null;

export function initTimeline(tl: TimelineController): void {
  timeline = tl;
}

export function handlePlan(data: any): void {
  currentPlan = data;
  console.log("Plan received:", data.summary, `${data.phases.length} phases`);
  if (timeline) {
    timeline.setPlan(data.phases);
  }
}

export function getTimeline(): TimelineController | null {
  return timeline;
}

export function getPlan(): any {
  return currentPlan;
}
