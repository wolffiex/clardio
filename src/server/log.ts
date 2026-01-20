/**
 * Simple logger helper - formats timestamps like [HH:MM:SS]
 */
export function log(message: string): void {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${time}] ${message}`);
}
