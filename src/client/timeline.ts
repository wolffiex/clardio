/**
 * Workout phase timeline visualization
 *
 * Renders a horizontal bar of phase segments proportional to duration.
 * Current phase is highlighted; past phases are dimmed.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanPhase {
  name: string;
  zone?: string;
  duration_s?: number;
  type?: string;
  max_duration_s?: number;
  target_hr?: number;
  position?: string;
  cadence?: number;
}

export interface PhaseUpdateInfo {
  phaseIndex: number;
  ends_at: number | null;  // workout elapsed SECONDS when phase ends, null for recovery
}

// ---------------------------------------------------------------------------
// Zone colors
// ---------------------------------------------------------------------------

const ZONE_COLORS: Record<string, { bg: string; text: string; dimmed: string }> = {
  Z1: { bg: "bg-blue-600",    text: "text-blue-200",   dimmed: "bg-blue-900" },
  Z2: { bg: "bg-green-600",   text: "text-green-200",  dimmed: "bg-green-900" },
  Z3: { bg: "bg-yellow-600",  text: "text-yellow-200", dimmed: "bg-yellow-900" },
  Z4: { bg: "bg-orange-600",  text: "text-orange-200", dimmed: "bg-orange-900" },
  Z5: { bg: "bg-red-600",     text: "text-red-200",    dimmed: "bg-red-900" },
  "Sweet Spot": { bg: "bg-amber-600", text: "text-amber-200", dimmed: "bg-amber-900" },
};

const RECOVERY_COLOR = { bg: "bg-slate-600", text: "text-slate-300", dimmed: "bg-slate-800" };
const DEFAULT_COLOR = { bg: "bg-gray-600", text: "text-gray-300", dimmed: "bg-gray-800" };

function getZoneColor(phase: PlanPhase) {
  if (phase.type === "recovery") return RECOVERY_COLOR;
  if (phase.zone && ZONE_COLORS[phase.zone]) return ZONE_COLORS[phase.zone];
  return DEFAULT_COLOR;
}

function getPhaseDuration(phase: PlanPhase): number {
  if (phase.type === "recovery") return phase.max_duration_s ?? 600;
  return phase.duration_s ?? 60;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (s === 0) return `${m}:00`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function abbreviateName(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  // Try to abbreviate common words
  let short = name
    .replace(/Recovery/i, "Rec")
    .replace(/Warmup/i, "WU")
    .replace(/Cooldown/i, "CD")
    .replace(/Interval/i, "Int")
    .replace(/Standing/i, "Stand")
    .replace(/Seated/i, "Seat");
  if (short.length <= maxLen) return short;
  return short.slice(0, maxLen - 1) + "\u2026";
}

// ---------------------------------------------------------------------------
// Timeline controller
// ---------------------------------------------------------------------------

export class TimelineController {
  private container: HTMLElement;
  private phases: PlanPhase[] = [];
  private currentPhaseIndex: number = -1;

  // Phase timing in workout-elapsed seconds
  private endsAt: number | null = null;         // workout elapsed seconds when current phase ends
  private previousEndsAt: number | null = null;  // previous phase's ends_at, used to derive current phase start
  private currentPhaseStart: number = 0;         // workout elapsed seconds when current phase started

  // Workout start time (client's local clock)
  private workoutStartedAt: number = 0;

  // Client-side countdown timer state
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private tickCallback: (() => void) | null = null;

  constructor() {
    this.container = document.getElementById("timeline")!;
  }

  /**
   * Set the plan phases and render the initial timeline
   */
  setPlan(phases: PlanPhase[]): void {
    this.phases = phases;
    this.currentPhaseIndex = -1;
    this.previousEndsAt = null;
    this.endsAt = null;
    this.currentPhaseStart = 0;
    this.clearTimer();
    this.render();
    this.container.classList.remove("hidden");
  }

  /**
   * Update current phase state and re-render.
   * Accepts { phaseIndex, ends_at } where ends_at is in workout-elapsed seconds.
   */
  updatePhase(info: PhaseUpdateInfo): void {
    // Store ends_at (workout-elapsed seconds) for countdown and for next phase's start derivation
    this.endsAt = info.ends_at;

    // Derive phase start from the best available source
    const phase = this.phases[info.phaseIndex];
    if (this.previousEndsAt !== null) {
      // Normal case: chain from previous phase end
      this.currentPhaseStart = this.previousEndsAt;
    } else if (info.ends_at !== null && phase) {
      // Post-recovery timed phase: derive from ends_at minus plan duration
      this.currentPhaseStart = info.ends_at - (phase.duration_s ?? 0);
    } else {
      // Recovery after recovery (unlikely) or no data: use client clock
      this.currentPhaseStart = this.getWorkoutElapsed();
    }

    // Only update previousEndsAt when we have a real value (don't overwrite with null from recovery)
    if (info.ends_at !== null) {
      this.previousEndsAt = info.ends_at;
    } else {
      this.previousEndsAt = null;
    }

    this.currentPhaseIndex = info.phaseIndex;

    this.startTimer();
    this.render();
  }

  /**
   * Record the local timestamp when the workout started.
   * Called once when the "connected" event fires.
   */
  setWorkoutStartedAt(ts: number): void {
    this.workoutStartedAt = ts;
  }

  /**
   * Get workout elapsed time in seconds, computed from the client's local clock.
   */
  getWorkoutElapsed(): number {
    if (this.workoutStartedAt === 0) return 0;
    return (Date.now() - this.workoutStartedAt) / 1000;
  }

  /**
   * Register a callback to be called on each 1-second timer tick.
   */
  onTick(callback: () => void): void {
    this.tickCallback = callback;
  }

  /**
   * Check if we have plan data
   */
  hasPlan(): boolean {
    return this.phases.length > 0;
  }

  // -------------------------------------------------------------------------
  // Client-side countdown timer
  // -------------------------------------------------------------------------

  private clearTimer(): void {
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  private startTimer(): void {
    this.clearTimer();
    this.timerInterval = setInterval(() => this.tickTimer(), 1000);
  }

  private tickTimer(): void {
    this.updateDetailLine();
    if (this.tickCallback) this.tickCallback();
  }

  /**
   * Get the current countdown (timed phases) or elapsed (recovery) in seconds,
   * computed from workout-elapsed seconds.
   */
  private getClientSeconds(): { elapsed: number; remaining: number | null } {
    const workoutElapsed = this.getWorkoutElapsed();

    if (this.endsAt === null) {
      // Recovery phase (no end time): count up from phase start
      const phaseStart = this.computePhaseStart();
      const elapsed = workoutElapsed - phaseStart;
      return { elapsed: Math.max(0, elapsed), remaining: null };
    }

    // Timed phase: compute from ends_at (workout-elapsed seconds)
    const remaining = this.endsAt - workoutElapsed;

    // Derive phase duration from the plan phase
    const phase = this.phases[this.currentPhaseIndex];
    const phaseDuration = phase ? getPhaseDuration(phase) : 60;
    const elapsed = phaseDuration - Math.max(0, remaining);

    return { elapsed: Math.max(0, elapsed), remaining: Math.max(0, remaining) };
  }

  /**
   * Return the workout-elapsed seconds when the current phase started.
   * This is computed once in updatePhase() and stored.
   */
  private computePhaseStart(): number {
    return this.currentPhaseStart;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    if (this.phases.length === 0) return;

    const totalDuration = this.phases.reduce((sum, p) => sum + getPhaseDuration(p), 0);

    // Build detail line (above the bar)
    const detailHtml = this.buildDetailLine();

    // Build phase segments
    const segmentsHtml = this.phases.map((phase, i) => {
      const duration = getPhaseDuration(phase);
      const widthPercent = (duration / totalDuration) * 100;
      const color = getZoneColor(phase);
      const isCurrent = i === this.currentPhaseIndex;
      const isCompleted = i < this.currentPhaseIndex;

      // Determine background class
      let bgClass: string;
      if (isCurrent) {
        bgClass = `${color.bg} phase-active`;
      } else if (isCompleted) {
        bgClass = `${color.dimmed} opacity-60`;
      } else {
        bgClass = `${color.dimmed} opacity-40`;
      }

      // Label: zone or heart-arrow for recovery. Show name too if there's room.
      const isRecoveryPhase = phase.type === "recovery";
      const zone = isRecoveryPhase ? "\u2665\u2193" : (phase.zone ?? "");
      const showName = widthPercent > 8;
      const nameAbbrev = showName ? abbreviateName(phase.name, widthPercent > 15 ? 12 : 6) : "";

      // Progress fill within current phase
      let progressHtml = "";
      if (isCurrent) {
        const phaseDur = getPhaseDuration(phase);
        if (phaseDur > 0) {
          const { elapsed } = this.getClientSeconds();
          if (isRecoveryPhase) {
            // Recovery: pulsing fill showing elapsed progress
            const progressPercent = Math.min(100, (elapsed / phaseDur) * 100);
            progressHtml = `<div class="absolute inset-y-0 left-0 bg-white/10 rounded-sm recovery-progress" style="width:${progressPercent}%"></div>`;
          } else {
            const progressPercent = Math.min(100, (elapsed / phaseDur) * 100);
            progressHtml = `<div class="absolute inset-y-0 left-0 bg-white/15 rounded-sm" style="width:${progressPercent}%"></div>`;
          }
        }
      }

      // Recovery segments get a dashed border to look distinct even when not current
      const recoveryBorder = isRecoveryPhase && !isCurrent ? "border border-dashed border-slate-500/40" : "";

      return `<div class="relative h-7 flex items-center justify-center overflow-hidden rounded-sm ${bgClass} ${recoveryBorder} ${isCurrent ? 'ring-1 ring-white/60' : ''}" style="width:${widthPercent}%" title="${phase.name}${phase.zone ? ' ' + phase.zone : ''}${isRecoveryPhase && phase.target_hr ? ' HR\u2193' + phase.target_hr : ''}">
        ${progressHtml}
        <span class="relative z-10 text-xs font-medium ${isCurrent ? 'text-white' : color.text} truncate px-1">${nameAbbrev ? nameAbbrev + ' ' : ''}${zone}</span>
      </div>`;
    }).join("");

    this.container.innerHTML = `
      <div id="timeline-detail" class="mb-1 text-sm text-gray-400 font-mono truncate h-5">${detailHtml}</div>
      <div class="flex gap-px h-7">${segmentsHtml}</div>
    `;
  }

  /**
   * Update only the detail line text (called by the 1s timer tick).
   * Avoids re-rendering the full segment bar every second.
   */
  private updateDetailLine(): void {
    const el = document.getElementById("timeline-detail");
    if (el) {
      el.innerHTML = this.buildDetailLine();
    }
  }

  private buildDetailLine(): string {
    if (this.currentPhaseIndex < 0 || this.currentPhaseIndex >= this.phases.length) {
      return "";
    }

    const phase = this.phases[this.currentPhaseIndex];
    const isRecovery = phase.type === "recovery";
    const parts: string[] = [];

    // Phase name
    parts.push(`<span class="text-white">${phase.name}</span>`);

    if (isRecovery) {
      // Recovery phase: show HR target and count-up elapsed timer
      parts.push('<span class="text-slate-400">Recovery</span>');

      // HR target indicator
      if (phase.target_hr) {
        parts.push(`<span class="text-slate-300">HR \u2193${phase.target_hr}</span>`);
      }

      // Count-up elapsed from client clock
      const { elapsed } = this.getClientSeconds();
      parts.push(`<span class="text-white text-base font-bold tabular-nums">${formatDuration(Math.floor(elapsed))}</span>`);
    } else {
      // Timed phase: show zone, cadence, position, countdown
      if (phase.zone) {
        parts.push(`<span class="text-gray-300">${phase.zone}</span>`);
      }

      // Cadence
      if (phase.cadence) {
        parts.push(`<span class="text-gray-500">${phase.cadence}rpm</span>`);
      }

      // Position
      if (phase.position) {
        parts.push(`<span class="text-gray-500">${phase.position}</span>`);
      }

      // Countdown from client clock
      const { remaining } = this.getClientSeconds();
      if (remaining !== null) {
        parts.push(`<span class="text-white text-base font-bold tabular-nums">${formatDuration(Math.floor(remaining))}</span>`);
      }
    }

    // Phase position in plan
    parts.push(`<span class="text-gray-600">${this.currentPhaseIndex + 1}/${this.phases.length}</span>`);

    return parts.join('<span class="text-gray-700 mx-1">\u00b7</span>');
  }
}
