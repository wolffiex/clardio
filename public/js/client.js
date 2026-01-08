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
function createActionPayload(label) {
  return {
    action: "button_pressed",
    label,
    timestamp: Date.now()
  };
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
  constructor(callback) {
    this.callback = callback;
  }
  setTarget(event) {
    this.clear();
    if (!event) {
      this.callback(null);
      return;
    }
    if (event.remaining <= 0) {
      this.callback(null);
      return;
    }
    this.target = { power: event.power, cadence: event.cadence };
    this.remaining = event.remaining;
    this.updateDisplay();
    this.intervalId = setInterval(() => {
      this.remaining--;
      if (this.remaining <= 0) {
        this.clear();
        this.callback(null);
      } else {
        this.updateDisplay();
      }
    }, 1000);
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

// src/client/ui.ts
class UIController {
  elements;
  onButtonClick = null;
  currentButtonLabel = "";
  countdown;
  constructor() {
    this.countdown = new CountdownTimer((display) => {
      this.updateTargetDisplay(display);
    });
    this.elements = {
      coachMessage: document.getElementById("coach-message"),
      actionButton: document.getElementById("action-button"),
      power: document.getElementById("metric-power"),
      hr: document.getElementById("metric-hr"),
      cadence: document.getElementById("metric-cadence"),
      time: document.getElementById("metric-time"),
      targetOverlay: document.getElementById("target-overlay"),
      targetPower: document.getElementById("target-power"),
      targetRemaining: document.getElementById("target-remaining"),
      connectionDot: document.getElementById("connection-dot"),
      connectionText: document.getElementById("connection-text")
    };
    this.elements.actionButton.addEventListener("click", () => {
      if (this.currentButtonLabel && this.onButtonClick) {
        this.onButtonClick(this.currentButtonLabel);
      }
    });
  }
  setButtonHandler(handler) {
    this.onButtonClick = handler;
  }
  updateCoach(event) {
    this.elements.coachMessage.textContent = event.text;
    if (event.button) {
      this.currentButtonLabel = event.button;
      this.elements.actionButton.textContent = event.button;
      this.elements.actionButton.classList.remove("hidden");
    } else {
      this.hideButton();
    }
  }
  hideButton() {
    this.elements.actionButton.classList.add("hidden");
    this.currentButtonLabel = "";
  }
  updateMetrics(event) {
    this.elements.power.textContent = event.power.toString();
    this.elements.hr.textContent = event.hr.toString();
    this.elements.cadence.textContent = event.cadence.toString();
    this.elements.time.textContent = formatTime(event.elapsed);
  }
  updateTarget(event) {
    this.countdown.setTarget(event);
  }
  updateTargetDisplay(display) {
    if (display) {
      this.elements.targetPower.textContent = display.text;
      this.elements.targetRemaining.textContent = display.time;
      this.elements.targetOverlay.classList.remove("hidden");
    } else {
      this.elements.targetOverlay.classList.add("hidden");
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
}

// src/client/main.ts
var sse = new SSEClient;
var ui = new UIController;
sse.on("connected", () => {
  console.log("[App] SSE connected event received");
  ui.setConnectionStatus("connected");
  ui.updateCoach({ text: "Connected. Warming up..." });
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
ui.setButtonHandler(async (label) => {
  try {
    const payload = createActionPayload(label);
    const response = await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      console.error("[App] Action failed:", response.status);
    }
    ui.hideButton();
  } catch (error) {
    console.error("[App] Failed to send action:", error);
  }
});
sse.connect();
console.log("[App] Clardio UI initialized");
