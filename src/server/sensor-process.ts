import { log } from "./log";
import type { Subprocess } from "bun";

let sensorProcess: Subprocess | null = null;

/**
 * Spawns the sensor bridge process (uv run clardio-sensors)
 */
export function spawnSensorBridge(): void {
  if (sensorProcess) {
    log("Sensor bridge already running");
    return;
  }

  log("Spawning sensor bridge");
  sensorProcess = Bun.spawn(["uv", "run", "clardio-sensors"], {
    stdout: "inherit",
    stderr: "inherit",
  });
}

/**
 * Kills the sensor bridge process gracefully (SIGTERM)
 */
export function killSensorBridge(): void {
  if (!sensorProcess) {
    return;
  }

  log("Killing sensor bridge");
  sensorProcess.kill("SIGTERM");
  sensorProcess = null;
}
