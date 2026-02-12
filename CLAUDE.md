# Clardio

AI cycling coach with Claude as the coach. Connects to spin bikes via Bluetooth.

## The Coach

Claude controls the screen - this is not a chat interface. The coach is:
- Terse, dry, observational
- Never disappointed, never effusive
- Example phrases: "I see you.", "15 seconds. Don't quit.", "HR still at 145. I'll wait."

## Architecture

- **Bun server** - SSE for server-to-client, HTTP POST for sensor metrics
- **Two-phase coaching** - Opus 4.6 generates a workout plan once at start, Sonnet 4.5 coaches every 10 seconds
- **Structured output** - Both models return JSON via `output_config.format` JSON schema (not tool_use)
- **SQLite database** - Plans and samples stored in `~/.clardio/clardio.db` via `bun:sqlite`
- **Bluetooth sensor bridge** - Python process connects to BLE devices and POSTs metrics to server

### Workout Flow

1. Browser connects to `/api/events` (SSE)
2. Server calls Opus 4.6 to generate a structured workout plan
3. Plan saved to SQLite
4. Sonnet 4.5 coaches every 10 seconds, receiving metrics + plan + phase context
5. Sensor samples saved to SQLite as they arrive
6. On SSE disconnect, workout stops (no special finalization -- ride data is the record)

## Models

| Model | Role | When |
|-------|------|------|
| Claude Opus 4.6 (`claude-opus-4-6`) | Workout planner | Once at workout start |
| Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`) | Real-time coach | Every 10 seconds |

Both use `@anthropic-ai/sdk` directly with single-turn `messages.create` calls. No agent SDK, no tool_use. Structured output is enforced via `output_config.format` with a JSON schema.

## Bluetooth Devices

| Device | MAC | Services |
|--------|-----|----------|
| Gymnasticon (K2Pi) | B8:27:EB:95:0B:90 | Cycling Power (0x1818), CSC (0x1816) |
| COROS PACE 3 | F7:AF:40:38:08:90 | Heart Rate (0x180D) |

## Bluetooth Troubleshooting

### Find the USB dongle's HCI index

The USB dongle can change index between reboots or resets. Check with:
```bash
hciconfig -a
```
Look for the Realtek adapter (manufacturer 93). It might be hci1, hci2, etc.

### Check if Bluetooth service is running

The Bluetooth service can die silently. If `bluetoothctl` hangs or scans return nothing:
```bash
systemctl status bluetooth
sudo systemctl start bluetooth
```

### Commands that hang when service is down

These commands will hang indefinitely if the Bluetooth service is dead. Always wrap with `timeout`:
```bash
timeout 10 bluetoothctl devices              # hangs without service
timeout 10 hcitool -i hci2 lescan            # hangs without service
timeout 10 btmgmt --index 2 find -l          # hangs without service
```

Safe commands that don't hang:
```bash
hciconfig -a                                  # always works
systemctl status bluetooth                    # always works
```

### Scan for devices

Verify the adapter can see devices (replace `2` with your HCI index):
```bash
sudo timeout 10 btmgmt --index 2 find -l
```

### Run sensor bridge

The sensor bridge uses Python + bleak (via BlueZ D-Bus API). It auto-starts the Bluetooth service if needed:
```bash
bun run sensors
# or directly:
uv run clardio-sensors
```

### Reset unresponsive dongle

If the USB dongle becomes unresponsive with timeout errors:
```bash
sudo usbreset "2357:0604"
```

## Tech Stack

- Bun (runtime + bundler + SQLite via `bun:sqlite`)
- TypeScript
- Tailwind CSS (via CDN)
- `@anthropic-ai/sdk` for Claude API (direct single-turn calls)
- No React - plain HTML + TS
- Python + bleak (Bluetooth sensor bridge)

## Project Structure

```
src/server/index.ts        # Bun HTTP server, static files, route dispatch
src/server/sse.ts          # SSE connection handling, workout lifecycle triggers
src/server/routes.ts       # POST /api/metrics handler (sensor data ingestion)
src/server/workout.ts      # Workout session manager (plan -> coach loop)
src/server/coach.ts        # Anthropic SDK calls (planWorkout, sendCoachMessage)
src/server/coach-prompt.ts # All prompts, schemas, rider profile, zone calculations
src/server/db.ts           # SQLite database (plans + samples tables)
src/server/sensor-process.ts # Spawns/kills Python sensor bridge subprocess
src/server/replay.ts       # Replay mode: plays back recorded sessions
src/server/replay-config.ts # Replay CLI flag parsing (--replay, --speed)
src/server/log.ts          # Server logging
src/client/main.ts         # Browser entry point
src/client/sse-client.ts   # SSE event handling
src/client/handlers.ts     # Event handlers for metrics, coach, target updates
src/client/ui.ts           # DOM manipulation
src/client/progress.ts     # Workout progress display
src/shared/types.ts        # Shared TypeScript types (SSE events)
src/scripts/sim.ts         # Sensor simulator (interactive, sends every 3s)
src/clardio_sensors/       # Python Bluetooth sensor bridge (bleak)
public/                    # Static files (HTML, built JS)
scripts/                   # Development/debugging scripts
tests/                     # Bun tests
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/events` | GET | SSE stream (connects triggers workout start, disconnect triggers stop) |
| `/api/metrics` | POST | Sensor data from Bluetooth bridge or simulator (`{ power?, hr?, cadence? }`) |

## Database

SQLite at `~/.clardio/clardio.db`. Created automatically on first run. Uses WAL mode.

### Schema

**plans** - One row per workout session:
```sql
id              INTEGER PRIMARY KEY AUTOINCREMENT
created_at      TEXT NOT NULL DEFAULT (datetime('now'))
phases          TEXT NOT NULL        -- JSON array of phase objects
completed       INTEGER NOT NULL DEFAULT 0  -- legacy column, not used
summary         TEXT                        -- legacy column, not used
```

**samples** - Sensor readings during a workout:
```sql
id              INTEGER PRIMARY KEY AUTOINCREMENT
plan_id         INTEGER NOT NULL REFERENCES plans(id)
timestamp_ms    INTEGER NOT NULL
duration_ms     INTEGER NOT NULL     -- Time since previous sample
power           REAL
hr              REAL
cadence         REAL
```

Rider profile (power capabilities, aerobic fitness, training zones, FTP estimate) is synthesized from historical samples at workout start. No separate rider config file.

## Prompts

Each model gets a **static system prompt** (cacheable) and a **dynamic user message** (changes per call).

### Planning (Opus 4.6)

- **System prompt** (`buildPlanningSystemPrompt()`): Workout structure rules, interval formats, cadence ranges, form cues, position variety guidelines. Never changes.
- **User prompt** (`buildPlanningUserPrompt()`): Rider profile from DB history, training zones (FTP/HR), previous plan summaries. Changes every session.
- **Output schema** (`planSchema`): `{ summary, phases: [{ name, duration_minutes, zone, cadence, position, cues, notes }] }`

### Coaching (Sonnet 4.5)

- **System prompt** (`buildCoachingSystemPrompt()`): Coach persona/voice, coaching rules (HR primary signal, terse messages, phase transition behavior). Never changes.
- **User message** (built per tick in `workout.ts`): Current plan overview, zones, current phase with elapsed/remaining time, phase transition markers, form cues, recent coach messages, 30s metrics summary, HR trend, status line.
- **Output schema** (`coachSchema`): `{ message, power, cadence }`

### Previewing Prompts

```bash
bun scripts/dump-prompt.ts              # Show both planning and coaching prompts
bun scripts/dump-prompt.ts planning     # Planning only
bun scripts/dump-prompt.ts coaching     # Coaching only (includes sample user message)
```

## Development

```bash
bun install              # Install dependencies
bun test                 # Run tests
bun run build            # Build client bundle
bun run dev              # Start server with hot reload (starts sensor bridge)
bun run dev:sim          # Start server without sensor bridge (use simulator)
bun run start            # Start server (production)
bun run sim              # Run sensor simulator (interactive, auto-sends every 3s)
bun run sensors          # Run sensor bridge standalone
```

### Utility Scripts

```bash
bun scripts/dump-prompt.ts              # Preview planning + coaching prompts and schemas
bun scripts/test-plan.ts                # Call Opus to generate a plan (requires ANTHROPIC_API_KEY)
bun scripts/test-db.ts                  # Test SQLite CRUD operations
```

## Testing the Client UI

Use the screenshot script with Playwright to visually verify UI states:

```bash
# Take screenshot (waits for real coach response)
bun scripts/screenshot.ts /tmp/test.png

