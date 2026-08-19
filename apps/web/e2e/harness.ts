// @effect-diagnostics nodeBuiltinImport:off - e2e harness: spawns and drives the dev server as a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTimersPromises from "node:timers/promises";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import {
  parseDevRunnerLine,
  parsePairingUrl,
  redactSecrets,
  webOrigin,
  type DevRunnerPorts,
} from "./devOutput.ts";
import { addProjectFromEmptyState, waitForAppReady } from "./session.ts";

const REPO_ROOT = NodePath.resolve(
  NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  "../../..",
);
const WEB_ROOT = NodePath.join(REPO_ROOT, "apps/web");
const SQLITE_STATE_SCRIPT = NodePath.join(REPO_ROOT, "apps/server/scripts/t3-sqlite-state.ts");
const SHARED_T3_HOME = NodePath.join(NodeOS.homedir(), ".t3");
const READY_TIMEOUT_MS = 180_000;
const PLAYWRIGHT_OUTPUT_DIR = NodePath.join(WEB_ROOT, ".playwright");

export interface IsolatedWebAppOptions {
  /** Skip adding the fixture git repo as a Project. Default: add it. */
  readonly addFixtureProject?: boolean;
  readonly headed?: boolean;
}

export interface IsolatedWebApp {
  readonly homeDir: string;
  readonly fixtureProjectDir: string;
  readonly origin: string;
  readonly ports: DevRunnerPorts;
  readonly page: Page;
  readonly context: BrowserContext;
  close(): Promise<void>;
  querySqlite(sql: string): Promise<ReadonlyArray<Record<string, unknown>>>;
}

interface MutableResources {
  homeDir: string | null;
  fixtureProjectDir: string | null;
  child: NodeChildProcess.ChildProcess | null;
  browser: Browser | null;
  page: Page | null;
  unregisterExitKill: (() => void) | null;
}

/**
 * Starts `vp run dev` against a disposable home directory, pairs Chromium once,
 * and optionally adds a fixture git Project. Future browser suites should call
 * this instead of spawning the stack themselves.
 */
export async function startIsolatedWebApp(
  options: IsolatedWebAppOptions = {},
): Promise<IsolatedWebApp> {
  const resources: MutableResources = {
    homeDir: null,
    fixtureProjectDir: null,
    child: null,
    browser: null,
    page: null,
    unregisterExitKill: null,
  };

  try {
    return await startIsolatedWebAppUnsafe(options, resources);
  } catch (error) {
    await dumpHarnessFailure(resources, error);
    await disposeResources(resources);
    throw error;
  }
}

