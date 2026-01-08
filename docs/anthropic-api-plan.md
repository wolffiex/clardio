# Anthropic API Integration Plan for Clardio

## Overview

This document outlines the integration of the Anthropic TypeScript SDK for Clardio's AI cycling coach. Claude will control workouts in real-time, communicating with riders through a terse, dry coaching voice while managing power/cadence targets and monitoring rider metrics.

## SDK Setup and Configuration

### Installation

```bash
bun add @anthropic-ai/sdk zod
```

The SDK reads `ANTHROPIC_API_KEY` from environment variables by default.

### Basic Client Setup

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY, // Optional - uses env var by default
});
```

### Recommended Model

Use **Claude Sonnet 4.5** (`claude-sonnet-4-5-20250929`) for the coaching loop:
- Best balance of speed, cost, and capability for real-time interaction
- Excellent parallel tool use for responding to metrics while managing targets
- Input: $3/MTok, Output: $15/MTok

For budget-conscious deployments, **Claude Haiku 4.5** could work for simpler coaching scenarios.

## Tool Definitions

### TypeScript Types

```typescript
import { z } from 'zod';

// Rider state from sensors
interface RiderState {
  power: number;           // Current power in watts
  heartRate: number;       // Current HR in bpm
  cadence: number;         // Current cadence in rpm
  elapsedTime: number;     // Seconds since workout start
  currentTarget?: {
    type: 'power' | 'cadence';
    value: number;
    remainingSeconds: number;
  };
  buttonVisible: boolean;
  buttonLabel?: string;
}

// Workout history summary
interface WorkoutSummary {
  date: string;           // ISO date
  durationMinutes: number;
  tss: number;            // Training Stress Score
  avgPower: number;
  normalizedPower: number;
  notes?: string;
}
```

### Tool Schemas with Zod

```typescript
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

// Display a coach message on screen
const sendMessageTool = betaZodTool({
  name: 'send_message',
  description: `Display a terse coaching message on the rider's screen.
    Keep messages short (1-8 words). Use a dry, matter-of-fact tone.
    Examples: "Good.", "Power's drifting.", "30 seconds.", "Recover."`,
  inputSchema: z.object({
    text: z.string().max(50).describe('The message to display'),
    duration: z.number().optional().describe('Display duration in seconds (default: 5)'),
  }),
  run: async (input) => {
    // Implementation will send to UI
    return JSON.stringify({ sent: true });
  },
});

// Set a power or cadence target
const setTargetTool = betaZodTool({
  name: 'set_target',
  description: `Set a power or cadence target for the rider.
    Power targets are in watts. Cadence targets are in rpm.
    Duration is how long the target should be held.
    Use this to structure intervals, build phases, or maintain steady state.`,
  inputSchema: z.object({
    type: z.enum(['power', 'cadence']),
    value: z.number().positive().describe('Target value (watts for power, rpm for cadence)'),
    durationSeconds: z.number().positive().describe('How long to hold the target'),
  }),
  run: async (input) => {
    return JSON.stringify({ set: true, ...input });
  },
});

// Clear the current target
const clearTargetTool = betaZodTool({
  name: 'clear_target',
  description: 'Remove the current power/cadence target. Use for recovery or free-riding phases.',
  inputSchema: z.object({}),
  run: async (input) => {
    return JSON.stringify({ cleared: true });
  },
});

// Show a commitment button
const showButtonTool = betaZodTool({
  name: 'show_button',
  description: `Show a commitment button for the rider to press.
    Use to get rider buy-in before hard efforts, confirm readiness, or mark phase transitions.
    Examples: "[Let's go]", "[Ready]", "[One more]", "[Send it]"`,
  inputSchema: z.object({
    label: z.string().max(20).describe('Button label in brackets, e.g., "[Ready]"'),
  }),
  run: async (input) => {
    return JSON.stringify({ shown: true, label: input.label });
  },
});

