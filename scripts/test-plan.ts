import { buildPlanningPrompt } from "../src/server/coach-prompt";
import { planWorkout } from "../src/server/coach";
import { getRecentPlans } from "../src/server/db";

async function main() {
  console.log("Building planning prompt...\n");

  const recentPlans = getRecentPlans(5);
  const previousPlansText =
    recentPlans.length === 0
      ? "No previous plans."
      : recentPlans
          .map((p) => {
            const phases = JSON.parse(p.phases);
            return `${p.created_at}: ${phases.map((ph: any) => ph.name).join(", ")}`;
          })
          .join("\n");

  const prompt = await buildPlanningPrompt(previousPlansText);

  console.log("Calling Opus 4.6 to generate workout plan...\n");
  const plan = await planWorkout(prompt, "Design today's workout.");

  console.log(`Summary: ${plan.summary}\n`);
  console.log("Phases:");
  console.log("\u2500".repeat(80));

  let totalMinutes = 0;
  for (const phase of plan.phases) {
    console.log(`  ${phase.name}`);
    console.log(
      `    Duration: ${phase.duration_minutes} min | Zone: ${phase.zone} | Position: ${phase.position}`
    );
    console.log(`    Cadence: ${phase.cadence[0]}-${phase.cadence[1]} RPM`);
    if (phase.cues.length > 0) {
      console.log(`    Cues: ${phase.cues.join(", ")}`);
    }
    console.log(`    Notes: ${phase.notes}`);
    console.log();
    totalMinutes += phase.duration_minutes;
  }

  console.log("\u2500".repeat(80));
  console.log(`Total: ${totalMinutes} minutes, ${plan.phases.length} phases`);
}

main().catch(console.error);
