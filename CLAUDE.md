# Clardio

AI cycling coach with Claude as the coach. Connects to spin bikes via Bluetooth.

## The Coach

Claude controls the screen - this is not a chat interface. The coach is:
- Terse, dry, observational
- Never disappointed, never effusive
- Example phrases: "I see you.", "15 seconds. Don't quit.", "HR still at 145. I'll wait."

## Architecture

- **Bun server** - SSE for server-to-client, HTTP POST for client-to-server and tools
- **Coach process** - Separate from UI server (multiprocess, HTTP interface)
- **Bluetooth** - Bike data via Gymnasticon/K2Pi, HR via COROS watch (not yet implemented)

## Tech Stack

- Bun (runtime + bundler)
- TypeScript
- Tailwind CSS (via CDN)
- Anthropic SDK for Claude API
- No React - plain HTML + TS

## Project Structure

```
src/server/    # Bun server (SSE, routes)
src/client/    # Browser client (SSE handling, UI)
src/shared/    # Shared types
public/        # Static files (HTML, built JS)
docs/          # Planning documents
tests/         # Bun tests
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/events` | GET | SSE stream |
| `/api/action` | POST | Button presses from client |
| `/api/coach` | POST | Tool: send_message |
| `/api/target` | POST | Tool: set_target |
| `/api/end` | POST | Tool: end_workout |

## Claude's Tools

Three tools total:

1. **send_message** - `{ text, button? }` - Coach speaks to rider
2. **set_target** - `{ power?, cadence?, duration } | null` - Set or clear target
3. **end_workout** - `{ summary, stats }` - End the session

## Development

```bash
bun install        # Install dependencies
bun test           # Run tests
bun run build      # Build client bundle
bun run dev        # Start server with hot reload
bun run start      # Start server
```
