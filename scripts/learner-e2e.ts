#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side browser automation.
/**
 * Scripted learner: a throwaway OminaX server on the free Replay provider, driven through the
 * built web app the way a learner would: New lesson, a plain Send during a reply, and a queued
 * send during a reply. It checks that the basic flow works. It does not reproduce Claude's
 * in-place steering or the CW2 refusal; SteeringCompletion.integration.test.ts pins those.
 *
 *   vp run learner-e2e [--skip-build] [--out <dir>]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { chromium, type Page } from "playwright-core";

import {
  buildShowcasePairingUrl,
  issuePairingCredential,
  reserveAvailablePort,
  stopProcess,
} from "./mobile-showcase.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const REPLAY_AGENT = NodePath.join(REPO_ROOT, "apps/server/scripts/dev-replay-agent.ts");
const STEP_TIMEOUT_MS = 60_000;
// The last line of every Replay showcase turn.
const REPLY_END = "This turn is a replay.";

function realpathOrSelf(path: string): string {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return path;
  }
}

export function isLiveDataDir(dir: string, home = NodeOS.homedir()): boolean {
  const real = realpathOrSelf(dir);
  return [".t3", ".ominax", ".t3-learn"]
    .map((name) => realpathOrSelf(NodePath.join(home, name)))
    .some((live) => real === live || real.startsWith(`${live}${NodePath.sep}`));
}

let step = "setup";
const consoleErrors: string[] = [];

async function check(name: string, run: () => Promise<void>): Promise<void> {
  step = name;
  console.log(`… ${name}`);
  await run();
  console.log(`✓ ${name}`);
}

const errorToast = (page: Page) => page.locator('[data-type="error"] [data-slot="toast-title"]');
const stopButton = (page: Page) => page.getByRole("button", { name: "Stop generation" });
const queuedChip = (page: Page) => page.getByLabel(/^Queued message 1 of 1/);
const composer = (page: Page) => page.getByRole("textbox").last();

async function expectNoErrorToast(page: Page): Promise<void> {
  const titles = await errorToast(page).allInnerTexts();
  if (titles.length > 0) throw new Error(`Error toast: ${titles.join(" | ")}`);
}

/** Waits for the running reply to end, failing as soon as an error toast shows. */
async function waitForReplyEnd(page: Page): Promise<void> {
  await Promise.race([
    stopButton(page).waitFor({ state: "detached", timeout: STEP_TIMEOUT_MS }),
    errorToast(page)
      .first()
      .waitFor({ timeout: STEP_TIMEOUT_MS })
      .then(() => expectNoErrorToast(page)),
  ]);
  await expectNoErrorToast(page);
}

/** Sends while idle and waits until the reply is streaming. */
async function sendIdle(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await page.keyboard.press("Enter");
  await stopButton(page).waitFor({ timeout: STEP_TIMEOUT_MS });
}

/** The latest finished reply sits below the given message, so the message got its own reply. */
async function expectReplyBelow(page: Page, message: string): Promise<void> {
  const sent = await page.getByText(message).last().boundingBox();
  const reply = await page.getByText(REPLY_END).last().boundingBox();
  if (sent === null || reply === null || reply.y <= sent.y) {
    throw new Error(`No finished reply below "${message}".`);
  }
}

async function runLearner(page: Page): Promise<void> {
  await check("skip the tour and What's new", async () => {
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    await button("Skip").click({ timeout: STEP_TIMEOUT_MS });
    // What's new opens once the tour closes, on a profile that never ran the setup wizard.
    await button("Try New lesson").waitFor({ timeout: STEP_TIMEOUT_MS });
    await button("Skip").click({ timeout: STEP_TIMEOUT_MS });
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: STEP_TIMEOUT_MS });
  });

  await check("L1 New lesson's first reply streams and finishes", async () => {
    await page.getByRole("button", { name: "New lesson", exact: true }).click();
    await page.getByLabel("Where?").getByText("A new, unrelated lesson").click();
    await page.getByLabel("What do you want to learn?").fill("How a hash map works");
    await page.getByRole("button", { name: "Start lesson" }).click();
    await stopButton(page).waitFor({ timeout: STEP_TIMEOUT_MS });
    // "Slow" is a model only the Replay agent offers; any other chip could be a paid model.
    const chip = (
      await page.locator('[data-chat-provider-model-picker="true"]').innerText()
    ).trim();
    if (chip !== "Slow")
      throw new Error(`The lesson is not on Replay's Slow model (chip: ${chip}).`);
    await waitForReplyEnd(page);
    await expectReplyBelow(page, "How a hash map works");
  });

  await check("L2a plain Send during a reply restarts it with the message", async () => {
    await sendIdle(page, "Start with buckets, please.");
    const steer = "What happens on a collision?";
    await composer(page).fill(steer);
    await page.getByRole("button", { name: "Steer message" }).click();
    await expectNoErrorToast(page);
    if ((await composer(page).innerText()).trim() !== "") {
      throw new Error("The draft bounced back into the composer.");
    }
    // Replay can't steer in place, so a steer cuts the attempt off and restarts it. Since #119
    // a refused steer falls back to the queue instead, which only L2b should see.
    const outcome = await Promise.race([
      page
        .getByText("Cut off by a steer")
        .waitFor()
        .then(() => "restarted"),
      queuedChip(page)
        .waitFor()
        .then(() => "queued"),
    ]);
    if (outcome === "queued")
      throw new Error("The send was queued instead of restarting the reply.");
    await page.getByText(steer).waitFor();
    await waitForReplyEnd(page);
    await expectReplyBelow(page, steer);
  });

  await check("L2b queued send during a reply runs afterwards", async () => {
    await sendIdle(page, "And resizing?");
    const queued = "When should I pick a tree instead?";
    await composer(page).fill(queued);
    // The send button's hint: "Click to steer, Ctrl-click to queue" (⌘ on macOS).
    await page
      .getByRole("button", { name: "Steer message" })
      .click({ modifiers: ["ControlOrMeta"] });
    await queuedChip(page).waitFor({ timeout: STEP_TIMEOUT_MS });
    await expectNoErrorToast(page);
    await page.getByText(queued).waitFor({ timeout: STEP_TIMEOUT_MS });
    await queuedChip(page).waitFor({ state: "detached", timeout: STEP_TIMEOUT_MS });
    await stopButton(page).waitFor({ timeout: STEP_TIMEOUT_MS });
    await waitForReplyEnd(page);
    await expectReplyBelow(page, queued);
  });
}

