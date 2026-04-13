import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import {
  type BrowserPerfMetrics,
  summarizeBrowserPerfMetrics,
  type PerfRunArtifact,
  type PerfServerMetricSample,
  writePerfArtifact,
} from "../../../../test/perf/support/artifact";
import {
  installBrowserPerfCollector,
  PERF_BROWSER_GLOBAL,
} from "../../../../test/perf/support/browserMetrics";
import type { PerfThresholdProfile } from "../../../../test/perf/support/thresholds";
import type {
  PerfProviderScenarioId,
  PerfSeedScenarioId,
} from "@t3tools/shared/perf/scenarioCatalog";
import { getPerfSeedScenario } from "@t3tools/shared/perf/scenarioCatalog";
import {
  NoopServerSampler,
  type PerfServerSampler,
} from "../../../../test/perf/support/serverSampler";
import { buildPerfServerEnv } from "./serverEnv";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const serverBinPath = resolve(repoRoot, "apps/server/dist/bin.mjs");
const serverClientIndexPath = resolve(repoRoot, "apps/server/dist/client/index.html");
const PERF_ARTIFACT_DIR_ENV = "T3CODE_PERF_ARTIFACT_DIR";
const PERF_HEADFUL_ENV = "T3CODE_PERF_HEADFUL";
const PERF_SEED_JSON_START = "__T3_PERF_SEED_JSON_START__";
const PERF_SEED_JSON_END = "__T3_PERF_SEED_JSON_END__";

interface PerfSeedThreadSummary {
  readonly id: string;
  readonly projectId: string;
  readonly projectTitle: string | null;
  readonly title: string;
  readonly turnCount: number | null;
  readonly messageCount: number;
  readonly activityCount: number;
  readonly proposedPlanCount: number;
  readonly checkpointCount: number;
}

interface PerfSeedProjectSummary {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly threadCount: number;
}

export interface PerfSeededState {
  readonly scenarioId: PerfSeedScenarioId;
  readonly runParentDir: string;
  readonly baseDir: string;
  readonly workspaceRoot: string;
  readonly projectTitle: string | null;
  readonly projectSummaries: ReadonlyArray<PerfSeedProjectSummary>;
  readonly threadSummaries: ReadonlyArray<PerfSeedThreadSummary>;
}

interface StartPerfAppHarnessOptions {
  readonly suite: string;
  readonly seedScenarioId: PerfSeedScenarioId;
  readonly providerScenarioId?: PerfProviderScenarioId;
  readonly serverSampler?: PerfServerSampler;
}

interface FinishPerfRunOptions {
  readonly suite: string;
  readonly scenarioId: string;
  readonly thresholds: PerfThresholdProfile;
  readonly metadata?: Record<string, unknown>;
  readonly actionSummary?: {
    readonly threadSwitchActionPrefix?: string;
    readonly burstActionName?: string;
  };
  readonly artifactBasename?: string;
}

export interface PerfAppHarness {
  readonly seededState: PerfSeededState;
  readonly page: Page;
  readonly url: string;
  readonly artifactDir: string;
  readonly startAction: (name: string) => Promise<void>;
  readonly endAction: (name: string) => Promise<number | null>;
  readonly resetBrowserMetrics: () => Promise<void>;
  readonly sampleMountedRows: (label: string) => Promise<number>;
  readonly snapshotBrowserMetrics: () => Promise<BrowserPerfMetrics>;
  readonly finishRun: (options: FinishPerfRunOptions) => Promise<{
    readonly artifactPath: string;
    readonly artifact: PerfRunArtifact;
    readonly browserMetrics: BrowserPerfMetrics;
    readonly serverMetrics: ReadonlyArray<PerfServerMetricSample> | null;
  }>;
}

async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to resolve a free localhost port."));
        return;
      }
      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function waitForServerReady(url: string, process: ChildProcess): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = 45_000;
  const requestTimeoutMs = 1_000;

  while (Date.now() - startedAt < timeoutMs) {
    if (process.exitCode !== null) {
      throw new Error(`Perf server exited early with code ${process.exitCode}.`);
    }
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore connection races while the server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }

  throw new Error(`Timed out waiting for perf server readiness at ${url}.`);
}

async function verifyBuiltArtifacts(): Promise<void> {
  await Promise.all([access(serverBinPath), access(serverClientIndexPath)]).catch(() => {
    throw new Error(
      `Built perf artifacts are missing. Expected ${serverBinPath} and ${serverClientIndexPath}. Run bun run test:perf:web or build the app first.`,
    );
  });
}

