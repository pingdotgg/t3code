#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off - Host-side browser automation.
// Scripted learner on Replay: New lesson, a plain Send mid-reply, a queued send mid-reply.
// It checks the basic flow only; Claude's in-place steering and the provider refusals are
// pinned by SteeringCompletion.integration.test.ts. Usage: vp run learner-e2e [--skip-build] [--out <dir>]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { chromium, type Browser, type Page } from "playwright-core";

import {
  buildShowcasePairingUrl,
  issuePairingCredential,
  reserveAvailablePort,
  stopProcess,
} from "./mobile-showcase.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const REPLAY_AGENT = NodePath.join(REPO_ROOT, "apps/server/scripts/dev-replay-agent.ts");
const STEP_TIMEOUT_MS = 60_000;
// Default instances of the built-in drivers (apps/server/src/provider/builtInDrivers.ts).
const BUILT_IN_DRIVERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "fx",
  "opencode",
  "antigravity",
  "kiro",
  "pi",
  "muse",
];
// The last line of every Replay showcase turn.
const REPLY_END = "This turn is a replay.";

// Resolves links through the nearest existing ancestor, so a path that doesn't exist yet counts.
function realpathOrSelf(path: string): string {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    const parent = NodePath.dirname(path);
    return parent === path ? path : NodePath.join(realpathOrSelf(parent), NodePath.basename(path));
  }
}

export function isLiveDataDir(dir: string, home = NodeOS.homedir()): boolean {
  const real = realpathOrSelf(dir);
  return [".t3", ".ominax", ".t3-learn"]
    .map((name) => realpathOrSelf(NodePath.join(home, name)))
    .some((live) => real === live || real.startsWith(`${live}${NodePath.sep}`));
}

let step = "setup";
const startedAt = Date.now();
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
const consoleErrors: string[] = [];

// Playwright quotes the pairing URL in navigation errors; CI logs must not carry it.
const failureLine = (error: unknown) =>
  `learner-e2e failed at "${step}" (${elapsed()}): ${
    error instanceof Error ? error.message : String(error)
  }`.replace(/token=\w+/g, "token=<redacted>");

async function check(name: string, run: () => Promise<void>): Promise<void> {
  step = name;
  console.log(`… ${name} (${elapsed()})`);
  await run();
  console.log(`✓ ${name} (${elapsed()})`);
}

const errorToast = (page: Page) => page.locator('[data-type="error"] [data-slot="toast-title"]');
const stopButton = (page: Page) => page.getByRole("button", { name: "Stop generation" });
const queuedChip = (page: Page) => page.getByLabel(/^Queued message 1 of 1/);
const composer = (page: Page) => page.getByRole("textbox").last();

async function expectNoErrorToast(page: Page): Promise<void> {
  const titles = await errorToast(page).allInnerTexts();
  if (titles.length > 0) throw new Error(`Error toast: ${titles.join(" | ")}`);
}

/** Waits until a finished reply sits below the message and nothing is running. */
async function waitForReplyBelow(page: Page, message: string): Promise<void> {
  // Only a finished showcase turn reaches its last line, so this waits out restarts and queues.
  const reply = page.locator(`:text("${REPLY_END}"):below(:text("${message}"))`);
  await reply.or(errorToast(page)).first().waitFor();
  await expectNoErrorToast(page);
  await stopButton(page).waitFor({ state: "detached" });
  await expectNoErrorToast(page);
}

/** Sends while idle and waits until the reply is streaming. */
async function sendIdle(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await page.keyboard.press("Enter");
  await stopButton(page).waitFor();
}