async function main(): Promise<void> {
  // Inherited from a live server's shell, these would point the sandbox at real data.
  for (const key of ["T3CODE_HOME", "T3_BOOT_SERVICE_UNIT", "T3_SERVICE_LAUNCHER_CONTEXT"]) {
    delete NodeProcess.env[key];
  }
  // The real chat sync restarts ominax.service; a missing unit hides the Sync button.
  NodeProcess.env.OMINAX_CHAT_SYNC_UNIT = "learner-e2e-no-chat-sync.service";
  NodeProcess.env.T3_LEARN_CHAT_SYNC_UNIT = "learner-e2e-no-chat-sync.service";

  const args = NodeProcess.argv.slice(2);
  const skipBuild = args.includes("--skip-build");
  const outIndex = args.indexOf("--out");
  const outDir = NodePath.resolve(
    outIndex === -1
      ? NodePath.join(NodeOS.tmpdir(), `learner-e2e-${Date.now()}`)
      : args[outIndex + 1]!,
  );
  await NodeFSP.mkdir(outDir, { recursive: true });
  if (!skipBuild) {
    step = "web build";
    const build = NodeChildProcess.spawnSync("vp", ["build"], {
      cwd: NodePath.join(REPO_ROOT, "apps/web"),
      stdio: "inherit",
    });
    if (build.status !== 0) throw new Error("The web build failed.");
  }
  if (!NodeFS.existsSync(NodePath.join(REPO_ROOT, "apps/web/dist/index.html"))) {
    throw new Error("No web build at apps/web/dist. Run without --skip-build.");
  }

  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "learner-e2e-"));
  if (isLiveDataDir(baseDir)) throw new Error(`Refusing to run in live data: ${baseDir}`);
  const workspace = NodePath.join(baseDir, "workspace");
  await NodeFSP.mkdir(NodePath.join(baseDir, "userdata"), { recursive: true });
  await NodeFSP.mkdir(workspace);
  await NodeFSP.writeFile(
    NodePath.join(baseDir, "userdata", "settings.json"),
    JSON.stringify({
      providerInstances: {
        devReplay: {
          displayName: "Replay (dev)",
          driver: "acpRegistry",
          config: {
            source: "local",
            commandPath: NodeProcess.execPath,
            commandArgs: [REPLAY_AGENT],
          },
        },
      },
      defaultModelSelection: { instanceId: "devReplay", model: "slow" },
    }),
  );

  // New lesson in the sidebar needs a project to start from; serve won't bootstrap one.
  const addProject = NodeChildProcess.spawnSync(
    NodeProcess.execPath,
    ["apps/server/src/bin.ts", "project", "add", workspace, "--base-dir", baseDir],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (addProject.status !== 0) throw new Error(`project add failed: ${addProject.stderr}`);

  const serverLog = NodeFS.createWriteStream(NodePath.join(outDir, "server.log"));
  let server: NodeChildProcess.ChildProcess | undefined;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  try {
    step = "server boot";
    const port = await reserveAvailablePort();
    server = NodeChildProcess.spawn(
      NodeProcess.execPath,
      [
        "apps/server/src/bin.ts",
        "serve",
        "--base-dir",
        baseDir,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--no-browser",
        workspace,
      ],
      { cwd: REPO_ROOT, env: NodeProcess.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    // stdout carries the startup pairing token, so only stderr goes to the log.
    server.stderr?.pipe(serverLog);
    const exited = new Promise<never>((_, reject) =>
      server?.once("exit", (code) => reject(new Error(`The server exited (code ${code}).`))),
    );
    exited.catch(() => {});
    // The port opens before the app serves; this line marks the app ready.
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        let output = "";
        server?.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("OminaX server is ready.")) resolve();
        });
      }),
    ]);
    const credential = await issuePairingCredential(baseDir);
    await page.goto(buildShowcasePairingUrl("127.0.0.1", port, credential), {
      waitUntil: "domcontentloaded",
    });
    await runLearner(page);
    console.log("learner-e2e passed");
  } catch (error) {
    await page
      .screenshot({ path: NodePath.join(outDir, "failure.png"), fullPage: true })
      .catch(() => {});
    await NodeFSP.writeFile(NodePath.join(outDir, "console-errors.txt"), consoleErrors.join("\n"));
    const log = await NodeFSP.readFile(NodePath.join(outDir, "server.log"), "utf8").catch(() => "");
    console.error(log.split("\n").slice(-40).join("\n"));
    console.error(
      `learner-e2e failed at "${step}": ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(`Screenshot, console errors and server log: ${outDir}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
    if (server !== undefined) await stopProcess(server);
    await NodeFSP.rm(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(
      `learner-e2e failed at "${step}": ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