async function stopChildProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) {
    return;
  }

  process.kill("SIGTERM");
  const exited = await new Promise<boolean>((resolveExited) => {
    const timer = setTimeout(() => resolveExited(false), 5_000);
    process.once("exit", () => {
      clearTimeout(timer);
      resolveExited(true);
    });
  });

  if (!exited && process.exitCode === null) {
    process.kill("SIGKILL");
    await new Promise<void>((resolveExited) => {
      process.once("exit", () => resolveExited());
    });
  }
}

async function ensureArtifactDir(suite: string, scenarioId: string): Promise<string> {
  const baseArtifactDir = resolve(
    process.env[PERF_ARTIFACT_DIR_ENV] ?? join(repoRoot, "artifacts/perf"),
  );
  const runId = `${suite}-${scenarioId}-${Date.now().toString()}`;
  const artifactDir = join(baseArtifactDir, runId);
  await mkdir(artifactDir, { recursive: true });
  return artifactDir;
}

async function cleanupPerfRunDir(runParentDir: string): Promise<void> {
  await rm(runParentDir, { recursive: true, force: true });
}

async function writeServerLogs(
  artifactDir: string,
  stdout: string,
  stderr: string,
  basename: string,
): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  await Promise.all([
    writeFile(join(artifactDir, `${basename}.server.stdout.log`), stdout, "utf8"),
    writeFile(join(artifactDir, `${basename}.server.stderr.log`), stderr, "utf8"),
  ]);
}

async function invokeBrowserCollector<T>(
  page: Page,
  fn: (collectorName: string, ...args: ReadonlyArray<unknown>) => T,
  ...args: ReadonlyArray<unknown>
): Promise<T> {
  return await page.evaluate(
    ({ collectorName, args: serializedArgs, fnSource }) => {
      const runtimeFn = new Function(
        "collectorName",
        "args",
        `return (${fnSource})(collectorName, ...args);`,
      ) as (collectorName: string, args: ReadonlyArray<unknown>) => T;
      return runtimeFn(collectorName, serializedArgs);
    },
    {
      collectorName: PERF_BROWSER_GLOBAL,
      args,
      fnSource: fn.toString(),
    },
  );
}

function parsePerfSeededState(stdout: string): PerfSeededState {
  const startIndex = stdout.lastIndexOf(PERF_SEED_JSON_START);
  const endIndex = stdout.lastIndexOf(PERF_SEED_JSON_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const payload = stdout.slice(startIndex + PERF_SEED_JSON_START.length, endIndex).trim();
    return JSON.parse(payload) as PerfSeededState;
  }

  return JSON.parse(stdout) as PerfSeededState;
}

