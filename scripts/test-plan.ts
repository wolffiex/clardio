import {
  buildPlanningSystemPrompt,
  buildPlanningUserPrompt,
  isRecoveryPhase,
  type Phase,
} from "../src/server/coach-prompt";
import { planWorkout } from "../src/server/coach";
import { getRecentPlans } from "../src/server/db";

function formatDuration(seconds: number): string {
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (sec === 0) return `${min}:00`;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

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

  const systemPrompt = buildPlanningSystemPrompt();
  const userPrompt = buildPlanningUserPrompt(previousPlansText);

  console.log("Calling Opus 4.6 to generate workout plan...\n");
  const plan = await planWorkout(systemPrompt, userPrompt);

  console.log(`Summary: ${plan.summary}\n`);
  console.log("Phases:");
  console.log("\u2500".repeat(80));

  let totalDurationS = 0;
  for (const phase of plan.phases) {
    if (isRecoveryPhase(phase)) {
      const formStr =
        phase.cadence
          ? ` [form: ${phase.cadence}rpm]`
          : "";
      console.log(
        `  Recovery (${phase.position}, ${phase.cadence}rpm, HR < ${phase.target_hr}, max ${formatDuration(phase.max_duration_s)})${formStr}`
      );
      console.log();
      totalDurationS += phase.max_duration_s;
    } else {
      const cuesStr =
        phase.form_cues && phase.form_cues.length > 0
          ? ` [form: ${phase.form_cues.join(", ")}]`
          : "";
      console.log(
        `  ${phase.name} (${phase.zone}, ${phase.position}, ${phase.cadence}rpm, ${formatDuration(phase.duration_s)})${cuesStr}`
      );
      console.log();
      totalDurationS += phase.duration_s;
    }
  }

  console.log("\u2500".repeat(80));
  const totalMin = Math.floor(totalDurationS / 60);
  const totalSec = totalDurationS % 60;
  const totalStr = totalSec === 0 ? `${totalMin}:00` : `${totalMin}:${totalSec.toString().padStart(2, "0")}`;
  console.log(`Total: ${totalStr} (${plan.phases.length} phases)`);
}

main().catch(console.error);