async function startIsolatedWebAppUnsafe(
  options: IsolatedWebAppOptions,
  resources: MutableResources,
): Promise<IsolatedWebApp> {
  const homeDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-e2e-home-"));
  const fixtureProjectDir = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3code-e2e-project-"),
  );
  resources.homeDir = homeDir;
  resources.fixtureProjectDir = fixtureProjectDir;
  assertIsolatedHome(homeDir);
  await initFixtureProject(fixtureProjectDir);

  const childEnv = { ...process.env };
  delete childEnv.VITE_HTTP_URL;
  delete childEnv.VITE_WS_URL;
  childEnv.T3CODE_HOME = homeDir;
  childEnv.T3CODE_NO_BROWSER = "1";
  childEnv.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = "0";
  if (childEnv.T3CODE_BUNDLED_DEV === undefined) {
    childEnv.T3CODE_BUNDLED_DEV = "1";
  }

  const child = NodeChildProcess.spawn("vp", ["run", "dev", "--home-dir", homeDir], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  resources.child = child;
  if (child.pid === undefined) {
    throw new Error("Failed to spawn vp run dev (no pid).");
  }
  resources.unregisterExitKill = registerExitKill(child.pid);

  const output = { text: "" };
  const ready = waitForDevReady(child, output);
  const startup = { timedOut: true };

  const exit = new Promise<never>((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          redactSecrets(
            `vp run dev exited before becoming ready (code=${String(code)}, signal=${String(signal)}).\n${tail(output.text)}`,
          ),
        ),
      );
    });
  });

  let ports: DevRunnerPorts;
  try {
    ports = await Promise.race([
      ready,
      exit,
      timeoutError("vp run dev", READY_TIMEOUT_MS, output, startup),
    ]);
  } finally {
    startup.timedOut = false;
    child.removeAllListeners("exit");
  }

  const origin = webOrigin(ports.webPort);
  await waitForHttp(origin, READY_TIMEOUT_MS);

  const pairingUrl = parsePairingUrl(output.text);
  if (pairingUrl === null) {
    throw new Error(
      redactSecrets(
        `Dev server started but no pairing URL appeared in logs.\n${tail(output.text)}`,
      ),
    );
  }

  const browser = await launchChromium(options.headed === true || process.env.E2E_HEADED === "1");
  resources.browser = browser;
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    baseURL: origin,
  });
  const page = await context.newPage();
  resources.page = page;
  page.setDefaultTimeout(15_000);
  await page.goto(pairingUrl, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 120_000 });
  const appReady = await waitForAppReady(page);

  if (options.addFixtureProject !== false && appReady === "empty") {
    await addProjectFromEmptyState(page, fixtureProjectDir);
  }

  return {
    homeDir,
    fixtureProjectDir,
    origin,
    ports,
    page,
    context,
    async close() {
      await disposeResources(resources);
    },
    async querySqlite(sql) {
      return querySqliteState(homeDir, sql);
    },
  };
}

function assertIsolatedHome(homeDir: string): void {
  const resolved = NodePath.resolve(homeDir);
  if (resolved === SHARED_T3_HOME || resolved.startsWith(`${SHARED_T3_HOME}${NodePath.sep}`)) {
    throw new Error("Refusing to start e2e against the shared ~/.t3 home.");
  }
}

async function initFixtureProject(dir: string): Promise<void> {
  await NodeFSP.writeFile(NodePath.join(dir, "README.md"), "# e2e fixture\n");
  NodeChildProcess.execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  NodeChildProcess.execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.email=e2e@t3.invalid", "-c", "user.name=e2e", "commit", "-m", "init"],
    { cwd: dir, stdio: "ignore" },
  );
}

