/**
 * Replay mode configuration.
 * Parsed from CLI args. Separate module to avoid circular imports.
 */

const replayIdx = process.argv.indexOf("--replay");
export const replayPlanId: number | null =
  replayIdx !== -1 && process.argv[replayIdx + 1]
    ? parseInt(process.argv[replayIdx + 1], 10)
    : null;

const speedIdx = process.argv.indexOf("--speed");
export const replaySpeed: number =
  speedIdx !== -1 && process.argv[speedIdx + 1]
    ? parseFloat(process.argv[speedIdx + 1])
    : 1;
