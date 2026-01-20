import type { CoachEvent, MetricsEvent, TargetEvent } from "../shared/types";
import { formatTime } from "./handlers";
import { calculateFillPercent, getProgressColor } from "./progress";

interface UIElements {
  coachMessage: HTMLElement;
  power: HTMLElement;
  hr: HTMLElement;
  cadence: HTMLElement;
  time: HTMLElement;
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
  connectionDot: HTMLElement;
  connectionText: HTMLElement;
}

export class UIController {
  private elements: UIElements;
  private power: number = 0;
  private cadence: number = 0;
  private targetPower: number | null = null;
  private targetCadence: number | null = null;
  private timerStart: number = 0;
  private timerInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.elements = {
      coachMessage: document.getElementById("coach-message")!,
      power: document.getElementById("metric-power")!,
      hr: document.getElementById("metric-hr")!,
      cadence: document.getElementById("metric-cadence")!,
      time: document.getElementById("metric-time")!,
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
      connectionDot: document.getElementById("connection-dot")!,
      connectionText: document.getElementById("connection-text")!,
    };
  }

  startTimer(): void {
    this.timerStart = Date.now();
    this.updateTimerDisplay();
    this.timerInterval = setInterval(() => this.updateTimerDisplay(), 1000);
  }

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

  updateCoach(event: CoachEvent): void {
    this.elements.coachMessage.textContent = event.text;
  }

  updateMetrics(event: MetricsEvent): void {
    this.power = event.power;
    this.cadence = event.cadence;

    this.elements.power.textContent = event.power.toString();
    this.elements.hr.textContent = event.hr.toString();
    this.elements.cadence.textContent = event.cadence.toString();

    this.render();
  }

  updateTarget(event: TargetEvent | null): void {
    if (event) {
      this.targetPower = event.power;
      this.targetCadence = event.cadence;
    } else {
      this.targetPower = null;
      this.targetCadence = null;
    }
    this.render();
  }

  setConnectionStatus(status: "connected" | "connecting" | "disconnected"): void {
    const dotColors = {
      connected: "bg-green-500",
      connecting: "bg-yellow-500",
      disconnected: "bg-red-500",
    };
    this.elements.connectionDot.className = `w-3 h-3 rounded-full ${dotColors[status]}`;
    this.elements.connectionText.textContent = status;
  }

  private render(): void {
    this.renderProgressBar(
      'power',
      this.power,
      this.targetPower,
      'W',
      this.elements.powerTargetSection,
      this.elements.powerTarget,
      this.elements.powerBarContainer,
      this.elements.powerBarFill,
      this.elements.powerDelta,
      this.elements.powerOverTarget
    );
    this.renderProgressBar(
      'cadence',
      this.cadence,
      this.targetCadence,
      'rpm',
      this.elements.cadenceTargetSection,
      this.elements.cadenceTarget,
      this.elements.cadenceBarContainer,
      this.elements.cadenceBarFill,
      this.elements.cadenceDelta,
      this.elements.cadenceOverTarget
    );
  }

  private renderProgressBar(
    _type: string,
    value: number,
    target: number | null,
    unit: string,
    targetSection: HTMLElement,
    targetValue: HTMLElement,
    barContainer: HTMLElement,
    barFill: HTMLElement,
    delta: HTMLElement,
    overTarget: HTMLElement
  ): void {
    if (target === null) {
      targetSection.className = "text-right hidden";
      barContainer.className = "relative h-8 bg-gray-900 rounded-full overflow-hidden hidden";
      delta.className = "mt-2 text-center font-medium hidden";
      overTarget.className = "absolute right-2 top-1/2 -translate-y-1/2 text-xl text-yellow-400 font-bold hidden";
      return;
    }

    const fillPercent = calculateFillPercent(value, target);
    const color = getProgressColor(value, target);
    const diff = Math.round(value - target);

    const barColorClasses = {
      green: "from-green-600 to-green-400",
      orange: "from-orange-600 to-orange-500",
      red: "from-red-600 to-red-500",
    }[color];

    const deltaColorClass = diff >= 0
      ? (color === 'red' ? "text-red-500" : "text-green-500")
      : "text-orange-500";

    targetSection.className = "text-right";
    targetValue.textContent = target.toString();

    barContainer.className = "relative h-8 bg-gray-900 rounded-full overflow-hidden";
    barFill.className = `absolute inset-y-0 left-0 bg-gradient-to-r ${barColorClasses} rounded-full transition-all duration-300`;
    barFill.style.width = `${fillPercent}%`;

    delta.className = `mt-2 text-center font-medium ${deltaColorClass}`;
    delta.textContent = diff >= 0 ? `+${diff}${unit}` : `${Math.abs(diff)}${unit} to go`;

    overTarget.className = color === 'red'
      ? "absolute right-2 top-1/2 -translate-y-1/2 text-xl text-yellow-400 font-bold"
      : "absolute right-2 top-1/2 -translate-y-1/2 text-xl text-yellow-400 font-bold hidden";
  }
}
