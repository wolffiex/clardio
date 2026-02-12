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
  completed: number;
  summary: string | null;
};

type SampleRow = {
  timestamp_ms: number;
  duration_ms: number;
  power: number | null;
  hr: number | null;
  cadence: number | null;
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
  const plans = db.query(
    "SELECT p.*, (SELECT COUNT(*) FROM samples s WHERE s.plan_id = p.id) AS sample_count, (SELECT MAX(timestamp_ms) - MIN(timestamp_ms) FROM samples s WHERE s.plan_id = p.id) AS span_ms FROM plans p ORDER BY p.id"
  ).all() as (PlanRow & { sample_count: number; span_ms: number | null })[];

  if (plans.length === 0) {
    console.log("No plans found in database.");
    db.close();
    return;
  }

  console.log("Plans:");
  console.log("-".repeat(80));
  for (const p of plans) {
    const phases: Phase[] = JSON.parse(p.phases);
    const totalPlanMin = phases.reduce((s, ph) => s + ph.duration_minutes, 0);
    const actualDuration = p.span_ms ? formatDuration(p.span_ms) : "no samples";
    const status = p.completed ? "done" : "incomplete";
    const phaseNames = phases.map((ph) => ph.name).join(", ");
    console.log(
      `  ${p.id}. [${p.created_at}] ${status} | plan: ${totalPlanMin}min | actual: ${actualDuration} | ${p.sample_count} samples`
    );
    console.log(`     phases: ${phaseNames}`);
    if (p.summary) {
      console.log(`     summary: ${p.summary}`);
    }
  }
  console.log();
  console.log("Usage: bun scripts/replay.ts <plan_id> <MM:SS> [--call]");
  db.close();
}

// ---------------------------------------------------------------------------
// Phase computation from elapsed time
// ---------------------------------------------------------------------------

