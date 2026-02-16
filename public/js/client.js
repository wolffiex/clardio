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
    const eventTypes = ["connected", "coach", "metrics", "target", "plan"];
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
var currentPlan = null;
var timeline = null;
function initTimeline(tl) {
  timeline = tl;
}
function handlePlan(data) {
  currentPlan = data;
  console.log("Plan received:", data.summary, `${data.phases.length} phases`);
  if (timeline) {
    timeline.setPlan(data.phases);
  }
}
function getTimeline() {
  return timeline;
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
      powerScaleLabels: document.getElementById("power-scale-labels"),
      powerDelta: document.getElementById("power-delta"),
      cadenceBarContainer: document.getElementById("cadence-bar-container"),
      cadenceBarFill: document.getElementById("cadence-bar-fill"),
      cadenceTargetPointer: document.getElementById("cadence-target-pointer"),
      cadenceTargetLabel: document.getElementById("cadence-target-label"),
      cadenceScaleLabels: document.getElementById("cadence-scale-labels"),
      cadenceDelta: document.getElementById("cadence-delta"),
      connectionDot: document.getElementById("connection-dot"),
      connectionText: document.getElementById("connection-text")
    };
  }
  startTimer(offsetSeconds = 0) {
    if (this.timerInterval)
      return;
    this.timerStart = Date.now() - offsetSeconds * 1000;
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
      const tl = getTimeline();
      if (tl && tl.hasPlan()) {
        tl.updatePhase({
          phaseIndex: event.phaseIndex,
          phaseName: event.phaseName,
          phaseStartedAt: event.phaseStartedAt,
          phaseDuration: event.phaseDuration,
          isRecovery: event.isRecovery,
          targetHr: event.targetHr,
          serverTimestamp: event.serverTimestamp
        });
      }
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
    this.renderProgressBar(this.power, this.targetPower, POWER_MIN, POWER_MAX, POWER_GRACE_ZONE, POWER_MAX_DISTANCE, "W", this.elements.powerBarContainer, this.elements.powerBarFill, this.elements.powerTargetPointer, this.elements.powerTargetLabel, this.elements.powerScaleLabels, this.elements.powerDelta);
    this.renderProgressBar(this.cadence, this.targetCadence, CADENCE_MIN, CADENCE_MAX, CADENCE_GRACE_ZONE, CADENCE_MAX_DISTANCE, "rpm", this.elements.cadenceBarContainer, this.elements.cadenceBarFill, this.elements.cadenceTargetPointer, this.elements.cadenceTargetLabel, this.elements.cadenceScaleLabels, this.elements.cadenceDelta);
  }
  renderProgressBar(value, target, min, max, graceZone, maxDistance, unit, barContainer, barFill, targetPointer, targetLabel, scaleLabels, delta) {
    const fillPercent = calculateFillPercent(value, min, max);
    const color = target !== null ? getColorFromDistance(value, target, graceZone, maxDistance) : "rgb(107, 114, 128)";
    barContainer.className = "relative h-8 bg-gray-900 rounded-full overflow-visible";
    barFill.className = "absolute inset-y-0 left-0 rounded-full transition-all duration-300";
    barFill.style.width = `${fillPercent}%`;
    barFill.style.backgroundColor = color;
    scaleLabels.className = "flex justify-between text-sm text-gray-500 mt-1";
    if (target === null) {
      targetPointer.className = "absolute top-0 bottom-0 w-0.5 bg-white hidden";
      targetLabel.className = "absolute -top-6 text-sm text-gray-400 tabular-nums hidden";
      delta.className = "mt-2 text-center font-medium hidden";
      return;
    }
    const targetPos = calculateFillPercent(target, min, max);
    const diff = Math.round(value - target);
    targetPointer.className = "absolute top-0 bottom-0 w-0.5 bg-white";
    targetPointer.style.left = `${targetPos}%`;
    targetPointer.style.transform = "translateX(-50%)";
    targetLabel.className = "absolute -top-6 text-sm text-gray-400 tabular-nums";
    targetLabel.style.left = `${targetPos}%`;
    targetLabel.textContent = `${target}${unit}`;
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

// src/client/timeline.ts
var ZONE_COLORS = {
  Z1: { bg: "bg-blue-600", text: "text-blue-200", dimmed: "bg-blue-900" },
  Z2: { bg: "bg-green-600", text: "text-green-200", dimmed: "bg-green-900" },
  Z3: { bg: "bg-yellow-600", text: "text-yellow-200", dimmed: "bg-yellow-900" },
  Z4: { bg: "bg-orange-600", text: "text-orange-200", dimmed: "bg-orange-900" },
  Z5: { bg: "bg-red-600", text: "text-red-200", dimmed: "bg-red-900" },
  "Sweet Spot": { bg: "bg-amber-600", text: "text-amber-200", dimmed: "bg-amber-900" }
};
var RECOVERY_COLOR = { bg: "bg-slate-600", text: "text-slate-300", dimmed: "bg-slate-800" };
var DEFAULT_COLOR = { bg: "bg-gray-600", text: "text-gray-300", dimmed: "bg-gray-800" };
function getZoneColor(phase) {
  if (phase.type === "recovery")
    return RECOVERY_COLOR;
  if (phase.zone && ZONE_COLORS[phase.zone])
    return ZONE_COLORS[phase.zone];
  return DEFAULT_COLOR;
}
function getPhaseDuration(phase) {
  if (phase.type === "recovery" && phase.max_duration_s)
    return phase.max_duration_s;
  return phase.duration_s ?? 60;
}
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (s === 0)
    return `${m}:00`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function abbreviateName(name, maxLen) {
  if (name.length <= maxLen)
    return name;
  let short = name.replace(/Recovery/i, "Rec").replace(/Warmup/i, "WU").replace(/Cooldown/i, "CD").replace(/Interval/i, "Int").replace(/Standing/i, "Stand").replace(/Seated/i, "Seat");
  if (short.length <= maxLen)
    return short;
  return short.slice(0, maxLen - 1) + "…";
}

class TimelineController {
  container;
  phases = [];
  currentPhaseIndex = -1;
  isRecovery = false;
  phaseName = "";
  targetHr = undefined;
  phaseStartedAt = 0;
  phaseDuration = null;
  clockOffset = 0;
  timerInterval = null;
  constructor() {
    this.container = document.getElementById("timeline");
  }
  setPlan(phases) {
    this.phases = phases;
    this.currentPhaseIndex = -1;
    this.clearTimer();
    this.render();
    this.container.classList.remove("hidden");
  }
  updatePhase(info) {
    this.currentPhaseIndex = info.phaseIndex;
    this.phaseName = info.phaseName;
    this.isRecovery = info.isRecovery;
    this.targetHr = info.targetHr;
    this.phaseStartedAt = info.phaseStartedAt;
    this.phaseDuration = info.phaseDuration;
    const localTimestamp = Date.now();
    this.clockOffset = localTimestamp - info.serverTimestamp;
    this.startTimer();
    this.render();
  }
  hasPlan() {
    return this.phases.length > 0;
  }
  clearTimer() {
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }
  startTimer() {
    this.clearTimer();
    this.timerInterval = setInterval(() => this.tickTimer(), 1000);
  }
  tickTimer() {
    this.updateDetailLine();
  }
  getClientSeconds() {
    const elapsed = (Date.now() - this.phaseStartedAt - this.clockOffset) / 1000;
    if (this.isRecovery || this.phaseDuration === null) {
      return { elapsed: Math.max(0, elapsed), remaining: null };
    }
    const remaining = Math.max(0, this.phaseDuration - elapsed);
    return { elapsed: Math.max(0, elapsed), remaining };
  }
  render() {
    if (this.phases.length === 0)
      return;
    const totalDuration = this.phases.reduce((sum, p) => sum + getPhaseDuration(p), 0);
    const detailHtml = this.buildDetailLine();
    const segmentsHtml = this.phases.map((phase, i) => {
      const duration = getPhaseDuration(phase);
      const widthPercent = duration / totalDuration * 100;
      const color = getZoneColor(phase);
      const isCurrent = i === this.currentPhaseIndex;
      const isCompleted = i < this.currentPhaseIndex;
      let bgClass;
      if (isCurrent) {
        bgClass = `${color.bg} phase-active`;
      } else if (isCompleted) {
        bgClass = `${color.dimmed} opacity-60`;
      } else {
        bgClass = `${color.dimmed} opacity-40`;
      }
      const isRecoveryPhase = phase.type === "recovery";
      const zone = isRecoveryPhase ? "♥↓" : phase.zone ?? "";
      const showName = widthPercent > 8;
      const nameAbbrev = showName ? abbreviateName(phase.name, widthPercent > 15 ? 12 : 6) : "";
      let progressHtml = "";
      if (isCurrent && this.phaseDuration !== null && this.phaseDuration > 0) {
        const { elapsed } = this.getClientSeconds();
        if (this.isRecovery) {
          const progressPercent = Math.min(100, elapsed / this.phaseDuration * 100);
          progressHtml = `<div class="absolute inset-y-0 left-0 bg-white/10 rounded-sm recovery-progress" style="width:${progressPercent}%"></div>`;
        } else {
          const progressPercent = Math.min(100, elapsed / this.phaseDuration * 100);
          progressHtml = `<div class="absolute inset-y-0 left-0 bg-white/15 rounded-sm" style="width:${progressPercent}%"></div>`;
        }
      }
      const recoveryBorder = isRecoveryPhase && !isCurrent ? "border border-dashed border-slate-500/40" : "";
      return `<div class="relative h-7 flex items-center justify-center overflow-hidden rounded-sm ${bgClass} ${recoveryBorder} ${isCurrent ? "ring-1 ring-white/60" : ""}" style="width:${widthPercent}%" title="${phase.name}${phase.zone ? " " + phase.zone : ""}${isRecoveryPhase && phase.target_hr ? " HR↓" + phase.target_hr : ""}">
        ${progressHtml}
        <span class="relative z-10 text-xs font-medium ${isCurrent ? "text-white" : color.text} truncate px-1">${nameAbbrev ? nameAbbrev + " " : ""}${zone}</span>
      </div>`;
    }).join("");
    this.container.innerHTML = `
      <div id="timeline-detail" class="mb-1 text-sm text-gray-400 font-mono truncate h-5">${detailHtml}</div>
      <div class="flex gap-px h-7">${segmentsHtml}</div>
    `;
  }
  updateDetailLine() {
    const el = document.getElementById("timeline-detail");
    if (el) {
      el.innerHTML = this.buildDetailLine();
    }
  }
  buildDetailLine() {
    if (this.currentPhaseIndex < 0 || this.currentPhaseIndex >= this.phases.length) {
      return "";
    }
    const phase = this.phases[this.currentPhaseIndex];
    const parts = [];
    parts.push(`<span class="text-white">${phase.name}</span>`);
    if (this.isRecovery) {
      parts.push('<span class="text-slate-400">Recovery</span>');
      const hrTarget = this.targetHr ?? phase.target_hr;
      if (hrTarget) {
        parts.push(`<span class="text-slate-300">HR ↓${hrTarget}</span>`);
      }
      const { elapsed } = this.getClientSeconds();
      parts.push(`<span class="text-white text-base font-bold tabular-nums">${formatDuration(Math.floor(elapsed))}</span>`);
    } else {
      if (phase.zone) {
        parts.push(`<span class="text-gray-300">${phase.zone}</span>`);
      }
      if (phase.cadence) {
        parts.push(`<span class="text-gray-500">${phase.cadence}rpm</span>`);
      }
      if (phase.position) {
        parts.push(`<span class="text-gray-500">${phase.position}</span>`);
      }
      if (this.phaseDuration !== null && this.phaseDuration > 0) {
        const { remaining } = this.getClientSeconds();
        if (remaining !== null) {
          parts.push(`<span class="text-white text-base font-bold tabular-nums">${formatDuration(Math.floor(remaining))}</span>`);
        }
      }
    }
    parts.push(`<span class="text-gray-600">${this.currentPhaseIndex + 1}/${this.phases.length}</span>`);
    return parts.join('<span class="text-gray-700 mx-1">·</span>');
  }
}

// src/client/main.ts
var wakeLock = null;
async function requestWakeLock() {
  if (!navigator.wakeLock) {
    console.log("[WakeLock] Not available (requires HTTPS)");
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    console.log("[WakeLock] Acquired");
    wakeLock.addEventListener("release", () => {
      console.log("[WakeLock] Released");
    });
  } catch (err) {
    console.log("[WakeLock] Failed:", err);
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    requestWakeLock();
  }
});
requestWakeLock();
var sse = new SSEClient;
var ui = new UIController;
var timeline2 = new TimelineController;
initTimeline(timeline2);
var params = new URLSearchParams(window.location.search);
var testMode = params.has("power") || params.has("target_power");
if (testMode) {
  console.log("[App] Test mode enabled via URL params");
  ui.setConnectionStatus("connected");
  let timerOffset = 0;
  const phaseIndexParam = params.get("phase_index");
  const phaseElapsedParam = params.get("phase_elapsed");
  if (phaseIndexParam !== null && phaseElapsedParam !== null) {
    const pi = parseInt(phaseIndexParam);
    const pe = parseInt(phaseElapsedParam);
    const sampleDurations = [300, 300, 120, 180, 240, 60, 180, 300, 240, 120, 300];
    for (let i = 0;i < pi && i < sampleDurations.length; i++) {
      timerOffset += sampleDurations[i];
    }
    timerOffset += pe;
  }
  ui.startTimer(timerOffset);
  const message = params.get("message");
  if (message) {
    ui.updateCoach({ text: message });
  }
  const phaseIndex = params.has("phase_index") ? parseInt(params.get("phase_index")) : -1;
  const phaseElapsed = params.has("phase_elapsed") ? parseInt(params.get("phase_elapsed")) : 0;
  if (phaseIndex >= 0) {
    const samplePlan = {
      summary: "Threshold intervals with standing surges",
      phases: [
        { name: "Easy Spin", zone: "Z1", duration_s: 300, position: "seated", cadence: 75 },
        { name: "Build", zone: "Z2", duration_s: 300, position: "seated", cadence: 85 },
        { name: "Opener", zone: "Z4", duration_s: 120, position: "seated", cadence: 92 },
        { name: "Recovery", type: "recovery", target_hr: 130, max_duration_s: 180, position: "seated", cadence: 75 },
        { name: "Threshold 1", zone: "Z4", duration_s: 240, position: "seated", cadence: 90 },
        { name: "Standing Surge", zone: "Z5", duration_s: 60, position: "standing", cadence: 65 },
        { name: "Recovery", type: "recovery", target_hr: 125, max_duration_s: 180, position: "seated", cadence: 75 },
        { name: "Sweet Spot", zone: "Sweet Spot", duration_s: 300, position: "seated", cadence: 90 },
        { name: "Threshold 2", zone: "Z4", duration_s: 240, position: "seated", cadence: 90 },
        { name: "Recovery", type: "recovery", target_hr: 120, max_duration_s: 120, position: "seated", cadence: 75 },
        { name: "Cooldown", zone: "Z1", duration_s: 300, position: "seated", cadence: 70 }
      ]
    };
    handlePlan(samplePlan);
    const currentPhase = samplePlan.phases[phaseIndex];
    const isRecoveryPhase = currentPhase?.type === "recovery";
    const phaseDuration = currentPhase ? isRecoveryPhase ? null : currentPhase.duration_s ?? 60 : 60;
    const now = Date.now();
    const fakePhaseStartedAt = now - phaseElapsed * 1000;
    timeline2.updatePhase({
      phaseIndex,
      phaseName: currentPhase?.name ?? "",
      phaseStartedAt: fakePhaseStartedAt,
      phaseDuration,
      isRecovery: isRecoveryPhase,
      targetHr: isRecoveryPhase ? currentPhase?.target_hr : undefined,
      serverTimestamp: now
    });
  }
  const targetPower = params.get("target_power");
  const targetCadence = params.get("target_cadence");
  if (targetPower || targetCadence) {
    const testNow = Date.now();
    ui.updateTarget({
      power: targetPower ? parseInt(targetPower) : null,
      cadence: targetCadence ? parseInt(targetCadence) : null,
      position: null,
      phaseIndex: 0,
      phaseName: "",
      phaseStartedAt: testNow,
      phaseDuration: null,
      isRecovery: false,
      serverTimestamp: testNow
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
  sse.on("plan", (data) => {
    handlePlan(data);
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
