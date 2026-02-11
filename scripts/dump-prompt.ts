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

## Plan
Sweet spot with standing surges
   Easy Spin: 5min Z1 Recovery seated 70-80rpm
   Build to Endurance: 5min Z2 Endurance seated 75-85rpm
   Opener Surge: 1min Z4 Threshold standing 85-95rpm
   Recovery: 2min Z1 Recovery seated 70-80rpm
-> Sweet Spot Block 1: 8min Sweet Spot seated 85-95rpm
   Standing Surge: 1min Z4 Threshold standing 80-90rpm
   Sweet Spot Block 2: 8min Sweet Spot seated 85-95rpm
   Standing Surge: 1min Z4 Threshold standing 80-90rpm
   Sweet Spot Block 3: 8min Sweet Spot seated 85-95rpm
   Easy Spin Cooldown: 3min Z1 Recovery seated 70-80rpm
   Final Cooldown: 3min Z1 Recovery seated 65-75rpm

## Zones
${zones}

## Current Phase
Sweet Spot Block 1 | Sweet Spot | seated | 85-95rpm
Phase time: 3:20 elapsed, 4:40 remaining
Cues: smooth circles, drop heels, quiet hips, rhythmic breathing
Notes: Steady sweet spot effort at 88-94% FTP

## Current Targets
Power: 195W | Cadence: 90rpm

## Recent Coach Messages
[15:20] "Settling in. Good rhythm."
[15:30] "HR right where it should be."

## HR Trajectory
5m ago: 110 | 4m ago: 122 | 3m ago: 133 | 2m ago: 140 | 1m ago: 144 | now: 146
Rising +36 bpm over 5 min

## Recent Metrics (last 30s)
Power: avg 192W, range 185-200W
HR: avg 146bpm, range 144-148bpm
Cadence: avg 89rpm, range 87-92rpm
Trend: heart rate steady

## Status
Sweet Spot | Phase avg: 193W 145bpm 89rpm | Max HR: 152 | Elapsed: 15:40`;

  console.log(sampleUserMessage);
  console.log();
  console.log("-".repeat(80));
  console.log("COACHING SCHEMA");
  console.log("-".repeat(80));
  console.log(JSON.stringify(coachSchema, null, 2));
  console.log();
}