// Hide the commitment button
const hideButtonTool = betaZodTool({
  name: 'hide_button',
  description: 'Hide the commitment button after it has been pressed or is no longer needed.',
  inputSchema: z.object({}),
  run: async (input) => {
    return JSON.stringify({ hidden: true });
  },
});

// Get current rider state
const getRiderStateTool = betaZodTool({
  name: 'get_rider_state',
  description: `Get the rider's current metrics: power, heart rate, cadence, elapsed time.
    Also returns current target status and button visibility.
    Call this to check if the rider is hitting targets or needs adjustment.`,
  inputSchema: z.object({}),
  run: async (input) => {
    // Implementation will read from sensor state
    return JSON.stringify({
      power: 250,
      heartRate: 145,
      cadence: 90,
      elapsedTime: 1200,
      currentTarget: { type: 'power', value: 260, remainingSeconds: 45 },
      buttonVisible: false,
    } satisfies RiderState);
  },
});

// Get workout history
const getWorkoutHistoryTool = betaZodTool({
  name: 'get_workout_history',
  description: `Get summaries of past workouts for context.
    Use to reference previous sessions, track progression, or adjust intensity.`,
  inputSchema: z.object({
    limit: z.number().optional().describe('Number of recent workouts to retrieve (default: 5)'),
  }),
  run: async (input) => {
    return JSON.stringify([
      { date: '2026-01-06', durationMinutes: 60, tss: 75, avgPower: 200, normalizedPower: 220 },
    ] satisfies WorkoutSummary[]);
  },
});

// End the workout
const endWorkoutTool = betaZodTool({
  name: 'end_workout',
  description: `Signal that the workout is complete. Include a brief summary.
    Use after cooldown is complete or rider requests to stop.`,
  inputSchema: z.object({
    summary: z.string().describe('Brief workout summary (1-2 sentences)'),
  }),
  run: async (input) => {
    return JSON.stringify({ ended: true, summary: input.summary });
  },
});

// All tools array
const coachingTools = [
  sendMessageTool,
  setTargetTool,
  clearTargetTool,
  showButtonTool,
  hideButtonTool,
  getRiderStateTool,
  getWorkoutHistoryTool,
  endWorkoutTool,
];
```

## Coaching Loop Architecture

### Event-Driven with Polling Hybrid

The coaching loop uses a hybrid approach:

1. **Polling interval** (every 5-10 seconds): Feed current metrics to Claude
2. **Event triggers**: Immediate updates for button presses, target completions
3. **Streaming responses**: Real-time feel for coach messages

```
+----------------+     +----------------+     +------------------+
|  Sensor Feed   |---->|  Loop Manager  |---->|  Anthropic API   |
|  (power, HR,   |     |  (aggregates,  |     |  (streaming)     |
|   cadence)     |     |   triggers)    |     |                  |
+----------------+     +----------------+     +------------------+
                              |                       |
                              v                       v
                       +----------------+     +----------------+
                       |  Event Queue   |     |  Tool Executor |
                       |  (button, etc) |     |  (UI updates)  |
                       +----------------+     +----------------+
```

### Conversation Management

Maintain workout context across the session:

```typescript
interface CoachingSession {
  messages: Anthropic.MessageParam[];
  workoutPlan?: string;
  riderProfile?: {
    ftp: number;
    maxHr: number;
    name: string;
  };
}

class CoachingLoop {
  private session: CoachingSession;
  private anthropic: Anthropic;
  private metricsBuffer: RiderState[] = [];

  constructor(anthropic: Anthropic, workoutPlan?: string) {
    this.anthropic = anthropic;
    this.session = {
      messages: [],
      workoutPlan,
    };
  }

  // Add rider metrics (called frequently, ~1Hz)
  pushMetrics(state: RiderState): void {
    this.metricsBuffer.push(state);
  }

