/**
 * Dump the coach's system prompts to stdout
 *
 * Usage: bun scripts/dump-prompt.ts [planning|coaching|both]
 * Default: both
 */

import {
  buildPlanningPrompt,
  buildCoachingPrompt,
  planSchema,
  coachSchema,
} from "../src/server/coach-prompt.ts";

const arg = process.argv[2] ?? "both";

if (arg === "planning" || arg === "both") {
  console.log("=".repeat(80));
  console.log("PLANNING PROMPT");
  console.log("=".repeat(80));
  console.log();
  const planning = await buildPlanningPrompt("No previous plans.");
  console.log(planning);
  console.log();
  console.log("-".repeat(80));
  console.log("PLANNING SCHEMA");
  console.log("-".repeat(80));
  console.log(JSON.stringify(planSchema, null, 2));
  console.log();
}

if (arg === "coaching" || arg === "both") {
  console.log("=".repeat(80));
  console.log("COACHING PROMPT");
  console.log("=".repeat(80));
  console.log();
  const coaching = await buildCoachingPrompt();
  console.log(coaching);
  console.log();
  console.log("-".repeat(80));
  console.log("COACHING SCHEMA");
  console.log("-".repeat(80));
  console.log(JSON.stringify(coachSchema, null, 2));
  console.log();
}
