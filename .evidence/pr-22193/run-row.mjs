#!/usr/bin/env node
// Records one matrix row against one build.
// Usage: node run-row.mjs <row> <label> <worktree> [outDir]
// Stops the worktree's dev server (only the group this script family started), seeds
// settings.json, starts `vp run dev`, records the scripted steps, and logs the persisted
// defaultModelSelection before and after. The server is left running for stills; stop it with stop.mjs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { caption, gotoSettingsGeneral, modelRow, openApp, webOriginFromLog } from "./lib.mjs";
import { startServer, stopServer } from "./server.mjs";
import { openNewThread } from "./new-thread.mjs";

const [row, label, worktree, outDir = "/tmp/ev-22193"] = process.argv.slice(2);
const ROWS = {
  R1a: { seed: "S-off", run: settingsEffort("Low") },
  R1b: { seed: "S-unavail", run: settingsEffort("Low") },
  R1c: { seed: "S-absent", run: settingsEffort("Low") },
  R1d: { seed: "S-base", run: settingsEffort("Low") },
  R1e: { seed: "S-base", run: composerEffort },
  R1f: { seed: "S-hidden", run: settingsEffort("Low") },
  R2a: { seed: "S-opus45-xhigh", run: unsupportedEffort },
  R2b: { seed: "S-opus45-xhigh-off", run: settingsEffort("Max") },
  R3a: { seed: "S-haiku45", run: noEffortModel },
};
const spec = ROWS[row];
if (!spec || !label || !worktree) {
  console.error(`usage: run-row.mjs <${Object.keys(ROWS).join("|")}> <label> <worktree> [outDir]`);
  process.exit(2);
}

NodeFS.mkdirSync(outDir, { recursive: true });
const settingsFile = NodePath.join(worktree, ".t3/userdata/settings.json");
const pidFile = NodePath.join(outDir, `${label}.pgid`);
const logFile = NodePath.join(outDir, `${label}-${row}-dev.log`);
const persistedLog = NodePath.join(outDir, "persisted.log");
const base = `${row}-${label}`;

function persisted() {
  try {
    return NodeChildProcess.execFileSync("jq", ["-c", ".defaultModelSelection", settingsFile], {
      encoding: "utf8",
    }).trim();
  } catch {
    return JSON.stringify(
      JSON.parse(NodeFS.readFileSync(settingsFile, "utf8")).defaultModelSelection ?? null,
    );
  }
}
function logPersisted(phase) {
  const line = `${new Date().toISOString()} ${label} ${row} ${phase} ${persisted()}`;
  NodeFS.appendFileSync(persistedLog, `${line}\n`);
  console.log(line);
}

await stopServer(pidFile);
NodeChildProcess.execFileSync(
  "node",
  [NodePath.join(import.meta.dirname, "seed.mjs"), worktree, spec.seed],
  {
    stdio: "inherit",
  },
);
logPersisted(`seeded:${spec.seed}`);
await startServer({ worktree, pidFile, logFile });
logPersisted("server-started");

const videoDir = NodePath.join(outDir, `video-${base}`);
const app = await openApp({
  worktree,
  authFile: NodePath.join(outDir, `auth-${label}.json`),
  webOrigin: webOriginFromLog(logFile),
  videoDir,
});
const t0 = Date.now();
const steps = [];
const say = async (text, hold = 1800) => {
  const s = Math.round((Date.now() - t0) / 1000);
  steps.push(
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")} ${text}`,
  );
  await caption(app.page, `[${label}] ${row}: ${text}`).catch(() => {});
  await NodeTimersPromises.setTimeout(hold);
};
const ctx = {
  ...app,
  say,
  persisted,
  logPersisted,
  shot: (n) => app.page.screenshot({ path: NodePath.join(outDir, `${base}-${n}.png`) }),
};

try {
  await spec.run(ctx);
} catch (error) {
  await say(`DRIVER ERROR: ${error.message.split("\n")[0]}`, 1500);
  console.error(error);
  process.exitCode = 1;
} finally {
  logPersisted("final");
  const video = app.page.video();
  await app.context.close();
  await app.browser.close();
  const webm = await video.path();
  NodeChildProcess.execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    webm,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    NodePath.join(outDir, `${base}.mp4`),
  ]);
  NodeFS.writeFileSync(NodePath.join(outDir, `${base}.steps.txt`), `${steps.join("\n")}\n`);
  console.log(steps.join("\n"));
}

function traitsTrigger(page) {
  // Every row button that is not the model picker, the source badge, or the reset button.
  return modelRow(page).locator(
    'button:not([data-chat-provider-model-picker]):not([aria-label^="Set on"]):not([aria-label^="Reset"])',
  );
}

async function showRow({ page, origin, say, persisted }, intro) {
  await page.goto(origin);
  await say(intro, 1200);
  await gotoSettingsGeneral(page, origin);
  await say(
    `Settings > General > New threads > Model. Row: "${(await modelRow(page).innerText()).split("\n").filter(Boolean).slice(2).join(" · ")}"`,
    2500,
  );
  await say(`settings.json defaultModelSelection = ${persisted()}`, 2500);
}

