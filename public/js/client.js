// src/client/sse-client.ts
class SSEClient {
  eventSource = null;
  handlers = new Map;
  url = "/api/events";
  on(event, handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event).push(handler);
  }
  emit(event, data) {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(data);
      }
    }
  }
  connect(url = "/api/events") {
    this.url = url;
    this.eventSource = new EventSource(url);
    this.eventSource.onopen = () => {
      console.log("[SSE] Connected");
      this.emit("_connected", {});
    };
    this.eventSource.onerror = (err) => {
      console.error("[SSE] Error, will auto-reconnect", err);
      this.emit("_error", err);
    };
    const eventTypes = ["connected", "coach", "metrics", "target"];
    for (const type of eventTypes) {
      this.eventSource.addEventListener(type, (event) => {
        try {
          const data = JSON.parse(event.data);
          this.emit(type, data);
        } catch (error) {
          console.error(`[SSE] Failed to parse ${type} event:`, error);
        }
      });
    }
  }
  disconnect() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
  isConnected() {
    return this.eventSource?.readyState === EventSource.OPEN;
  }
}

// src/client/handlers.ts
function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor(seconds % 3600 / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

// src/client/countdown.ts
function formatRemaining(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
function formatTargetText(target) {
  if (target.power !== undefined && target.cadence !== undefined) {
    return `${target.power}W / ${target.cadence}rpm`;
  } else if (target.power !== undefined) {
    return `${target.power}W`;
  } else if (target.cadence !== undefined) {
    return `${target.cadence}rpm`;
  }
  return "";
}

class CountdownTimer {
  intervalId = null;
  remaining = 0;
  target = null;
  callback;
  onComplete = null;
  constructor(callback, onComplete) {
    this.callback = callback;
    this.onComplete = onComplete || null;
  }
  setOnComplete(callback) {
    this.onComplete = callback;
  }
  setTarget(event) {
    this.clear();
    if (!event) {
      this.callback(null);
      return false;
    }
    if (event.remaining === undefined) {
      return false;
    }
    if (event.remaining <= 0) {
      this.callback(null);
      if (this.onComplete) {
        this.onComplete();
      }
      return false;
    }
    this.target = { power: event.power, cadence: event.cadence };
    this.remaining = event.remaining;
    this.updateDisplay();
    this.intervalId = setInterval(() => {
      this.remaining--;
      if (this.remaining <= 0) {
        this.clear();
        this.callback(null);
        if (this.onComplete) {
          this.onComplete();
        }
      } else {
        this.updateDisplay();
      }
    }, 1000);
    return true;
  }
  clear() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.target = null;
    this.remaining = 0;
  }
  updateDisplay() {
    if (!this.target)
      return;
    const text = formatTargetText(this.target);
    const time = formatRemaining(this.remaining);
    this.callback({ text, time });
  }
  getRemaining() {
    return this.remaining;
  }
  isActive() {
    return this.intervalId !== null;
  }
}

// src/client/rolling-average.ts
class RollingAverage {
  values = [];
  windowSize;
  constructor(windowSeconds = 3) {
    this.windowSize = windowSeconds;
  }
  push(value) {
    this.values.push(value);
    if (this.values.length > this.windowSize) {
      this.values.shift();
    }
    return this.average();
  }
  average() {
    if (this.values.length === 0)
      return 0;
    return this.values.reduce((a, b) => a + b, 0) / this.values.length;
  }
  clear() {
    this.values = [];
  }
  count() {
    return this.values.length;
  }
}
function calculateFillPercent(rollingAvg, target) {
  if (target <= 0)
    return 0;
  return Math.min(100, rollingAvg / target * 100);
}
function getProgressColor(rollingAvg, target) {
  return rollingAvg >= target ? "green" : "orange";
}

// src/client/ui.ts
class UIController {
  elements;
  countdown;
  powerAvg;
  cadenceAvg;
  baseline = null;
  activeTarget = null;
  constructor() {
    this.powerAvg = new RollingAverage(3);
    this.cadenceAvg = new RollingAverage(3);
    this.countdown = new CountdownTimer((display) => this.updateCountdownDisplay(display), () => this.revertToBaseline());
    this.elements = {
      coachMessage: document.getElementById("coach-message"),
      power: document.getElementById("metric-power"),
      hr: document.getElementById("metric-hr"),
      cadence: document.getElementById("metric-cadence"),
      time: document.getElementById("metric-time"),
      powerTargetSection: document.getElementById("power-target-section"),
      powerTarget: document.getElementById("power-target"),
      powerBarContainer: document.getElementById("power-bar-container"),
      powerBarFill: document.getElementById("power-bar-fill"),
      powerDelta: document.getElementById("power-delta"),
      cadenceTargetSection: document.getElementById("cadence-target-section"),
      cadenceTarget: document.getElementById("cadence-target"),
      cadenceBarContainer: document.getElementById("cadence-bar-container"),
      cadenceBarFill: document.getElementById("cadence-bar-fill"),
      cadenceDelta: document.getElementById("cadence-delta"),
      countdownSection: document.getElementById("countdown-section"),
      countdownTime: document.getElementById("countdown-time"),
      connectionDot: document.getElementById("connection-dot"),
      connectionText: document.getElementById("connection-text")
    };
  }
  updateCoach(event) {
    this.elements.coachMessage.textContent = event.text;
  }
  updateMetrics(event) {
    this.elements.power.textContent = event.power.toString();
    this.elements.hr.textContent = event.hr.toString();
    this.elements.cadence.textContent = event.cadence.toString();
    this.elements.time.textContent = formatTime(event.elapsed);
    const powerRolling = this.powerAvg.push(event.power);
    const cadenceRolling = this.cadenceAvg.push(event.cadence);
    const displayTarget = this.activeTarget || this.baseline;
    this.updateProgressBar("power", powerRolling, displayTarget?.power, "W");
    this.updateProgressBar("cadence", cadenceRolling, displayTarget?.cadence, "rpm");
  }
  updateProgressBar(type, rollingAvg, target, unit) {
    const elements = type === "power" ? {
      targetSection: this.elements.powerTargetSection,
      targetValue: this.elements.powerTarget,
      barContainer: this.elements.powerBarContainer,
      barFill: this.elements.powerBarFill,
      delta: this.elements.powerDelta
    } : {
      targetSection: this.elements.cadenceTargetSection,
      targetValue: this.elements.cadenceTarget,
      barContainer: this.elements.cadenceBarContainer,
      barFill: this.elements.cadenceBarFill,
      delta: this.elements.cadenceDelta
    };
    if (!target) {
      elements.targetSection.classList.add("hidden");
      elements.barContainer.classList.add("hidden");
      elements.delta.classList.add("hidden");
      return;
    }
    elements.targetSection.classList.remove("hidden");
    elements.barContainer.classList.remove("hidden");
    elements.delta.classList.remove("hidden");
    elements.targetValue.textContent = target.toString();
    const fillPercent = calculateFillPercent(rollingAvg, target);
    const color = getProgressColor(rollingAvg, target);
    elements.barFill.style.width = `${fillPercent}%`;
    if (color === "green") {
      elements.barFill.classList.remove("from-orange-600", "to-orange-500");
      elements.barFill.classList.add("from-green-600", "to-green-400");
    } else {
      elements.barFill.classList.remove("from-green-600", "to-green-400");
      elements.barFill.classList.add("from-orange-600", "to-orange-500");
    }
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
  updateTarget(event) {
    if (!event) {
      this.baseline = null;
      this.activeTarget = null;
      this.countdown.setTarget(null);
      return;
    }
    if (event.remaining !== undefined) {
      this.activeTarget = {
        power: event.power,
        cadence: event.cadence
      };
      this.countdown.setTarget(event);
    } else {
      this.baseline = {
        power: event.power,
        cadence: event.cadence
      };
    }
  }
  revertToBaseline() {
    this.activeTarget = null;
  }
  updateCountdownDisplay(display) {
    if (display) {
      this.elements.countdownTime.textContent = display.time;
      this.elements.countdownSection.classList.remove("hidden");
    } else {
      this.elements.countdownSection.classList.add("hidden");
    }
  }
  setConnectionStatus(status) {
    const dotColors = {
      connected: "bg-green-500",
      connecting: "bg-yellow-500",
      disconnected: "bg-red-500"
    };
    this.elements.connectionDot.classList.remove("bg-green-500", "bg-yellow-500", "bg-red-500");
    this.elements.connectionDot.classList.add(dotColors[status]);
    this.elements.connectionText.textContent = status;
  }
  getCurrentTarget() {
    return this.activeTarget || this.baseline;
  }
  getBaseline() {
    return this.baseline ? { ...this.baseline } : null;
  }
  getActiveTarget() {
    return this.activeTarget ? { ...this.activeTarget } : null;
  }
}

// src/client/main.ts
var sse = new SSEClient;
var ui = new UIController;
sse.on("connected", () => {
  console.log("[App] SSE connected event received");
  ui.setConnectionStatus("connected");
});
sse.on("coach", (data) => {
  ui.updateCoach(data);
});
sse.on("metrics", (data) => {
  ui.updateMetrics(data);
});
sse.on("target", (data) => {
  ui.updateTarget(data);
});
sse.on("_connected", () => {
  ui.setConnectionStatus("connecting");
});
sse.on("_error", () => {
  ui.setConnectionStatus("disconnected");
});
sse.connect();
console.log("[App] Clardio UI initialized");
