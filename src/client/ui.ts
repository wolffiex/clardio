import type { CoachEvent, MetricsEvent, TargetEvent } from "../shared/types";
import { formatTime } from "./handlers";
import { RollingAverage, calculateFillPercent, getProgressColor } from "./rolling-average";

interface UIElements {
  coachMessage: HTMLElement;
  power: HTMLElement;
  hr: HTMLElement;
  cadence: HTMLElement;
  time: HTMLElement;
  // Target elements
  powerTargetSection: HTMLElement;
  powerTarget: HTMLElement;
  powerBarContainer: HTMLElement;
  powerBarFill: HTMLElement;
  powerDelta: HTMLElement;
  powerOverTarget: HTMLElement;
  cadenceTargetSection: HTMLElement;
  cadenceTarget: HTMLElement;
  cadenceBarContainer: HTMLElement;
  cadenceBarFill: HTMLElement;
  cadenceDelta: HTMLElement;
  cadenceOverTarget: HTMLElement;
  // Connection
  connectionDot: HTMLElement;
  connectionText: HTMLElement;
}

interface CurrentTarget {
  power: number;
  cadence: number;
}

/**
 * UI Controller - manages DOM updates with progress bar meters
 */
export class UIController {
  private elements: UIElements;

  // Rolling averages for smoothing
  private powerAvg: RollingAverage;
  private cadenceAvg: RollingAverage;

  // Current target from coach
  private target: CurrentTarget | null = null;

  // Last known values for re-rendering on target change
  private lastPower: number = 0;
  private lastCadence: number = 0;

  constructor() {
    this.powerAvg = new RollingAverage(3);
    this.cadenceAvg = new RollingAverage(3);

    this.elements = {
      coachMessage: document.getElementById("coach-message")!,
      power: document.getElementById("metric-power")!,
      hr: document.getElementById("metric-hr")!,
      cadence: document.getElementById("metric-cadence")!,
      time: document.getElementById("metric-time")!,
      // Target elements
      powerTargetSection: document.getElementById("power-target-section")!,
      powerTarget: document.getElementById("power-target")!,
      powerBarContainer: document.getElementById("power-bar-container")!,
      powerBarFill: document.getElementById("power-bar-fill")!,
      powerDelta: document.getElementById("power-delta")!,
      powerOverTarget: document.getElementById("power-over-target")!,
      cadenceTargetSection: document.getElementById("cadence-target-section")!,
      cadenceTarget: document.getElementById("cadence-target")!,
      cadenceBarContainer: document.getElementById("cadence-bar-container")!,
      cadenceBarFill: document.getElementById("cadence-bar-fill")!,
      cadenceDelta: document.getElementById("cadence-delta")!,
      cadenceOverTarget: document.getElementById("cadence-over-target")!,
      // Connection
      connectionDot: document.getElementById("connection-dot")!,
      connectionText: document.getElementById("connection-text")!,
    };
  }

  /**
   * Update coach message
   */
  updateCoach(event: CoachEvent): void {
    this.elements.coachMessage.textContent = event.text;
  }

  /**
   * Update metrics display with rolling averages and progress bars
   */
  updateMetrics(event: MetricsEvent): void {
    // Update basic displays
    this.elements.power.textContent = event.power.toString();
    this.elements.hr.textContent = event.hr.toString();
    this.elements.cadence.textContent = event.cadence.toString();
    this.elements.time.textContent = formatTime(event.elapsed);

    // Store last values for re-rendering on target change
    this.lastPower = event.power;
    this.lastCadence = event.cadence;

    // Push to rolling averages
    const powerRolling = this.powerAvg.push(event.power);
    const cadenceRolling = this.cadenceAvg.push(event.cadence);

    // Update progress bars if target is set
    this.updateProgressBar(
      'power',
      event.power,
      powerRolling,
      this.target?.power,
      'W'
    );

    this.updateProgressBar(
      'cadence',
      event.cadence,
      cadenceRolling,
      this.target?.cadence,
      'rpm'
    );
  }

