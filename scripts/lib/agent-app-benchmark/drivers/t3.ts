// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Public benchmark adapter owns isolated state and child lifecycle.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeProcess from "node:process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import { serveDriver, type DriverHandlers } from "agent-app-benchmark/driver-sdk";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { _electron } from "playwright-core";

import {
  materializeT3PublicCorpus,
  type T3PublicMaterializationResult,
} from "./t3-public-materializer.ts";

const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;

interface OwnedProcess {
  readonly pid: number;
  readonly startTimeMs: number;
  readonly owner: "application";
  readonly category: string;
}

interface ReadinessTarget {
  readonly logicalSessionId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly expectedMessageIds: ReadonlyArray<string>;
}

interface ReadinessReceipt {
  readonly endpoint: "correct-content-painted-and-input-ready";
  readonly checks: ReadonlyArray<{ readonly id: string; readonly passed: boolean }>;
}

interface MonotonicClock {
  readonly kind: "single-monotonic-clock";
  readonly clock: string;
  readonly start: number;
  readonly end: number;
}

interface PreparedDriverState {
  readonly materialization: T3PublicMaterializationResult;
  readonly stateHandles: { readonly P0: string; readonly P1: string };
}

interface ActiveLaunch {
  readonly processes: ReadonlyArray<OwnedProcess>;
  readonly readiness: ReadinessReceipt;
  readonly clock: MonotonicClock;
}

interface SwitchCase {
  readonly caseId: string;
  readonly workload: "isolated-latency" | "progressive-resource" | "resource-control";
  readonly sessionState?: "cold" | "warm";
  readonly sourceSessionId?: string;
  readonly destinationSessionId: string;
}

interface StartCase {
  readonly caseId: string;
  readonly startMode: "new-application-state" | "initialized-application-state";
}

interface T3DriverDependencies {
  readonly hello: Record<string, unknown>;
  readonly prepare: (params: PrepareParams) => Promise<PreparedDriverState>;
  readonly launch: (stateHandle: string, initialSessionId: string) => Promise<ActiveLaunch>;
  readonly activate: (target: ReadinessTarget) => Promise<MonotonicClock>;
  readonly shutdown: () => Promise<{
    readonly terminated: ReadonlyArray<OwnedProcess>;
    readonly survivors: ReadonlyArray<OwnedProcess>;
  }>;
}

interface PrepareParams {
  readonly scenarioId: string;
  readonly scenarioDigestSha256: string;
  readonly corpusDirectory: string;
  readonly corpusManifestPath: string;
  readonly corpusDigestSha256: string;
  readonly corpusDefinitionDigestSha256: string;
  readonly eventSchemaDigestSha256: string;
  readonly runDirectory: string;
}

interface LaunchParams {
  readonly scenarioId: string;
  readonly stateHandle: string;
  readonly initialSessionId: string;
  readonly groupId: string;
}

interface ExecuteParams {
  readonly scenarioId: string;
  readonly stateHandle?: string;
  readonly case: StartCase | SwitchCase;
}

export interface T3PublicDriver {
  readonly hello: () => Promise<Record<string, unknown>>;
  readonly prepare: (params: PrepareParams) => Promise<Record<string, unknown>>;
  readonly launch: (params: LaunchParams) => Promise<Record<string, unknown>>;
  readonly execute: (params: ExecuteParams) => Promise<Record<string, unknown>>;
  readonly shutdown: () => Promise<Record<string, unknown>>;
}

