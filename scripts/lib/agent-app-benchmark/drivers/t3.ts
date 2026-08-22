// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Executable benchmark driver owns local files, stdio, and child lifecycle seams.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeProcess from "node:process";
import * as NodeReadline from "node:readline";
import * as NodeStream from "node:stream";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { _electron } from "playwright-core";

import {
  AGENT_APP_BENCHMARK_VERSION,
  AGENT_APP_DRIVER_PROTOCOL_VERSION,
  decodeAgentAppCorpus,
  decodeDriverMessage,
  type AgentAppCorpus,
  type AgentAppProfileId,
  type AgentAppScenarioId,
  type DriverHelloResult,
  type DriverRequest,
  type DriverResponse,
  type OwnedProcess,
  type RawMetricSample,
} from "../contracts.ts";
import { validateCorpusIntegrity } from "../corpus.ts";
import { materializeT3Corpus } from "./t3-materializer.ts";

interface PreparedEnvironment {
  readonly homeDir: string;
  readonly dbPath: string;
  readonly workspaceRoot: string;
}

interface LaunchResult {
  readonly processes: ReadonlyArray<OwnedProcess>;
  readonly readinessEvidence: string;
}

interface SessionReadinessTarget extends SemanticTimelineTarget {
  readonly sessionId: string;
  readonly title: string;
}

export interface SemanticTimelinePaintSnapshot {
  readonly expectedVisibleMessageId: string | null;
  readonly expectedVisibleMessageTextLength: number;
  readonly visibleSemanticMessageCount: number;
  readonly visibleRowIds: ReadonlyArray<string>;
  readonly overflowPx: number;
  readonly topGapPx: number;
}

export interface SemanticTimelineTarget {
  readonly expectedMessageIds: ReadonlyArray<string>;
}

export function semanticTimelinePaintReady(
  snapshot: SemanticTimelinePaintSnapshot,
  target: SemanticTimelineTarget,
): boolean {
  return (
    snapshot.expectedVisibleMessageId !== null &&
    target.expectedMessageIds.includes(snapshot.expectedVisibleMessageId) &&
    snapshot.expectedVisibleMessageTextLength > 0 &&
    snapshot.visibleSemanticMessageCount > 0 &&
    (snapshot.overflowPx <= 100 || snapshot.topGapPx <= 96)
  );
}

export interface T3DriverAutomation {
  readonly runScenario: (input: {
    readonly attemptId: string;
    readonly profile: AgentAppProfileId;
    readonly scenario: AgentAppScenarioId;
    readonly seed: string;
    readonly sessionTargets: ReadonlyArray<SessionReadinessTarget>;
  }) => Promise<ReadonlyArray<RawMetricSample>>;
}

export interface T3DriverDependencies {
  readonly hello: DriverHelloResult;
  readonly liveHomeDir?: string | undefined;
  readonly prepareEnvironment: (input: {
    readonly runDirectory: string;
  }) => Promise<PreparedEnvironment>;
  readonly launchApplication: (input: {
    readonly isolatedProfilePath: string;
    readonly environment: PreparedEnvironment;
  }) => Promise<LaunchResult>;
  readonly automation: T3DriverAutomation;
  readonly shutdownApplication: (reason: string) => Promise<{
    readonly terminated: ReadonlyArray<OwnedProcess>;
    readonly survivors: ReadonlyArray<OwnedProcess>;
  }>;
}

export interface T3Driver {
  readonly hello: () => Promise<DriverHelloResult>;
  readonly prepare: (
    params: Extract<DriverRequest, { readonly method: "prepare" }>["params"],
  ) => Promise<
    Extract<DriverResponse, { readonly method: "prepare"; readonly ok: true }>["result"]
  >;
  readonly launch: (
    params: Extract<DriverRequest, { readonly method: "launch" }>["params"],
  ) => Promise<Extract<DriverResponse, { readonly method: "launch"; readonly ok: true }>["result"]>;
  readonly runScenario: (
    params: Extract<DriverRequest, { readonly method: "run-scenario" }>["params"],
  ) => Promise<
    Extract<DriverResponse, { readonly method: "run-scenario"; readonly ok: true }>["result"]
  >;
  readonly shutdown: (
    params: Extract<DriverRequest, { readonly method: "shutdown" }>["params"],
  ) => Promise<
    Extract<DriverResponse, { readonly method: "shutdown"; readonly ok: true }>["result"]
  >;
}

