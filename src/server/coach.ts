/**
 * Coach - Anthropic SDK integration (stateless, single-turn)
 *
 * Two functions:
 * - planWorkout: Opus 4.6 generates a structured workout plan
 * - sendCoachMessage: Sonnet 4.5 reacts to metrics every 10 seconds
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  type WorkoutPlan,
  type CoachResponse,
  planSchema,
  coachSchema,
} from "./coach-prompt";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

export async function planWorkout(
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
    console.error("Coach error:", err);
    return null;
  }
}
