import type { CoachEvent, MetricsEvent, TargetEvent } from "../shared/types";
import { formatTime } from "./handlers";
import {
  calculateFillPercent,
  calculateTargetPosition,
  getColorFromDistance,
  POWER_MIN,
  POWER_MAX,
  CADENCE_MIN,
  CADENCE_MAX,
  POWER_GRACE_ZONE,
  POWER_MAX_DISTANCE,
  CADENCE_GRACE_ZONE,
  CADENCE_MAX_DISTANCE,
} from "./progress";

interface UIElements {
  coachMessage: HTMLElement;
  power: HTMLElement;
  hr: HTMLElement;
  cadence: HTMLElement;
  time: HTMLElement;
  powerBarContainer: HTMLElement;
  powerBarFill: HTMLElement;
  powerTargetPointer: HTMLElement;
  powerTargetLabel: HTMLElement;
  powerValueLabel: HTMLElement;
  powerScaleLabels: HTMLElement;
  powerDelta: HTMLElement;
  cadenceBarContainer: HTMLElement;
  cadenceBarFill: HTMLElement;
  cadenceTargetPointer: HTMLElement;
  cadenceTargetLabel: HTMLElement;
  cadenceValueLabel: HTMLElement;
  cadenceScaleLabels: HTMLElement;
  cadenceDelta: HTMLElement;
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
      powerBarContainer: document.getElementById("power-bar-container")!,
      powerBarFill: document.getElementById("power-bar-fill")!,
      powerTargetPointer: document.getElementById("power-target-pointer")!,
      powerTargetLabel: document.getElementById("power-target-label")!,
      powerValueLabel: document.getElementById("power-value-label")!,
      powerScaleLabels: document.getElementById("power-scale-labels")!,
      powerDelta: document.getElementById("power-delta")!,
      cadenceBarContainer: document.getElementById("cadence-bar-container")!,
      cadenceBarFill: document.getElementById("cadence-bar-fill")!,
      cadenceTargetPointer: document.getElementById("cadence-target-pointer")!,
      cadenceTargetLabel: document.getElementById("cadence-target-label")!,
      cadenceValueLabel: document.getElementById("cadence-value-label")!,
      cadenceScaleLabels: document.getElementById("cadence-scale-labels")!,
      cadenceDelta: document.getElementById("cadence-delta")!,
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

    // Clamp displayed values to reasonable ranges
    const displayPower = Math.max(0, Math.min(500, event.power));
    const displayCadence = Math.max(0, Math.min(200, event.cadence));

    this.elements.power.textContent = displayPower.toString();
    this.elements.hr.textContent = event.hr.toString();
    this.elements.cadence.textContent = displayCadence.toString();

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
      this.power,
      this.targetPower,
      POWER_MIN,
      POWER_MAX,
      POWER_GRACE_ZONE,
      POWER_MAX_DISTANCE,
      'W',
      this.elements.powerBarContainer,
      this.elements.powerBarFill,
      this.elements.powerTargetPointer,
      this.elements.powerTargetLabel,
      this.elements.powerValueLabel,
      this.elements.powerScaleLabels,
      this.elements.powerDelta
    );
    this.renderProgressBar(
      this.cadence,
      this.targetCadence,
      CADENCE_MIN,
      CADENCE_MAX,
      CADENCE_GRACE_ZONE,
      CADENCE_MAX_DISTANCE,
      'rpm',
      this.elements.cadenceBarContainer,
      this.elements.cadenceBarFill,
      this.elements.cadenceTargetPointer,
      this.elements.cadenceTargetLabel,
      this.elements.cadenceValueLabel,
      this.elements.cadenceScaleLabels,
      this.elements.cadenceDelta
    );
  }

  private renderProgressBar(
    value: number,
    target: number | null,
    min: number,
    max: number,
    graceZone: number,
    maxDistance: number,
    unit: string,
    barContainer: HTMLElement,
    barFill: HTMLElement,
    targetPointer: HTMLElement,
    targetLabel: HTMLElement,
    valueLabel: HTMLElement,
    scaleLabels: HTMLElement,
    delta: HTMLElement
  ): void {
    if (target === null) {
      barContainer.className = "relative h-8 bg-gray-900 rounded-full overflow-hidden hidden";
      targetPointer.className = "absolute top-0 bottom-0 w-0.5 bg-white hidden";
      targetLabel.className = "absolute -top-6 text-sm text-gray-400 tabular-nums hidden";
      valueLabel.className = "absolute -top-10 text-3xl font-bold text-white tabular-nums hidden";
      scaleLabels.className = "flex justify-between text-sm text-gray-500 mt-1 hidden";
      delta.className = "mt-2 text-center font-medium hidden";
      return;
    }

    const fillPercent = calculateFillPercent(value, min, max);
    const targetPos = calculateTargetPosition(target, min, max);
    const color = getColorFromDistance(value, target, graceZone, maxDistance);
    const diff = Math.round(value - target);

    barContainer.className = "relative h-8 bg-gray-900 rounded-full overflow-visible";
    barFill.className = "absolute inset-y-0 left-0 rounded-full transition-all duration-300";
    barFill.style.width = `${fillPercent}%`;
    barFill.style.backgroundColor = color;

    // Position target pointer
    targetPointer.className = "absolute top-0 bottom-0 w-0.5 bg-white";
    targetPointer.style.left = `${targetPos}%`;
    targetPointer.style.transform = "translateX(-50%)";

    // Position target label above the pointer
    targetLabel.className = "absolute -top-6 text-sm text-gray-400 tabular-nums";
    targetLabel.style.left = `${targetPos}%`;
    targetLabel.textContent = `${target}${unit}`;

    // Position value label above the fill line, clamped to 20-90% to avoid edge overlap
    // 20% minimum prevents overlap with POWER/CADENCE label on the left
    const labelPosition = Math.max(20, Math.min(90, fillPercent));
    valueLabel.style.left = `${labelPosition}%`;

    // Show scale labels
    scaleLabels.className = "flex justify-between text-sm text-gray-500 mt-1";

    // Delta text color based on distance
    // Cap delta display for huge values
    const maxDelta = unit === 'W' ? 100 : 50;
    delta.className = "mt-2 text-center font-medium";
    delta.style.color = color;
    if (Math.abs(diff) > maxDelta) {
      delta.textContent = diff > 0 ? `>${maxDelta}${unit}` : `<-${maxDelta}${unit}`;
    } else {
      delta.textContent = diff >= 0 ? `+${diff}${unit}` : `${diff}${unit}`;
    }
  }
}