export function createT3Driver(dependencies: T3DriverDependencies): T3Driver {
  let corpus: AgentAppCorpus | undefined;
  let sessionTargets: ReadonlyArray<SessionReadinessTarget> | undefined;
  let environment: PreparedEnvironment | undefined;
  let launched = false;

  const requirePrepared = () => {
    if (!corpus || !sessionTargets || !environment) {
      throw new Error("T3 driver is not prepared.");
    }
    return { corpus, sessionTargets, environment };
  };

  return {
    hello: async () => dependencies.hello,
    prepare: async (params) => {
      if (corpus || environment) throw new Error("T3 driver is already prepared.");
      const contents = await NodeFSP.readFile(params.corpusPath, "utf8");
      const decoded = decodeAgentAppCorpus(JSON.parse(contents) as unknown);
      validateCorpusIntegrity(decoded);
      if (decoded.manifest.hashes.corpusSha256 !== params.corpusDigestSha256) {
        throw new Error("Prepared corpus digest does not match the driver request.");
      }
      const prepared = await dependencies.prepareEnvironment({
        runDirectory: params.runDirectory,
      });
      const result = materializeT3Corpus({
        corpus: decoded,
        dbPath: prepared.dbPath,
        disposableRoot: params.runDirectory,
        workspaceRoot: prepared.workspaceRoot,
        ...(dependencies.liveHomeDir ? { liveHomeDir: dependencies.liveHomeDir } : {}),
      });
      const requested = new Set(params.profiles);
      corpus = decoded;
      sessionTargets = result.readinessTargets;
      environment = prepared;
      return { coverage: result.coverage.filter((coverage) => requested.has(coverage.profile)) };
    },
    launch: async (params) => {
      const prepared = requirePrepared();
      if (launched) throw new Error("T3 application is already launched.");
      const result = await dependencies.launchApplication({
        isolatedProfilePath: params.isolatedProfilePath,
        environment: prepared.environment,
      });
      if (result.processes.length === 0) throw new Error("T3 launch returned no owned processes.");
      launched = true;
      return {
        processes: [...result.processes],
        automationReady: true,
        readinessEvidence: result.readinessEvidence,
      };
    },
    runScenario: async (params) => {
      const prepared = requirePrepared();
      if (!launched) throw new Error("T3 application is not launched.");
      const samples = await dependencies.automation.runScenario({
        attemptId: params.attemptId,
        profile: params.profile,
        scenario: params.scenario,
        seed: params.seed,
        sessionTargets: prepared.sessionTargets,
      });
      return { samples: [...samples] };
    },
    shutdown: async (params) => {
      const application = await dependencies.shutdownApplication(params.reason);
      corpus = undefined;
      sessionTargets = undefined;
      environment = undefined;
      launched = false;
      return { terminated: [...application.terminated], survivors: [...application.survivors] };
    },
  };
}

function driverError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retriable: false;
} {
  const message = error instanceof Error ? error.message : String(error);
  return { code: "t3-driver-error", message: message.slice(0, 1_024), retriable: false };
}

export async function runT3DriverStdio(
  driver: T3Driver,
  input: NodeStream.Readable = process.stdin,
  output: NodeStream.Writable = process.stdout,
): Promise<void> {
  const seen = new Set<string>();
  const lines = NodeReadline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let request: DriverRequest | undefined;
    try {
      const message = decodeDriverMessage(JSON.parse(line) as unknown);
      if (message.kind !== "request") throw new Error("T3 driver accepts request messages only.");
      request = message;
      if (seen.has(request.correlationId)) throw new Error("Duplicate correlation ID.");
      seen.add(request.correlationId);
      let result: unknown;
      switch (request.method) {
        case "hello":
          if (request.params.frameworkVersion !== AGENT_APP_BENCHMARK_VERSION) {
            throw new Error("Unsupported benchmark framework version.");
          }
          result = await driver.hello();
          break;
        case "prepare":
          result = await driver.prepare(request.params);
          break;
        case "launch":
          result = await driver.launch(request.params);
          break;
        case "run-scenario":
          result = await driver.runScenario(request.params);
          break;
        case "shutdown":
          result = await driver.shutdown(request.params);
          break;
      }
      output.write(
        `${JSON.stringify({
          protocolVersion: AGENT_APP_DRIVER_PROTOCOL_VERSION,
          kind: "response",
          correlationId: request.correlationId,
          method: request.method,
          ok: true,
          result,
        })}\n`,
      );
    } catch (error) {
      if (!request) throw error;
      output.write(
        `${JSON.stringify({
          protocolVersion: AGENT_APP_DRIVER_PROTOCOL_VERSION,
          kind: "response",
          correlationId: request.correlationId,
          method: request.method,
          ok: false,
          error: driverError(error),
        })}\n`,
      );
    }
  }
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
  /** Main-process evaluation; the only place Electron exposes display facts. */
  readonly evaluate: <A>(source: string) => Promise<A>;
  readonly close: () => Promise<void>;
}

