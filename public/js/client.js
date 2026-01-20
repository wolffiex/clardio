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

// src/client/progress.ts
function calculateFillPercent(value, target) {
  if (target <= 0)
    return 0;
  return Math.min(100, value / target * 100);
}
function getProgressColor(value, target, grace = 5) {
  if (value < target)
    return "orange";
  if (value > target + grace)
    return "red";
  return "green";
}

// src/client/ui.ts
class UIController {
  elements;
  power = 0;
  cadence = 0;
  targetPower = null;
  targetCadence = null;
  timerStart = 0;
  timerInterval = null;
  constructor() {
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
  updateCoach(event) {
    this.elements.coachMessage.textContent = event.text;
  }
  updateMetrics(event) {
    this.power = event.power;
    this.cadence = event.cadence;
    this.elements.power.textContent = event.power.toString();
    this.elements.hr.textContent = event.hr.toString();
    this.elements.cadence.textContent = event.cadence.toString();
    this.render();
  }
  updateTarget(event) {
    if (event) {
      this.targetPower = event.power;
      this.targetCadence = event.cadence;
    } else {
      this.targetPower = null;
      this.targetCadence = null;
    }
    this.render();
  }
  setConnectionStatus(status) {
    const dotColors = {
      connected: "bg-green-500",
      connecting: "bg-yellow-500",
      disconnected: "bg-red-500"
    };
    this.elements.connectionDot.className = `w-3 h-3 rounded-full ${dotColors[status]}`;
    this.elements.connectionText.textContent = status;
  }
  render() {
    this.renderProgressBar("power", this.power, this.targetPower, "W", this.elements.powerTargetSection, this.elements.powerTarget, this.elements.powerBarContainer, this.elements.powerBarFill, this.elements.powerDelta, this.elements.powerOverTarget);
    this.renderProgressBar("cadence", this.cadence, this.targetCadence, "rpm", this.elements.cadenceTargetSection, this.elements.cadenceTarget, this.elements.cadenceBarContainer, this.elements.cadenceBarFill, this.elements.cadenceDelta, this.elements.cadenceOverTarget);
  }
  renderProgressBar(_type, value, target, unit, targetSection, targetValue, barContainer, barFill, delta, overTarget) {
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
      red: "from-red-600 to-red-500"
    }[color];
    const deltaColorClass = diff >= 0 ? color === "red" ? "text-red-500" : "text-green-500" : "text-orange-500";
    targetSection.className = "text-right";
    targetValue.textContent = target.toString();
    barContainer.className = "relative h-8 bg-gray-900 rounded-full overflow-hidden";
    barFill.className = `absolute inset-y-0 left-0 bg-gradient-to-r ${barColorClasses} rounded-full transition-all duration-300`;
    barFill.style.width = `${fillPercent}%`;
    delta.className = `mt-2 text-center font-medium ${deltaColorClass}`;
    delta.textContent = diff >= 0 ? `+${diff}${unit}` : `${Math.abs(diff)}${unit} to go`;
    overTarget.className = color === "red" ? "absolute right-2 top-1/2 -translate-y-1/2 text-xl text-yellow-400 font-bold" : "absolute right-2 top-1/2 -translate-y-1/2 text-xl text-yellow-400 font-bold hidden";
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
  const power2 = params.get("power2");
  const cadence2 = params.get("cadence2");
  if (power2 && cadence2) {
    ui.updateMetrics({
      power: parseInt(power2),
      hr: hr ? parseInt(hr) : 120,
      cadence: parseInt(cadence2),
      elapsed: 20
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
