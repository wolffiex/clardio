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
  power?: number;
  cadence?: number;
}

/**
 * UI Controller - manages DOM updates with progress bar meters
 */
export class UIController {
  private elements: UIElements;
  private countdown: CountdownTimer;

  // Rolling averages for smoothing
  private powerAvg: RollingAverage;
  private cadenceAvg: RollingAverage;

  // Current target values
  private currentTarget: CurrentTarget = {};

  constructor() {
    this.powerAvg = new RollingAverage(3);
    this.cadenceAvg = new RollingAverage(3);

    this.countdown = new CountdownTimer((display) => {
      this.updateCountdownDisplay(display);
    });

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

    // Update progress bars if targets are set
    this.updateProgressBar(
      'power',
      powerRolling,
      this.currentTarget.power,
      'W'
    );

    this.updateProgressBar(
      'cadence',
      cadenceRolling,
      this.currentTarget.cadence,
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
   * Update target - starts countdown timer and stores target values
   */
  updateTarget(event: TargetEvent | null): void {
    if (event) {
      // Store current target values
      this.currentTarget = {
        power: event.power,
        cadence: event.cadence,
      };
    } else {
      // Clear targets
      this.currentTarget = {};
    }

    this.countdown.setTarget(event);
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
      // Clear targets when countdown ends
      this.currentTarget = {};
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
   * Get current target (for testing)
   */
  getCurrentTarget(): CurrentTarget {
    return { ...this.currentTarget };
  }
}