interface PlaywrightLocator {
  readonly count: () => Promise<number>;
  readonly nth: (index: number) => PlaywrightLocator;
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
  readonly keyboard: { readonly press: (key: string) => Promise<void> };
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
  if (!Number.isFinite(timestamp)) {
    throw new Error("T3 renderer did not observe a trusted activation event.");
  }
  return timestamp;
}

async function waitForComposerUsable(page: PlaywrightPage): Promise<void> {
  await page.locator('[data-testid="composer-editor"]').waitFor({ state: "visible" });
  const usable = await page.evaluate<boolean>(`
    (() => {
      const composer = document.querySelector('[data-testid="composer-editor"]');
      if (!(composer instanceof HTMLElement)) return false;
      const bounds = composer.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 &&
        composer.getAttribute("aria-disabled") !== "true" &&
        !composer.hasAttribute("disabled");
    })()
  `);
  if (!usable) throw new Error("T3 composer is visible but not usable.");
}

async function visibleThreadRowSummary(page: PlaywrightPage): Promise<string> {
  return page.evaluate<string>(`
    JSON.stringify(Array.from(document.querySelectorAll("[data-thread-item]"))
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .slice(0, 8)
      .map((element) => ({
        id: element.getAttribute("data-thread-id"),
        testId: element.getAttribute("data-testid") ?? element.querySelector("[data-testid]")?.getAttribute("data-testid"),
        text: element.textContent?.trim().slice(0, 80)
      })))
  `);
}