export function createT3PublicDriver(dependencies: T3DriverDependencies): T3PublicDriver {
  let prepared: PreparedDriverState | undefined;
  let active = false;

  const requirePrepared = (): PreparedDriverState => {
    if (!prepared) throw new Error("T3 driver has not prepared the public corpus.");
    return prepared;
  };
  const resolveTarget = (logicalSessionId: string): ReadinessTarget => {
    const target = requirePrepared().materialization.readinessTargets.get(logicalSessionId);
    if (!target) throw new Error(`T3 has no materialized target for ${logicalSessionId}.`);
    return target;
  };
  const requireStateHandle = (stateHandle: string): void => {
    const handles = requirePrepared().stateHandles;
    if (stateHandle !== handles.P0 && stateHandle !== handles.P1)
      throw new Error("T3 rejected an unknown state handle.");
  };

  return {
    hello: async () => dependencies.hello,
    prepare: async (params) => {
      if (prepared) throw new Error("T3 driver is already prepared.");
      prepared = await dependencies.prepare(params);
      return {
        materializationMode: "translated",
        corpusDigestSha256: prepared.materialization.corpusDigestSha256,
        eventSchemaDigestSha256: prepared.materialization.eventSchemaDigestSha256,
        mappingDigestSha256: prepared.materialization.mappingDigestSha256,
        stateHandles: prepared.stateHandles,
        sessionMapping: prepared.materialization.sessionMapping,
      };
    },
    launch: async (params) => {
      if (active) throw new Error("T3 application is already running.");
      requireStateHandle(params.stateHandle);
      resolveTarget(params.initialSessionId);
      const launch = await dependencies.launch(params.stateHandle, params.initialSessionId);
      if (launch.processes.length === 0) throw new Error("T3 launch returned no application root.");
      active = true;
      return { ready: true, processes: launch.processes, readiness: launch.readiness };
    },
    execute: async (params) => {
      if (params.scenarioId === "app-start-v1") {
        if (active) throw new Error("T3 app-start requires no running application.");
        if (!("startMode" in params.case) || !params.stateHandle)
          throw new Error("T3 app-start request is incomplete.");
        requireStateHandle(params.stateHandle);
        const launch = await dependencies.launch(params.stateHandle, "control");
        active = true;
        return execution(params.case.caseId, launch.clock, launch.readiness);
      }
      if (params.scenarioId !== "session-switch-v1" || "startMode" in params.case)
        throw new Error(`T3 does not support scenario ${params.scenarioId}.`);
      if (!active) throw new Error("T3 session switching requires a running application.");
      const benchmarkCase = params.case;
      const destination = resolveTarget(benchmarkCase.destinationSessionId);
      const control = resolveTarget(benchmarkCase.sourceSessionId ?? "control");
      if (benchmarkCase.workload !== "resource-control") {
        if (benchmarkCase.sessionState === "warm") await dependencies.activate(destination);
        await dependencies.activate(control);
      }
      const clock = await dependencies.activate(destination);
      return execution(benchmarkCase.caseId, clock, readinessReceipt());
    },
    shutdown: async () => {
      const result = await dependencies.shutdown();
      active = false;
      return result;
    },
  };
}

function execution(caseId: string, clock: MonotonicClock, readiness: ReadinessReceipt) {
  return { caseId, durationMs: clock.end - clock.start, clock, readiness };
}

function readinessReceipt(): ReadinessReceipt {
  return {
    endpoint: "correct-content-painted-and-input-ready",
    checks: [
      { id: "content-identity", passed: true },
      { id: "first-fold-painted", passed: true },
      { id: "two-presentations", passed: true },
      { id: "trusted-input", passed: true },
    ],
  };
}

interface PlaywrightElectronProcess {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
}

interface PlaywrightElectronApplication {
  readonly process: () => PlaywrightElectronProcess;
  readonly firstWindow: () => Promise<PlaywrightPage>;
  readonly close: () => Promise<void>;
}

interface PlaywrightLocator {
  readonly count: () => Promise<number>;
  readonly first: () => PlaywrightLocator;
  readonly filter: (input: {
    readonly hasText?: string | RegExp;
    readonly visible?: boolean;
  }) => PlaywrightLocator;
  readonly click: () => Promise<void>;
  readonly waitFor: (input: { readonly state: "visible" }) => Promise<void>;
}

interface PlaywrightPage {
  readonly waitForLoadState: (state: "domcontentloaded") => Promise<void>;
  readonly waitForSelector: (selector: string) => Promise<unknown>;
  readonly locator: (selector: string) => PlaywrightLocator;
  readonly bringToFront: () => Promise<void>;
  readonly evaluate: <A>(source: string) => Promise<A>;
}

