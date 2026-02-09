#!/usr/bin/env bun
/**
 * Sensor simulator - sends fake metrics to the local server
 * Auto-sends every second. Type to update values between sends.
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
    const res = await fetch(`${SERVER}/api/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      console.log(`→ ${JSON.stringify(payload)}`);
    } else {
      console.log(`⚠ ${res.status}: ${JSON.stringify(payload)}`);
    }
  } catch (e) {
    console.log(`⚠ Connection failed`);
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
    console.log(`  set ${named[1]}=${val}`);
    return true;
  }

  // Three numbers: "130 90 200" (hr cadence power)
  const triple = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)$/);
  if (triple) {
    hr = parseInt(triple[1], 10);
    cadence = parseInt(triple[2], 10);
    power = parseInt(triple[3], 10);
    console.log(`  set hr=${hr} rpm=${cadence} w=${power}`);
    return true;
  }

  console.log(`  unknown input: ${trimmed}`);
  return true;
}

function showPrompt() {
  rl.prompt();
}

console.log("\nSensor Simulator (auto-sends every 1s)");
console.log("Commands: hr <N> | rpm <N> | w <N> | <hr> <rpm> <w> | q\n");

rl.setPrompt(`[hr:${hr} rpm:${cadence} w:${power}] > `);
showPrompt();

// Auto-send on a 1-second interval
const interval = setInterval(() => {
  sendMetrics();
  rl.setPrompt(`[hr:${hr} rpm:${cadence} w:${power}] > `);
}, 1000);

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