function getCurrentPhase(
  phases: Phase[],
  elapsedMs: number
): { currentPhase: Phase | null; phaseElapsed: number; phaseRemaining: number; phaseIndex: number } {
  const elapsedMin = elapsedMs / 1000 / 60;
  let accumulated = 0;

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    if (elapsedMin < accumulated + phase.duration_minutes) {
      const phaseElapsedMin = elapsedMin - accumulated;
      return {
        currentPhase: phase,
        phaseElapsed: phaseElapsedMin * 60 * 1000,
        phaseRemaining: (phase.duration_minutes - phaseElapsedMin) * 60 * 1000,
        phaseIndex: i,
      };
    }
    accumulated += phase.duration_minutes;
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
  zonesText: string
): string {
  const elapsedStr = formatElapsed(offsetMs);
  const sections: string[] = [];

  // WORKOUT TIME
  sections.push(`WORKOUT TIME: ${elapsedStr}`);
  sections.push("");

  // Plan overview
  sections.push("## Plan");
  sections.push(planSummary);
  const elapsedMin = offsetMs / 1000 / 60;
  let accumulated = 0;
  for (const phase of phases) {
    const marker =
      accumulated <= elapsedMin && elapsedMin < accumulated + phase.duration_minutes
        ? "->"
        : "  ";
    sections.push(
      `${marker} ${phase.name}: ${phase.duration_minutes}min ${phase.zone} ${phase.position} ${phase.cadence[0]}-${phase.cadence[1]}rpm`
    );
    accumulated += phase.duration_minutes;
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
    sections.push(
      `${currentPhase.name} | ${currentPhase.zone} | ${currentPhase.position} | ${currentPhase.cadence[0]}-${currentPhase.cadence[1]}rpm`
    );
    sections.push(
      `Phase time: ${formatElapsed(phaseElapsed)} elapsed, ${formatElapsed(phaseRemaining)} remaining`
    );

    // Upcoming phase preview when nearing end
    if (phaseRemaining <= 30_000 && phaseIndex < phases.length - 1) {
      const nextPhase = phases[phaseIndex + 1];
      const remainingSec = Math.round(phaseRemaining / 1000);
      sections.push(
        `\u23ED NEXT (in ${remainingSec}s): ${nextPhase.name} | ${nextPhase.zone} | ${nextPhase.position} | ${nextPhase.cadence[0]}-${nextPhase.cadence[1]}rpm`
      );
    }

    if (currentPhase.cues.length > 0) {
      sections.push(`Cues: ${currentPhase.cues.join(", ")}`);
    }
    if (currentPhase.notes) {
      sections.push(`Notes: ${currentPhase.notes}`);
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

  // Coach Notes -- not stored in DB
  sections.push("");
  sections.push("## Coach Notes");
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

  // Recent Metrics (last 30s relative to offset)
  sections.push("");
  sections.push("## Recent Metrics (last 30s)");
  const recentCutoff = cutoffTimestamp - 30_000;
  const recentSamples = samplesUpToOffset.filter((s) => s.timestamp_ms >= recentCutoff);

  if (recentSamples.length > 0) {
    const powers = recentSamples.filter((s) => s.power !== null).map((s) => s.power!);
    const hrs = recentSamples.filter((s) => s.hr !== null).map((s) => s.hr!);
    const cadences = recentSamples.filter((s) => s.cadence !== null).map((s) => s.cadence!);

    const avg = (arr: number[]) =>
      Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);

    if (powers.length > 0) {
      sections.push(
        `Power: avg ${avg(powers)}W, range ${Math.min(...powers)}-${Math.max(...powers)}W`
      );
    }
    if (hrs.length > 0) {
      sections.push(
        `HR: avg ${avg(hrs)}bpm, range ${Math.min(...hrs)}-${Math.max(...hrs)}bpm`
      );
    }
    if (cadences.length > 0) {
      sections.push(
        `Cadence: avg ${avg(cadences)}rpm, range ${Math.min(...cadences)}-${Math.max(...cadences)}rpm`
      );
    }

    // HR trend (last 45s)
    const trendCutoff = cutoffTimestamp - 45_000;
    const trendSamples = samplesUpToOffset.filter(
      (s) => s.timestamp_ms >= trendCutoff && s.hr !== null && s.hr > 0
    );
    if (trendSamples.length >= 2) {
      const firstHr =
        trendSamples.slice(0, 3).reduce((s, x) => s + x.hr!, 0) /
        Math.min(3, trendSamples.length);
      const lastHr =
        trendSamples.slice(-3).reduce((s, x) => s + x.hr!, 0) /
        Math.min(3, trendSamples.length);
      const diff = lastHr - firstHr;
      let trend = "heart rate steady";
      if (diff > 10) trend = "heart rate climbing quickly";
      else if (diff > 3) trend = "heart rate climbing";
      else if (diff < -10) trend = "heart rate falling quickly";
      else if (diff < -3) trend = "heart rate falling";
      sections.push(`Trend: ${trend}`);
    }
  } else {
    sections.push("No samples in last 30s");
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
      phaseStartMs = accum * 60 * 1000;
      break;
    }
    accum += phase.duration_minutes;
  }
  const phaseStartTimestamp = firstTimestamp + phaseStartMs;
  const phaseSamples = samplesUpToOffset.filter((s) => s.timestamp_ms >= phaseStartTimestamp);

  const zonePart = statusPhase ? statusPhase.zone : "---";
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
  const totalPlanMin = phases.reduce((s, ph) => s + ph.duration_minutes, 0);

  // Derive a summary -- the plan table does not store the WorkoutPlan summary,
  // only the completion summary. Use the phase names as a stand-in.
  const planSummary = phases.map((ph) => ph.name).join(" -> ");

  // Load samples up to offset
  const allSamples = db.query(
    "SELECT timestamp_ms, duration_ms, power, hr, cadence FROM samples WHERE plan_id = ? ORDER BY timestamp_ms"
  ).all(planId) as SampleRow[];
  db.close();

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
  console.log();

  // Sections we cannot reconstruct
  console.log("NOTE: The following sections cannot be reconstructed from DB data:");
  console.log("  - Recent Coach Messages (not stored)");
  console.log("  - Coach Notes (not stored)");
  console.log("  - Current Targets (not stored)");
  console.log("  Placeholders are shown in their place.");
  console.log();

  // Build system prompt
  const systemPrompt = buildCoachingSystemPrompt();

  // Build zones (uses current DB state, same as a live workout would at start)
  const zonesText = getZonesText();

  // Build user message
  const userMessage = buildReplayUserMessage(phases, planSummary, allSamples, offsetMs, zonesText);

  // Print system prompt
  console.log("=".repeat(80));
  console.log("SYSTEM PROMPT");
  console.log("=".repeat(80));
  console.log();
  console.log(systemPrompt);
  console.log();

  // Print user message
  console.log("=".repeat(80));
  console.log("USER MESSAGE");
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
      console.log(`  power:    ${response.power}W`);
      console.log(`  cadence:  ${response.cadence}rpm`);
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
