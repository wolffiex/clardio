import { getDb, savePlan, getRecentPlans, saveSample, getSamplesForPlan, closeDb } from "../src/server/db";

console.log("Testing SQLite database...\n");

// Test plan creation
const phases = JSON.stringify([
  { name: "Warmup", duration_minutes: 10, zone: "Z1-Z2", cadence: [75, 90], position: "seated", cues: ["smooth pedal stroke"], notes: "Progressive build" },
  { name: "Interval 1", duration_minutes: 6, zone: "Z4", cadence: [85, 95], position: "seated", cues: ["drop heels"], notes: "Threshold" },
  { name: "Recovery 1", duration_minutes: 3, zone: "Z1", cadence: [85, 95], position: "seated", cues: ["relax grip"], notes: "Easy spin" },
  { name: "Cool-down", duration_minutes: 5, zone: "Z1", cadence: [75, 90], position: "seated", cues: [], notes: "Wind down" },
]);

const planId = savePlan(phases);
console.log(`Created plan ${planId}`);

// Test sample storage
const now = Date.now();
saveSample(planId, now, 4000, 150, 130, 85);
saveSample(planId, now + 4000, 4000, 155, 132, 86);
saveSample(planId, now + 8000, 4000, 148, 135, 84);
console.log("Saved 3 samples");

// Test retrieval
const plans = getRecentPlans(5);
console.log(`\nRecent plans (${plans.length}):`);
for (const p of plans) {
  const ph = JSON.parse(p.phases);
  console.log(`  Plan ${p.id}: ${ph.length} phases, created ${p.created_at}`);
}

const samples = getSamplesForPlan(planId);
console.log(`\nSamples for plan ${planId} (${samples.length}):`);
for (const s of samples) {
  console.log(`  ${s.timestamp_ms}: ${s.power}W ${s.hr}bpm ${s.cadence}rpm (${s.duration_ms}ms)`);
}

closeDb();
console.log("\nAll tests passed!");
