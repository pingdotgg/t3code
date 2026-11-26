// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Launches a packaged desktop app against a seeded T3 home, opens a thread, and checks its
// messages render. Release jobs run it so a build whose backend or bundle cannot start fails
// before it is published.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import type * as NodeStream from "node:stream";
import * as NodeUtil from "node:util";
import { chromium, type Browser } from "playwright-core";

// A snapshot from an older build on purpose: the packaged server must migrate it forward, as it
// does for every upgrading user. It holds one project and two threads, nothing else.
const FIXTURE_DB = NodePath.join(import.meta.dirname, "fixtures/desktop-launch/statev2.sqlite");
const THREAD_TITLE = "Release launch check";
const THREAD_MESSAGE = "The release opens and shows this thread.";
const STEP_TIMEOUT_MS = 60_000;

const { values } = NodeUtil.parseArgs({
  options: {
    executable: { type: "string" },
    // An unpackaged app directory for a plain Electron executable, as PR CI runs it.
    app: { type: "string" },
    "artifacts-dir": { type: "string" },
  },
});
const executable = values.executable;
if (!executable)
  throw new Error(
    "Usage: smoke-desktop-app.ts --executable <app> [--app <dir>] [--artifacts-dir <dir>]",
  );
const artifactsDir = NodePath.resolve(values["artifacts-dir"] ?? "desktop-launch-check");

const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-launch-"));
const t3Home = NodePath.join(home, "t3");
NodeFS.mkdirSync(NodePath.join(t3Home, "userdata"), { recursive: true });
NodeFS.copyFileSync(FIXTURE_DB, NodePath.join(t3Home, "userdata/statev2.sqlite"));

// Packaged builds turn off Electron's Node inspector fuse, which Playwright's `_electron.launch`
// needs, so the check attaches through Chromium's DevTools port instead.
function devToolsEndpoint(
  child: NodeChildProcess.ChildProcessByStdio<null, null, NodeStream.Readable>,
) {
  const endpoint = new Promise<string>((resolve, reject) => {
    let output = "";
    let found = false;
    // Keeps draining stderr after the match so a chatty app never blocks on a full pipe.
    child.stderr.on("data", (chunk: Buffer) => {
      if (found) return;
      output += chunk.toString();
      const endpoint = /DevTools listening on (ws:\/\/\S+)\r?\n/.exec(output)?.[1];
      if (endpoint) {
        found = true;
        resolve(endpoint);
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(new Error(`The app exited (${signal ?? code}) before it opened DevTools.`)),
    );
  });
  const timeout = NodeTimersPromises.setTimeout(STEP_TIMEOUT_MS, undefined, { ref: false }).then(
    () => Promise.reject(new Error(`No DevTools endpoint after ${STEP_TIMEOUT_MS}ms.`)),
  );
  return Promise.race([endpoint, timeout]);
}

let step = "launching the app";
let app: NodeChildProcess.ChildProcessByStdio<null, null, NodeStream.Readable> | undefined;
let browser: Browser | undefined;
try {
  app = NodeChildProcess.spawn(
    executable,
    // Linux CI runners do not allow the Chromium sandbox's user namespaces.
    [
      ...(values.app ? [NodePath.resolve(values.app)] : []),
      "--no-sandbox",
      "--remote-debugging-port=0",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      // HOME stays real: on macOS a fake HOME has no login keychain, and safeStorage blocks the
      // main process on a keychain dialog. macOS keeps its Electron profile in the runner's HOME.
      env: {
        ...process.env,
        XDG_CONFIG_HOME: NodePath.join(home, ".config"),
        XDG_DATA_HOME: NodePath.join(home, ".local/share"),
        T3CODE_HOME: t3Home,
        T3CODE_TELEMETRY_ENABLED: "false",
        T3CODE_DISABLE_AUTO_UPDATE: "true",
      },
    },
  );
  browser = await chromium.connectOverCDP(await devToolsEndpoint(app), {
    timeout: STEP_TIMEOUT_MS,
  });
  // A backend that never starts leaves no window, or only the "could not start" window, so the
  // thread wait below fails either way and its screenshot shows the startup error.
  step = "waiting for the first window";
  const context = browser.contexts()[0];
  if (!context) throw new Error("The app exposed no browser context over DevTools.");
  const page =
    context.pages()[0] ?? (await context.waitForEvent("page", { timeout: STEP_TIMEOUT_MS }));
  try {
    step = `finding "${THREAD_TITLE}" in the sidebar`;
    const thread = page.locator("li[data-thread-item]", { hasText: THREAD_TITLE });
    await thread.waitFor({ timeout: STEP_TIMEOUT_MS });
    step = "opening the thread";
    await thread.click();
    await page.getByText(THREAD_MESSAGE).waitFor({ timeout: STEP_TIMEOUT_MS });
  } catch (error) {
    NodeFS.mkdirSync(artifactsDir, { recursive: true });
    await page
      .screenshot({ path: NodePath.join(artifactsDir, "window.png"), timeout: 10_000 })
      .catch(() => {});
    throw error;
  }
  console.log("Desktop launch check passed: the app opened and showed the seeded thread.");
} catch (error) {
  console.error(`Desktop launch check failed while ${step}.`);
  NodeFS.mkdirSync(artifactsDir, { recursive: true });
  console.error(error instanceof Error ? error.message : error);
  const logs = NodePath.join(t3Home, "userdata/logs");
  if (NodeFS.existsSync(logs)) {
    NodeFS.cpSync(logs, NodePath.join(artifactsDir, "logs"), { recursive: true });
    const serverLog = NodePath.join(logs, "server-child.log");
    if (NodeFS.existsSync(serverLog)) {
      console.error("\nLast backend output (server-child.log):");
      console.error(NodeFS.readFileSync(serverLog, "utf8").split("\n").slice(-20).join("\n"));
    }
  }
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (app && app.exitCode === null && app.signalCode === null) {
    // A hung app never finishes closing; kill it so the job does not wait for its timeout.
    const exited = new Promise((resolve) => app?.once("exit", resolve));
    app.kill("SIGTERM");
    await Promise.race([exited, NodeTimersPromises.setTimeout(10_000, undefined, { ref: false })]);
    app.kill("SIGKILL");
  }
  NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
}
