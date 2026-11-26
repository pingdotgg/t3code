// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off
// Launches a packaged desktop app against a seeded T3 home, opens a thread, and checks its
// messages render. Release jobs run it so a build whose backend or bundle cannot start fails
// before it is published.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
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

// Packaged builds turn off Electron's Node inspector fuse, so Playwright's `_electron.launch`
// (which attaches through `--inspect`) never connects. Chromium's DevTools port still works.
const waitForDevToolsEndpoint = (child: NodeChildProcess.ChildProcess) =>
  new Promise<string>((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      process.stderr.write(chunk);
      output += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve(match[1]);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      reject(new Error(`The app exited (code ${code}, signal ${signal}) before DevTools opened.`));
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`DevTools did not open within ${STEP_TIMEOUT_MS}ms.`));
    }, STEP_TIMEOUT_MS);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });

let step = "launching the app";
let child: NodeChildProcess.ChildProcess | undefined;
let browser: Browser | undefined;
try {
  child = NodeChildProcess.spawn(
    executable,
    [
      ...(values.app ? [NodePath.resolve(values.app)] : []),
      // Linux CI runners do not allow the Chromium sandbox's user namespaces.
      "--no-sandbox",
      "--remote-debugging-port=0",
    ],
    {
      stdio: ["ignore", "inherit", "pipe"],
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
  const endpoint = await waitForDevToolsEndpoint(child);
  browser = await chromium.connectOverCDP(endpoint, { timeout: STEP_TIMEOUT_MS });
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
  if (child && child.exitCode === null && child.signalCode === null) {
    // Let the app quit cleanly, but a hung app never does; kill it so the job does not wait.
    const exited = new Promise((resolve) => child?.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, NodeTimersPromises.setTimeout(10_000, undefined, { ref: false })]);
    child.kill("SIGKILL");
  }
  NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
}