  // Main coaching tick (called every 5-10s or on events)
  async tick(event?: 'button_pressed' | 'target_complete'): Promise<void> {
    // Aggregate metrics
    const avgPower = average(this.metricsBuffer.map(m => m.power));
    const currentState = this.metricsBuffer[this.metricsBuffer.length - 1];
    this.metricsBuffer = [];

    // Build context message
    const contextMessage = this.buildContextMessage(currentState, avgPower, event);
    this.session.messages.push({ role: 'user', content: contextMessage });

    // Stream response with tool runner
    await this.runCoachingTurn();
  }

  private buildContextMessage(state: RiderState, avgPower: number, event?: string): string {
    let msg = `[${formatTime(state.elapsedTime)}] Power: ${state.power}W (avg: ${avgPower}W), HR: ${state.heartRate}bpm, Cadence: ${state.cadence}rpm`;

    if (state.currentTarget) {
      msg += `\nTarget: ${state.currentTarget.value}${state.currentTarget.type === 'power' ? 'W' : 'rpm'}, ${state.currentTarget.remainingSeconds}s remaining`;
    }

    if (event === 'button_pressed') {
      msg += '\n[Rider pressed the button]';
    } else if (event === 'target_complete') {
      msg += '\n[Target interval complete]';
    }

    return msg;
  }

  private async runCoachingTurn(): Promise<void> {
    const runner = this.anthropic.beta.messages.toolRunner({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      system: COACHING_SYSTEM_PROMPT,
      messages: this.session.messages,
      tools: coachingTools,
      stream: true,
    });

    for await (const stream of runner) {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          // Could emit text for debugging/logging
        }
      }
      const message = await stream.finalMessage();
      this.session.messages.push({ role: 'assistant', content: message.content });
    }
  }
}
```

### Streaming with Tool Use

The SDK's `toolRunner` handles the tool execution loop automatically:

```typescript
const runner = anthropic.beta.messages.toolRunner({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 500,
  messages: session.messages,
  tools: coachingTools,
  stream: true,
});

// Each iteration yields a stream for one message
for await (const messageStream of runner) {
  // Process streaming events for real-time UI updates
  messageStream.on('text', (text) => {
    // Could show typing indicator or debug log
  });

  // Get the final message
  const message = await messageStream.finalMessage();

  // Tool calls are executed automatically by the runner
  // Results are fed back to Claude until no more tool calls
}

