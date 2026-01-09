/**
 * Rolling average calculator for smoothing metrics over time.
 * Assumes 1 update per second for window size calculation.
 */
export class RollingAverage {
  private values: number[] = [];
  private windowSize: number;

  /**
   * Create a rolling average calculator
   * @param windowSeconds Number of seconds to average over (default 3)
   */
  constructor(windowSeconds: number = 3) {
    this.windowSize = windowSeconds;
  }

  /**
   * Push a new value and return the current average
   * @param value The value to add
   * @returns The rolling average
   */
  push(value: number): number {
    this.values.push(value);
    // Keep only last windowSize values (assuming 1 update/sec)
    if (this.values.length > this.windowSize) {
      this.values.shift();
    }
    return this.average();
  }

  /**
   * Get the current average
   * @returns The average of stored values, or 0 if empty
   */
  average(): number {
    if (this.values.length === 0) return 0;
    return this.values.reduce((a, b) => a + b, 0) / this.values.length;
  }

  /**
   * Clear all stored values
   */
  clear(): void {
    this.values = [];
  }

  /**
   * Get current number of values stored
   */
  count(): number {
    return this.values.length;
  }
}

/**
 * Calculate progress bar fill percentage
 * @param rollingAvg Current rolling average value
 * @param target Target value
 * @returns Percentage (0-100), capped at 100
 */
export function calculateFillPercent(rollingAvg: number, target: number): number {
  if (target <= 0) return 0;
  return Math.min(100, (rollingAvg / target) * 100);
}

/**
 * Determine progress bar color based on target
 * @param rollingAvg Current rolling average value
 * @param target Target value
 * @returns 'green' if at or above target, 'orange' if below
 */
export function getProgressColor(rollingAvg: number, target: number): 'green' | 'orange' {
  return rollingAvg >= target ? 'green' : 'orange';
}