function waitForDevReady(
  child: NodeChildProcess.ChildProcess,
  output: { text: string },
): Promise<DevRunnerPorts> {
  return new Promise((resolve, reject) => {
    const onChunk = (chunk: Buffer) => {
      output.text += chunk.toString("utf8");
      const ports = parseDevRunnerLine(output.text);
      const pairingUrl = parsePairingUrl(output.text);
      if (ports !== null && pairingUrl !== null) {
        child.stdout?.off("data", onChunk);
        child.stderr?.off("data", onChunk);
        resolve(ports);
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.once("error", (error) => {
      reject(new Error(`Failed to spawn vp run dev: ${error.message}`));
    });
  });
}

async function waitForHttp(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin, { redirect: "manual" });
      await response.arrayBuffer().catch(() => undefined);
      return;
    } catch (error) {
      lastError = error;
      await NodeTimersPromises.setTimeout(250);
    }
  }
  throw new Error(
    `Timed out waiting for ${origin} to accept connections: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function launchChromium(headed: boolean): Promise<Browser> {
  try {
    return await chromium.launch({ headless: !headed });
  } catch (error) {
    if (!isMissingBrowserError(error)) {
      throw error;
    }
    NodeChildProcess.execFileSync(process.execPath, [playwrightCliPath(), "install", "chromium"], {
      cwd: WEB_ROOT,
      stdio: "inherit",
    });
    return await chromium.launch({ headless: !headed });
  }
}

function playwrightCliPath(): string {
  return NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.resolve("playwright/package.json"))),
    "cli.js",
  );
}

function isMissingBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Executable doesn't exist") ||
    message.includes("browserType.launch: Executable doesn't exist")
  );
}

async function querySqliteState(
  homeDir: string,
  sql: string,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [SQLITE_STATE_SCRIPT, "query", "--base-dir", homeDir, "--sql", sql],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      redactSecrets(
        `sqlite query failed (status=${String(result.status)}):\n${result.stderr}\n${result.stdout}`,
      ),
    );
  }
  const parsed = parseSqliteStdout(result.stdout);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("rows" in parsed) ||
    !Array.isArray(parsed.rows)
  ) {
    throw new Error(redactSecrets(`sqlite query did not return rows JSON:\n${result.stdout}`));
  }
  return parsed.rows as ReadonlyArray<Record<string, unknown>>;
}

function parseSqliteStdout(text: string): unknown {
  const trimmed = redactSecrets(text).trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

async function dumpHarnessFailure(resources: MutableResources, error: unknown): Promise<void> {
  const page = resources.page;
  if (page === null) {
    return;
  }
  try {
    await NodeFSP.mkdir(PLAYWRIGHT_OUTPUT_DIR, { recursive: true });
    await page.screenshot({
      path: NodePath.join(PLAYWRIGHT_OUTPUT_DIR, "harness-failed.png"),
      fullPage: true,
    });
    const bodyText = (await page.locator("body").innerText()).slice(0, 2_000);
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error) {
      error.message = redactSecrets(`${message}\nurl=${page.url()}\n${bodyText}`);
    }
  } catch {
    // Best-effort evidence; the original error is more important.
  }
}

async function disposeResources(resources: MutableResources): Promise<void> {
  resources.unregisterExitKill?.();
  resources.unregisterExitKill = null;
  await resources.browser?.close().catch(() => undefined);
  resources.browser = null;
  await stopDevProcess(resources.child);
  resources.child = null;
  if (process.env.E2E_KEEP === "1") {
    return;
  }
  if (resources.homeDir !== null) {
    await NodeFSP.rm(resources.homeDir, { recursive: true, force: true }).catch(() => undefined);
  }
  if (resources.fixtureProjectDir !== null) {
    await NodeFSP.rm(resources.fixtureProjectDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function stopDevProcess(child: NodeChildProcess.ChildProcess | null): Promise<void> {
  if (child === null || child.pid === undefined) {
    return;
  }
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
  killProcessGroup(pid, "SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    NodeTimersPromises.setTimeout(8_000).then(() => true),
  ]);
  if (timedOut) {
    killProcessGroup(pid, "SIGKILL");
    await Promise.race([exited, NodeTimersPromises.setTimeout(2_000)]);
  }
}

function registerExitKill(pid: number): () => void {
  const onExit = () => {
    killProcessGroup(pid, "SIGKILL");
  };
  process.once("exit", onExit);
  return () => {
    process.removeListener("exit", onExit);
  };
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isProcessGone(error)) {
      try {
        process.kill(pid, signal);
      } catch (innerError) {
        if (!isProcessGone(innerError)) {
          throw innerError;
        }
      }
    }
  }
}

function isProcessGone(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ESRCH"
  );
}

function timeoutError(
  label: string,
  timeoutMs: number,
  output: { text: string },
  startup: { timedOut: boolean },
): Promise<DevRunnerPorts> {
  return NodeTimersPromises.setTimeout(timeoutMs).then(() => {
    if (!startup.timedOut) {
      return undefined as unknown as DevRunnerPorts;
    }
    throw new Error(
      redactSecrets(
        `Timed out after ${String(timeoutMs)}ms waiting for ${label}.\n${tail(output.text)}`,
      ),
    );
  });
}

function tail(text: string, maxChars = 8_000): string {
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

export { PLAYWRIGHT_OUTPUT_DIR, REPO_ROOT };