async function ensureWorkItemsRendered(page: PlaywrightPage, expectedCount: number): Promise<void> {
  const rows = page.locator("[data-thread-item]");
  let renderedCount = await rows.count();
  while (renderedCount < expectedCount) {
    const showMore = page.locator("button").filter({ hasText: /^Show \d+ more$/u, visible: true });
    if ((await showMore.count()) !== 1) {
      throw new Error(
        `Only ${renderedCount} of ${expectedCount} work items rendered and the settled-tail control was unavailable.`,
      );
    }
    await showMore.click();
    await page.evaluate(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const nextCount = await rows.count();
    if (nextCount <= renderedCount) {
      throw new Error("Settled-tail expansion did not render additional work items.");
    }
    renderedCount = nextCount;
  }
}

async function waitForSemanticTimelinePaint(
  page: PlaywrightPage,
  target: SemanticTimelineTarget,
): Promise<number> {
  if (target.expectedMessageIds.length === 0) {
    throw new Error("Semantic timeline readiness requires a canonical message ID.");
  }
  const expectedMessageIds = JSON.stringify(target.expectedMessageIds);
  return page.evaluate<number>(`
    new Promise((resolve, reject) => {
      const expectedMessageIds = new Set(${expectedMessageIds});
      const deadline = performance.now() + 30000;
      let previousSignature;
      const visible = (element, viewportRect) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" &&
          Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0 &&
          rect.bottom > viewportRect.top && rect.top < viewportRect.bottom;
      };
      const textHash = (value) => {
        let hash = 2166136261;
        for (let index = 0; index < value.length; index += 1) {
          hash ^= value.charCodeAt(index);
          hash = Math.imul(hash, 16777619) >>> 0;
        }
        return hash;
      };
      const sample = () => {
        const rows = Array.from(document.querySelectorAll("[data-timeline-row-id]"));
        const semanticRows = rows.filter((row) => row.hasAttribute("data-message-id"));
        const targetRow = semanticRows.find((row) => {
          const id = row.getAttribute("data-message-id");
          return id !== null && expectedMessageIds.has(id);
        });
        if (!(targetRow instanceof HTMLElement)) return undefined;
        let viewport = targetRow.parentElement;
        while (viewport instanceof HTMLElement) {
          const overflowY = getComputedStyle(viewport).overflowY;
          if (overflowY === "auto" || overflowY === "scroll") break;
          viewport = viewport.parentElement;
        }
        const scrollViewport = viewport instanceof HTMLElement
          ? viewport
          : document.scrollingElement instanceof HTMLElement
            ? document.scrollingElement
            : document.documentElement;
        const viewportRect = scrollViewport === document.documentElement
          ? { top: 0, bottom: innerHeight }
          : scrollViewport.getBoundingClientRect();
        const visibleRows = rows.filter((row) =>
          row instanceof HTMLElement && visible(row, viewportRect)
        );
        const visibleTarget = semanticRows.find((row) => {
          if (!(row instanceof HTMLElement) || !visible(row, viewportRect)) return false;
          const id = row.getAttribute("data-message-id");
          return id !== null && expectedMessageIds.has(id);
        });
        if (!(visibleTarget instanceof HTMLElement)) return undefined;
        const targetText = visibleTarget.innerText.trim();
        if (targetText.length === 0 || visibleTarget.querySelector('[data-slot="skeleton"]')) {
          return undefined;
        }
        const firstVisible = visibleRows[0];
        const topGap = firstVisible instanceof HTMLElement
          ? Math.max(0, firstVisible.getBoundingClientRect().top - viewportRect.top)
          : Number.POSITIVE_INFINITY;
        const overflow = Math.max(0, scrollViewport.scrollHeight - scrollViewport.clientHeight);
        if (!(visibleRows.length > 0 && (overflow <= 100 || topGap <= 96))) return undefined;
        const rowState = visibleRows.map((row) => {
          const element = row;
          const text = element.innerText.trim();
          const rect = element.getBoundingClientRect();
          return [
            element.getAttribute("data-timeline-row-id"),
            element.getAttribute("data-message-id"),
            text.length,
            textHash(text),
            Math.round(rect.top * 10) / 10,
            Math.round(rect.height * 10) / 10,
          ];
        });
        return JSON.stringify({
          targetMessageId: visibleTarget.getAttribute("data-message-id"),
          targetTextLength: targetText.length,
          targetTextHash: textHash(targetText),
          rowState,
          scrollTop: Math.round(scrollViewport.scrollTop * 10) / 10,
          scrollHeight: scrollViewport.scrollHeight,
          clientHeight: scrollViewport.clientHeight,
          topGap: Math.round(topGap * 10) / 10,
        });
      };
      const frame = (paintedAtMs) => {
        const signature = sample();
        if (signature !== undefined && signature === previousSignature) {
          resolve(paintedAtMs);
          return;
        }
        previousSignature = signature;
        if (performance.now() >= deadline) {
          reject(new Error("T3 timeline did not paint a stable canonical latest-turn message."));
          return;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    })
  `);
}

function seededOrder(length: number, seed: string): ReadonlyArray<number> {
  let state = 2_166_136_261;
  for (const character of seed) {
    state ^= character.codePointAt(0) ?? 0;
    state = Math.imul(state, 16_777_619) >>> 0;
  }
  const order = Array.from({ length }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const selected = state % (index + 1);
    [order[index], order[selected]] = [order[selected]!, order[index]!];
  }
  return order;
}

export function warmSwitchPlan<T extends { readonly sessionId: string }>(
  targets: ReadonlyArray<T>,
  seed: string,
): { readonly warmup: ReadonlyArray<T>; readonly measured: ReadonlyArray<T> } {
  const warmup = [...targets];
  const measured = seededOrder(targets.length, seed).map((index) => targets[index]!);
  if (measured[0]?.sessionId === warmup.at(-1)?.sessionId) measured.push(measured.shift()!);
  return { warmup, measured };
}

async function activateWorkItem(
  page: PlaywrightPage,
  readinessTarget: SessionReadinessTarget,
  scenario: "cold-open" | "warm-switch",
): Promise<{ readonly start: number; readonly end: number }> {
  const matches = page.locator(`[data-thread-id=${JSON.stringify(readinessTarget.sessionId)}]`);
  const matchCount = await matches.count();
  if (matchCount === 0) {
    throw new Error(
      `${scenario === "cold-open" ? "Cold-open" : "Warm-switch"} target '${readinessTarget.title}' is not visible; rows=${await visibleThreadRowSummary(page)}.`,
    );
  }
  const target = matches.first();
  await armTrustedActivation(page);
  await target.click();
  const start = await readTrustedActivation(page);
  await page
    .locator("h2")
    .filter({ hasText: readinessTarget.title, visible: true })
    .waitFor({ state: "visible" });
  await waitForComposerUsable(page);
  const end = await waitForSemanticTimelinePaint(page, readinessTarget);
  return { start, end };
}

async function switchAmongWorkItems(
  page: PlaywrightPage,
  sessionTargets: ReadonlyArray<SessionReadinessTarget>,
  seed: string,
): Promise<ReadonlyArray<{ readonly start: number; readonly end: number }>> {
  await ensureWorkItemsRendered(page, sessionTargets.length);
  const rows = page.locator("[data-thread-item]");
  const rowCount = await rows.count();
  if (sessionTargets.length < 20 || rowCount < 20) {
    throw new Error("Warm switching requires all 20 materialized work items.");
  }
  const targets = sessionTargets.slice(0, 20);
  const plan = warmSwitchPlan(targets, seed);
  for (const target of plan.warmup) {
    await activateWorkItem(page, target, "warm-switch");
  }
  const timings: Array<{ readonly start: number; readonly end: number }> = [];
  for (const target of plan.measured) {
    timings.push(await activateWorkItem(page, target, "warm-switch"));
  }
  return timings;
}

function workspaceSample(input: {
  readonly attemptId: string;
  readonly scenario: "app-cold-ready-v1" | "work-item-cold-open-v1" | "work-item-warm-switch-v1";
  readonly metric: "app.cold_ready_ms" | "work_item.cold_open_ms" | "work_item.warm_switch_p95_ms";
  readonly startTimestamp: number;
  readonly endTimestamp: number;
}): RawMetricSample {
  return {
    schemaVersion: 1,
    sampleId: `${input.attemptId}-${input.scenario}`,
    attemptId: input.attemptId,
    profile: "workspace-core-v1",
    scenario: input.scenario,
    metric: input.metric,
    observation: {
      state: "exact",
      value: input.endTimestamp - input.startTimestamp,
      unit: "ms",
    },
    evidence: [
      {
        sequence: 0,
        name: "trusted-action-to-stable-semantic-paint",
        clockOwner: "t3-renderer",
        clockDomain: "performance.now",
        resolutionMs: 0.1,
        observerMethod:
          "Trusted click to two identical animation-frame snapshots containing a canonical latest-turn message and complete first fold",
        startTimestamp: input.startTimestamp,
        endTimestamp: input.endTimestamp,
      },
    ],
    validity: {
      status: "valid",
      evidence: [
        {
          check: "canonical-latest-turn-stable-and-visible",
          expectedCount: 1,
          actualCount: 1,
          passed: true,
        },
      ],
    },
  };
}

function resourceCoordinationSample(input: {
  readonly attemptId: string;
  readonly scenario: "resource-sweep-v1" | "resource-quiescence-v1";
  readonly startTimestamp: number;
  readonly endTimestamp: number;
}): RawMetricSample {
  const metric =
    input.scenario === "resource-sweep-v1"
      ? "resource.peak_process_family_rss_mib"
      : "resource.quiescent_cpu_p95_pct";
  return {
    schemaVersion: 1,
    sampleId: `${input.attemptId}-${input.scenario}-driver-coordination`,
    attemptId: input.attemptId,
    profile: "resource-core-v1",
    scenario: input.scenario,
    metric,
    observation: {
      state: "invalid",
      reason: "Resource values are derived by the runner-owned standalone observer.",
    },
    evidence: [
      {
        sequence: 0,
        name: "resource-observer-coordination-window",
        clockOwner: "t3-renderer",
        clockDomain: "performance.now",
        resolutionMs: 0.1,
        observerMethod:
          "Driver holds the concrete workload or quiescence window while the runner samples the process family",
        startTimestamp: input.startTimestamp,
        endTimestamp: input.endTimestamp,
      },
    ],
    validity: {
      status: "invalid",
      evidence: [],
      failures: [
        {
          code: "runner-owned-resource-observation",
          message:
            "This coordination response is replaced by the runner's standalone process-family observation.",
          evidence: [],
        },
      ],
    },
  };
}

async function gitOutput(
  repoRoot: string,
  args: ReadonlyArray<string>,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "git",
      [...args],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 1_048_576 },
      (error, stdout) => resolve(error === null ? stdout.trim() : undefined),
    );
  });
}

