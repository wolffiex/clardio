#!/usr/bin/env bun
/**
 * Sensor simulator - sends fake metrics to the local server
 * Auto-sends every 3 seconds, silently. Type to update values.
 *
 * Input formats:
 *   hr 130       - set heart rate
 *   rpm 90       - set cadence
 *   w 200        - set power
 *   130 90 200   - set all three (hr cadence power)
 *   q            - quit
 *   (empty)      - do nothing, auto-send continues
 */

import * as readline from "readline";

const SERVER = "http://localhost:3000";

let hr = 120;
let cadence = 80;
let power = 150;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function sendMetrics() {
  const payload = { hr, cadence, power };

  try {
    await fetch(`${SERVER}/api/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // silent
  }
}

function parseInput(line: string): boolean {
  const trimmed = line.trim().toLowerCase();
  if (trimmed === "q") return false;
  if (!trimmed) return true;

  // Named value: "hr 130", "rpm 90", "w 200"
  const named = trimmed.match(/^(hr|rpm|w)\s+(\d+)$/);
  if (named) {
    const val = parseInt(named[2], 10);
    switch (named[1]) {
      case "hr": hr = val; break;
      case "rpm": cadence = val; break;
      case "w": power = val; break;
    }
    console.log(`${named[1]}=${val}`);
    return true;
  }

  // Three numbers: "130 90 200" (hr cadence power)
  const triple = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)$/);
  if (triple) {
    hr = parseInt(triple[1], 10);
    cadence = parseInt(triple[2], 10);
    power = parseInt(triple[3], 10);
    console.log(`hr=${hr} rpm=${cadence} w=${power}`);
    return true;
  }

  console.log(`unknown: ${trimmed}`);
  return true;
}

function showPrompt() {
  rl.prompt();
}

console.log("\nSensor Simulator (auto-sends every 3s)");
console.log("Commands: hr <N> | rpm <N> | w <N> | <hr> <rpm> <w> | q\n");

rl.setPrompt(`[hr:${hr} rpm:${cadence} w:${power}] > `);
showPrompt();

// Auto-send on a 3-second interval, silently
const interval = setInterval(() => {
  sendMetrics();
}, 3000);

rl.on("line", (line: string) => {
  const continueRunning = parseInput(line);
  if (!continueRunning) {
    clearInterval(interval);
    rl.close();
    console.log("\nDone.");
    return;
  }
  rl.setPrompt(`[hr:${hr} rpm:${cadence} w:${power}] > `);
  showPrompt();
});

rl.on("close", () => {
  clearInterval(interval);
});