async function armTrustedActivation(page: PlaywrightPage): Promise<void> {
  await page.evaluate<void>(`
    globalThis.__t3AgentAppTrustedActivation = undefined;
    document.addEventListener("click", (event) => {
      if (event.isTrusted) globalThis.__t3AgentAppTrustedActivation = performance.now();
    }, { capture: true, once: true });
  `);
}

async function readTrustedActivation(page: PlaywrightPage): Promise<number> {
  const timestamp = await page.evaluate<number>(
    "globalThis.__t3AgentAppTrustedActivation ?? Number.NaN",
  );
  if (!Number.isFinite(timestamp))
    throw new Error("T3 renderer did not observe a trusted activation.");
  return timestamp;
}

async function waitForComposerUsable(page: PlaywrightPage): Promise<void> {
  await page.locator('[data-testid="composer-editor"]').waitFor({ state: "visible" });
  const usable = await page.evaluate<boolean>(`
    (() => {
      const composer = document.querySelector('[data-testid="composer-editor"]');
      if (!(composer instanceof HTMLElement)) return false;
      const bounds = composer.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && composer.getAttribute("aria-disabled") !== "true" && !composer.hasAttribute("disabled");
    })()
  `);
  if (!usable) throw new Error("T3 composer is visible but not usable.");
}

async function ensureWorkItemsRendered(page: PlaywrightPage, expectedCount: number): Promise<void> {
  const rows = page.locator("[data-thread-item]");
  let renderedCount = await rows.count();
  while (renderedCount < expectedCount) {
    const showMore = page.locator("button").filter({ hasText: /^Show \d+ more$/u, visible: true });
    if ((await showMore.count()) !== 1)
      throw new Error(`Only ${renderedCount} of ${expectedCount} benchmark sessions rendered.`);
    await showMore.click();
    await page.evaluate(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const nextCount = await rows.count();
    if (nextCount <= renderedCount) throw new Error("T3 session-list expansion made no progress.");
    renderedCount = nextCount;
  }
}

async function waitForSemanticTimelinePaint(
  page: PlaywrightPage,
  target: ReadinessTarget,
): Promise<number> {
  const expectedMessageIds = JSON.stringify(target.expectedMessageIds);
  return page.evaluate<number>(`
    new Promise((resolve, reject) => {
      const expected = new Set(${expectedMessageIds});
      const deadline = performance.now() + 30000;
      let previous;
      const visible = (element, viewport) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
      };
      const sample = () => {
        const rows = Array.from(document.querySelectorAll("[data-timeline-row-id]"));
        const targetRow = rows.find((row) => row instanceof HTMLElement && expected.has(row.getAttribute("data-message-id")));
        if (!(targetRow instanceof HTMLElement)) return undefined;
        let viewport = targetRow.parentElement;
        while (viewport instanceof HTMLElement && !["auto", "scroll"].includes(getComputedStyle(viewport).overflowY)) viewport = viewport.parentElement;
        const scroll = viewport instanceof HTMLElement ? viewport : document.documentElement;
        const bounds = scroll === document.documentElement ? { top: 0, bottom: innerHeight } : scroll.getBoundingClientRect();
        const visibleRows = rows.filter((row) => row instanceof HTMLElement && visible(row, bounds));
        if (!visible(targetRow, bounds) || targetRow.innerText.trim().length === 0 || targetRow.querySelector('[data-slot="skeleton"]')) return undefined;
        const first = visibleRows[0];
        const topGap = first instanceof HTMLElement ? Math.max(0, first.getBoundingClientRect().top - bounds.top) : Infinity;
        const overflow = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
        if (visibleRows.length === 0 || (overflow > 100 && topGap > 96)) return undefined;
        return JSON.stringify(visibleRows.map((row) => [row.getAttribute("data-timeline-row-id"), row.getAttribute("data-message-id"), row.innerText.trim().length, Math.round(row.getBoundingClientRect().top * 10) / 10, Math.round(row.getBoundingClientRect().height * 10) / 10]));
      };
      const frame = (paintedAt) => {
        const current = sample();
        if (current !== undefined && current === previous) return resolve(paintedAt);
        previous = current;
        if (performance.now() >= deadline) return reject(new Error("T3 did not paint stable canonical session content."));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    })
  `);
}

async function activateWorkItem(
  page: PlaywrightPage,
  target: ReadinessTarget,
): Promise<MonotonicClock> {
  const matches = page.locator(`[data-thread-id=${JSON.stringify(target.sessionId)}]`);
  if ((await matches.count()) === 0)
    throw new Error(`T3 benchmark session ${target.logicalSessionId} is not visible.`);
  await armTrustedActivation(page);
  await matches.first().click();
  const start = await readTrustedActivation(page);
  await page
    .locator("h2")
    .filter({ hasText: target.title, visible: true })
    .waitFor({ state: "visible" });
  await waitForComposerUsable(page);
  const end = await waitForSemanticTimelinePaint(page, target);
  return { kind: "single-monotonic-clock", clock: "t3-renderer-performance", start, end };
}

async function gitOutput(repoRoot: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      [...args],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 1_048_576 },
      (error, stdout) => {
        if (error) reject(new Error(`Unable to read T3 source identity: ${error.message}`));
        else resolve(stdout.trim());
      },
    );
  });
}

