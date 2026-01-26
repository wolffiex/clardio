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
var POWER_MIN = 50;
var POWER_MAX = 400;
var CADENCE_MIN = 45;
var CADENCE_MAX = 120;
function calculateFillPercent(value, min, max) {
  if (value <= min)
    return 0;
  if (value >= max)
    return 100;
  return (value - min) / (max - min) * 100;
}
function calculateTargetPosition(target, min, max) {
  if (target <= min)
    return 0;
  if (target >= max)
    return 100;
  return (target - min) / (max - min) * 100;
}
var POWER_GRACE_ZONE = 10;
var POWER_MAX_DISTANCE = 50;
var CADENCE_GRACE_ZONE = 5;
var CADENCE_MAX_DISTANCE = 20;
function interpolateColor(color1, color2, factor) {
  const r = Math.round(color1[0] + (color2[0] - color1[0]) * factor);
  const g = Math.round(color1[1] + (color2[1] - color1[1]) * factor);
  const b = Math.round(color1[2] + (color2[2] - color1[2]) * factor);
  return `rgb(${r}, ${g}, ${b})`;
}
var GREEN = [34, 197, 94];
var YELLOW = [234, 179, 8];
var ORANGE = [249, 115, 22];
var RED = [239, 68, 68];
function getColorFromDistance(value, target, graceZone, maxDistance) {
  if (target === null)
    return "rgb(107, 114, 128)";
  const distance = Math.abs(value - target);
  if (distance <= graceZone) {
    return `rgb(${GREEN[0]}, ${GREEN[1]}, ${GREEN[2]})`;
  }
  if (distance >= maxDistance) {
    return `rgb(${RED[0]}, ${RED[1]}, ${RED[2]})`;
  }
  const effectiveDistance = distance - graceZone;
  const effectiveRange = maxDistance - graceZone;
  const factor = effectiveDistance / effectiveRange;
  if (factor <= 0.33) {
    return interpolateColor(GREEN, YELLOW, factor / 0.33);
  } else if (factor <= 0.66) {
    return interpolateColor(YELLOW, ORANGE, (factor - 0.33) / 0.33);
  } else {
    return interpolateColor(ORANGE, RED, (factor - 0.66) / 0.34);
  }
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
      powerBarContainer: document.getElementById("power-bar-container"),
      powerBarFill: document.getElementById("power-bar-fill"),
      powerTargetPointer: document.getElementById("power-target-pointer"),
      powerTargetLabel: document.getElementById("power-target-label"),
      powerValueLabel: document.getElementById("power-value-label"),
      powerScaleLabels: document.getElementById("power-scale-labels"),
      powerDelta: document.getElementById("power-delta"),
      cadenceBarContainer: document.getElementById("cadence-bar-container"),
      cadenceBarFill: document.getElementById("cadence-bar-fill"),
      cadenceTargetPointer: document.getElementById("cadence-target-pointer"),
      cadenceTargetLabel: document.getElementById("cadence-target-label"),
      cadenceValueLabel: document.getElementById("cadence-value-label"),
      cadenceScaleLabels: document.getElementById("cadence-scale-labels"),
      cadenceDelta: document.getElementById("cadence-delta"),
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
    const displayPower = Math.max(0, Math.min(500, event.power));
    const displayCadence = Math.max(0, Math.min(200, event.cadence));
    this.elements.power.textContent = displayPower.toString();
    this.elements.hr.textContent = event.hr.toString();
    this.elements.cadence.textContent = displayCadence.toString();
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
    this.renderProgressBar(this.power, this.targetPower, POWER_MIN, POWER_MAX, POWER_GRACE_ZONE, POWER_MAX_DISTANCE, "W", this.elements.powerBarContainer, this.elements.powerBarFill, this.elements.powerTargetPointer, this.elements.powerTargetLabel, this.elements.powerValueLabel, this.elements.powerScaleLabels, this.elements.powerDelta);
    this.renderProgressBar(this.cadence, this.targetCadence, CADENCE_MIN, CADENCE_MAX, CADENCE_GRACE_ZONE, CADENCE_MAX_DISTANCE, "rpm", this.elements.cadenceBarContainer, this.elements.cadenceBarFill, this.elements.cadenceTargetPointer, this.elements.cadenceTargetLabel, this.elements.cadenceValueLabel, this.elements.cadenceScaleLabels, this.elements.cadenceDelta);
  }
  renderProgressBar(value, target, min, max, graceZone, maxDistance, unit, barContainer, barFill, targetPointer, targetLabel, valueLabel, scaleLabels, delta) {
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
    targetPointer.className = "absolute top-0 bottom-0 w-0.5 bg-white";
    targetPointer.style.left = `${targetPos}%`;
    targetPointer.style.transform = "translateX(-50%)";
    targetLabel.className = "absolute -top-6 text-sm text-gray-400 tabular-nums";
    targetLabel.style.left = `${targetPos}%`;
    targetLabel.textContent = `${target}${unit}`;
    const labelPosition = Math.max(20, Math.min(90, fillPercent));
    valueLabel.style.left = `${labelPosition}%`;
    scaleLabels.className = "flex justify-between text-sm text-gray-500 mt-1";
    const maxDelta = unit === "W" ? 100 : 50;
    delta.className = "mt-2 text-center font-medium";
    delta.style.color = color;
    if (Math.abs(diff) > maxDelta) {
      delta.textContent = diff > 0 ? `>${maxDelta}${unit}` : `<-${maxDelta}${unit}`;
    } else {
      delta.textContent = diff >= 0 ? `+${diff}${unit}` : `${diff}${unit}`;
    }
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
