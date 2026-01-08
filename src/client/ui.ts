import type { CoachEvent, MetricsEvent, TargetEvent } from "../shared/types";
import { formatTime } from "./handlers";
import { CountdownTimer } from "./countdown";

interface UIElements {
  coachMessage: HTMLElement;
  power: HTMLElement;
  hr: HTMLElement;
  cadence: HTMLElement;
  time: HTMLElement;
  targetOverlay: HTMLElement;
  targetPower: HTMLElement;
  targetRemaining: HTMLElement;
  connectionDot: HTMLElement;
  connectionText: HTMLElement;
}

/**
 * UI Controller - manages DOM updates
 */
export class UIController {
  private elements: UIElements;
  private countdown: CountdownTimer;

  constructor() {
    this.countdown = new CountdownTimer((display) => {
      this.updateTargetDisplay(display);
    });

    this.elements = {
      coachMessage: document.getElementById("coach-message")!,
      power: document.getElementById("metric-power")!,
      hr: document.getElementById("metric-hr")!,
      cadence: document.getElementById("metric-cadence")!,
      time: document.getElementById("metric-time")!,
      targetOverlay: document.getElementById("target-overlay")!,
      targetPower: document.getElementById("target-power")!,
      targetRemaining: document.getElementById("target-remaining")!,
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
   * Update metrics display
   */
  updateMetrics(event: MetricsEvent): void {
    this.elements.power.textContent = event.power.toString();
    this.elements.hr.textContent = event.hr.toString();
    this.elements.cadence.textContent = event.cadence.toString();
    this.elements.time.textContent = formatTime(event.elapsed);
  }

  /**
   * Update target - starts countdown timer
   */
  updateTarget(event: TargetEvent | null): void {
    this.countdown.setTarget(event);
  }

  /**
   * Internal: update target display elements
   */
  private updateTargetDisplay(display: { text: string; time: string } | null): void {
    if (display) {
      this.elements.targetPower.textContent = display.text;
      this.elements.targetRemaining.textContent = display.time;
      this.elements.targetOverlay.classList.remove("hidden");
    } else {
      this.elements.targetOverlay.classList.add("hidden");
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
}
