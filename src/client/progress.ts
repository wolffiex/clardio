/**
 * Fixed scale ranges for meters
 */
export const POWER_MIN = 50;
export const POWER_MAX = 400;
export const CADENCE_MIN = 45;
export const CADENCE_MAX = 120;

/**
 * Calculate bar fill percentage based on fixed scale range
 * @param value Current value
 * @param min Minimum of the scale
 * @param max Maximum of the scale
 * @returns Percentage (0-100), clamped to range
 */
export function calculateFillPercent(value: number, min: number, max: number): number {
  if (value <= min) return 0;
  if (value >= max) return 100;
  return ((value - min) / (max - min)) * 100;
}

/**
 * Calculate target pointer position on the fixed scale
 * @param target Target value
 * @param min Minimum of the scale
 * @param max Maximum of the scale
 * @returns Percentage (0-100), clamped to range
 */
export function calculateTargetPosition(target: number, min: number, max: number): number {
  if (target <= min) return 0;
  if (target >= max) return 100;
  return ((target - min) / (max - min)) * 100;
}

/**
 * Grace zone thresholds (absolute values, not percentages)
 */
export const POWER_GRACE_ZONE = 10;      // ±10W from target = green
export const POWER_MAX_DISTANCE = 50;    // 50W+ from target = red
export const CADENCE_GRACE_ZONE = 5;     // ±5 rpm from target = green
export const CADENCE_MAX_DISTANCE = 20;  // 20+ rpm from target = red

/**
 * Interpolate between two colors based on a factor (0-1)
 */
function interpolateColor(color1: [number, number, number], color2: [number, number, number], factor: number): string {
  const r = Math.round(color1[0] + (color2[0] - color1[0]) * factor);
  const g = Math.round(color1[1] + (color2[1] - color1[1]) * factor);
  const b = Math.round(color1[2] + (color2[2] - color1[2]) * factor);
  return `rgb(${r}, ${g}, ${b})`;
}

// Colors: green -> yellow -> orange -> red
const GREEN: [number, number, number] = [34, 197, 94];    // #22c55e
const YELLOW: [number, number, number] = [234, 179, 8];   // #eab308
const ORANGE: [number, number, number] = [249, 115, 22];  // #f97316
const RED: [number, number, number] = [239, 68, 68];      // #ef4444

/**
 * Get color based on absolute distance from target with grace zones
 * Uses absolute thresholds, not percentages:
 * - Power: ±10W grace zone, 50W+ = red
 * - Cadence: ±5 rpm grace zone, 20+ rpm = red
 *
 * @param value Current value
 * @param target Target value (null means no target)
 * @param graceZone Absolute distance that stays green
 * @param maxDistance Absolute distance that becomes full red
 * @returns CSS color string
 */
export function getColorFromDistance(
  value: number,
  target: number | null,
  graceZone: number,
  maxDistance: number
): string {
  // No target = neutral gray
  if (target === null) return 'rgb(107, 114, 128)'; // gray-500

  const distance = Math.abs(value - target);

  // In grace zone = pure green
  if (distance <= graceZone) {
    return `rgb(${GREEN[0]}, ${GREEN[1]}, ${GREEN[2]})`;
  }

  // Beyond max distance = pure red
  if (distance >= maxDistance) {
    return `rgb(${RED[0]}, ${RED[1]}, ${RED[2]})`;
  }

  // Calculate factor from edge of grace zone to max distance
  // factor 0 = just outside grace zone (green)
  // factor 1 = at max distance (red)
  const effectiveDistance = distance - graceZone;
  const effectiveRange = maxDistance - graceZone;
  const factor = effectiveDistance / effectiveRange;

  // Smooth interpolation through green -> yellow -> orange -> red
  if (factor <= 0.33) {
    // Green to yellow
    return interpolateColor(GREEN, YELLOW, factor / 0.33);
  } else if (factor <= 0.66) {
    // Yellow to orange
    return interpolateColor(YELLOW, ORANGE, (factor - 0.33) / 0.33);
  } else {
    // Orange to red
    return interpolateColor(ORANGE, RED, (factor - 0.66) / 0.34);
  }
}
