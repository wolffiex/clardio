#!/bin/bash
# Clardio Bluetooth Simulator
# Pushes fake sensor data to /api/metrics at 1Hz
# Usage: ./scripts/simulate.sh [duration_seconds]

set -e

SERVER=${SERVER:-http://localhost:3000}
DURATION=${1:-120}  # Default 2 minutes

echo "Clardio Simulator - Pushing fake sensor data for ${DURATION}s"
echo "Server: ${SERVER}"
echo "Press Ctrl+C to stop"
echo ""

elapsed=0
base_power=130
base_hr=120
base_cadence=85

while [ $elapsed -lt $DURATION ]; do
  # Add some variation
  power=$((base_power + RANDOM % 40 - 20))
  hr=$((base_hr + elapsed / 10 + RANDOM % 10 - 5))  # HR drifts up over time
  cadence=$((base_cadence + RANDOM % 10 - 5))

  # Clamp values
  [ $power -lt 0 ] && power=0
  [ $hr -lt 60 ] && hr=60
  [ $cadence -lt 0 ] && cadence=0

  curl -s -X POST "${SERVER}/api/metrics" \
    -H "Content-Type: application/json" \
    -d "{\"power\":${power},\"hr\":${hr},\"cadence\":${cadence},\"elapsed\":${elapsed}}" > /dev/null

  printf "\r[%3ds] Power: %3dW | HR: %3dbpm | Cadence: %2drpm" "$elapsed" "$power" "$hr" "$cadence"

  sleep 1
  elapsed=$((elapsed + 1))
done

echo ""
echo "Simulation complete!"