export function parseProcessStartTime(output: string, pid: number): number {
  const startTimeMs = Date.parse(output.trim());
  if (!Number.isFinite(startTimeMs) || startTimeMs < 0)
    throw new Error(`Invalid start time for PID ${pid}.`);
  return Math.floor(startTimeMs / 1_000) * 1_000;
}

async function processStartTimeMs(pid: number): Promise<number> {
  const output = await new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { encoding: "utf8", maxBuffer: 65_536 },
      (error, stdout) => {
        if (error) reject(new Error(`Unable to read start time for PID ${pid}.`));
        else resolve(stdout);
      },
    );
  });
  return parseProcessStartTime(output, pid);
}

async function waitForOwnedProcessExit(
  process: PlaywrightElectronProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (process.exitCode !== null || process.signalCode !== null) return true;
  return Promise.race([
    new Promise<true>((resolve) => process.once("exit", () => resolve(true))),
    NodeTimersPromises.setTimeout(timeoutMs, false),
  ]);
}

async function closeOwnedApplication(
  app: PlaywrightElectronApplication,
  process: PlaywrightElectronProcess,
): Promise<boolean> {
  if (
    await Promise.race([
      app.close().then(
        () => true,
        () => false,
      ),
      NodeTimersPromises.setTimeout(5_000, false),
    ])
  )
    return waitForOwnedProcessExit(process, 1_000);
  process.kill("SIGTERM");
  if (await waitForOwnedProcessExit(process, 5_000)) return true;
  process.kill("SIGKILL");
  return waitForOwnedProcessExit(process, 5_000);
}

async function sha256Files(files: ReadonlyArray<string>): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files) hash.update(await NodeFSP.readFile(file));
  return hash.digest("hex");
}

