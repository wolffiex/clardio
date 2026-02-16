/**
 * Dump the coach's system and user prompts to stdout
 *
 * Usage: bun scripts/dump-prompt.ts [planning|coaching|both]
 * Default: both
 */

import {
  buildPlanningSystemPrompt,
  buildPlanningUserPrompt,
  buildCoachingSystemPrompt,
  getZonesText,
  planSchema,
  coachSchema,
} from "../src/server/coach-prompt.ts";

const arg = process.argv[2] ?? "both";

if (arg === "planning" || arg === "both") {
  console.log("=".repeat(80));
  console.log("PLANNING SYSTEM PROMPT");
  console.log("=".repeat(80));
  console.log();
  console.log(buildPlanningSystemPrompt());
  console.log();
  console.log("=".repeat(80));
  console.log("PLANNING USER PROMPT");
  console.log("=".repeat(80));
  console.log();
  console.log(buildPlanningUserPrompt("No previous plans."));
  console.log();
  console.log("-".repeat(80));
  console.log("PLANNING SCHEMA");
  console.log("-".repeat(80));
  console.log(JSON.stringify(planSchema, null, 2));
  console.log();
}

if (arg === "coaching" || arg === "both") {
  console.log("=".repeat(80));
  console.log("COACHING SYSTEM PROMPT");
  console.log("=".repeat(80));
  console.log();
  console.log(buildCoachingSystemPrompt());
  console.log();
  console.log("=".repeat(80));
  console.log("COACHING USER PROMPT (sample)");
  console.log("=".repeat(80));
  console.log();

  // Build a realistic sample of what a mid-workout coaching tick looks like
  const zones = getZonesText();

  const sampleUserMessage = `WORKOUT TIME: 15:40

## Timing
Elapsed: 15:40
Avg coach latency: 7.2s
Your message displays at ~15:47

## Plan
Sweet spot with standing surges
-> Sweet Spot Block 1: 8min Sweet Spot seated 85-95rpm
   Standing Surge: 1min Z4 standing 80-90rpm
   Sweet Spot Block 2: 8min Sweet Spot seated 85-95rpm
   (+3 more phases)

## Zones
${zones}

## Rider Profile
(rider profile from DB history -- power capabilities, aerobic fitness, patterns, recent load)

## Session Trends
(compact session trends -- EF trend, warmup HR, FTP estimate)

## Current Phase (AUTHORITATIVE — do not override)
Sweet Spot Block 1 | Sweet Spot | seated | 85-95rpm
Phase time: 3:20 elapsed, 4:40 remaining
HR target: 140-150 (informational)
Cue: drop heels at bottom of stroke
(2 of 4 phase cues)

## Current Target
Power: 195W

## Recent Coach Messages
[15:20] "Settling in. Good rhythm."
[15:30] "HR right where it should be."

## Note from previous tick
First interval HR peaked at Z4 ceiling, recovered well

## HR Trajectory
5m ago: 110 | 4m ago: 122 | 3m ago: 133 | 2m ago: 140 | 1m ago: 144 | now: 146
Rising +36 bpm over 5 min

## Recent Metrics (15s avg)
Power 192W\u2192 | HR 146\u2191 | Cadence 89\u2192

## Status
Phase avg: 193W 145bpm 89rpm | Max HR: 152 | Elapsed: 15:40`;

  console.log(sampleUserMessage);
  console.log();
  console.log("-".repeat(80));
  console.log("COACHING SCHEMA");
  console.log("-".repeat(80));
  console.log(JSON.stringify(coachSchema, null, 2));
  console.log();
}