async function runLearner(page: Page): Promise<void> {
  await check("skip the tour and What's new", async () => {
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    await button("Skip").click();
    // What's new opens once the tour closes, on a profile that never ran the setup wizard.
    await button("Try New lesson").waitFor();
    await button("Skip").click();
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: STEP_TIMEOUT_MS });
  });

  await check("L1 New lesson's first reply streams and finishes", async () => {
    await page.getByRole("button", { name: "New lesson", exact: true }).click();
    await page.getByLabel("Where?").getByText("A new, unrelated lesson").click();
    await page.getByLabel("What do you want to learn?").fill("How a hash map works");
    await page.getByRole("button", { name: "Start lesson" }).click();
    await stopButton(page).waitFor();
    // "Slow" is a model only the Replay agent offers; any other chip could be a paid model.
    const chip = (
      await page.locator('[data-chat-provider-model-picker="true"]').innerText()
    ).trim();
    if (chip !== "Slow")
      throw new Error(`The lesson is not on Replay's Slow model (chip: ${chip}).`);
    await waitForReplyBelow(page, "How a hash map works");
  });

  await check("L2a plain Send during a reply restarts it with the message", async () => {
    await sendIdle(page, "Start with buckets, please.");
    const steer = "What happens on a collision?";
    await composer(page).fill(steer);
    await page.getByRole("button", { name: "Steer message" }).click();
    // Replay can't steer in place, so a steer cuts the attempt off and restarts it.
    // A refused steer falls back to the queue instead (only L2b should see one) or errors.
    await page
      .getByText("Cut off by a steer")
      .or(queuedChip(page))
      .or(errorToast(page))
      .first()
      .waitFor();
    await expectNoErrorToast(page);
    if (await queuedChip(page).isVisible()) {
      throw new Error("The send was queued instead of restarting the reply.");
    }
    if ((await composer(page).innerText()).trim() !== "") {
      throw new Error("The draft bounced back into the composer.");
    }
    await waitForReplyBelow(page, steer);
  });

  await check("L2b queued send during a reply runs afterwards", async () => {
    await sendIdle(page, "And resizing?");
    const queued = "When should I pick a tree instead?";
    await composer(page).fill(queued);
    // The send button's hint: "Click to steer, Ctrl-click to queue" (⌘ on macOS).
    await page
      .getByRole("button", { name: "Steer message" })
      .click({ modifiers: ["ControlOrMeta"] });
    await queuedChip(page).waitFor();
    await expectNoErrorToast(page);
    await queuedChip(page).waitFor({ state: "detached" });
    await waitForReplyBelow(page, queued);
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
  if (isLiveDataDir(outDir)) throw new Error(`Refusing to write into live data: ${outDir}`);
  if (!skipBuild) {
    step = "web build";
    const build = NodeChildProcess.spawnSync("vp", ["build"], {
      cwd: NodePath.join(REPO_ROOT, "apps/web"),
      stdio: "inherit",
    });
    if (build.status !== 0) throw new Error("The web build failed.");
  }
  step = "setup";
  if (!NodeFS.existsSync(NodePath.join(REPO_ROOT, "apps/web/dist/index.html"))) {
    throw new Error("No web build at apps/web/dist. Run without --skip-build.");
  }

  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "learner-e2e-"));
  if (isLiveDataDir(baseDir)) throw new Error(`Refusing to run in live data: ${baseDir}`);
  await NodeFSP.mkdir(outDir, { recursive: true });
  let server: NodeChildProcess.ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    const workspace = NodePath.join(baseDir, "workspace");
    await NodeFSP.mkdir(NodePath.join(baseDir, "userdata"), { recursive: true });
    await NodeFSP.mkdir(workspace);
    await NodeFSP.writeFile(
      NodePath.join(baseDir, "userdata", "settings.json"),
      JSON.stringify({
        providerInstances: {
          // Only Replay runs: no paid model is reachable, and startup probes nothing else.
          ...Object.fromEntries(
            BUILT_IN_DRIVERS.map((driver) => [driver, { driver, enabled: false }]),
          ),
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

    browser = await chromium.launch();
    const opened = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page = opened;
    opened.setDefaultTimeout(STEP_TIMEOUT_MS);
    opened.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message));
    opened.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    step = "server boot";
    const port = await reserveAvailablePort();
    const spawned = NodeChildProcess.spawn(
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
    server = spawned;
    // stdout carries the startup pairing token, so only stderr goes to the log.
    spawned.stderr?.pipe(NodeFS.createWriteStream(NodePath.join(outDir, "server.log")));
    const exited = new Promise<never>((_, reject) =>
      spawned.once("exit", (code) => reject(new Error(`The server exited (code ${code}).`))),
    );
    exited.catch(() => {});
    // The port opens before the app serves; this line marks the app ready.
    await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("The server wasn't ready within 2 minutes.")),
          120_000,
        ).unref(),
      ),
      new Promise<void>((resolve) => {
        let output = "";
        spawned.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("OminaX server is ready.")) resolve();
        });
      }),
    ]);
    console.log(`server ready (${elapsed()})`);
    const credential = await issuePairingCredential(baseDir);
    await opened.goto(buildShowcasePairingUrl("127.0.0.1", port, credential), {
      waitUntil: "domcontentloaded",
    });
    console.log(`page loaded (${elapsed()})`);
    await runLearner(opened);
    console.log("learner-e2e passed");
    if (outIndex === -1) await NodeFSP.rm(outDir, { recursive: true, force: true });
  } catch (error) {
    await page
      ?.screenshot({ path: NodePath.join(outDir, "failure.png"), fullPage: true })
      .catch(() => {});
    await NodeFSP.writeFile(NodePath.join(outDir, "console-errors.txt"), consoleErrors.join("\n"));
    await NodeFSP.copyFile(
      NodePath.join(baseDir, "userdata", "logs", "server.trace.ndjson"),
      NodePath.join(outDir, "server.trace.ndjson"),
    ).catch(() => {});
    const log = await NodeFSP.readFile(NodePath.join(outDir, "server.log"), "utf8").catch(() => "");
    console.error(log.split("\n").slice(-40).join("\n"));
    console.error(failureLine(error));
    console.error(`Screenshot, console errors and server log: ${outDir}`);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    if (server !== undefined) await stopProcess(server);
    await NodeFSP.rm(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(failureLine(error));
    process.exitCode = 1;
  });
}
