#!/usr/bin/env node
// At-rest stills of the Settings default-model row page and the new-thread composer.
// Usage: node stills.mjs <label> <worktree> <seed> [outDir] [variants]
// variants: comma list of <width>-<theme>, default 1440-light,1440-dark,390-light,390-dark.
// Reseeds and restarts the worktree's dev server like run-row.mjs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { gotoSettingsGeneral, openApp, webOriginFromLog } from "./lib.mjs";
import { startServer, stopServer } from "./server.mjs";
import { openNewThread } from "./new-thread.mjs";

const [label, worktree, seed, outDir = "/tmp/ev-22193", variantList] = process.argv.slice(2);
if (!label || !worktree || !seed) {
  console.error("usage: stills.mjs <label> <worktree> <seed> [outDir] [variants]");
  process.exit(2);
}
const variants = (variantList ?? "1440-light,1440-dark,390-light,390-dark").split(",").map((v) => {
  const [width, theme] = v.split("-");
  return { width: Number(width), height: Number(width) >= 1000 ? 900 : 844, theme };
});

const stillsDir = NodePath.join(outDir, "stills");
NodeFS.mkdirSync(stillsDir, { recursive: true });
const pidFile = NodePath.join(outDir, `${label}.pgid`);
const logFile = NodePath.join(outDir, `${label}-stills-${seed}-dev.log`);
await stopServer(pidFile);
NodeChildProcess.execFileSync(
  "node",
  [NodePath.join(import.meta.dirname, "seed.mjs"), worktree, seed],
  { stdio: "inherit" },
);
await startServer({ worktree, pidFile, logFile });

const { browser, context, page, origin } = await openApp({
  worktree,
  authFile: NodePath.join(outDir, `auth-${label}.json`),
  webOrigin: webOriginFromLog(logFile),
});
await openNewThread(page, origin);
const draftUrl = page.url();

for (const { width, height, theme } of variants) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme });
  const name = (surface) =>
    NodePath.join(stillsDir, `${seed}-${surface}-${width}-${theme}-${label}.png`);

  await gotoSettingsGeneral(page, origin);
  await page.mouse.move(0, height - 1);
  await NodeTimersPromises.setTimeout(800);
  await page.screenshot({ path: name("settings") });

  await page.goto(draftUrl);
  await page
    .locator('[data-composer-shortcut="composer.effort"], [data-chat-provider-model-picker="true"]')
    .first()
    .waitFor({ timeout: 90_000 });
  await NodeTimersPromises.setTimeout(3000);
  await page.mouse.move(0, height - 1);
  await page.screenshot({ path: name("composer") });
  console.log(`${seed} ${width} ${theme} ${label} done`);
}
await context.close();
await browser.close();
