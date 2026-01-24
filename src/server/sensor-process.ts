import { log } from "./log";
import type { Subprocess } from "bun";

let sensorProcess: Subprocess | null = null;

async function pipeOutput(name: string, stream: ReadableStream<Uint8Array>) {
  log(`[sensors] Starting ${name} pipe`);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        log(`[sensors] ${name} pipe closed`);
        break;
      }
      const text = decoder.decode(value);
      for (const line of text.split("\n")) {
        if (line.trim()) log(`[sensors] ${line}`);
      }
    }
  } catch (e) {
    log(`[sensors] ${name} pipe error: ${e}`);
  }
}

/**
 * Spawns the sensor bridge process (uv run clardio-sensors)
 */
export function spawnSensorBridge(): void {
  if (sensorProcess) {
    log("Sensor bridge already running");
    return;
  }

  log("Spawning sensor bridge...");
  sensorProcess = Bun.spawn(["uv", "run", "clardio-sensors"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  log(`Sensor bridge spawned (pid: ${sensorProcess.pid})`);

  // Forward output through server's stdout (so tee captures it)
  if (sensorProcess.stdout) pipeOutput("stdout", sensorProcess.stdout);
  if (sensorProcess.stderr) pipeOutput("stderr", sensorProcess.stderr);
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
