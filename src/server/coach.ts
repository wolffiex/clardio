/**
 * Coach - Anthropic SDK integration
 *
 * Run directly to test: bun src/server/coach.ts
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaJSONSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import {
  buildSystemPrompt,
  responseSchema,
  type CoachResponse,
} from "./coach-prompt";
import type { MetricsEvent } from "../shared/types";

const client = new Anthropic();

type Message = Anthropic.MessageParam;

let systemPrompt: string | null = null;
let messages: Message[] = [];

export async function initCoach(): Promise<void> {
  systemPrompt = await buildSystemPrompt();
  messages = [];
}

export async function sendMetrics(metrics: MetricsEvent): Promise<CoachResponse> {
  if (!systemPrompt) {
    await initCoach();
  }

  const userMessage = `power:${metrics.power}W hr:${metrics.hr}bpm cadence:${metrics.cadence}rpm elapsed:${metrics.elapsed}s`;

  messages.push({ role: "user", content: userMessage });

  const response = await client.beta.messages.parse({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 256,
    system: systemPrompt!,
    messages,
    output_format: betaJSONSchemaOutputFormat(responseSchema),
  });

  const parsed = response.parsed_output as CoachResponse;

  // Store raw text for conversation history
  const content = response.content[0];
  if (content.type === "text") {
    messages.push({ role: "assistant", content: content.text });
  }

  return parsed;
}

export function resetCoach(): void {
  messages = [];
}

// Test harness
if (import.meta.main) {
  await initCoach();
  console.log("Coach initialized\n");

  // Simulate a few metrics updates
  const testMetrics: MetricsEvent[] = [
    { power: 0, hr: 72, cadence: 0, elapsed: 0 },
    { power: 85, hr: 95, cadence: 65, elapsed: 30 },
    { power: 110, hr: 118, cadence: 78, elapsed: 60 },
    { power: 105, hr: 125, cadence: 75, elapsed: 90 },
  ];

  for (const metrics of testMetrics) {
    console.log(`→ power:${metrics.power}W hr:${metrics.hr}bpm cadence:${metrics.cadence}rpm elapsed:${metrics.elapsed}s`);
    const response = await sendMetrics(metrics);
    console.log(`← "${response.message}"`);
    if (response.target) {
      console.log(`  target: ${response.target.power}W ${response.target.cadence}rpm${response.target.duration ? ` for ${response.target.duration}s` : " (baseline)"}`);
    }
    console.log();
  }
}