# Test mode with URL params (instant, no coach API needed)
bun scripts/screenshot.ts /tmp/test.png "power=120&cadence=85&target_power=100&target_cadence=75&message=Push+harder"

# Test state transitions (power2/cadence2 apply after first update)
bun scripts/screenshot.ts /tmp/test.png "power=80&cadence=60&power2=103&cadence2=78&target_power=100&target_cadence=75"
```

URL params for test mode:
- `power`, `cadence`, `hr` - Current metric values
- `target_power`, `target_cadence` - Target values
- `message` - Coach message text
- `power2`, `cadence2` - Second update for testing transitions

The test mode bypasses SSE entirely - the client reads URL params on load and renders immediately.

## Replay Mode

Replay a recorded session's sensor data with fresh coaching. Useful for testing prompt changes against historical rides without needing the bike.

```bash
bun run dev --replay 4        # replay plan 4 at 1x speed
bun run dev --replay 4 --speed 2  # replay at 2x (halves all timing)
bun run dev --replay 4 --speed 10 # fast-forward at 10x
```

How it works:
- Loads the plan and sensor samples from the **production** DB (`~/.clardio/clardio.db`)
- Reuses the original plan (phases, zones, timing) from that session
- Feeds sensor data through the normal pipeline at original timing intervals, divided by speed factor
- Coaching runs fresh with current prompts (real API calls to Claude every 10s / speed)
- New coaching data is saved to the **dev** DB (`~/.clardio/clardio-dev.db`)
- Sensor bridge is not started (data comes from the replay)
- Open the browser to `http://localhost:3000` to see the UI update in real time