async function makeDefaultDependencies(): Promise<T3DriverDependencies> {
  const sourcePath = NodeURL.fileURLToPath(import.meta.url);
  const repoRoot = NodePath.resolve(NodePath.dirname(sourcePath), "../../../..");
  const materializerPath = NodePath.join(NodePath.dirname(sourcePath), "t3-public-materializer.ts");
  const desktopEntry = NodePath.join(repoRoot, "apps/desktop/dist-electron/main.cjs");
  const desktopPackage = JSON.parse(
    await NodeFSP.readFile(NodePath.join(repoRoot, "apps/desktop/package.json"), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof desktopPackage.version !== "string" || desktopPackage.version.length === 0)
    throw new Error("T3 desktop version is missing.");
  await NodeFSP.access(desktopEntry);
  const sourceCommit = await gitOutput(repoRoot, ["rev-parse", "HEAD"]);
  if (!SOURCE_COMMIT.test(sourceCommit)) throw new Error("T3 source revision is invalid.");
  const driverDigestSha256 = await sha256Files([sourcePath, materializerPath]);
  const buildDigestSha256 = await sha256Files([desktopEntry]);
  if (!SHA256.test(driverDigestSha256) || !SHA256.test(buildDigestSha256))
    throw new Error("T3 digest generation failed.");

  let readinessTargets: ReadonlyMap<string, ReadinessTarget> = new Map();
  let application: PlaywrightElectronApplication | undefined;
  let page: PlaywrightPage | undefined;
  let processIdentity: OwnedProcess | undefined;
  let attemptSequence = 0;

  const shutdown = async () => {
    const app = application;
    const identity = processIdentity;
    application = undefined;
    page = undefined;
    processIdentity = undefined;
    if (!app) return { terminated: [], survivors: [] };
    const closed = await closeOwnedApplication(app, app.process());
    if (!identity) {
      if (!closed)
        throw new Error("T3 could not close an application that failed during readiness.");
      return { terminated: [], survivors: [] };
    }
    return closed
      ? { terminated: [identity], survivors: [] }
      : { terminated: [], survivors: [identity] };
  };

  const launch = async (stateHandle: string, initialSessionId: string): Promise<ActiveLaunch> => {
    if (application) throw new Error("T3 application is already running.");
    const target = readinessTargets.get(initialSessionId);
    if (!target) throw new Error(`T3 has no readiness target for ${initialSessionId}.`);
    const attemptHome = NodePath.join(
      NodePath.dirname(stateHandle),
      "attempts",
      String(attemptSequence++),
    );
    await NodeFSP.mkdir(NodePath.dirname(attemptHome), { recursive: true, mode: 0o700 });
    await NodeFSP.cp(stateHandle, attemptHome, { recursive: true, errorOnExist: true });
    const launcher = (await import(
      NodeURL.pathToFileURL(NodePath.join(repoRoot, "apps/desktop/scripts/electron-launcher.mjs"))
        .href
    )) as {
      readonly resolveElectronLaunchCommand: (args: ReadonlyArray<string>) => {
        readonly electronPath: string;
        readonly args: ReadonlyArray<string>;
      };
    };
    const command = launcher.resolveElectronLaunchCommand([desktopEntry]);
    const start = NodePerfHooks.performance.now();
    const app = (await _electron.launch({
      executablePath: command.electronPath,
      args: [...command.args],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        T3CODE_HOME: attemptHome,
        VITE_DEV_SERVER_URL: "",
      },
    })) as unknown as PlaywrightElectronApplication;
    application = app;
    try {
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded");
      await window.waitForSelector("[data-thread-item]");
      await window.bringToFront();
      await ensureWorkItemsRendered(window, readinessTargets.size);
      await activateWorkItem(window, target);
      const end = NodePerfHooks.performance.now();
      const electronProcess = app.process();
      if (electronProcess.pid === undefined) throw new Error("T3 Electron root PID is missing.");
      processIdentity = {
        pid: electronProcess.pid,
        startTimeMs: await processStartTimeMs(electronProcess.pid),
        owner: "application",
        category: "electron-main",
      };
      page = window;
      return {
        processes: [processIdentity],
        readiness: readinessReceipt(),
        clock: { kind: "single-monotonic-clock", clock: "node-perf-hooks", start, end },
      };
    } catch (error) {
      await shutdown();
      throw error;
    }
  };

  return {
    hello: {
      protocolVersion: 1,
      application: {
        id: "t3",
        name: "T3 Code",
        version: desktopPackage.version,
        buildDigestSha256,
      },
      driver: {
        name: "t3-reference",
        version: "1",
        sourceCommit,
        digestSha256: driverDigestSha256,
      },
      scenarios: ["app-start-v1", "session-switch-v1"],
      sourceEventFormats: ["opencode-event-v1"],
      materializationModes: ["translated"],
      guiFramework: "electron",
    },
    prepare: async (params) => {
      const privateRoot = NodePath.join(
        NodePath.resolve(params.runDirectory),
        "driver-state",
        "t3",
      );
      const p0 = NodePath.join(privateRoot, "P0");
      const p1 = NodePath.join(privateRoot, "P1");
      const workspaceRoot = NodePath.join(privateRoot, "workspaces");
      const dbPath = NodePath.join(p0, "userdata", "state.sqlite");
      await NodeFSP.mkdir(NodePath.dirname(dbPath), { recursive: true, mode: 0o700 });
      await NodeFSP.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
      const migrations = (await import(
        NodeURL.pathToFileURL(NodePath.join(repoRoot, "apps/server/src/persistence/Migrations.ts"))
          .href
      )) as { readonly runMigrations: () => Effect.Effect<ReadonlyArray<unknown>, Error, never> };
      const sqliteClient = (await import(
        NodeURL.pathToFileURL(
          NodePath.join(repoRoot, "apps/server/src/persistence/NodeSqliteClient.ts"),
        ).href
      )) as { readonly layer: (input: { readonly filename: string }) => never };
      const silentLogger = Logger.layer([Logger.make<unknown, void>(() => undefined)], {
        mergeWithExisting: false,
      });
      await Effect.runPromise(
        migrations
          .runMigrations()
          .pipe(
            Effect.provide(sqliteClient.layer({ filename: dbPath })),
            Effect.provide(silentLogger) as never,
          ),
      );
      const materialization = await materializeT3PublicCorpus({
        corpusDirectory: params.corpusDirectory,
        corpusManifestPath: params.corpusManifestPath,
        expectedCorpusDigestSha256: params.corpusDigestSha256,
        expectedEventSchemaDigestSha256: params.eventSchemaDigestSha256,
        dbPath,
        disposableRoot: privateRoot,
        workspaceRoot,
      });
      readinessTargets = materialization.readinessTargets;
      await NodeFSP.cp(p0, p1, { recursive: true, errorOnExist: true });
      await launch(p1, "control");
      const warmupShutdown = await shutdown();
      if (warmupShutdown.survivors.length > 0)
        throw new Error("T3 P1 initialization left a surviving process.");
      const initializedAttempt = NodePath.join(privateRoot, "attempts", "0");
      await NodeFSP.rm(p1, { recursive: true, force: true });
      await NodeFSP.rename(initializedAttempt, p1);
      return { materialization, stateHandles: { P0: p0, P1: p1 } };
    },
    launch,
    activate: async (target) => {
      if (!page) throw new Error("T3 renderer is not running.");
      return activateWorkItem(page, target);
    },
    shutdown,
  };
}

