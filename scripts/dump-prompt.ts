/**
 * Dump the coach's system prompt to stdout
 *
 * Usage: bun scripts/dump-prompt.ts
 */

import { buildSystemPrompt } from "../src/server/coach-prompt.ts";

const prompt = await buildSystemPrompt();
console.log(prompt);
