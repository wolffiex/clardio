/**
 * Replay coach prompt at a specific point in a past workout
 *
 * Usage:
 *   bun scripts/replay.ts                        # List all plans
 *   bun scripts/replay.ts 2 15:00                # Show prompt at 15:00 into plan 2
 *   bun scripts/replay.ts 2 15:00 --call          # Also call the coach API
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import Anthropic from "@anthropic-ai/sdk";
import {
  type Phase,
  type CoachResponse,
  isRecoveryPhase,
  buildCoachingSystemPrompt,
  getZonesText,
  coachSchema,
} from "../src/server/coach-prompt";

// ---------------------------------------------------------------------------
// DB access (standalone, not using the singleton from db.ts to avoid migration side effects)
// ---------------------------------------------------------------------------

const DB_PATH = join(homedir(), ".clardio", "clardio.db");

function openDb(): Database {
  const db = new Database(DB_PATH, { readonly: true });
  return db;
}

type PlanRow = {
  id: number;
  created_at: string;
  phases: string;
  summary: string | null;
};

type SampleRow = {
  timestamp_ms: number;
  duration_ms: number;
  power: number | null;
  hr: number | null;
  cadence: number | null;
};

type CoachTickRow = {
  id: number;
  plan_id: number;
  elapsed_s: number;
  user_message: string | null;
  response_message: string | null;
  response_power: number | null;
  response_cadence: number | null;
  response_note: string | null;
  latency_ms: number | null;
};

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function parseTime(str: string): number {
  // Accepts "15:00" or "5:30" -> milliseconds
  const parts = str.split(":");
  if (parts.length !== 2) throw new Error(`Invalid time format: ${str} (expected MM:SS)`);
  const minutes = parseInt(parts[0], 10);
  const seconds = parseInt(parts[1], 10);
  if (isNaN(minutes) || isNaN(seconds)) throw new Error(`Invalid time format: ${str}`);
  return (minutes * 60 + seconds) * 1000;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatDuration(totalMs: number): string {
  const totalSec = Math.round(totalMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (sec === 0) return `${min}min`;
  return `${min}min ${sec}s`;
}

// ---------------------------------------------------------------------------
// Plan listing
// ---------------------------------------------------------------------------

function listPlans(): void {
  const db = openDb();

  // Check if coach_ticks table exists (old DBs may not have it)
  const hasTicksTable = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='coach_ticks'"
  ).get() !== null;

  const tickCountSql = hasTicksTable
    ? "(SELECT COUNT(*) FROM coach_ticks t WHERE t.plan_id = p.id)"
    : "0";

  const plans = db.query(
    `SELECT p.*, (SELECT COUNT(*) FROM samples s WHERE s.plan_id = p.id) AS sample_count, (SELECT MAX(timestamp_ms) - MIN(timestamp_ms) FROM samples s WHERE s.plan_id = p.id) AS span_ms, ${tickCountSql} AS tick_count FROM plans p ORDER BY p.id`
  ).all() as (PlanRow & { sample_count: number; span_ms: number | null; tick_count: number })[];

  if (plans.length === 0) {
    console.log("No plans found in database.");
    db.close();
    return;
  }

  console.log("Plans:");
  console.log("-".repeat(80));
  for (const p of plans) {
    const phases: Phase[] = JSON.parse(p.phases);
    const totalPlanSec = phases.reduce((s, ph) => {
      if (isRecoveryPhase(ph)) return s + (ph.max_duration_s ?? 600);
      // Handle legacy duration_minutes format
      if ("duration_minutes" in ph) return s + (ph as any).duration_minutes * 60;
      return s + ph.duration_s;
    }, 0);
    const totalPlanMin = Math.round(totalPlanSec / 60);
    const actualDuration = p.span_ms ? formatDuration(p.span_ms) : "no samples";
    const phaseNames = phases.map((ph) => ph.name).join(", ");
    const tickInfo = p.tick_count > 0 ? ` | ${p.tick_count} ticks` : "";
    console.log(
      `  ${p.id}. [${p.created_at}] plan: ${totalPlanMin}min | actual: ${actualDuration} | ${p.sample_count} samples${tickInfo}`
    );
    console.log(`     phases: ${phaseNames}`);
    if (p.summary) {
      console.log(`     summary: ${p.summary}`);
    }
  }
  console.log();
  console.log("Usage: bun scripts/replay.ts <plan_id> <MM:SS> [--call]");
  console.log("       bun scripts/replay.ts <plan_id> --ticks");
  db.close();
}

// ---------------------------------------------------------------------------
// Phase computation from elapsed time
// ---------------------------------------------------------------------------

function getPhaseDurationS(phase: Phase): number {
  if (isRecoveryPhase(phase)) return phase.max_duration_s ?? 600;
  // Handle legacy duration_minutes format
  if ("duration_minutes" in phase) return (phase as any).duration_minutes * 60;
  return phase.duration_s;
}

function getCurrentPhase(
  phases: Phase[],
  elapsedMs: number
): { currentPhase: Phase | null; phaseElapsed: number; phaseRemaining: number; phaseIndex: number } {
  const elapsedS = elapsedMs / 1000;
  let accumulated = 0;

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const durationS = getPhaseDurationS(phase);
    if (elapsedS < accumulated + durationS) {
      const phaseElapsedS = elapsedS - accumulated;
      return {
        currentPhase: phase,
        phaseElapsed: phaseElapsedS * 1000,
        phaseRemaining: (durationS - phaseElapsedS) * 1000,
        phaseIndex: i,
      };
    }
    accumulated += durationS;
  }

  return { currentPhase: null, phaseElapsed: 0, phaseRemaining: 0, phaseIndex: -1 };
}

// ---------------------------------------------------------------------------
// HR trajectory from DB samples
// ---------------------------------------------------------------------------

function buildHrTrajectory(samples: SampleRow[], offsetMs: number, firstTimestamp: number): string | null {
  // "now" = samples near the offset time
  const nowTarget = firstTimestamp + offsetMs;
  const nowSamples = samples.filter(
    (s) => s.hr !== null && s.hr > 0 && Math.abs(s.timestamp_ms - nowTarget) <= 15_000
  );
  if (nowSamples.length === 0) return null;

  const avg = (arr: number[]) =>
    Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);

  const nowHr = avg(nowSamples.map((s) => s.hr!));

  const marks = [
    { label: "5m ago", minutesAgo: 5 },
    { label: "4m ago", minutesAgo: 4 },
    { label: "3m ago", minutesAgo: 3 },
    { label: "2m ago", minutesAgo: 2 },
    { label: "1m ago", minutesAgo: 1 },
  ];

  const points: { label: string; hr: number; minutesAgo: number }[] = [];

  for (const mark of marks) {
    const targetMs = nowTarget - mark.minutesAgo * 60_000;
    const windowSamples = samples.filter(
      (s) => s.hr !== null && s.hr > 0 && Math.abs(s.timestamp_ms - targetMs) <= 10_000
    );
    if (windowSamples.length > 0) {
      points.push({
        label: mark.label,
        hr: avg(windowSamples.map((s) => s.hr!)),
        minutesAgo: mark.minutesAgo,
      });
    }
  }

  if (points.length === 0) return null;

  const parts = points.map((p) => `${p.label}: ${p.hr}`);
  parts.push(`now: ${nowHr}`);
  const timeline = parts.join(" | ");

  const earliest = points[0];
  const totalChange = nowHr - earliest.hr;
  const spanMinutes = earliest.minutesAgo;

  let trend: string;
  if (Math.abs(totalChange) <= 2) {
    trend = `Stable (\u00B1${Math.abs(totalChange)} bpm over ${spanMinutes} min)`;
  } else if (totalChange > 0) {
    trend = `Rising +${totalChange} bpm over ${spanMinutes} min`;
  } else {
    trend = `Falling ${totalChange} bpm over ${spanMinutes} min`;
  }

  return `${timeline}\n${trend}`;
}

// ---------------------------------------------------------------------------
// Build the user message from DB data
// ---------------------------------------------------------------------------

function buildReplayUserMessage(
  phases: Phase[],
  planSummary: string,
  samples: SampleRow[],
  offsetMs: number,
  zonesText: string,
): string {
  const elapsedStr = formatElapsed(offsetMs);
  const sections: string[] = [];

  // WORKOUT TIME
  sections.push(`WORKOUT TIME: ${elapsedStr}`);
  sections.push("");

  // Plan overview (current + next 2 phases, with remaining count)
  sections.push("## Plan");
  sections.push(planSummary);
  const elapsedS = offsetMs / 1000;
  let accumulated = 0;
  let currentPhaseIdx = 0;
  for (let i = 0; i < phases.length; i++) {
    const durationS = getPhaseDurationS(phases[i]);
    if (accumulated <= elapsedS && elapsedS < accumulated + durationS) {
      currentPhaseIdx = i;
      break;
    }
    accumulated += durationS;
    if (i === phases.length - 1) currentPhaseIdx = phases.length; // past end
  }
  const visibleEnd = Math.min(currentPhaseIdx + 3, phases.length);
  accumulated = 0;
  for (let i = 0; i < phases.length; i++) {
    accumulated += getPhaseDurationS(phases[i]);
  }
  // Recompute accumulated per-phase for display
  let accum2 = 0;
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const durationS = getPhaseDurationS(phase);
    if (i >= currentPhaseIdx && i < visibleEnd) {
      const marker =
        accum2 <= elapsedS && elapsedS < accum2 + durationS
          ? "->"
          : "  ";
      if (isRecoveryPhase(phase)) {
        sections.push(
          `${marker} ${phase.name}: recovery (HR<${phase.target_hr}) ${phase.position} ${phase.cadence}rpm`
        );
      } else {
        const zoneName = phase.zone;
        const durationMin = Math.round(durationS / 60);
        sections.push(
          `${marker} ${phase.name}: ${durationMin}min ${zoneName} ${phase.position} ${phase.cadence}rpm`
        );
      }
    }
    accum2 += durationS;
  }
  const remainingAfterVisible = phases.length - visibleEnd;
  if (remainingAfterVisible > 0) {
    sections.push(`   (+${remainingAfterVisible} more phase${remainingAfterVisible === 1 ? "" : "s"})`);
  }

  // Zones
  sections.push("");
  sections.push("## Zones");
  sections.push(zonesText);

  // Current Phase
  sections.push("");
  sections.push("## Current Phase");
  const { currentPhase, phaseElapsed, phaseRemaining, phaseIndex } = getCurrentPhase(phases, offsetMs);
  if (currentPhase) {
    if (isRecoveryPhase(currentPhase)) {
      sections.push(
        `Recovery -- target HR: ${currentPhase.target_hr}, elapsed: ${Math.round(phaseElapsed / 1000)}s`
      );
      sections.push(`${currentPhase.name} | recovery | ${currentPhase.position} | ${currentPhase.cadence}rpm`);
    } else {
      sections.push(
        `${currentPhase.name} | ${currentPhase.zone} | ${currentPhase.position} | ${currentPhase.cadence}rpm`
      );
      sections.push(
        `Phase time: ${formatElapsed(phaseElapsed)} elapsed, ${formatElapsed(phaseRemaining)} remaining`
      );
      if (currentPhase.hr_target) {
        sections.push(`HR target: ${currentPhase.hr_target} (informational)`);
      }

      // Upcoming phase preview when nearing end
      if (phaseRemaining <= 30_000 && phaseIndex < phases.length - 1) {
        const nextPhase = phases[phaseIndex + 1];
        const remainingSec = Math.round(phaseRemaining / 1000);
        if (isRecoveryPhase(nextPhase)) {
          sections.push(
            `\u23ED NEXT (in ${remainingSec}s): ${nextPhase.name} | recovery | ${nextPhase.position} | ${nextPhase.cadence}rpm`
          );
        } else {
          sections.push(
            `\u23ED NEXT (in ${remainingSec}s): ${nextPhase.name} | ${nextPhase.zone} | ${nextPhase.position} | ${nextPhase.cadence}rpm`
          );
        }
      }

      const cues = currentPhase.form_cues ?? (currentPhase as any).cues;
      if (cues && cues.length > 0) {
        sections.push(`Cues: ${cues.join(", ")}`);
      }
    }
  } else {
    sections.push("Workout complete -- cool down.");
  }

  // Current Targets -- not stored in DB
  sections.push("");
  sections.push("## Current Targets");
  sections.push("[not available -- targets are not stored in DB]");

  // Recent Coach Messages -- not stored in DB
  sections.push("");
  sections.push("## Recent Coach Messages");
  sections.push("[not available -- coach messages are not stored in DB]");

  // Note from previous tick -- not stored in DB
  sections.push("");
  sections.push("## Note from previous tick");
  sections.push("[not available -- coach notes are not stored in DB]");

  // Get samples up to the offset
  const firstTimestamp = samples.length > 0 ? samples[0].timestamp_ms : 0;
  const cutoffTimestamp = firstTimestamp + offsetMs;
  const samplesUpToOffset = samples.filter((s) => s.timestamp_ms <= cutoffTimestamp);

  // HR Trajectory
  if (samplesUpToOffset.length > 0) {
    const hrTrajectory = buildHrTrajectory(samplesUpToOffset, offsetMs, firstTimestamp);
    if (hrTrajectory) {
      sections.push("");
      sections.push("## HR Trajectory");
      sections.push(hrTrajectory);
    }
  }

  // Recent Metrics (15s avg with trend arrows, matching live format)
  sections.push("");
  sections.push("## Recent Metrics (15s avg)");
  const currentCutoff = cutoffTimestamp - 15_000;
  const currentSamples = samplesUpToOffset.filter((s) => s.timestamp_ms >= currentCutoff);
  const previousCutoff = cutoffTimestamp - 30_000;
  const previousSamples = samplesUpToOffset.filter(
    (s) => s.timestamp_ms >= previousCutoff && s.timestamp_ms < currentCutoff
  );

  if (currentSamples.length > 0) {
    const avg = (arr: number[]) =>
      Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);

    const powers = currentSamples.filter((s) => s.power !== null).map((s) => s.power!);
    const hrs = currentSamples.filter((s) => s.hr !== null && s.hr > 0).map((s) => s.hr!);
    const cadences = currentSamples.filter((s) => s.cadence !== null).map((s) => s.cadence!);

    const curPower = powers.length > 0 ? avg(powers) : 0;
    const curHr = hrs.length > 0 ? avg(hrs) : 0;
    const curCadence = cadences.length > 0 ? avg(cadences) : 0;

    // Compute trend arrows by comparing current 15s to previous 15s
    let powerTrend = "\u2192";
    let hrTrend = "\u2192";
    let cadenceTrend = "\u2192";

    if (previousSamples.length > 0) {
      const prevPowers = previousSamples.filter((s) => s.power !== null).map((s) => s.power!);
      const prevHrs = previousSamples.filter((s) => s.hr !== null && s.hr > 0).map((s) => s.hr!);
      const prevCadences = previousSamples.filter((s) => s.cadence !== null).map((s) => s.cadence!);

      if (prevPowers.length > 0) {
        const powerDiff = curPower - avg(prevPowers);
        if (powerDiff > 10) powerTrend = "\u2191";
        else if (powerDiff < -10) powerTrend = "\u2193";
      }

      if (prevHrs.length > 0) {
        const hrDiff = curHr - avg(prevHrs);
        if (hrDiff > 3) hrTrend = "\u2191";
        else if (hrDiff < -3) hrTrend = "\u2193";
      }

      if (prevCadences.length > 0) {
        const cadenceDiff = curCadence - avg(prevCadences);
        if (cadenceDiff > 5) cadenceTrend = "\u2191";
        else if (cadenceDiff < -5) cadenceTrend = "\u2193";
      }
    }

    sections.push(
      `Power ${curPower}W${powerTrend} | HR ${curHr}${hrTrend} | Cadence ${curCadence}${cadenceTrend}`
    );
  } else {
    sections.push("No samples in last 15s");
  }

  // Status
  sections.push("");
  sections.push("## Status");
  const { currentPhase: statusPhase } = getCurrentPhase(phases, offsetMs);
  const maxHr = samplesUpToOffset.length > 0
    ? Math.max(...samplesUpToOffset.filter((s) => s.hr !== null && s.hr > 0).map((s) => s.hr!), 0)
    : 0;

  // Phase avg: use samples from the start of the current phase
  let phaseStartMs = 0;
  let accum = 0;
  for (const phase of phases) {
    if (phase === statusPhase) {
      phaseStartMs = accum * 1000;
      break;
    }
    accum += getPhaseDurationS(phase);
  }
  const phaseStartTimestamp = firstTimestamp + phaseStartMs;
  const phaseSamples = samplesUpToOffset.filter((s) => s.timestamp_ms >= phaseStartTimestamp);

  const zonePart = statusPhase
    ? (isRecoveryPhase(statusPhase) ? "Recovery" : statusPhase.zone)
    : "---";
  if (phaseSamples.length > 0) {
    const pavg = (arr: (number | null)[]) => {
      const valid = arr.filter((v): v is number => v !== null && v > 0);
      return valid.length > 0 ? Math.round(valid.reduce((s, x) => s + x, 0) / valid.length) : 0;
    };
    sections.push(
      `${zonePart} | Phase avg: ${pavg(phaseSamples.map((s) => s.power))}W ${pavg(phaseSamples.map((s) => s.hr))}bpm ${pavg(phaseSamples.map((s) => s.cadence))}rpm | Max HR: ${maxHr} | Elapsed: ${elapsedStr}`
    );
  } else {
    sections.push(
      `${zonePart} | Phase avg: -- | Max HR: ${maxHr} | Elapsed: ${elapsedStr}`
    );
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Coach API call
// ---------------------------------------------------------------------------

async function callCoach(systemPrompt: string, userMessage: string): Promise<CoachResponse | null> {
  const client = new Anthropic();
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      output_config: {
        format: {
          type: "json_schema",
          schema: coachSchema,
        },
      },
    });

    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    if (!textBlock) return null;
    return JSON.parse(textBlock.text) as CoachResponse;
  } catch (err) {
    console.error("Coach API error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tick helpers
// ---------------------------------------------------------------------------

function loadCoachTicks(db: Database, planId: number): CoachTickRow[] {
  // Check if coach_ticks table exists (old DBs may not have it)
  const hasTicksTable = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='coach_ticks'"
  ).get() !== null;
  if (!hasTicksTable) return [];

  return db.query(
    "SELECT * FROM coach_ticks WHERE plan_id = ? ORDER BY elapsed_s"
  ).all(planId) as CoachTickRow[];
}

function findClosestTick(ticks: CoachTickRow[], elapsedS: number): CoachTickRow | null {
  if (ticks.length === 0) return null;
  let closest = ticks[0];
  let closestDist = Math.abs(closest.elapsed_s - elapsedS);
  for (const tick of ticks) {
    const dist = Math.abs(tick.elapsed_s - elapsedS);
    if (dist < closestDist) {
      closest = tick;
      closestDist = dist;
    }
  }
  return closest;
}

function listTicks(db: Database, planId: number): void {
  const ticks = loadCoachTicks(db, planId);
  if (ticks.length === 0) {
    console.log(`No coach ticks stored for plan ${planId}.`);
    return;
  }

  console.log(`Coach ticks for plan ${planId} (${ticks.length} total):`);
  console.log("-".repeat(80));
  for (const tick of ticks) {
    const elapsed = formatElapsed(tick.elapsed_s * 1000);
    const msg = tick.response_message
      ? `"${tick.response_message.length > 60 ? tick.response_message.slice(0, 60) + "..." : tick.response_message}"`
      : "(no response)";
    const latency = tick.latency_ms !== null ? `${tick.latency_ms}ms` : "---";
    const targets = tick.response_power !== null
      ? `${tick.response_power}W`
      : "---";
    console.log(`  ${elapsed}  ${latency}  ${targets}  ${msg}`);
  }
  console.log();
  console.log("Usage: bun scripts/replay.ts <plan_id> <MM:SS> [--call]");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  // No args -> list plans
  if (args.length === 0) {
    listPlans();
    return;
  }

  // Parse plan_id
  const planId = parseInt(args[0], 10);
  if (isNaN(planId)) {
    console.error(`Invalid plan ID: ${args[0]}`);
    process.exit(1);
  }

  // --ticks mode: list all tick timestamps for a plan
  if (args.includes("--ticks")) {
    const db = openDb();
    const plan = db.query("SELECT * FROM plans WHERE id = ?").get(planId) as PlanRow | null;
    if (!plan) {
      console.error(`Plan ${planId} not found.`);
      db.close();
      process.exit(1);
    }
    listTicks(db, planId);
    db.close();
    return;
  }

  // Parse time offset
  if (args.length < 2) {
    console.error("Missing time offset. Usage: bun scripts/replay.ts <plan_id> <MM:SS> [--call]");
    process.exit(1);
  }
  const offsetMs = parseTime(args[1]);

  // Parse --call flag
  const shouldCall = args.includes("--call");

  // Load plan
  const db = openDb();
  const plan = db.query("SELECT * FROM plans WHERE id = ?").get(planId) as PlanRow | null;
  if (!plan) {
    console.error(`Plan ${planId} not found.`);
    db.close();
    process.exit(1);
  }

  const phases: Phase[] = JSON.parse(plan.phases);
  const totalPlanSec = phases.reduce((s, ph) => s + getPhaseDurationS(ph), 0);
  const totalPlanMin = Math.round(totalPlanSec / 60);

  // Derive a summary -- the plan table does not store the WorkoutPlan summary,
  // only the completion summary. Use the phase names as a stand-in.
  const planSummary = phases.map((ph) => ph.name).join(" -> ");

  // Load samples up to offset
  const allSamples = db.query(
    "SELECT timestamp_ms, duration_ms, power, hr, cadence FROM samples WHERE plan_id = ? ORDER BY timestamp_ms"
  ).all(planId) as SampleRow[];

  // Load coach ticks
  const ticks = loadCoachTicks(db, planId);
  db.close();

  const elapsedS = offsetMs / 1000;
  const closestTick = findClosestTick(ticks, elapsedS);

  const firstTimestamp = allSamples.length > 0 ? allSamples[0].timestamp_ms : 0;
  const cutoffTimestamp = firstTimestamp + offsetMs;
  const samplesUpToOffset = allSamples.filter((s) => s.timestamp_ms <= cutoffTimestamp);

  // Print info
  console.log("=".repeat(80));
  console.log(`REPLAY: Plan ${planId} at ${formatElapsed(offsetMs)}`);
  console.log("=".repeat(80));
  console.log(`  Created: ${plan.created_at}`);
  console.log(`  Plan duration: ${totalPlanMin}min`);
  console.log(`  Total samples: ${allSamples.length}`);
  console.log(`  Samples up to ${formatElapsed(offsetMs)}: ${samplesUpToOffset.length}`);
  if (allSamples.length > 0) {
    const spanMs = allSamples[allSamples.length - 1].timestamp_ms - allSamples[0].timestamp_ms;
    console.log(`  Actual workout duration: ${formatDuration(spanMs)}`);
  }
  console.log(`  Stored coach ticks: ${ticks.length}`);
  console.log();

  // Show stored tick data if available
  if (closestTick) {
    const tickElapsed = formatElapsed(closestTick.elapsed_s * 1000);
    const dist = Math.abs(closestTick.elapsed_s - elapsedS);
    console.log("=".repeat(80));
    console.log(`STORED COACH TICK at ${tickElapsed} (${dist < 0.5 ? "exact" : `${dist.toFixed(1)}s away`})`);
    console.log("=".repeat(80));
    console.log();

    // Show the actual user message that was sent (if stored)
    if (closestTick.user_message) {
      console.log("--- ACTUAL USER MESSAGE (from DB) ---");
      console.log(closestTick.user_message);
      console.log("--- END ACTUAL USER MESSAGE ---");
      console.log();
    } else {
      console.log("  (user_message not stored -- will use reconstructed prompt)");
      console.log();
    }

    // Show the actual coach response
    console.log("--- ACTUAL COACH RESPONSE ---");
    if (closestTick.response_message !== null) {
      console.log(`  message:  "${closestTick.response_message}"`);
      console.log(`  power:    ${closestTick.response_power ?? "---"}W`);
      console.log(`  note:     ${closestTick.response_note ?? "(none)"}`);
      console.log(`  latency:  ${closestTick.latency_ms ?? "---"}ms`);
    } else {
      console.log("  (API call failed -- no response)");
      console.log(`  latency:  ${closestTick.latency_ms ?? "---"}ms`);
    }
    console.log("--- END ACTUAL COACH RESPONSE ---");
    console.log();
  } else {
    // No stored ticks -- fall back to reconstruction
    console.log("NOTE: No stored coach ticks for this plan. Falling back to reconstruction.");
    console.log("  The following sections cannot be reconstructed from DB data:");
    console.log("  - Recent Coach Messages (not stored)");
    console.log("  - Coach Notes (not stored)");
    console.log("  - Current Targets (not stored)");
    console.log("  Placeholders are shown in their place.");
    console.log();
  }

  // Build system prompt
  const systemPrompt = buildCoachingSystemPrompt();

  // Build zones (uses current DB state, same as a live workout would at start)
  const zonesText = getZonesText();

  // Build reconstructed user message (always shown for comparison / --call use)
  // Use stored user_message if available, otherwise reconstruct from DB data
  const userMessage = closestTick?.user_message
    ?? buildReplayUserMessage(phases, planSummary, allSamples, offsetMs, zonesText);

  // Print system prompt
  console.log("=".repeat(80));
  console.log("SYSTEM PROMPT");
  console.log("=".repeat(80));
  console.log();
  console.log(systemPrompt);
  console.log();

  // Print user message (actual from tick or reconstructed)
  console.log("=".repeat(80));
  console.log(closestTick?.user_message ? "USER MESSAGE (from stored tick)" : "USER MESSAGE (reconstructed)");
  console.log("=".repeat(80));
  console.log();
  console.log(userMessage);
  console.log();

  // Print schema
  console.log("-".repeat(80));
  console.log("RESPONSE SCHEMA");
  console.log("-".repeat(80));
  console.log(JSON.stringify(coachSchema, null, 2));
  console.log();

  // Call coach API if requested
  if (shouldCall) {
    console.log("=".repeat(80));
    console.log("CALLING COACH API...");
    console.log("=".repeat(80));
    console.log();

    const start = Date.now();
    const response = await callCoach(systemPrompt, userMessage);
    const latency = Date.now() - start;

    if (response) {
      console.log(`Response (${latency}ms):`);
      console.log(`  message:  "${response.message}"`);
      console.log(`  power:    ${response.power ?? "---"}W`);
      console.log(`  note:     ${response.note ?? "(none)"}`);
    } else {
      console.log("No response from coach API.");
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
