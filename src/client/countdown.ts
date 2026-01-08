import type { TargetEvent } from "../shared/types";

/**
 * Format remaining seconds as M:SS
 */
export function formatRemaining(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Format target display string
 */
export function formatTargetText(target: { power?: number; cadence?: number }): string {
  if (target.power !== undefined && target.cadence !== undefined) {
    return `${target.power}W / ${target.cadence}rpm`;
  } else if (target.power !== undefined) {
    return `${target.power}W`;
  } else if (target.cadence !== undefined) {
    return `${target.cadence}rpm`;
  }
  return "";
}

export type CountdownCallback = (display: { text: string; time: string } | null) => void;

/**
 * Countdown timer for target display
 * Handles interval management and display formatting
 */
export class CountdownTimer {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private remaining: number = 0;
  private target: { power?: number; cadence?: number } | null = null;
  private callback: CountdownCallback;

  constructor(callback: CountdownCallback) {
    this.callback = callback;
  }

  /**
   * Start or replace countdown with a new target
   */
  setTarget(event: TargetEvent | null): void {
    // Clear any existing countdown
    this.clear();

    if (!event) {
      // Null target - clear display
      this.callback(null);
      return;
    }

    // Zero or negative duration - clear immediately
    if (event.remaining <= 0) {
      this.callback(null);
      return;
    }

    // Store target info and remaining time
    this.target = { power: event.power, cadence: event.cadence };
    this.remaining = event.remaining;

    // Update display immediately
    this.updateDisplay();

    // Start countdown interval
    this.intervalId = setInterval(() => {
      this.remaining--;

      if (this.remaining <= 0) {
        this.clear();
        this.callback(null);
      } else {
        this.updateDisplay();
      }
    }, 1000);
  }

  /**
   * Clear countdown and stop interval
   */
  clear(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.target = null;
    this.remaining = 0;
  }

  /**
   * Update display via callback
   */
  private updateDisplay(): void {
    if (!this.target) return;

    const text = formatTargetText(this.target);
    const time = formatRemaining(this.remaining);

    this.callback({ text, time });
  }

  /**
   * Get current remaining time (for testing)
   */
  getRemaining(): number {
    return this.remaining;
  }

  /**
   * Check if countdown is active (for testing)
   */
  isActive(): boolean {
    return this.intervalId !== null;
  }
}
