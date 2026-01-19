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
- **Bluetooth sensor bridge** - Connects to BLE devices and POSTs metrics to server

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

The sensor bridge auto-detects the Realtek USB dongle and starts the Bluetooth service if needed:
```bash
sudo bun run sensors
```

To override auto-detection:
```bash
sudo NOBLE_HCI_DEVICE_ID=2 bun run sensors
```

### Reset unresponsive dongle

If the USB dongle becomes unresponsive with timeout errors:
```bash
sudo usbreset "2357:0604"
```

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
