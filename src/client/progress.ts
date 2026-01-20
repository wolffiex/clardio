/**
 * Calculate progress bar fill percentage
 * @param value Current value
 * @param target Target value
 * @returns Percentage (0-100), capped at 100
 */
export function calculateFillPercent(value: number, target: number): number {
  if (target <= 0) return 0;
  return Math.min(100, (value / target) * 100);
}

/**
 * Determine progress bar color based on target
 * @param value Current value
 * @param target Target value
 * @param grace Amount over target before showing red (default 5)
 * @returns 'green' if at target (within grace), 'orange' if below, 'red' if over grace
 */
export function getProgressColor(value: number, target: number, grace: number = 5): 'green' | 'orange' | 'red' {
  if (value < target) return 'orange';
  if (value > target + grace) return 'red';
  return 'green';
}
