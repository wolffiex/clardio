/**
 * Coach - Anthropic SDK integration (stateless, single-turn)
 *
 * Two functions:
 * - planWorkout: Opus 4.6 generates a structured workout plan
 * - sendCoachMessage: Sonnet 4.5 reacts to metrics every 10 seconds
 */

import Anthropic from "@anthropic-ai/sdk";
import { APIError } from "@anthropic-ai/sdk/error";
import { log } from "./log";
import {
  type WorkoutPlan,
  type CoachResponse,
  planSchema,
  coachSchema,
} from "./coach-prompt";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const RETRY_DELAY_MS = 2000;

function isRetryableStatus(err: unknown): boolean {
  return err instanceof APIError && (err.status === 500 || err.status === 503);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function planWorkout(
  systemPrompt: string,
  userMessage: string
): Promise<WorkoutPlan> {
  try {
    return await callPlanner(systemPrompt, userMessage);
  } catch (err) {
    if (isRetryableStatus(err)) {
      log(`Planner API error (${(err as APIError).status}), retrying in ${RETRY_DELAY_MS}ms...`);
      await sleep(RETRY_DELAY_MS);
      return await callPlanner(systemPrompt, userMessage);
    }
    throw err;
  }
}

async function callPlanner(
  systemPrompt: string,
  userMessage: string
): Promise<WorkoutPlan> {
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    output_config: {
      format: {
        type: "json_schema",
        schema: planSchema,
      },
    },
  });

  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text"
  );
  if (!textBlock) throw new Error("No text response from planner");
  return JSON.parse(textBlock.text) as WorkoutPlan;
}

export async function sendCoachMessage(
  systemPrompt: string,
  userMessage: string
): Promise<CoachResponse | null> {
  try {
    return await callCoach(systemPrompt, userMessage);
  } catch (err) {
    if (isRetryableStatus(err)) {
      log(`Coach API error (${(err as APIError).status}), retrying in ${RETRY_DELAY_MS}ms...`);
      await sleep(RETRY_DELAY_MS);
      try {
        return await callCoach(systemPrompt, userMessage);
      } catch (retryErr) {
        log(`Coach retry failed: ${retryErr}`);
        return null;
      }
    }
    log(`Coach error: ${err}`);
    return null;
  }
}

async function callCoach(
  systemPrompt: string,
  userMessage: string
): Promise<CoachResponse | null> {
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
}