export async function startPerfAppHarness(
  options: StartPerfAppHarnessOptions,
): Promise<PerfAppHarness> {
  await verifyBuiltArtifacts();

  const seededState = await (async () => {
    const seedProcess = spawn(
      "bun",
      ["run", "apps/server/scripts/seedPerfState.ts", options.seedScenarioId],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    seedProcess.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    seedProcess.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const [exitCode] = (await once(seedProcess, "exit")) as [number | null];
    if (exitCode !== 0) {
      throw new Error(`Perf seed command failed with code ${exitCode ?? "unknown"}.\n${stderr}`);
    }
    return parsePerfSeededState(stdout);
  })();
  const artifactDir = await ensureArtifactDir(options.suite, options.seedScenarioId);
  const port = await pickFreePort();
  const url = `http://127.0.0.1:${port}/`;
  const env = buildPerfServerEnv(process.env, options.providerScenarioId);

  let stdoutBuffer = "";
  let stderrBuffer = "";
  const serverProcess = spawn(
    process.execPath,
    [
      serverBinPath,
      "--mode",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      `${port}`,
      "--base-dir",
      seededState.baseDir,
      "--no-browser",
    ],
    {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  serverProcess.stdout?.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
  });
  serverProcess.stderr?.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
  });
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    await waitForServerReady(url, serverProcess);

    browser = await chromium.launch({
      headless: process.env[PERF_HEADFUL_ENV] !== "1",
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await context.addInitScript(installBrowserPerfCollector, "[data-timeline-row-kind]");
    page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const firstProjectTitle =
      seededState.projectSummaries[0]?.title ??
      seededState.projectTitle ??
      getPerfSeedScenario(options.seedScenarioId).projects[0]?.title;
    if (!firstProjectTitle) {
      throw new Error(`Seed scenario '${options.seedScenarioId}' produced no projects.`);
    }
    await page.getByText(firstProjectTitle, { exact: true }).first().waitFor({ timeout: 45_000 });

    const sampler = options.serverSampler ?? new NoopServerSampler();
    if (serverProcess.pid) {
      await sampler.start({ pid: serverProcess.pid });
    }
    const runStartedAt = new Date().toISOString();
    const readyPage = page;
    if (!readyPage) {
      throw new Error("Perf app harness did not initialize a browser page.");
    }

    let finishPromise:
      | Promise<{
          readonly artifactPath: string;
          readonly artifact: PerfRunArtifact;
          readonly browserMetrics: BrowserPerfMetrics;
          readonly serverMetrics: ReadonlyArray<PerfServerMetricSample> | null;
        }>
      | undefined;

    const teardown = async () => {
      await Promise.allSettled([
        context ? context.close() : Promise.resolve(),
        browser ? browser.close() : Promise.resolve(),
      ]);
      await stopChildProcess(serverProcess);
      await cleanupPerfRunDir(seededState.runParentDir);
    };

    return {
      seededState,
      page: readyPage,
      url,
      artifactDir,
      startAction: (name) =>
        invokeBrowserCollector(
          readyPage,
          (collectorName, actionName) => {
            (window as Window & Record<string, any>)[collectorName]?.startAction(
              actionName as string,
            );
          },
          name,
        ),
      endAction: (name) =>
        invokeBrowserCollector(
          readyPage,
          (collectorName, actionName) => {
            return (
              (window as Window & Record<string, any>)[collectorName]?.endAction(
                actionName as string,
              ) ?? null
            );
          },
          name,
        ),
      resetBrowserMetrics: () =>
        invokeBrowserCollector(readyPage, (collectorName) => {
          (window as Window & Record<string, any>)[collectorName]?.reset();
        }),
      sampleMountedRows: (label) =>
        invokeBrowserCollector(
          readyPage,
          (collectorName, sampleLabel) => {
            return (
              (window as Window & Record<string, any>)[collectorName]?.sampleMountedRows(
                sampleLabel as string,
              ) ?? 0
            );
          },
          label,
        ),
      snapshotBrowserMetrics: () =>
        invokeBrowserCollector(readyPage, (collectorName) => {
          return ((window as Window & Record<string, any>)[collectorName]?.snapshot() ?? {
            actions: [],
            longTasks: [],
            rafGapsMs: [],
            mountedRowSamples: [],
          }) as BrowserPerfMetrics;
        }),
      finishRun: async (finishOptions) => {
        if (finishPromise) {
          return await finishPromise;
        }

        finishPromise = (async () => {
          const completedAt = new Date().toISOString();
          const browserMetrics: BrowserPerfMetrics = await (async () => {
            try {
              return await invokeBrowserCollector(readyPage, (collectorName) => {
                return ((window as Window & Record<string, any>)[collectorName]?.snapshot() ?? {
                  actions: [],
                  longTasks: [],
                  rafGapsMs: [],
                  mountedRowSamples: [],
                }) as BrowserPerfMetrics;
              });
            } catch {
              return {
                actions: [],
                longTasks: [],
                rafGapsMs: [],
                mountedRowSamples: [],
              } satisfies BrowserPerfMetrics;
            }
          })();
          const serverMetrics = await sampler.stop();
          await teardown();

          const basename =
            finishOptions.artifactBasename ?? `${finishOptions.suite}-${finishOptions.scenarioId}`;
          await writeServerLogs(artifactDir, stdoutBuffer, stderrBuffer, basename);
          const artifact: PerfRunArtifact = {
            suite: finishOptions.suite,
            scenarioId: finishOptions.scenarioId,
            startedAt: runStartedAt,
            completedAt,
            thresholds: finishOptions.thresholds,
            summary: summarizeBrowserPerfMetrics(browserMetrics, finishOptions.actionSummary),
            browserMetrics,
            serverMetrics,
            ...(finishOptions.metadata ? { metadata: finishOptions.metadata } : {}),
          };
          const artifactPath = join(artifactDir, `${basename}.json`);
          await writePerfArtifact(artifactPath, artifact);

          return {
            artifactPath,
            artifact,
            browserMetrics,
            serverMetrics,
          };
        })();

        return await finishPromise;
      },
    };
  } catch (error) {
    await Promise.allSettled([
      context ? context.close() : Promise.resolve(),
      browser ? browser.close() : Promise.resolve(),
    ]);
    await stopChildProcess(serverProcess);
    await cleanupPerfRunDir(seededState.runParentDir);
    throw error;
  }
}