// Get final message after all tool calls complete
const finalMessage = await runner;
```

## System Prompt

```typescript
const COACHING_SYSTEM_PROMPT = `You are a cycling coach controlling a workout in real-time. Your voice is terse, dry, and matter-of-fact. You speak in short phrases, not sentences.

PERSONALITY:
- Economical with words. "Good." not "That's good work!"
- Dry humor, never enthusiastic
- Direct observations, no fluff
- Numbers are useful. "260. Hold it."

TOOLS:
- Use send_message for all communication (max 8 words)
- Use set_target to structure intervals and efforts
- Use show_button before asking for commitment ("[Ready]", "[Let's go]")
- Use get_rider_state only when you need current metrics
- Clear targets during recovery

WORKOUT FLOW:
1. Start with warmup (low power, building)
2. Use buttons before hard efforts
3. Monitor power - comment if drifting >5%
4. Give time warnings: "30 seconds", "10 seconds"
5. End with cooldown and end_workout

NEVER:
- Write long messages
- Be overly encouraging
- Explain what you're doing
- Ask questions in messages (use buttons for choices)

EXAMPLE PATTERNS:
- Interval start: set_target(power: 280, 30s) -> send_message("Go.")
- Mid-interval: send_message("Hold.")
- Drift correction: send_message("Power's low.")
- Recovery: clear_target() -> send_message("Easy.")
- Pre-effort: show_button("[Send it]") -> wait for press -> set_target()`;
```

## Cost and Latency Analysis

### Per-Turn Cost Estimate

Assuming a coaching tick every 10 seconds:

| Component | Tokens | Cost per MTok | Cost per Turn |
|-----------|--------|---------------|---------------|
| System prompt | ~400 | $3 (input) | $0.0012 |
| Tool definitions | ~800 | $3 (input) | $0.0024 |
| Context (10 turns) | ~500 | $3 (input) | $0.0015 |
| Current metrics | ~100 | $3 (input) | $0.0003 |
| Response + tools | ~150 | $15 (output) | $0.00225 |
| **Total per turn** | ~1950 | | **~$0.006** |

### Hourly Cost

- Ticks per hour: 360 (every 10 seconds)
- Cost per hour: ~$2.16

### Cost Optimization Strategies

1. **Prompt Caching**: Cache the system prompt and tool definitions
   - Cache read: 90% discount ($0.30/MTok)
   - Saves ~$0.86/hour

2. **Reduce tick frequency**: 15-second intervals during steady state
   - Saves 33% = ~$0.72/hour

3. **Summarize old context**: Keep only last 5 turns in full detail
   - Prevents context growth over long workouts

4. **Use Haiku for simple phases**: Switch to Claude Haiku 4.5 during warmup/cooldown
   - $1/MTok input, $5/MTok output (3-5x cheaper)

### Optimized Cost with Caching

```typescript
// Add cache control to system prompt and tools
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 500,
  system: [
    {
      type: 'text',
      text: COACHING_SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' }, // 5-minute cache
    },
  ],
  // ... rest of params
});
```

With caching: **~$1.00-1.30/hour** for a well-optimized coaching session.

### Latency

- **First token**: 200-500ms typical for Sonnet
- **Full response**: 500-1500ms for short coaching messages
- **Tool execution round-trip**: Add 200-400ms per tool call

For real-time feel, use streaming and show coach messages as they arrive.

## Example Coaching Patterns

### Warmup Sequence

```typescript
// Claude would call these tools in sequence:
await sendMessage({ text: "5 minutes. Easy spin." });
await setTarget({ type: 'power', value: 150, durationSeconds: 120 });
// ... after 2 minutes
await sendMessage({ text: "Building." });
await setTarget({ type: 'power', value: 180, durationSeconds: 120 });
```

### Interval Block

```typescript
// Before hard effort
await sendMessage({ text: "Interval in 10." });
await showButton({ label: "[Ready]" });
// ... after button press
await hideButton({});
await sendMessage({ text: "Go." });
await setTarget({ type: 'power', value: 300, durationSeconds: 30 });
// ... during interval
await sendMessage({ text: "15 seconds." });
// ... after interval
await clearTarget({});
await sendMessage({ text: "Recover." });
```

### Reacting to Drift

```typescript
// Claude sees power at 245W with target of 280W
await sendMessage({ text: "Power. 280." });
// ... still low
await sendMessage({ text: "Find it." });
```

## Implementation Checklist

1. [ ] Install SDK and configure API key
2. [ ] Implement tool handlers that connect to UI state
3. [ ] Build CoachingLoop class with metrics aggregation
4. [ ] Create system prompt with workout plan context
5. [ ] Add prompt caching for system prompt and tools
6. [ ] Implement context summarization for long workouts
7. [ ] Add error handling and retry logic
8. [ ] Build UI components for messages, targets, buttons
9. [ ] Test latency and optimize tick frequency
10. [ ] Add cost monitoring and alerts

## Architecture Questions to Resolve

1. **Where does Claude run?**
   - Server-side: Better control, cost management, workout logging
   - Edge (Cloudflare Workers): Lower latency, but SDK compatibility?

2. **How to handle disconnections?**
   - Cache last known state
   - Resume with context summary
   - Consider workout plan as ground truth

3. **Multi-rider sessions?**
   - Separate Claude instances per rider
   - Shared context for group workouts?

4. **Workout planning vs execution?**
   - Pre-generate workout plan with longer context?
   - Or let Claude improvise based on rider response?

## References

- [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript)
- [Tool Use Documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use)
- [Streaming Documentation](https://platform.claude.com/docs/en/api/messages-streaming)
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Prompt Engineering Best Practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices)