  /**
   * Update a single progress bar meter
   * @param currentValue - The instantaneous value (for delta display)
   * @param rollingAvg - The rolling average (for progress bar fill)
   */
  private updateProgressBar(
    type: 'power' | 'cadence',
    currentValue: number,
    rollingAvg: number,
    target: number | undefined,
    unit: string
  ): void {
    const elements = type === 'power'
      ? {
          targetSection: this.elements.powerTargetSection,
          targetValue: this.elements.powerTarget,
          barContainer: this.elements.powerBarContainer,
          barFill: this.elements.powerBarFill,
          delta: this.elements.powerDelta,
          overTarget: this.elements.powerOverTarget,
        }
      : {
          targetSection: this.elements.cadenceTargetSection,
          targetValue: this.elements.cadenceTarget,
          barContainer: this.elements.cadenceBarContainer,
          barFill: this.elements.cadenceBarFill,
          delta: this.elements.cadenceDelta,
          overTarget: this.elements.cadenceOverTarget,
        };

    if (!target) {
      // No target - hide progress bar elements
      elements.targetSection.classList.add("hidden");
      elements.barContainer.classList.add("hidden");
      elements.delta.classList.add("hidden");
      elements.overTarget.classList.add("hidden");
      return;
    }

    // Show target elements
    elements.targetSection.classList.remove("hidden");
    elements.barContainer.classList.remove("hidden");
    elements.delta.classList.remove("hidden");

    // Update target display
    elements.targetValue.textContent = target.toString();

    // Calculate fill percentage and color
    const fillPercent = calculateFillPercent(rollingAvg, target);
    const color = getProgressColor(rollingAvg, target);

    // Update bar fill
    elements.barFill.style.width = `${fillPercent}%`;

    // Update bar color based on target status
    if (color === 'green') {
      elements.barFill.classList.remove("from-orange-600", "to-orange-500");
      elements.barFill.classList.add("from-green-600", "to-green-400");
    } else {
      elements.barFill.classList.remove("from-green-600", "to-green-400");
      elements.barFill.classList.add("from-orange-600", "to-orange-500");
    }

    // Update delta text (uses current value, not rolling average, to match displayed value)
    const diff = Math.round(currentValue - target);
    if (diff >= 0) {
      elements.delta.textContent = `+${diff}${unit}`;
      elements.delta.classList.remove("text-orange-500");
      elements.delta.classList.add("text-green-500");
    } else {
      elements.delta.textContent = `${Math.abs(diff)}${unit} to go`;
      elements.delta.classList.remove("text-green-500");
      elements.delta.classList.add("text-orange-500");
    }

    // Show over-target warning when rolling average exceeds target
    if (rollingAvg > target) {
      elements.overTarget.classList.remove("hidden");
    } else {
      elements.overTarget.classList.add("hidden");
    }
  }

  /**
   * Update target from coach
   */
  updateTarget(event: TargetEvent | null): void {
    if (!event) {
      this.target = null;
      // Re-render to hide target UI
      this.updateProgressBar('power', this.lastPower, this.powerAvg.average(), undefined, 'W');
      this.updateProgressBar('cadence', this.lastCadence, this.cadenceAvg.average(), undefined, 'rpm');
      return;
    }

    this.target = {
      power: event.power,
      cadence: event.cadence,
    };

    // Re-render progress bars with new target
    this.updateProgressBar('power', this.lastPower, this.powerAvg.average(), this.target.power, 'W');
    this.updateProgressBar('cadence', this.lastCadence, this.cadenceAvg.average(), this.target.cadence, 'rpm');
  }

  /**
   * Update connection status indicator
   */
  setConnectionStatus(status: "connected" | "connecting" | "disconnected"): void {
    const dotColors = {
      connected: "bg-green-500",
      connecting: "bg-yellow-500",
      disconnected: "bg-red-500",
    };

    // Remove all color classes
    this.elements.connectionDot.classList.remove("bg-green-500", "bg-yellow-500", "bg-red-500");
    this.elements.connectionDot.classList.add(dotColors[status]);
    this.elements.connectionText.textContent = status;
  }

  /**
   * Get current target (for testing)
   */
  getCurrentTarget(): CurrentTarget | null {
    return this.target ? { ...this.target } : null;
  }
}
