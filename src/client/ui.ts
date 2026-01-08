import type { CoachEvent, MetricsEvent, TargetEvent } from "../shared/types";
import { formatTime } from "./handlers";
import { CountdownTimer } from "./countdown";

interface UIElements {
  coachMessage: HTMLElement;
  actionButton: HTMLButtonElement;
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
  private onButtonClick: ((label: string) => void) | null = null;
  private currentButtonLabel: string = "";
  private countdown: CountdownTimer;

  constructor() {
    this.countdown = new CountdownTimer((display) => {
      this.updateTargetDisplay(display);
    });

    this.elements = {
      coachMessage: document.getElementById("coach-message")!,
      actionButton: document.getElementById("action-button") as HTMLButtonElement,
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

    // Button click handler
    this.elements.actionButton.addEventListener("click", () => {
      if (this.currentButtonLabel && this.onButtonClick) {
        this.onButtonClick(this.currentButtonLabel);
      }
    });
  }

  /**
   * Set handler for button clicks
   */
  setButtonHandler(handler: (label: string) => void): void {
    this.onButtonClick = handler;
  }

  /**
   * Update coach message and button
   */
  updateCoach(event: CoachEvent): void {
    this.elements.coachMessage.textContent = event.text;

    if (event.button) {
      this.currentButtonLabel = event.button;
      this.elements.actionButton.textContent = event.button;
      this.elements.actionButton.classList.remove("hidden");
    } else {
      this.hideButton();
    }
  }

  /**
   * Hide the action button
   */
  hideButton(): void {
    this.elements.actionButton.classList.add("hidden");
    this.currentButtonLabel = "";
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
