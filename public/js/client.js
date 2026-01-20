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
          console.log(`[SSE] Received ${type}:`, event.data);
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
function getProgressColor(rollingAvg, target, grace = 5) {
  if (rollingAvg < target)
    return "orange";
  if (rollingAvg > target + grace)
    return "red";
  return "green";
}

// src/client/ui.ts
class UIController {
  elements;
  powerAvg;
  cadenceAvg;
  target = null;
  lastPower = 0;
  lastCadence = 0;
  timerStart = 0;
  timerInterval = null;
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
  startTimer() {
    this.timerStart = Date.now();
    this.updateTimerDisplay();
    this.timerInterval = setInterval(() => this.updateTimerDisplay(), 1000);
  }
  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }
  updateTimerDisplay() {
    const elapsed = Math.floor((Date.now() - this.timerStart) / 1000);
    this.elements.time.textContent = formatTime(elapsed);
  }
  updateMetrics(event) {
    this.elements.power.textContent = event.power.toString();
    this.elements.hr.textContent = event.hr.toString();
    this.elements.cadence.textContent = event.cadence.toString();
    this.lastPower = event.power;
    this.lastCadence = event.cadence;
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
      elements.targetSection.className = "text-right hidden";
      elements.barContainer.className = "relative h-8 bg-gray-900 rounded-full overflow-hidden hidden";
      elements.delta.className = "mt-2 text-center font-medium hidden";
      elements.overTarget.className = "absolute right-2 top-1/2 -translate-y-1/2 text-xl text-yellow-400 font-bold hidden";
      return;
    }
    const fillPercent = calculateFillPercent(rollingAvg, target);
    const color = getProgressColor(rollingAvg, target);
    const diff = Math.round(currentValue - target);
    const barColorClasses = {
      green: "from-green-600 to-green-400",
      orange: "from-orange-600 to-orange-500",
      red: "from-red-600 to-red-500"
    }[color];
    const deltaColorClass = diff >= 0 ? color === "red" ? "text-red-500" : "text-green-500" : "text-orange-500";
    elements.targetSection.className = "text-right";
    elements.targetValue.textContent = target.toString();
    elements.barContainer.className = "relative h-8 bg-gray-900 rounded-full overflow-hidden";
    elements.barFill.className = `absolute inset-y-0 left-0 bg-gradient-to-r ${barColorClasses} rounded-full transition-all duration-300`;
    elements.barFill.style.width = `${fillPercent}%`;
    elements.delta.className = `mt-2 text-center font-medium ${deltaColorClass}`;
    elements.delta.textContent = diff >= 0 ? `+${diff}${unit}` : `${Math.abs(diff)}${unit} to go`;
    elements.overTarget.className = color === "red" ? "absolute right-2 top-1/2 -translate-y-1/2 text-xl text-yellow-400 font-bold" : "absolute right-2 top-1/2 -translate-y-1/2 text-xl text-yellow-400 font-bold hidden";
  }
  updateTarget(event) {
    if (!event) {
      this.target = null;
      this.updateProgressBar("power", this.lastPower, this.powerAvg.average(), undefined, "W");
      this.updateProgressBar("cadence", this.lastCadence, this.cadenceAvg.average(), undefined, "rpm");
      return;
    }
    this.target = {
      power: event.power,
      cadence: event.cadence
    };
    this.updateProgressBar("power", this.lastPower, this.powerAvg.average(), this.target.power, "W");
    this.updateProgressBar("cadence", this.lastCadence, this.cadenceAvg.average(), this.target.cadence, "rpm");
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
var params = new URLSearchParams(window.location.search);
var testMode = params.has("power") || params.has("target_power");
if (testMode) {
  console.log("[App] Test mode enabled via URL params");
  ui.setConnectionStatus("connected");
  ui.startTimer();
  const message = params.get("message");
  if (message) {
    ui.updateCoach({ text: message });
  }
  const targetPower = params.get("target_power");
  const targetCadence = params.get("target_cadence");
  if (targetPower && targetCadence) {
    ui.updateTarget({
      power: parseInt(targetPower),
      cadence: parseInt(targetCadence)
    });
  }
  const power = params.get("power");
  const cadence = params.get("cadence");
  const hr = params.get("hr");
  if (power && cadence) {
    ui.updateMetrics({
      power: parseInt(power),
      hr: hr ? parseInt(hr) : 120,
      cadence: parseInt(cadence),
      elapsed: 10
    });
  }
} else {
  sse.on("connected", () => {
    console.log("[App] SSE connected event received");
    ui.setConnectionStatus("connected");
    ui.startTimer();
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
    ui.stopTimer();
  });
  sse.connect();
}
console.log("[App] Clardio UI initialized");
