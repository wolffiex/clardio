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
  powerAvg;
  cadenceAvg;
  target = null;
  constructor() {
    this.powerAvg = new RollingAverage(3);
    this.cadenceAvg = new RollingAverage(3);
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
      powerOverTarget: document.getElementById("power-over-target"),
      cadenceTargetSection: document.getElementById("cadence-target-section"),
      cadenceTarget: document.getElementById("cadence-target"),
      cadenceBarContainer: document.getElementById("cadence-bar-container"),
      cadenceBarFill: document.getElementById("cadence-bar-fill"),
      cadenceDelta: document.getElementById("cadence-delta"),
      cadenceOverTarget: document.getElementById("cadence-over-target"),
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
    this.updateProgressBar("power", event.power, powerRolling, this.target?.power, "W");
    this.updateProgressBar("cadence", event.cadence, cadenceRolling, this.target?.cadence, "rpm");
  }
  updateProgressBar(type, currentValue, rollingAvg, target, unit) {
    const elements = type === "power" ? {
      targetSection: this.elements.powerTargetSection,
      targetValue: this.elements.powerTarget,
      barContainer: this.elements.powerBarContainer,
      barFill: this.elements.powerBarFill,
      delta: this.elements.powerDelta,
      overTarget: this.elements.powerOverTarget
    } : {
      targetSection: this.elements.cadenceTargetSection,
      targetValue: this.elements.cadenceTarget,
      barContainer: this.elements.cadenceBarContainer,
      barFill: this.elements.cadenceBarFill,
      delta: this.elements.cadenceDelta,
      overTarget: this.elements.cadenceOverTarget
    };
    if (!target) {
      elements.targetSection.classList.add("hidden");
      elements.barContainer.classList.add("hidden");
      elements.delta.classList.add("hidden");
      elements.overTarget.classList.add("hidden");
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
    if (rollingAvg > target) {
      elements.overTarget.classList.remove("hidden");
    } else {
      elements.overTarget.classList.add("hidden");
    }
  }
  updateTarget(event) {
    if (!event) {
      this.target = null;
      return;
    }
    this.target = {
      power: event.power,
      cadence: event.cadence
    };
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
    return this.target ? { ...this.target } : null;
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
