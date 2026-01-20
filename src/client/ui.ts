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

  // Client-side timer
  private timerStart: number = 0;
  private timerInterval: ReturnType<typeof setInterval> | null = null;

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
   * Start the workout timer
   */
  startTimer(): void {
    this.timerStart = Date.now();
    this.updateTimerDisplay();
    this.timerInterval = setInterval(() => this.updateTimerDisplay(), 1000);
  }

  /**
   * Stop the workout timer
   */
  stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  private updateTimerDisplay(): void {
    const elapsed = Math.floor((Date.now() - this.timerStart) / 1000);
    this.elements.time.textContent = formatTime(elapsed);
  }

  /**
   * Update metrics display with rolling averages and progress bars
   */
  updateMetrics(event: MetricsEvent): void {
    // Update basic displays (time is handled by client-side timer)
    this.elements.power.textContent = event.power.toString();
    this.elements.hr.textContent = event.hr.toString();
    this.elements.cadence.textContent = event.cadence.toString();

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
      // No target - hide everything
      elements.targetSection.className = "text-right hidden";
      elements.barContainer.className = "relative h-8 bg-gray-900 rounded-full overflow-hidden hidden";
      elements.delta.className = "mt-2 text-center font-medium hidden";
      elements.overTarget.className = "absolute right-2 top-1/2 -translate-y-1/2 text-xl text-yellow-400 font-bold hidden";
      return;
    }

    // Calculate state
    const fillPercent = calculateFillPercent(rollingAvg, target);
    const color = getProgressColor(rollingAvg, target);
    const diff = Math.round(currentValue - target);

    // Determine classes based on color
    const barColorClasses = {
      green: "from-green-600 to-green-400",
      orange: "from-orange-600 to-orange-500",
      red: "from-red-600 to-red-500",
    }[color];

    const deltaColorClass = diff >= 0
      ? (color === 'red' ? "text-red-500" : "text-green-500")
      : "text-orange-500";

    // Set all classes fresh (complete re-render)
    elements.targetSection.className = "text-right";
    elements.targetValue.textContent = target.toString();

    elements.barContainer.className = "relative h-8 bg-gray-900 rounded-full overflow-hidden";
    elements.barFill.className = `absolute inset-y-0 left-0 bg-gradient-to-r ${barColorClasses} rounded-full transition-all duration-300`;
    elements.barFill.style.width = `${fillPercent}%`;

    elements.delta.className = `mt-2 text-center font-medium ${deltaColorClass}`;
    elements.delta.textContent = diff >= 0 ? `+${diff}${unit}` : `${Math.abs(diff)}${unit} to go`;

    elements.overTarget.className = color === 'red'
      ? "absolute right-2 top-1/2 -translate-y-1/2 text-xl text-yellow-400 font-bold"
      : "absolute right-2 top-1/2 -translate-y-1/2 text-xl text-yellow-400 font-bold hidden";
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
