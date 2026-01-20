/**
 * Take a screenshot of the Clardio UI
 *
 * Usage: bun scripts/screenshot.ts [output.png] [url_params]
 *
 * Examples:
 *   bun scripts/screenshot.ts
 *   bun scripts/screenshot.ts /tmp/test.png
 *   bun scripts/screenshot.ts /tmp/test.png "power=120&cadence=85&target_power=100&target_cadence=75&message=Push+harder"
 *
 * URL params (test mode):
 *   power, cadence, hr - Metric values
 *   target_power, target_cadence - Target values
 *   message - Coach message
 */

import { chromium } from "playwright";

const outputPath = process.argv[2] || "/tmp/clardio-screenshot.png";
const urlParams = process.argv[3] || "";
const baseUrl = process.env.URL || "http://localhost:3000";
const url = urlParams ? `${baseUrl}?${urlParams}` : baseUrl;

async function takeScreenshot() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });

  page.on("console", (msg) => console.log(`[Browser] ${msg.text()}`));

  await page.goto(url);

  // In test mode, UI is ready immediately. Otherwise wait for coach.
  const waitTime = urlParams ? 500 : 10000;
  await page.waitForTimeout(waitTime);

  await page.screenshot({ path: outputPath, fullPage: true });
  console.log(`Screenshot saved to ${outputPath}`);

  await browser.close();
}

takeScreenshot().catch((err) => {
  console.error("Screenshot failed:", err.message);
  process.exit(1);
});