function asPrepareParams(params: Record<string, unknown>): PrepareParams {
  return params as unknown as PrepareParams;
}
function asLaunchParams(params: Record<string, unknown>): LaunchParams {
  return params as unknown as LaunchParams;
}
function asExecuteParams(params: Record<string, unknown>): ExecuteParams {
  return params as unknown as ExecuteParams;
}

export async function runT3PublicDriver(): Promise<void> {
  const driver = createT3PublicDriver(await makeDefaultDependencies());
  const handlers: DriverHandlers = {
    hello: async () => driver.hello(),
    prepare: async (params) => driver.prepare(asPrepareParams(params)),
    launch: async (params) => driver.launch(asLaunchParams(params)),
    execute: async (params) => driver.execute(asExecuteParams(params)),
    shutdown: async () => driver.shutdown(),
  };
  const cleanup = async () => {
    const result = await driver.shutdown();
    const survivors = result.survivors as ReadonlyArray<unknown>;
    if (survivors.length > 0) throw new Error("T3 driver cleanup left a surviving process.");
  };
  const terminate = (code: number) => {
    void cleanup().finally(() => NodeProcess.exit(code));
  };
  NodeProcess.once("SIGINT", () => terminate(130));
  NodeProcess.once("SIGTERM", () => terminate(143));
  try {
    await serveDriver(handlers);
  } finally {
    await cleanup();
  }
}

if (import.meta.main) await runT3PublicDriver();
