#!/usr/bin/env bun
/**
 * Sensor simulator - sends fake metrics to the local server
 * Tab or empty input keeps the current value
 */

import * as readline from "readline";

const SERVER = "http://localhost:3000";

let hr = 120;
let cadence = 80;
let power = 150;
let elapsed = 0;
let startTime = Date.now();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function sendMetrics() {
  elapsed = Math.floor((Date.now() - startTime) / 1000);
  const payload = { hr, cadence, power, elapsed };

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

async function loop() {
  console.log("\nSensor Simulator (empty/tab = keep value, q = quit)\n");

  while (true) {
    console.log(`\n--- elapsed: ${Math.floor((Date.now() - startTime) / 1000)}s ---`);

    const hrInput = await prompt(`HR [${hr}]: `);
    if (hrInput.toLowerCase() === "q") break;
    if (hrInput.trim()) hr = parseInt(hrInput, 10) || hr;

    const cadenceInput = await prompt(`RPM [${cadence}]: `);
    if (cadenceInput.toLowerCase() === "q") break;
    if (cadenceInput.trim()) cadence = parseInt(cadenceInput, 10) || cadence;

    const powerInput = await prompt(`W [${power}]: `);
    if (powerInput.toLowerCase() === "q") break;
    if (powerInput.trim()) power = parseInt(powerInput, 10) || power;

    await sendMetrics();
  }

  rl.close();
  console.log("\nDone.");
}

loop();
