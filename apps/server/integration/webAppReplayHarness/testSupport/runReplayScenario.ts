import fs from "node:fs";

import { chromium } from "playwright";

import { createWebAppReplayHarness } from "../createWebAppReplayHarness.ts";
import { ReplayAppPage } from "./replayAppPage.ts";

export const chromiumInstalled = fs.existsSync(chromium.executablePath());
export const shouldRunReplayE2E = process.env.T3CODE_E2E === "1";

export async function runReplayScenario(
  testFileUrl: string,
  fixtureName: string,
  run: (app: ReplayAppPage) => Promise<void>,
): Promise<void> {
  const harness = await createWebAppReplayHarness(testFileUrl, { fixtureName });
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await harness.openPage(browser, {
    viewport: { width: 1440, height: 1024 },
  });
  const app = new ReplayAppPage(page);

  try {
    await app.goto(harness.appUrl);
    await run(app);
  } finally {
    await context.close();
    await browser.close();
    await harness.dispose();
  }
}
