/**
 * Coach system prompt generator
 *
 * Run directly to preview: bun src/server/coach-prompt.ts
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import FitParser from "fit-file-parser";

interface WorkoutSummary {
  date: Date;
  durationMinutes: number;
  avgPower: number;
  maxPower: number;
  normalizedPower: number | null;
  avgHr: number;
  maxHr: number;
  avgCadence: number;
  calories: number;
}

async function parseFitFile(filePath: string): Promise<WorkoutSummary | null> {
  try {
    const buffer = await readFile(filePath);
    const parser = new FitParser({ force: true, mode: "cascade" });
    const data = await parser.parseAsync(buffer);

    const session = data.activity?.sessions?.[0];
    if (!session || session.sport !== "cycling") {
      return null;
    }

    return {
      date: new Date(session.start_time),
      durationMinutes: Math.round(session.total_elapsed_time / 60),
      avgPower: session.avg_power || 0,
      maxPower: session.max_power || 0,
      normalizedPower: session.normalized_power || null,
      avgHr: session.avg_heart_rate || 0,
      maxHr: session.max_heart_rate || 0,
      avgCadence: session.avg_cadence || 0,
      calories: session.total_calories || 0,
    };
  } catch {
    return null;
  }
}

export async function loadWorkoutHistory(): Promise<WorkoutSummary[]> {
  const fitDir = join(homedir(), "fit");

  try {
    const files = await readdir(fitDir);
    const fitFiles = files.filter((f) => f.endsWith(".fit"));

    const summaries = await Promise.all(
      fitFiles.map((f) => parseFitFile(join(fitDir, f)))
    );

    return summaries
      .filter((s): s is WorkoutSummary => s !== null)
      .sort((a, b) => b.date.getTime() - a.date.getTime());
  } catch {
    return [];
  }
}

function formatWorkoutHistory(workouts: WorkoutSummary[]): string {
  if (workouts.length === 0) {
    return "No recent workout history available.";
  }

  const lines = workouts.map((w) => {
    const date = w.date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    const np = w.normalizedPower ? ` NP:${w.normalizedPower}W` : "";
    return `- ${date}: ${w.durationMinutes}min, avg ${w.avgPower}W (max ${w.maxPower}W${np}), HR ${w.avgHr}/${w.maxHr}, ${w.avgCadence}rpm`;
  });

  // Calculate some aggregate stats
  const avgOfAvgPower = Math.round(
    workouts.reduce((sum, w) => sum + w.avgPower, 0) / workouts.length
  );
  const maxPowerEver = Math.max(...workouts.map((w) => w.maxPower));
  const avgDuration = Math.round(
    workouts.reduce((sum, w) => sum + w.durationMinutes, 0) / workouts.length
  );

  return `Recent workouts (${workouts.length} sessions):
${lines.join("\n")}

Patterns: avg session ${avgDuration}min, typical power ${avgOfAvgPower}W, peak ${maxPowerEver}W`;
}

// Response schema for structured output
export const responseSchema = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "Short message to display to the rider. Always required.",
    },
    target: {
      anyOf: [
        {
          type: "object",
          description: "Set a new target.",
          properties: {
            power: {
              type: "number",
              description: "Target power in watts.",
            },
            cadence: {
              type: "number",
              description: "Target cadence in rpm.",
            },
          },
          required: ["power", "cadence"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
      description: "Set a new target, or null to keep current target.",
    },
  },
  required: ["message", "target"],
  additionalProperties: false,
} as const;

export type CoachResponse = {
  message: string;
  target: {
    power: number;
    cadence: number;
  } | null;
};

export function getSystemPrompt(workoutHistory: string): string {
  return `You are clardio, an AI cycling coach controlling a display screen during indoor cycling workouts. You communicate with the rider through on-screen messages and control their targets.

## Your Persona

You are terse, dry, and observational. You see everything but say little. You are never disappointed, never effusive. You don't use exclamation marks. You don't say "great job" or "keep it up."

Example phrases that capture your voice:
- "I see you."
- "15 seconds. Don't quit."
- "HR still at 145. I'll wait."
- "There it is."
- "Power dropped. Find it again."
- "90 rpm. Hold."

## Rider Background

${workoutHistory}

Use this history to calibrate your expectations. Set targets appropriate for this rider's demonstrated capabilities.

## Your Response

Every response must include:
- **message**: Short text to display. One line, maybe two. The rider is working hard and can't read paragraphs.
- **target**: Set power/cadence targets, or null to keep current. Adjust targets continuously as needed.

## What You Receive

Periodic metrics updates with:
- power: current watts
- hr: heart rate in bpm
- cadence: rpm
- elapsed: seconds since workout started

## Guidelines

- Always send a message, even if just acknowledging. Short is fine.
- Set targets based on the rider's history. Start easy, build up.
- If the rider can't hold a target, acknowledge it and adjust. No judgment.
- Keep the workout moving. Don't let them rest too long, but don't break them either.`;
}

export async function buildSystemPrompt(): Promise<string> {
  const workouts = await loadWorkoutHistory();
  const historyText = formatWorkoutHistory(workouts);
  return getSystemPrompt(historyText);
}

// When run directly, output the prompt
if (import.meta.main) {
  const prompt = await buildSystemPrompt();
  console.log(prompt);
}
