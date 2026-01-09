import type { CoachEvent, MetricsEvent, TargetEvent } from "../shared/types";
import { formatTime } from "./handlers";
import { CountdownTimer } from "./countdown";
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
  cadenceTargetSection: HTMLElement;
  cadenceTarget: HTMLElement;
  cadenceBarContainer: HTMLElement;
  cadenceBarFill: HTMLElement;
  cadenceDelta: HTMLElement;
  // Countdown
  countdownSection: HTMLElement;
  countdownTime: HTMLElement;
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
 *
 * Tracks two types of targets:
 * - baseline: persists until changed (no countdown)
 * - activeTarget: has countdown, reverts to baseline when complete
 */
export class UIController {
  private elements: UIElements;
  private countdown: CountdownTimer;

  // Rolling averages for smoothing
  private powerAvg: RollingAverage;
  private cadenceAvg: RollingAverage;

  // Baseline target (persists until changed)
  private baseline: CurrentTarget | null = null;

  // Active target with countdown (reverts to baseline when complete)
  private activeTarget: CurrentTarget | null = null;

  constructor() {
    this.powerAvg = new RollingAverage(3);
    this.cadenceAvg = new RollingAverage(3);

    this.countdown = new CountdownTimer(
      (display) => this.updateCountdownDisplay(display),
      () => this.revertToBaseline()
    );

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
      cadenceTargetSection: document.getElementById("cadence-target-section")!,
      cadenceTarget: document.getElementById("cadence-target")!,
      cadenceBarContainer: document.getElementById("cadence-bar-container")!,
      cadenceBarFill: document.getElementById("cadence-bar-fill")!,
      cadenceDelta: document.getElementById("cadence-delta")!,
      // Countdown
      countdownSection: document.getElementById("countdown-section")!,
      countdownTime: document.getElementById("countdown-time")!,
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

    // Push to rolling averages
    const powerRolling = this.powerAvg.push(event.power);
    const cadenceRolling = this.cadenceAvg.push(event.cadence);

    // Display target: active target takes priority, otherwise show baseline
    const displayTarget = this.activeTarget || this.baseline;

    // Update progress bars if targets are set
    this.updateProgressBar(
      'power',
      powerRolling,
      displayTarget?.power,
      'W'
    );

    this.updateProgressBar(
      'cadence',
      cadenceRolling,
      displayTarget?.cadence,
      'rpm'
    );
  }

  /**
   * Update a single progress bar meter
   */
  private updateProgressBar(
    type: 'power' | 'cadence',
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
        }
      : {
          targetSection: this.elements.cadenceTargetSection,
          targetValue: this.elements.cadenceTarget,
          barContainer: this.elements.cadenceBarContainer,
          barFill: this.elements.cadenceBarFill,
          delta: this.elements.cadenceDelta,
        };

    if (!target) {
      // No target - hide progress bar elements
      elements.targetSection.classList.add("hidden");
      elements.barContainer.classList.add("hidden");
      elements.delta.classList.add("hidden");
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

    // Update delta text
    const diff = Math.round(rollingAvg - target);
    if (diff >= 0) {
      elements.delta.textContent = `+${diff}${unit}`;
      elements.delta.classList.remove("text-orange-500");
      elements.delta.classList.add("text-green-500");
    } else {
      elements.delta.textContent = `${Math.abs(diff)}${unit} to go`;
      elements.delta.classList.remove("text-green-500");
      elements.delta.classList.add("text-orange-500");
    }
  }

  /**
   * Update target - handles both baseline and active targets
   *
   * - Target WITH remaining: active target (starts countdown, reverts to baseline when done)
   * - Target WITHOUT remaining: baseline target (persists until changed)
   * - null: clears all targets
   */
  updateTarget(event: TargetEvent | null): void {
    if (!event) {
      // Null target - clear everything
      this.baseline = null;
      this.activeTarget = null;
      this.countdown.setTarget(null);
      return;
    }

    // Check if this is an active target (has remaining/duration) or baseline
    if (event.remaining !== undefined) {
      // Active target with countdown
      this.activeTarget = {
        power: event.power,
        cadence: event.cadence,
      };
      // Start countdown - will call revertToBaseline when done
      this.countdown.setTarget(event);
    } else {
      // Baseline target (no countdown)
      this.baseline = {
        power: event.power,
        cadence: event.cadence,
      };
      // Clear any active target since we're setting a new baseline
      // (but don't clear countdown - let it finish if running)
    }
  }

  /**
   * Revert display to baseline when active target countdown completes
   */
  private revertToBaseline(): void {
    this.activeTarget = null;
    // Baseline remains unchanged - UI will show baseline on next metrics update
  }

  /**
   * Internal: update countdown display elements
   */
  private updateCountdownDisplay(display: { text: string; time: string } | null): void {
    if (display) {
      this.elements.countdownTime.textContent = display.time;
      this.elements.countdownSection.classList.remove("hidden");
    } else {
      this.elements.countdownSection.classList.add("hidden");
      // Note: activeTarget is cleared by revertToBaseline callback
      // Baseline persists even when countdown ends
    }
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
   * Get current display target (for testing)
   * Returns activeTarget if set, otherwise baseline
   */
  getCurrentTarget(): CurrentTarget | null {
    return this.activeTarget || this.baseline;
  }

  /**
   * Get baseline target (for testing)
   */
  getBaseline(): CurrentTarget | null {
    return this.baseline ? { ...this.baseline } : null;
  }

  /**
   * Get active target (for testing)
   */
  getActiveTarget(): CurrentTarget | null {
    return this.activeTarget ? { ...this.activeTarget } : null;
  }
}