export function parseProcessStartTime(output: string, pid: number): number {
  const startTimeMs = Date.parse(output.trim());
  if (!Number.isFinite(startTimeMs) || startTimeMs < 0) {
    throw new Error(`Operating system reported an invalid start time for PID ${pid}.`);
  }
  return Math.floor(startTimeMs / 1_000) * 1_000;
}

async function processStartTimeMs(pid: number): Promise<number> {
  const command = NodeProcess.platform === "win32" ? "powershell.exe" : "ps";
  const args =
    NodeProcess.platform === "win32"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
        ]
      : ["-o", "lstart=", "-p", String(pid)];
  const output = await new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      args,
      { encoding: "utf8", maxBuffer: 65_536 },
      (error, stdout) =>
        error === null
          ? resolve(stdout)
          : reject(new Error(`Unable to read start time for PID ${pid}.`, { cause: error })),
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

async function closeOwnedElectronApplication(
  app: PlaywrightElectronApplication,
  process: PlaywrightElectronProcess,
): Promise<boolean> {
  const graceful = app.close().then(
    () => true,
    () => false,
  );
  if (await Promise.race([graceful, NodeTimersPromises.setTimeout(5_000, false)])) {
    return waitForOwnedProcessExit(process, 1_000);
  }
  process.kill("SIGTERM");
  if (await waitForOwnedProcessExit(process, 5_000)) return true;
  process.kill("SIGKILL");
  return waitForOwnedProcessExit(process, 5_000);
}

