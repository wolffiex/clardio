/**
 * Workout phase timeline visualization
 *
 * Renders a horizontal bar of phase segments proportional to duration.
 * Current phase is highlighted; completed phases are dimmed.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanPhase {
  name: string;
  zone?: string;
  duration_s?: number;
  type?: string;
  min_duration_s?: number;
  max_duration_s?: number;
  position?: string;
  cadence?: string;
}

export interface PhaseInfo {
  phaseIndex: number;
  phaseName?: string;
  phaseElapsed: number; // seconds
  phaseTotal: number;   // seconds
  isRecovery?: boolean;
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
  if (phase.type === "recovery" && phase.max_duration_s) return phase.max_duration_s;
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
  private phaseElapsed: number = 0;
  private phaseTotal: number = 0;
  private isRecovery: boolean = false;
  private phaseName: string = "";

  constructor() {
    this.container = document.getElementById("timeline")!;
  }

  /**
   * Set the plan phases and render the initial timeline
   */
  setPlan(phases: PlanPhase[]): void {
    this.phases = phases;
    this.currentPhaseIndex = -1;
    this.render();
    this.container.classList.remove("hidden");
  }

  /**
   * Update current phase state and re-render
   */
  updatePhase(info: PhaseInfo): void {
    this.currentPhaseIndex = info.phaseIndex;
    this.phaseName = info.phaseName ?? "";
    this.phaseElapsed = info.phaseElapsed;
    this.phaseTotal = info.phaseTotal;
    this.isRecovery = info.isRecovery ?? false;
    this.render();
  }

  /**
   * Check if we have plan data
   */
  hasPlan(): boolean {
    return this.phases.length > 0;
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

      // Label: zone or "Rec" for recovery. Show name too if there's room.
      const zone = phase.type === "recovery" ? "Rec" : (phase.zone ?? "");
      const showName = widthPercent > 8;
      const nameAbbrev = showName ? abbreviateName(phase.name, widthPercent > 15 ? 12 : 6) : "";

      // Progress fill within current phase
      let progressHtml = "";
      if (isCurrent && this.phaseTotal > 0) {
        const progressPercent = Math.min(100, (this.phaseElapsed / this.phaseTotal) * 100);
        progressHtml = `<div class="absolute inset-y-0 left-0 bg-white/15 rounded-sm" style="width:${progressPercent}%"></div>`;
      }

      return `<div class="relative h-7 flex items-center justify-center overflow-hidden rounded-sm ${bgClass} ${isCurrent ? 'ring-1 ring-white/60' : ''}" style="width:${widthPercent}%" title="${phase.name}${phase.zone ? ' ' + phase.zone : ''}">
        ${progressHtml}
        <span class="relative z-10 text-xs font-medium ${isCurrent ? 'text-white' : color.text} truncate px-1">${nameAbbrev ? nameAbbrev + ' ' : ''}${zone}</span>
      </div>`;
    }).join("");

    this.container.innerHTML = `
      <div class="mb-1 text-xs text-gray-400 font-mono truncate h-4">${detailHtml}</div>
      <div class="flex gap-px h-7">${segmentsHtml}</div>
    `;
  }

  private buildDetailLine(): string {
    if (this.currentPhaseIndex < 0 || this.currentPhaseIndex >= this.phases.length) {
      return "";
    }

    const phase = this.phases[this.currentPhaseIndex];
    const parts: string[] = [];

    // Phase name
    parts.push(`<span class="text-white">${phase.name}</span>`);

    // Zone
    if (phase.type === "recovery") {
      parts.push('<span class="text-slate-400">Recovery</span>');
    } else if (phase.zone) {
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

    // Time elapsed / total
    if (this.phaseTotal > 0) {
      const elapsed = formatDuration(this.phaseElapsed);
      const total = formatDuration(this.phaseTotal);
      parts.push(`<span class="text-gray-400">${elapsed} / ${total}</span>`);
    }

    // Phase position in plan
    parts.push(`<span class="text-gray-600">${this.currentPhaseIndex + 1}/${this.phases.length}</span>`);

    return parts.join('<span class="text-gray-700 mx-1">\u00b7</span>');
  }
}