async function reloadAndShow({ page, say, persisted }) {
  await say("Reload the page");
  await page.reload();
  await page.locator("#default-model").first().waitFor({ timeout: 60_000 });
  await page
    .waitForFunction(
      () =>
        !document.querySelector("#default-model")?.textContent?.includes("No providers available"),
      null,
      { timeout: 30_000 },
    )
    .catch(() => {});
  await NodeTimersPromises.setTimeout(2000);
  await say(
    `After reload. Row: "${(await modelRow(page).innerText()).split("\n").filter(Boolean).slice(2).join(" · ")}"`,
    2500,
  );
  await say(`jq .defaultModelSelection settings.json -> ${persisted()}`, 3500);
}

function settingsEffort(target) {
  return async (ctx) => {
    const { page, say, shot } = ctx;
    await showRow(ctx, `Seed ${spec.seed}`);
    await shot("row");
    const trigger = traitsTrigger(page);
    if ((await trigger.count()) === 0) {
      await say("No effort picker on the row, so effort cannot be changed here", 2500);
    } else {
      await say(
        `Open the effort picker (currently "${(await trigger.first().innerText()).trim()}")`,
        600,
      );
      await trigger.first().click();
      await NodeTimersPromises.setTimeout(1200);
      await shot("menu");
      await say(`Choose ${target}`, 600);
      await page.getByRole("menuitemradio", { name: target, exact: true }).click();
      await NodeTimersPromises.setTimeout(1500);
      await say(`Picked ${target}. settings.json now ${ctx.persisted()}`, 2500);
    }
    await reloadAndShow(ctx);
    await shot("after-reload");
  };
}

async function composerEffort(ctx) {
  const { page, origin, say, shot } = ctx;
  await openNewThread(page, origin);
  await say(`New thread screen. settings.json defaultModelSelection = ${ctx.persisted()}`, 2500);
  const effort = page.locator('[data-composer-shortcut="composer.effort"]').first();
  await say(
    `Open the composer effort menu (currently "${(await effort.innerText()).trim()}")`,
    600,
  );
  await effort.click();
  await NodeTimersPromises.setTimeout(1200);
  await shot("composer-menu");
  await say("Choose Low", 600);
  await page.getByRole("menuitemradio", { name: "Low", exact: true }).click();
  await NodeTimersPromises.setTimeout(1500);
  await say(
    `Composer effort now "${(await effort.innerText()).trim()}". settings.json = ${ctx.persisted()}`,
    2500,
  );
  await say("Reload the page");
  await page.reload();
  await page
    .locator('[data-composer-shortcut="composer.effort"]')
    .first()
    .waitFor({ timeout: 90_000 });
  await NodeTimersPromises.setTimeout(2500);
  await say(
    `After reload composer effort "${(await page.locator('[data-composer-shortcut="composer.effort"]').first().innerText()).trim()}"`,
    2000,
  );
  await gotoSettingsGeneral(page, origin);
  await say(
    `Settings row: "${(await modelRow(page).innerText()).split("\n").filter(Boolean).slice(2).join(" · ")}"`,
    2500,
  );
  await say(`jq .defaultModelSelection settings.json -> ${ctx.persisted()}`, 3500);
  await shot("after-reload");
}

async function unsupportedEffort(ctx) {
  const { page, say, shot } = ctx;
  await showRow(ctx, `Seed ${spec.seed} (opus-4-5 saved with xhigh, which it does not offer)`);
  await shot("row");
  const trigger = traitsTrigger(page).first();
  await say(
    `Open the effort picker without choosing (label "${(await trigger.innerText()).trim()}")`,
    600,
  );
  await trigger.click();
  await NodeTimersPromises.setTimeout(1200);
  await shot("menu");
  await say("Close it with Escape (no choice made)", 600);
  await page.keyboard.press("Escape");
  await NodeTimersPromises.setTimeout(1000);
  await say(`settings.json = ${ctx.persisted()}`, 2500);
  await reloadAndShow(ctx);
  await say("Now choose Max", 600);
  await traitsTrigger(page).first().click();
  await NodeTimersPromises.setTimeout(1000);
  await page.getByRole("menuitemradio", { name: "Max", exact: true }).click();
  await NodeTimersPromises.setTimeout(1500);
  await reloadAndShow(ctx);
  await shot("after-reload");
}

async function pickModel(page, say, query, optionName) {
  await modelRow(page).locator('[data-chat-provider-model-picker="true"]').click();
  await NodeTimersPromises.setTimeout(1000);
  const claudeTab = page
    .locator("[data-model-picker-content]")
    .getByRole("toolbar")
    .getByRole("button", { name: /claude/i });
  if (await claudeTab.count()) await claudeTab.first().click();
  await page.locator("[data-model-picker-content]").getByRole("combobox").fill(query);
  await NodeTimersPromises.setTimeout(1000);
  await say(`Model picker: search "${query}"`, 1200);
  await page
    .locator("[data-model-picker-content]")
    .getByRole("option", { name: optionName })
    .first()
    .click();
  await NodeTimersPromises.setTimeout(1500);
}

async function noEffortModel(ctx) {
  const { page, say, shot } = ctx;
  await showRow(ctx, `Seed ${spec.seed} (Haiku 4.5 has no effort control)`);
  await shot("row");
  await say(`Effort controls on the row: ${await traitsTrigger(page).count()}`, 2000);
  await pickModel(page, say, "Opus 4.8", /Opus 4\.8/);
  await say(`Picked Opus 4.8. settings.json = ${ctx.persisted()}`, 2500);
  await pickModel(page, say, "Haiku 4.5", /Haiku 4\.5/);
  await say(`Picked Haiku 4.5 again. settings.json = ${ctx.persisted()}`, 2500);
  await reloadAndShow(ctx);
  await shot("after-reload");
}
