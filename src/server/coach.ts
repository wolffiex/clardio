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

let systemPrompt: string | null = null;
let sessionId: string | null = null;

function log(message: string) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${time}] ${message}`);
}

export async function initCoach(): Promise<string> {
  systemPrompt = await buildSystemPrompt();
  sessionId = null;
  log("Coach system prompt:");
  console.log(systemPrompt);
  console.log("---");
  return systemPrompt;
}

async function sendMessage(userMessage: string): Promise<CoachResponse> {
  if (!systemPrompt) {
    await initCoach();
  }

  log(`Coach prompt: "${userMessage}"`);

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

export async function sendMetrics(prompt: string): Promise<CoachResponse> {
  return sendMessage(prompt);
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

  // Simulate a few metrics prompts
  const testPrompts = [
    "Workout starting.",
    "20s ago: hr:72 cadence:0 power:0\n15s ago: hr:85 cadence:50 power:60\nheart rate climbing quickly",
    "20s ago: hr:115 cadence:78 power:110\n5s ago: hr:120 cadence:80 power:115\nheart rate climbing",
    "20s ago: hr:145 cadence:80 power:120\n15s ago: hr:146 cadence:78 power:115\n10s ago: hr:147 cadence:75 power:105\n5s ago: hr:148 cadence:72 power:95\nheart rate steady",
  ];

  for (const prompt of testPrompts) {
    console.log(`→ ${prompt.replace(/\n/g, " | ")}`);
    const response = await sendMetrics(prompt);
    console.log(`← "${response.message}"`);
    if (response.target) {
      console.log(`  target: ${response.target.power}W ${response.target.cadence}rpm`);
    }
    console.log(`  session: ${sessionId}`);
    console.log();
  }
}