async function cleanSourceCommit(repoRoot: string): Promise<string | undefined> {
  const status = await gitOutput(repoRoot, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status === undefined || status.length > 0) return undefined;
  const commit = await gitOutput(repoRoot, ["rev-parse", "HEAD"]);
  return commit !== undefined && /^[0-9a-f]{40}$/u.test(commit) ? commit : undefined;
}

/**
 * Concrete release-desktop dependencies. Scenario automation intentionally
 * fails closed until a measurement-specific Playwright flow supplies real raw
 * samples; it never fabricates timing evidence.
 */
export async function makeDefaultT3DriverDependencies(): Promise<T3DriverDependencies> {
  const sourcePath = NodeURL.fileURLToPath(import.meta.url);
  const repoRoot = NodePath.resolve(NodePath.dirname(sourcePath), "../../../..");
  const desktopEntry = NodePath.join(repoRoot, "apps/desktop/dist-electron/main.cjs");
  const desktopPackage = JSON.parse(
    await NodeFSP.readFile(NodePath.join(repoRoot, "apps/desktop/package.json"), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof desktopPackage.version !== "string" || desktopPackage.version.length === 0) {
    throw new Error("T3 desktop package does not declare an application version.");
  }
  const sourceCommit = await cleanSourceCommit(repoRoot);
  const driverDigest = NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(sourcePath))
    .digest("hex");
  let electronApplication: PlaywrightElectronApplication | undefined;
  let electronPage: PlaywrightPage | undefined;
  let launchedHomeDir: string | undefined;
  let launchedProcess: OwnedProcess | undefined;
  let coldReadyTiming: { readonly start: number; readonly end: number } | undefined;

  const unavailableScenario = async (): Promise<ReadonlyArray<RawMetricSample>> => {
    throw new Error(
      "Release T3 scenario automation is unavailable without the scenario-specific Playwright observer.",
    );
  };

  return {
    hello: {
      protocolVersion: 1,
      application: {
        name: "T3 Code",
        version: desktopPackage.version,
        build: "production-equivalent",
        ...(sourceCommit === undefined ? {} : { sourceCommit }),
      },
      driver: {
        name: "t3-reference",
        version: "1",
        digestSha256: driverDigest,
        ...(sourceCommit === undefined ? {} : { sourceCommit }),
      },
      capabilities: {
        profiles: ["workspace-core-v1", "resource-core-v1"],
        scenarios: [
          "app-cold-ready-v1",
          "work-item-cold-open-v1",
          "work-item-warm-switch-v1",
          "resource-sweep-v1",
          "resource-quiescence-v1",
        ],
        metrics: [
          "app.cold_ready_ms",
          "work_item.cold_open_ms",
          "work_item.warm_switch_p95_ms",
          "resource.peak_process_family_rss_mib",
          "resource.quiescent_cpu_p95_pct",
        ],
        readinessDetection:
          "Canonical latest-turn message IDs plus complete-first-fold and usable-composer checks",
        paintDetection: "Two identical renderer animation-frame snapshots for session paint",
        requiredPreparation: ["built release desktop bundle", "isolated T3 home"],
      },
    },
    prepareEnvironment: async ({ runDirectory }) => {
      try {
        await NodeFSP.access(desktopEntry);
      } catch {
        throw new Error(
          `T3 desktop release bundle is missing at ${desktopEntry}; build the desktop app before benchmarking.`,
        );
      }
      const homeDir = NodePath.join(runDirectory, "t3-home");
      const stateDir = NodePath.join(homeDir, "userdata");
      const workspaceRoot = NodePath.join(runDirectory, "workspace");
      const dbPath = NodePath.join(stateDir, "state.sqlite");
      await NodeFSP.mkdir(stateDir, { recursive: true, mode: 0o700 });
      await NodeFSP.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
      const migrationsUrl = NodeURL.pathToFileURL(
        NodePath.join(repoRoot, "apps/server/src/persistence/Migrations.ts"),
      ).href;
      const sqliteClientUrl = NodeURL.pathToFileURL(
        NodePath.join(repoRoot, "apps/server/src/persistence/NodeSqliteClient.ts"),
      ).href;
      const migrations = (await import(migrationsUrl)) as {
        readonly runMigrations: () => Effect.Effect<ReadonlyArray<unknown>, Error, never>;
      };
      const sqliteClient = (await import(sqliteClientUrl)) as {
        readonly layer: (input: { readonly filename: string }) => never;
      };
      const protocolSafeLogger = Logger.layer([Logger.make<unknown, void>(() => undefined)], {
        mergeWithExisting: false,
      });
      await Effect.runPromise(
        migrations
          .runMigrations()
          .pipe(
            Effect.provide(sqliteClient.layer({ filename: dbPath })),
            Effect.provide(protocolSafeLogger) as never,
          ),
      );
      return { homeDir, dbPath, workspaceRoot };
    },
    launchApplication: async ({ environment }) => {
      launchedHomeDir = environment.homeDir;
      // The JS launcher is the desktop-owned canonical Electron resolution path.
      const launcherUrl = NodeURL.pathToFileURL(
        NodePath.join(repoRoot, "apps/desktop/scripts/electron-launcher.mjs"),
      ).href;
      const launcher = (await import(launcherUrl)) as {
        readonly resolveElectronLaunchCommand: (args: ReadonlyArray<string>) => {
          readonly electronPath: string;
          readonly args: ReadonlyArray<string>;
        };
      };
      const command = launcher.resolveElectronLaunchCommand([desktopEntry]);
      const coldReadyStart = NodePerfHooks.performance.now();
      const app = (await _electron.launch({
        executablePath: command.electronPath,
        args: [...command.args],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          T3CODE_HOME: environment.homeDir,
          VITE_DEV_SERVER_URL: "",
        },
      })) as unknown as PlaywrightElectronApplication;
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded");
      await window.waitForSelector("[data-thread-item]");
      await window.bringToFront();
      await window.locator("body").click();
      await window.keyboard.press("Tab");
      const acceptedTrustedInput = await window.evaluate<boolean>(
        "document.hasFocus() && document.activeElement !== document.body",
      );
      if (!acceptedTrustedInput) {
        await app.close();
        throw new Error("T3 renderer did not accept trusted focus/key input during readiness.");
      }
      await window.evaluate<number>(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))))",
      );
      coldReadyTiming = { start: coldReadyStart, end: NodePerfHooks.performance.now() };
      const electronProcess = app.process();
      if (electronProcess.pid === undefined) {
        await app.close();
        throw new Error("Playwright did not return the T3 Electron root PID.");
      }
      launchedProcess = {
        pid: electronProcess.pid,
        startTimeMs: await processStartTimeMs(electronProcess.pid),
        owner: "application",
        category: "electron-main",
      };
      electronApplication = app;
      electronPage = window;
      return {
        processes: [launchedProcess],
        readinessEvidence: "Electron first window reached DOMContentLoaded through Playwright.",
      };
    },
    automation: {
      runScenario: async ({ attemptId, scenario, seed, sessionTargets }) => {
        const page = electronPage;
        if (!page) throw new Error("T3 renderer page is unavailable.");
        if (scenario === "app-cold-ready-v1") {
          if (coldReadyTiming === undefined) throw new Error("Cold readiness was not observed.");
          const sample = workspaceSample({
            attemptId,
            scenario,
            metric: "app.cold_ready_ms",
            startTimestamp: coldReadyTiming.start,
            endTimestamp: coldReadyTiming.end,
          });
          return [
            {
              ...sample,
              evidence: [
                {
                  ...sample.evidence[0]!,
                  name: "electron-launch-to-input-ready",
                  clockOwner: "t3-driver",
                  clockDomain: "node:perf_hooks.performance.now",
                  observerMethod:
                    "Driver launch through two stable renderer paints and trusted focus/key acceptance",
                },
              ],
            },
          ];
        }
        const rows = page.locator("[data-thread-item]");
        const rowCount = await rows.count();
        if (rowCount === 0) throw new Error("No materialized T3 thread rows are visible.");
        if (scenario === "work-item-cold-open-v1") {
          await ensureWorkItemsRendered(page, sessionTargets.length);
          const readinessTarget = sessionTargets[0];
          if (!readinessTarget) {
            throw new Error("Cold opening requires a materialized target thread.");
          }
          const timing = await activateWorkItem(page, readinessTarget, "cold-open");
          return [
            workspaceSample({
              attemptId,
              scenario,
              metric: "work_item.cold_open_ms",
              startTimestamp: timing.start,
              endTimestamp: timing.end,
            }),
          ];
        }
        if (scenario === "work-item-warm-switch-v1") {
          const timings = await switchAmongWorkItems(page, sessionTargets, seed);
          const ordered = timings.map((timing) => timing.end - timing.start).sort((a, b) => a - b);
          const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1]!;
          const sample = workspaceSample({
            attemptId,
            scenario,
            metric: "work_item.warm_switch_p95_ms",
            startTimestamp: timings[0]!.start,
            endTimestamp: timings[0]!.end,
          });
          return [
            {
              ...sample,
              observation: { state: "exact", value: p95, unit: "ms" },
              evidence: timings.map((timing, sequence) => ({
                ...sample.evidence[0]!,
                sequence,
                startTimestamp: timing.start,
                endTimestamp: timing.end,
              })),
            },
          ];
        }
        if (scenario === "resource-sweep-v1") {
          const timings = await switchAmongWorkItems(page, sessionTargets, seed);
          return [
            resourceCoordinationSample({
              attemptId,
              scenario,
              startTimestamp: timings[0]!.start,
              endTimestamp: timings.at(-1)!.end,
            }),
          ];
        }
        if (scenario === "resource-quiescence-v1") {
          const startTimestamp = await page.evaluate<number>(
            "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))))",
          );
          await NodeTimersPromises.setTimeout(75_000);
          const endTimestamp = await page.evaluate<number>("performance.now()");
          return [
            resourceCoordinationSample({ attemptId, scenario, startTimestamp, endTimestamp }),
          ];
        }
        return unavailableScenario();
      },
    },
    shutdownApplication: async () => {
      const process = launchedProcess;
      const app = electronApplication;
      electronApplication = undefined;
      electronPage = undefined;
      coldReadyTiming = undefined;
      launchedProcess = undefined;
      if (!app || !process) return { terminated: [], survivors: [] };
      const electronProcess = app.process();
      return (await closeOwnedElectronApplication(app, electronProcess))
        ? { terminated: [process], survivors: [] }
        : { terminated: [], survivors: [process] };
    },
  };
}

