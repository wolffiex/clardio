# Last Workout Feedback (Session 2)

## What Worked
- Persona was great - terse, wry voice landed well during the ride
- Rider profile synthesis gave the coach useful context
- Dynamic zones and estimated FTP meant targets were reasonable

## What Didn't Work

### No Form Cues
The coach never gave form cues despite having detailed guidance in the prompt. The problem isn't the content - it's structural. The coach has no natural moment to deliver form cues because it's just reacting to metrics every 20 seconds with `{message, target}`.

### Latency
Latency grew as the conversation got longer. By the end of the session, responses were noticeably slow. The Claude SDK sends the full conversation each time.

### Power Data
Power was stuck at 10W initially - the Gymnasticon wasn't being discovered because we were matching by hardcoded MAC address. Fixed by switching to service UUID matching.

## Architecture Changes Needed

### Move from SDK to Anthropic API with Tools
The current approach uses the Claude SDK with structured output (`{message, target}`). This has problems:
- Full conversation sent every turn → growing latency
- `message` and `target` coupled together → coach can't speak without re-sending targets
- No way to set durations or timers

### Segment-Based Coaching
The coach should think in terms of mini workout segments, not continuous target-setting. This gives it natural moments for different types of communication.

**Proposed tools:**
1. `send_message` - Coach speaks to rider (decoupled from targets)
2. `set_segment` - Set power/cadence target + duration + optional label (e.g., "30s hard", "60s recovery")
3. `end_workout` - Wrap up with summary and stats

### Why Segments Matter
- Coach can plan: "Warmup 5min → 3x(30s hard / 60s easy) → Cooldown"
- Form cues naturally happen during easy/recovery segments
- Duration awareness means the coach knows WHEN things will change
- UI can show countdowns and progress
- Claude is natively good at tracking time - let it manage workout structure

### Context Management
With the raw API, we can:
- Summarize older exchanges instead of sending full history
- Keep only recent metrics + workout state
- Control exactly what context the coach sees each turn
