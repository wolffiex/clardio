/**
 * Coach - Claude Agent SDK integration
 *
 * Run directly to test: bun src/server/coach.ts
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  buildSystemPrompt,
  responseSchema,
  type CoachResponse,
} from "./coach-prompt";
import type { MetricsEvent } from "../shared/types";

let systemPrompt: string | null = null;
let sessionId: string | null = null;

export async function initCoach(): Promise<string> {
  systemPrompt = await buildSystemPrompt();
  sessionId = null;
  return systemPrompt;
}

async function sendMessage(userMessage: string): Promise<CoachResponse> {
  if (!systemPrompt) {
    await initCoach();
  }

  const options: Parameters<typeof query>[0]["options"] = {
    systemPrompt: systemPrompt!,
    model: "claude-sonnet-4-5-20250929",
    maxTurns: 1,
    outputFormat: {
      type: "json_schema",
      schema: responseSchema,
    },
    tools: [], // No tools - just respond with structured output
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  };

  // Resume session if we have one
  if (sessionId) {
    options.resume = sessionId;
  }

  const result = query({ prompt: userMessage, options });

  let response: CoachResponse | null = null;

  for await (const message of result) {
    // Capture session ID from init message
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
    }

    // Extract structured output from StructuredOutput tool use
    if (message.type === "assistant") {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" && block.name === "StructuredOutput") {
            response = block.input as CoachResponse;
          }
        }
      }
    }

    // Also check result for structured_output (in case of success)
    if (message.type === "result" && (message as any).structured_output) {
      response = (message as any).structured_output as CoachResponse;
    }
  }

  if (!response) {
    throw new Error("No response from coach");
  }

  return response;
}

export async function sendStart(): Promise<CoachResponse> {
  return sendMessage("Workout starting.");
}

export async function sendMetrics(metrics: MetricsEvent): Promise<CoachResponse> {
  const userMessage = `power:${metrics.power}W hr:${metrics.hr}bpm cadence:${metrics.cadence}rpm elapsed:${metrics.elapsed}s`;
  return sendMessage(userMessage);
}

export function resetCoach(): void {
  sessionId = null;
}

export function getSessionId(): string | null {
  return sessionId;
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
      console.log(`  target: ${response.target.power}W ${response.target.cadence}rpm`);
    }
    console.log(`  session: ${sessionId}`);
    console.log();
  }
}