type DriverTerminationSignal = "SIGINT" | "SIGTERM";

export interface T3DriverProcessHost {
  readonly once: (signal: DriverTerminationSignal, listener: () => void) => unknown;
  readonly off: (signal: DriverTerminationSignal, listener: () => void) => unknown;
  readonly exit: (code: number) => void;
}

/**
 * Keeps signal cleanup on the same exact driver-owned application handles. The
 * host is asked to exit only after that cleanup resolves.
 */
export async function runT3DriverExecutable(
  driver: T3Driver,
  input: NodeStream.Readable = NodeProcess.stdin,
  output: NodeStream.Writable = NodeProcess.stdout,
  host?: T3DriverProcessHost,
): Promise<void> {
  const processHost =
    host ?? (NodeProcess as unknown as { readonly default: T3DriverProcessHost }).default;
  let cleanup: Promise<void> | undefined;
  const shutdownOnce = (reason: string): Promise<void> => {
    cleanup ??= driver.shutdown({ reason }).then((result) => {
      if (result.survivors.length > 0) {
        throw new Error(
          `T3 driver cleanup left ${result.survivors.length} surviving owned processes.`,
        );
      }
    });
    return cleanup;
  };
  const terminate = (signal: DriverTerminationSignal, exitCode: number) => {
    void shutdownOnce(`driver-${signal.toLowerCase()}`).then(
      () => processHost.exit(exitCode),
      () => processHost.exit(1),
    );
  };
  const onInterrupt = () => terminate("SIGINT", 130);
  const onTerminate = () => terminate("SIGTERM", 143);
  processHost.once("SIGINT", onInterrupt);
  processHost.once("SIGTERM", onTerminate);
  try {
    await runT3DriverStdio(driver, input, output);
  } finally {
    processHost.off("SIGINT", onInterrupt);
    processHost.off("SIGTERM", onTerminate);
    await shutdownOnce("driver-stdio-closed");
  }
}

if (import.meta.main) {
  const dependencies = await makeDefaultT3DriverDependencies();
  await runT3DriverExecutable(createT3Driver(dependencies));
}
