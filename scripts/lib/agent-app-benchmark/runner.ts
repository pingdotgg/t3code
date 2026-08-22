// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - owns external benchmark drivers and bounded cleanup timers.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeReadline from "node:readline";

import {
  AGENT_APP_BENCHMARK_VERSION,
  AGENT_APP_DRIVER_PROTOCOL_VERSION,
  decodeDriverMessage,
  decodeRawMetricSample,
  decodeResultBundle,
  PRIMARY_METRIC_UNITS,
  type AgentAppResultBundle,
  type AgentAppProfileId,
  type AgentAppCorpusManifest,
  type AgentAppScenarioId,
  type CoverageEvidence,
  type DriverHelloResult,
  type DriverMethod,
  type EnvironmentDisclosure,
  type OwnedProcess,
  type PrimaryMetricId,
  type RawMetricSample,
} from "./contracts.ts";
import {
  buildBenchmarkReportFromResultBundle,
  renderBenchmarkMarkdown,
  type RunProfile,
} from "./report.ts";
import {
  deriveProcessFamilyMetrics,
  startStandaloneResourceMonitor,
  validateResourceCadence,
  type DeclaredProcessRoot,
  type StandaloneResourceMonitor,
} from "./process-metrics.ts";
import { assertShareableArtifact } from "./privacy.ts";
import { seededShuffle } from "./statistics.ts";

export const AGENT_APP_BENCHMARK_FRAMEWORK_VERSION = AGENT_APP_BENCHMARK_VERSION;

export type { RunProfile } from "./report.ts";
export type RunPhase = "warmup" | "measured" | "diagnostic";

export interface RunScheduleEntry {
  readonly sequence: number;
  readonly phase: RunPhase;
  readonly runIndex: number;
  readonly appId: string;
  readonly scenarioId: string;
}

export interface IncompleteFailure {
  readonly attemptId: string;
  readonly stage: string;
  readonly code: string;
  readonly message: string;
}

export function runProfileCounts(profile: RunProfile): {
  readonly warmups: number;
  readonly measured: number;
} {
  switch (profile) {
    case "smoke":
      return { warmups: 1, measured: 3 };
    case "quick":
      return { warmups: 1, measured: 5 };
    case "publication":
      return { warmups: 3, measured: 20 };
  }
}

export function buildRunSchedule(input: {
  readonly appIds: ReadonlyArray<string>;
  readonly scenarioIds: ReadonlyArray<string>;
  readonly runProfile: RunProfile;
  readonly seed: number;
}): ReadonlyArray<RunScheduleEntry> {
  if (input.appIds.length === 0) throw new Error("At least one app is required.");
  if (input.scenarioIds.length === 0) throw new Error("At least one scenario is required.");
  if (new Set(input.appIds).size !== input.appIds.length)
    throw new Error("App IDs must be unique.");
  if (new Set(input.scenarioIds).size !== input.scenarioIds.length) {
    throw new Error("Scenario IDs must be unique.");
  }
  const counts = runProfileCounts(input.runProfile);
  const schedule: Array<RunScheduleEntry> = [];
  const appendPhase = (phase: "warmup" | "measured", count: number, phaseSeed: number) => {
    for (let runIndex = 0; runIndex < count; runIndex += 1) {
      const scenarios = seededShuffle(input.scenarioIds, phaseSeed + runIndex * 101);
      for (const [scenarioIndex, scenarioId] of scenarios.entries()) {
        const apps = seededShuffle(input.appIds, phaseSeed + runIndex * 1_009 + scenarioIndex * 17);
        for (const appId of apps) {
          schedule.push({
            sequence: schedule.length,
            phase,
            runIndex,
            appId,
            scenarioId,
          });
        }
      }
    }
  };
  appendPhase("warmup", counts.warmups, input.seed ^ 0x57a4_0001);
  appendPhase("measured", counts.measured, input.seed ^ 0x6d45_0002);
  return schedule;
}

export function pairResourceScenarios(
  schedule: ReadonlyArray<RunScheduleEntry>,
): ReadonlyArray<RunScheduleEntry> {
  const groups = new Map<string, Array<RunScheduleEntry>>();
  for (const entry of schedule) {
    const key = `${entry.phase}:${entry.runIndex}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const paired = [...groups.values()].flatMap((group) => {
    const sweep = group.find((entry) => entry.scenarioId === "resource-sweep-v1");
    const quiescence = group.find((entry) => entry.scenarioId === "resource-quiescence-v1");
    if (!sweep || !quiescence) return group;
    const insertionIndex = Math.min(group.indexOf(sweep), group.indexOf(quiescence));
    const remaining = group.filter((entry) => entry !== sweep && entry !== quiescence);
    remaining.splice(insertionIndex, 0, sweep, quiescence);
    return remaining;
  });
  return paired.map((entry, sequence) => ({ ...entry, sequence }));
}

interface PendingRequest {
  readonly method: DriverMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

export interface DriverProcessOptions {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
}

export type BenchmarkInterruptSignal = "SIGINT" | "SIGTERM";

export interface BenchmarkDriverHandle {
  readonly pid: number;
  isRunning(): boolean;
  request(method: DriverMethod, params: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface BenchmarkRunnerDependencies {
  readonly spawnDriver?: (options: DriverProcessOptions) => Promise<BenchmarkDriverHandle>;
  readonly subscribeToInterrupts?: (
    listener: (signal: BenchmarkInterruptSignal) => void,
  ) => () => void;
  readonly startResourceMonitor?: typeof startStandaloneResourceMonitor;
}

class BenchmarkInterruptedError extends Error {
  readonly signal: BenchmarkInterruptSignal;

  constructor(signal: BenchmarkInterruptSignal) {
    super(`Benchmark interrupted by ${signal}.`);
    this.name = "BenchmarkInterruptedError";
    this.signal = signal;
  }
}

function subscribeToProcessInterrupts(
  listener: (signal: BenchmarkInterruptSignal) => void,
): () => void {
  const onSigint = () => listener("SIGINT");
  const onSigterm = () => listener("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

function createInterruptGate() {
  let interrupted: BenchmarkInterruptedError | undefined;
  let resolveInterrupt: (error: BenchmarkInterruptedError) => void = () => undefined;
  const event = new Promise<BenchmarkInterruptedError>((resolve) => {
    resolveInterrupt = resolve;
  });
  return {
    interrupt(signal: BenchmarkInterruptSignal): void {
      if (interrupted !== undefined) return;
      interrupted = new BenchmarkInterruptedError(signal);
      resolveInterrupt(interrupted);
    },
    async race<T>(operation: Promise<T>): Promise<T> {
      if (interrupted !== undefined) throw interrupted;
      return Promise.race([operation, event.then((error) => Promise.reject(error))]);
    },
    throwIfInterrupted(): void {
      if (interrupted !== undefined) throw interrupted;
    },
  };
}

export class DriverProcess {
  readonly #child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #requestTimeoutMs: number;
  readonly #cleanupTimeoutMs: number;
  #running = true;
  #failure: Error | null = null;
  #correlationSequence = 0;

  private constructor(
    child: NodeChildProcess.ChildProcessWithoutNullStreams,
    options: Pick<DriverProcessOptions, "requestTimeoutMs" | "cleanupTimeoutMs">,
  ) {
    this.#child = child;
    // Drivers speak only NDJSON on stdout. Always drain stderr so a verbose
    // driver cannot fill the pipe and deadlock an otherwise valid request.
    child.stderr.resume();
    // Terminal scenarios feed sentinels through a live PTY with per-sentinel
    // settling waits; a full run legitimately exceeds two minutes.
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 600_000;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
    const lines = NodeReadline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    child.once("error", (cause) => this.#fail(new Error("Driver process failed.", { cause })));
    child.once("exit", (code, signal) => {
      this.#running = false;
      if (this.#pending.size > 0) {
        this.#fail(
          new Error(
            `Driver exited before completing all responses (code=${code}, signal=${signal}).`,
          ),
        );
      }
    });
  }

  static spawn(options: DriverProcessOptions): Promise<DriverProcess> {
    return new Promise((resolve, reject) => {
      const child = NodeChildProcess.spawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      const onError = (cause: Error) =>
        reject(new Error("Unable to spawn benchmark driver.", { cause }));
      child.once("error", onError);
      child.once("spawn", () => {
        child.off("error", onError);
        resolve(new DriverProcess(child, options));
      });
    });
  }

  get pid(): number {
    if (this.#child.pid === undefined) throw new Error("Driver PID is unavailable.");
    return this.#child.pid;
  }

  isRunning(): boolean {
    return this.#running;
  }

  async request(method: DriverMethod, params: unknown): Promise<unknown> {
    if (!this.#running) throw this.#failure ?? new Error("Driver process is not running.");
    const correlationId = `request-${this.#correlationSequence++}`;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(correlationId);
        reject(new Error(`Driver request ${method} timed out after ${this.#requestTimeoutMs} ms.`));
      }, this.#requestTimeoutMs);
      timeout.unref();
      this.#pending.set(correlationId, { method, resolve, reject, timeout });
    });
    const request = {
      protocolVersion: AGENT_APP_DRIVER_PROTOCOL_VERSION,
      kind: "request",
      correlationId,
      method,
      params,
    };
    this.#child.stdin.write(`${JSON.stringify(request)}\n`, (cause) => {
      if (!cause) return;
      const pending = this.#pending.get(correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(correlationId);
      pending.reject(new Error(`Unable to write driver request ${method}.`, { cause }));
    });
    return response;
  }

  async close(): Promise<void> {
    if (!this.#running) return;
    this.#child.stdin.end();
    const exited = new Promise<void>((resolve) => this.#child.once("exit", () => resolve()));
    this.#child.kill("SIGTERM");
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<true>((resolve) => {
        const timeout = setTimeout(() => resolve(true), this.#cleanupTimeoutMs);
        timeout.unref();
      }),
    ]);
    if (timedOut && this.#running) {
      this.#child.kill("SIGKILL");
      await exited;
    }
  }

  #handleLine(line: string): void {
    let parsed: ReturnType<typeof decodeDriverMessage>;
    try {
      parsed = decodeDriverMessage(JSON.parse(line));
    } catch (cause) {
      this.#fail(new Error("Driver emitted malformed NDJSON.", { cause }));
      return;
    }
    if (parsed.kind !== "response") {
      this.#fail(new Error("Driver emitted a response that does not match protocol version 1."));
      return;
    }
    const pending = this.#pending.get(parsed.correlationId);
    if (!pending) {
      this.#fail(
        new Error(`Driver returned unknown or duplicate correlation ID ${parsed.correlationId}.`),
      );
      return;
    }
    if (pending.method !== parsed.method) {
      this.#fail(
        new Error(
          `Driver response ${parsed.correlationId} used method ${parsed.method}; expected ${pending.method}.`,
        ),
      );
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(parsed.correlationId);
    if (parsed.ok) {
      pending.resolve(parsed.result);
    } else {
      pending.reject(
        new Error(`Driver error ${parsed.error.code}: ${parsed.error.message}`, {
          cause: parsed.error,
        }),
      );
    }
  }

  #fail(error: Error): void {
    this.#failure = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export async function prepareRunDirectory(outputDirectory: string): Promise<string> {
  await NodeFSP.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(outputDirectory, 0o700);
  const attemptDirectory = NodePath.join(
    outputDirectory,
    `attempt-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${NodeCrypto.randomBytes(4).toString("hex")}`,
  );
  await NodeFSP.mkdir(attemptDirectory, { mode: 0o700 });
  return attemptDirectory;
}

export async function appendSample(
  attemptDirectory: string,
  sample: Readonly<Record<string, unknown>>,
): Promise<void> {
  await NodeFSP.appendFile(
    NodePath.join(attemptDirectory, "samples.ndjson"),
    `${JSON.stringify(sample)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export async function writeIncompleteArtifact(
  attemptDirectory: string,
  failure: IncompleteFailure,
): Promise<string> {
  await NodeFSP.mkdir(attemptDirectory, { recursive: true, mode: 0o700 });
  const output = NodePath.join(attemptDirectory, "run.json");
  await NodeFSP.writeFile(
    output,
    `${JSON.stringify(
      {
        frameworkVersion: AGENT_APP_BENCHMARK_FRAMEWORK_VERSION,
        status: "incomplete",
        failure,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return output;
}

export interface BenchmarkDriverConfiguration {
  readonly id: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface BenchmarkAttemptInput {
  readonly driver: BenchmarkDriverConfiguration;
  readonly corpusPath: string;
  readonly corpusId: string;
  readonly corpusDigestSha256: string;
  readonly corpusManifest: AgentAppCorpusManifest;
  readonly outputDirectory: string;
  readonly profiles: ReadonlyArray<AgentAppProfileId>;
  readonly scenarios: ReadonlyArray<AgentAppScenarioId>;
  readonly runProfile: RunProfile;
  readonly seed: number;
  readonly environment: EnvironmentDisclosure;
  /** Caller-declared caveats, such as disclosure fields it could not measure. */
  readonly extraLimitations?: ReadonlyArray<string>;
  readonly diagnostic?: boolean;
  readonly resourceMonitorPath?: string;
  readonly shareableReport?: boolean;
}

export interface BenchmarkAttemptResult {
  readonly attemptDirectory: string;
  readonly reportPath: string;
  readonly report: ReturnType<typeof buildBenchmarkReportFromResultBundle>;
  readonly hello: DriverHelloResult;
  readonly coverage: ReadonlyArray<CoverageEvidence>;
}

function processRoots(processes: ReadonlyArray<OwnedProcess>): ReadonlyArray<DeclaredProcessRoot> {
  return processes.map((process) => ({
    identity: { pid: process.pid, startTimeMs: process.startTimeMs },
    ownership: process.owner === "application" ? "app" : "harness",
    kind: process.owner === "application" ? "app-helper" : "runner",
    label: process.category,
  }));
}

async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await NodeFSP.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function sha256File(path: string): Promise<string> {
  return NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(path))
    .digest("hex");
}

function assertSupported(
  hello: DriverHelloResult,
  profiles: ReadonlyArray<AgentAppProfileId>,
  scenarios: ReadonlyArray<AgentAppScenarioId>,
): void {
  const supportedProfiles = new Set(hello.capabilities.profiles);
  const supportedScenarios = new Set(hello.capabilities.scenarios);
  const supportedMetrics = new Set(hello.capabilities.metrics);
  for (const profile of profiles) {
    if (!supportedProfiles.has(profile))
      throw new Error(`Driver does not support profile ${profile}.`);
  }
  for (const scenario of scenarios) {
    if (!supportedScenarios.has(scenario)) {
      throw new Error(`Driver does not support scenario ${scenario}.`);
    }
    for (const metric of SCENARIO_METRICS[scenario]) {
      if (!supportedMetrics.has(metric)) {
        throw new Error(`Driver omitted required metric ${metric} for scenario ${scenario}.`);
      }
    }
  }
}

function assertCoverage(
  coverage: ReadonlyArray<CoverageEvidence>,
  profiles: ReadonlyArray<AgentAppProfileId>,
  manifest: AgentAppCorpusManifest,
): void {
  for (const profile of profiles) {
    const evidence = coverage.find((entry) => entry.profile === profile);
    if (!evidence) throw new Error(`Driver omitted coverage for profile ${profile}.`);
    if (!evidence.passed) throw new Error(`Driver failed corpus coverage for profile ${profile}.`);
    if (evidence.corpusDigestSha256 !== manifest.hashes.corpusSha256) {
      throw new Error(`Driver coverage digest differed for profile ${profile}.`);
    }
    if (evidence.semanticSha256 !== manifest.hashes.semanticSha256) {
      throw new Error(`Driver semantic coverage hash differed for profile ${profile}.`);
    }
    if (JSON.stringify(evidence.counts) !== JSON.stringify(manifest.counts)) {
      throw new Error(`Driver semantic coverage counts differed for profile ${profile}.`);
    }
  }
}

function assertProcessOwnership(processes: ReadonlyArray<OwnedProcess>): void {
  if (!processes.some((process) => process.owner === "application")) {
    throw new Error("Driver launch returned no application-owned process root.");
  }
  const identities = new Set<string>();
  for (const process of processes) {
    const identity = `${process.pid}:${process.startTimeMs}`;
    if (identities.has(identity)) throw new Error(`Duplicate process identity ${identity}.`);
    identities.add(identity);
  }
}

function assertScenarioSamples(
  samples: ReadonlyArray<RawMetricSample>,
  entry: RunScheduleEntry,
  attemptId: string,
  profile: AgentAppProfileId,
  expectedMetrics: ReadonlyArray<PrimaryMetricId>,
  seenSampleIds: Set<string>,
): void {
  if (samples.length !== expectedMetrics.length) {
    throw new Error(
      `Scenario ${entry.scenarioId} returned ${samples.length} samples; expected ${expectedMetrics.length}.`,
    );
  }
  const returnedMetrics = new Set<PrimaryMetricId>();
  for (const rawSample of samples) {
    const sample = decodeRawMetricSample(rawSample);
    if (sample.attemptId !== attemptId) {
      throw new Error(`Scenario returned attempt ${sample.attemptId}; expected ${attemptId}.`);
    }
    if (sample.profile !== profile) {
      throw new Error(`Scenario returned profile ${sample.profile}; expected ${profile}.`);
    }
    if (sample.scenario !== entry.scenarioId) {
      throw new Error(`Scenario returned ${sample.scenario}; expected ${entry.scenarioId}.`);
    }
    if (!expectedMetrics.includes(sample.metric)) {
      throw new Error(`Scenario ${entry.scenarioId} returned unexpected metric ${sample.metric}.`);
    }
    if (returnedMetrics.has(sample.metric)) {
      throw new Error(`Scenario ${entry.scenarioId} returned duplicate metric ${sample.metric}.`);
    }
    returnedMetrics.add(sample.metric);
    if (seenSampleIds.has(sample.sampleId))
      throw new Error(`Duplicate sample ID ${sample.sampleId}.`);
    seenSampleIds.add(sample.sampleId);
  }
  for (const metric of expectedMetrics) {
    if (!returnedMetrics.has(metric)) {
      throw new Error(`Scenario ${entry.scenarioId} omitted required metric ${metric}.`);
    }
  }
}

const SCENARIO_PROFILE = {
  "app-cold-ready-v1": "workspace-core-v1",
  "work-item-cold-open-v1": "workspace-core-v1",
  "work-item-warm-switch-v1": "workspace-core-v1",
  "resource-sweep-v1": "resource-core-v1",
  "resource-quiescence-v1": "resource-core-v1",
} as const satisfies Record<AgentAppScenarioId, AgentAppProfileId>;

const SCENARIO_METRICS = {
  "app-cold-ready-v1": ["app.cold_ready_ms"],
  "work-item-cold-open-v1": ["work_item.cold_open_ms"],
  "work-item-warm-switch-v1": ["work_item.warm_switch_p95_ms"],
  "resource-sweep-v1": ["resource.peak_process_family_rss_mib"],
  "resource-quiescence-v1": ["resource.quiescent_cpu_p95_pct"],
} as const satisfies Record<AgentAppScenarioId, ReadonlyArray<PrimaryMetricId>>;

function resourceMetricSample(input: {
  readonly attemptId: string;
  readonly profile: AgentAppProfileId;
  readonly scenario: "resource-sweep-v1" | "resource-quiescence-v1";
  readonly startTimestamp: number;
  readonly endTimestamp: number;
  readonly value: number;
  readonly valid: boolean;
  readonly reasons: ReadonlyArray<string>;
}): RawMetricSample {
  const metric =
    input.scenario === "resource-sweep-v1"
      ? "resource.peak_process_family_rss_mib"
      : "resource.quiescent_cpu_p95_pct";
  const unit = input.scenario === "resource-sweep-v1" ? "MiB" : "percent";
  const evidence = [
    {
      sequence: 0,
      name: "standalone-process-family-observation",
      clockOwner: "benchmark-runner",
      clockDomain: "node:perf_hooks.performance.now",
      resolutionMs: input.scenario === "resource-sweep-v1" ? 250 : 1_000,
      observerMethod:
        "Runner monotonic receipt timeline for native snapshots over declared application roots",
      startTimestamp: input.startTimestamp,
      endTimestamp: input.endTimestamp,
    },
  ] as const;
  return {
    schemaVersion: 1,
    sampleId: `${input.attemptId}-${metric}`,
    attemptId: input.attemptId,
    profile: input.profile,
    scenario: input.scenario,
    metric,
    observation: input.valid
      ? { state: "exact", value: input.value, unit }
      : { state: "invalid", reason: "resource-observation-invalid" },
    evidence,
    validity: input.valid
      ? { status: "valid", evidence: [{ check: "resource-observation", passed: true }] }
      : {
          status: "invalid",
          evidence: [{ check: "resource-observation", passed: false }],
          failures: [
            {
              code: "resource-observation-invalid",
              message: input.reasons.join("; ") || "Resource observation was invalid.",
              evidence: [{ check: "resource-observation", passed: false }],
            },
          ],
        },
  };
}

export async function runBenchmarkAttempt(
  input: BenchmarkAttemptInput,
  dependencies: BenchmarkRunnerDependencies = {},
): Promise<BenchmarkAttemptResult> {
  if (input.profiles.length === 0) throw new Error("At least one profile is required.");
  if (input.scenarios.length === 0) throw new Error("At least one scenario is required.");
  if (
    input.scenarios.includes("resource-quiescence-v1") &&
    !input.scenarios.includes("resource-sweep-v1")
  ) {
    throw new Error("Resource quiescence requires the preceding resource sweep scenario.");
  }
  if (
    input.runProfile === "publication" &&
    (input.environment.thermalState === "unknown" || input.environment.powerSource === "unknown")
  ) {
    throw new Error("Publication runs require disclosed thermal and power states.");
  }
  const attemptDirectory = await prepareRunDirectory(input.outputDirectory);
  const primarySchedule = buildRunSchedule({
    appIds: [input.driver.id],
    scenarioIds: input.scenarios,
    runProfile: input.runProfile,
    seed: input.seed,
  });
  const schedule = pairResourceScenarios(
    input.diagnostic
      ? [
          ...primarySchedule,
          ...input.scenarios.map((scenarioId, index) => ({
            sequence: primarySchedule.length + index,
            phase: "diagnostic" as const,
            runIndex: 0,
            appId: input.driver.id,
            scenarioId,
          })),
        ]
      : primarySchedule,
  );
  const driver = await (dependencies.spawnDriver ?? DriverProcess.spawn)(input.driver);
  const interruptGate = createInterruptGate();
  const unsubscribeFromInterrupts = (
    dependencies.subscribeToInterrupts ?? subscribeToProcessInterrupts
  )((signal) => interruptGate.interrupt(signal));
  const request = (method: DriverMethod, params: unknown) => {
    interruptGate.throwIfInterrupted();
    return interruptGate.race(driver.request(method, params));
  };
  let resourceMonitor: StandaloneResourceMonitor | undefined;
  let hello: DriverHelloResult | undefined;
  let coverage: ReadonlyArray<CoverageEvidence> = [];
  let lifecycleActive = false;
  // Cleanup runs in `finally`, so a cleanup throw would replace whatever
  // failure caused it. Failures are collected here and folded into the
  // incomplete artifact instead of overwriting the original cause.
  const cleanupFailures: Array<string> = [];
  try {
    hello = (await request("hello", {
      frameworkVersion: AGENT_APP_BENCHMARK_VERSION,
    })) as DriverHelloResult;
    assertSupported(hello, input.profiles, input.scenarios);
    await writeJsonArtifact(NodePath.join(attemptDirectory, "environment.json"), input.environment);
    const resultAttempts: Array<AgentAppResultBundle["attempts"][number]> = [];
    const seenSampleIds = new Set<string>();
    const launchedProcesses: Array<{
      readonly sequence: number;
      readonly roots: ReadonlyArray<OwnedProcess>;
    }> = [];
    let activeResourceRoots: ReadonlyArray<DeclaredProcessRoot> | undefined;
    let activeResourceRunDirectory: string | undefined;
    for (const [entryIndex, entry] of schedule.entries()) {
      const profile = SCENARIO_PROFILE[entry.scenarioId as AgentAppScenarioId];
      if (!input.profiles.includes(profile)) {
        throw new Error(`Scenario ${entry.scenarioId} requires unselected profile ${profile}.`);
      }
      const attemptId = `${entry.phase}-${entry.runIndex}-${entry.sequence}`;
      const previousEntry = schedule[entryIndex - 1];
      const continuingResourceLifecycle =
        entry.scenarioId === "resource-quiescence-v1" &&
        previousEntry?.scenarioId === "resource-sweep-v1" &&
        previousEntry.phase === entry.phase &&
        previousEntry.runIndex === entry.runIndex &&
        lifecycleActive &&
        resourceMonitor !== undefined &&
        activeResourceRoots !== undefined &&
        activeResourceRunDirectory !== undefined;
      const runDirectory = continuingResourceLifecycle
        ? activeResourceRunDirectory!
        : NodePath.join(attemptDirectory, `run-${entry.sequence}`);
      const isolatedProfilePath = NodePath.join(runDirectory, "app-profile");
      if (!continuingResourceLifecycle) {
        await NodeFSP.mkdir(isolatedProfilePath, { recursive: true, mode: 0o700 });
      }
      let cleanupSurvivorCount = 0;
      let keepResourceLifecycle = false;
      let scenarioFailure: unknown;
      try {
        let roots = activeResourceRoots;
        if (!continuingResourceLifecycle) {
          const prepared = (await request("prepare", {
            corpusPath: input.corpusPath,
            corpusDigestSha256: input.corpusDigestSha256,
            runDirectory,
            profiles: input.profiles,
          })) as { readonly coverage: ReadonlyArray<CoverageEvidence> };
          lifecycleActive = true;
          assertCoverage(prepared.coverage, input.profiles, input.corpusManifest);
          if (coverage.length === 0) {
            coverage = prepared.coverage;
            await writeJsonArtifact(NodePath.join(attemptDirectory, "coverage.json"), coverage);
          } else if (JSON.stringify(coverage) !== JSON.stringify(prepared.coverage)) {
            throw new Error("Driver coverage changed between isolated benchmark runs.");
          }

          const launched = (await request("launch", { isolatedProfilePath })) as {
            readonly processes: ReadonlyArray<OwnedProcess>;
            readonly automationReady: boolean;
            readonly readinessEvidence: string;
          };
          if (!launched.automationReady) {
            throw new Error("Driver launch did not reach automation readiness.");
          }
          assertProcessOwnership(launched.processes);
          launchedProcesses.push({ sequence: entry.sequence, roots: launched.processes });
          roots = processRoots(launched.processes);
        }
        if (roots === undefined) throw new Error("Resource lifecycle roots are unavailable.");
        const resourceScenario =
          entry.scenarioId === "resource-sweep-v1" || entry.scenarioId === "resource-quiescence-v1";
        if (resourceScenario && resourceMonitor === undefined) {
          if (input.resourceMonitorPath === undefined) {
            throw new Error("Resource-core scenarios require the standalone resource monitor.");
          }
          const primaryRoot = roots.find((root) => root.ownership === "app");
          if (!primaryRoot) {
            throw new Error("No application-owned primary root is available to observe.");
          }
          resourceMonitor = await (
            dependencies.startResourceMonitor ?? startStandaloneResourceMonitor
          )({
            executablePath: input.resourceMonitorPath,
            roots,
            primaryRoot,
            sampleIntervalMs: 250,
          });
        }
        if (entry.scenarioId === "resource-quiescence-v1") {
          if (!continuingResourceLifecycle || resourceMonitor === undefined) {
            throw new Error("Resource quiescence did not immediately follow its measured sweep.");
          }
          resourceMonitor.setSampleInterval(1_000);
        }

        const resourceStartIndex = resourceMonitor?.samples.length ?? 0;
        const resourceScenarioStartTimeMs = resourceScenario
          ? NodePerfHooks.performance.now()
          : undefined;
        const driverResult = (await request("run-scenario", {
          attemptId,
          profile,
          scenario: entry.scenarioId,
          seed: String(input.seed + entry.sequence),
        })) as { readonly samples: ReadonlyArray<RawMetricSample> };
        const resourceScenarioEndTimeMs = resourceScenario
          ? NodePerfHooks.performance.now()
          : undefined;
        let samples = driverResult.samples;
        if (resourceScenario && resourceMonitor !== undefined) {
          const nextEntry = schedule[entryIndex + 1];
          const continuesIntoQuiescence =
            entry.scenarioId === "resource-sweep-v1" &&
            nextEntry?.scenarioId === "resource-quiescence-v1" &&
            nextEntry.phase === entry.phase &&
            nextEntry.runIndex === entry.runIndex;
          if (!continuesIntoQuiescence) await resourceMonitor.stop();
          const resourceSamples = resourceMonitor.samples.slice(resourceStartIndex);
          const resourceErrors = [...resourceMonitor.errors];
          const requestedIntervalMs = entry.scenarioId === "resource-quiescence-v1" ? 1_000 : 250;
          const firstTimestamp = resourceScenarioStartTimeMs ?? 0;
          const requiredEndTimestamp =
            entry.scenarioId === "resource-quiescence-v1"
              ? firstTimestamp + 75_000
              : (resourceScenarioEndTimeMs ?? firstTimestamp);
          const samplesInScenarioWindow = resourceSamples.filter(
            (sample) =>
              sample.monotonicTimeMs >= firstTimestamp &&
              sample.monotonicTimeMs <= requiredEndTimestamp,
          );
          const cadence = validateResourceCadence({
            samples: resourceSamples,
            requestedIntervalMs,
            windowStartTimeMs: firstTimestamp,
            windowEndTimeMs: requiredEndTimestamp,
            monitorErrors: resourceErrors,
          });
          const family = deriveProcessFamilyMetrics({
            samples: samplesInScenarioWindow,
            roots,
            ...(entry.scenarioId === "resource-quiescence-v1"
              ? {
                  quiescentWindow: {
                    startTimeMs: firstTimestamp + 15_000,
                    endTimeMs: firstTimestamp + 75_000,
                  },
                }
              : {}),
          });
          for (const observed of resourceSamples) {
            await NodeFSP.appendFile(
              NodePath.join(attemptDirectory, "resources.ndjson"),
              `${JSON.stringify({ sequence: entry.sequence, sample: observed })}\n`,
              { encoding: "utf8", mode: 0o600 },
            );
          }
          await writeJsonArtifact(
            NodePath.join(runDirectory, `resource-summary-${entry.scenarioId}.json`),
            {
              scenario: entry.scenarioId,
              observerPid: resourceMonitor.pid,
              cadence,
              family,
            },
          );
          const value =
            entry.scenarioId === "resource-sweep-v1"
              ? family.peakResidentBytes / (1_024 * 1_024)
              : (family.quiescentCpuP95Pct ?? 0);
          const reasons = [
            ...cadence.reasons,
            ...family.reasons,
            ...(entry.scenarioId === "resource-quiescence-v1" && family.quiescentCpuP95Pct === null
              ? ["no samples landed in the 60-second quiescent window"]
              : []),
          ];
          samples = [
            resourceMetricSample({
              attemptId,
              profile,
              scenario: entry.scenarioId,
              startTimestamp: firstTimestamp,
              endTimestamp: requiredEndTimestamp,
              value,
              valid: cadence.valid && family.valid && reasons.length === 0,
              reasons,
            }),
          ];
          if (continuesIntoQuiescence) {
            keepResourceLifecycle = true;
            activeResourceRoots = roots;
            activeResourceRunDirectory = runDirectory;
          } else {
            resourceMonitor = undefined;
            activeResourceRoots = undefined;
            activeResourceRunDirectory = undefined;
          }
        }
        assertScenarioSamples(
          samples,
          entry,
          attemptId,
          profile,
          SCENARIO_METRICS[entry.scenarioId as AgentAppScenarioId],
          seenSampleIds,
        );
        for (const sample of samples) {
          await appendSample(attemptDirectory, {
            sequence: entry.sequence,
            phase: entry.phase,
            runIndex: entry.runIndex,
            appId: input.driver.id,
            sample,
          });
        }
        resultAttempts.push({
          attemptId,
          measured: entry.phase === "measured",
          samples,
          diagnostics: [],
        });
      } catch (error) {
        scenarioFailure = error;
        throw error;
      } finally {
        // A cleanup failure is only allowed to become *the* error when the
        // scenario itself succeeded; otherwise it is recorded and the
        // original cause propagates.
        const runCleanup = async (stage: string, cleanup: () => Promise<void>) => {
          try {
            await cleanup();
          } catch (error) {
            if (scenarioFailure === undefined) throw error;
            cleanupFailures.push(
              `${stage}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        };
        if (!keepResourceLifecycle) {
          try {
            await runCleanup(`run-${entry.sequence} resource-monitor-stop`, async () => {
              if (resourceMonitor !== undefined) await resourceMonitor.stop();
            });
          } finally {
            resourceMonitor = undefined;
            activeResourceRoots = undefined;
            activeResourceRunDirectory = undefined;
          }
        }
        if (lifecycleActive && !keepResourceLifecycle) {
          await runCleanup(`run-${entry.sequence} driver-shutdown`, async () => {
            const shutdown = (await request("shutdown", {
              reason: `benchmark-run-${entry.sequence}-complete`,
            })) as {
              readonly terminated: ReadonlyArray<OwnedProcess>;
              readonly survivors: ReadonlyArray<OwnedProcess>;
            };
            lifecycleActive = false;
            cleanupSurvivorCount = shutdown.survivors.length;
          });
        }
      }
      if (cleanupSurvivorCount > 0) {
        throw new Error(`Driver cleanup left ${cleanupSurvivorCount} surviving owned processes.`);
      }
    }
    await driver.close();
    interruptGate.throwIfInterrupted();

    const resultBundleWithoutStatistics: AgentAppResultBundle = {
      schemaVersion: 1,
      frameworkVersion: String(AGENT_APP_BENCHMARK_VERSION),
      runId: NodePath.basename(attemptDirectory),
      corpus: { corpusId: input.corpusId, digestSha256: input.corpusDigestSha256 },
      runProfile: input.runProfile,
      application: hello.application,
      driver: hello.driver,
      profiles: input.profiles,
      environment: input.environment,
      resourceTopology: {
        included: launchedProcesses.flatMap((run) =>
          run.roots.filter((process) => process.owner === "application"),
        ),
        excluded: launchedProcesses.flatMap((run) =>
          run.roots.filter((process) => process.owner === "harness"),
        ),
        unattributed: [],
      },
      attempts: resultAttempts,
      statistics: [],
      limitations: [
        "Operating-system caches are not flushed; cold means a fresh process and isolated profile.",
        "Resource memory is a sampled peak at the framework cadence, not an instantaneous maximum.",
        ...(input.extraLimitations ?? []),
      ],
    };
    const preliminaryReport = buildBenchmarkReportFromResultBundle(resultBundleWithoutStatistics, {
      bootstrapSeed: input.seed,
    });
    const resultBundle = decodeResultBundle({
      ...resultBundleWithoutStatistics,
      statistics: preliminaryReport.metrics.flatMap((metric) =>
        metric.median !== undefined && metric.confidenceInterval !== undefined
          ? [
              {
                profile: metric.profileId as AgentAppProfileId,
                metric: metric.metricId as PrimaryMetricId,
                unit: PRIMARY_METRIC_UNITS[metric.metricId as PrimaryMetricId],
                median: metric.median,
                confidenceInterval95: {
                  lower: metric.confidenceInterval.low,
                  upper: metric.confidenceInterval.high,
                },
                measuredCount: metric.measuredSamples,
                invalidCount: metric.invalidSamples,
              },
            ]
          : [],
      ),
    });
    const coveragePath = NodePath.join(attemptDirectory, "coverage.json");
    const environmentPath = NodePath.join(attemptDirectory, "environment.json");
    const samplesPath = NodePath.join(attemptDirectory, "samples.ndjson");
    const resultPath = NodePath.join(attemptDirectory, "result.json");
    await writeJsonArtifact(resultPath, resultBundle);
    const report = buildBenchmarkReportFromResultBundle(resultBundle, {
      bootstrapSeed: input.seed,
    });
    if (input.shareableReport) assertShareableArtifact(report);
    const reportPath = NodePath.join(attemptDirectory, "report.md");
    const renderedReport = renderBenchmarkMarkdown(report);
    await NodeFSP.writeFile(reportPath, renderedReport, {
      encoding: "utf8",
      mode: 0o600,
    });
    const runArtifact = {
      schemaVersion: 1,
      frameworkVersion: AGENT_APP_BENCHMARK_VERSION,
      status: "complete",
      runProfile: input.runProfile,
      seed: input.seed,
      corpus: { id: input.corpusId, digestSha256: input.corpusDigestSha256 },
      application: hello.application,
      driver: hello.driver,
      schedule,
      processes: launchedProcesses,
      artifactDigests: {
        coverage: await sha256File(coveragePath),
        environment: await sha256File(environmentPath),
        samples: await sha256File(samplesPath),
        result: await sha256File(resultPath),
        report: await sha256File(reportPath),
      },
    };
    await writeJsonArtifact(NodePath.join(attemptDirectory, "run.json"), runArtifact);
    interruptGate.throwIfInterrupted();
    return { attemptDirectory, reportPath, report, hello, coverage };
  } catch (cause) {
    if (resourceMonitor !== undefined) {
      try {
        await resourceMonitor.stop();
      } catch {
        // Incomplete artifact below records the failed attempt; the monitor is
        // still addressed only through its captured child handle.
      }
      resourceMonitor = undefined;
    }
    if (driver.isRunning() && lifecycleActive) {
      try {
        await driver.request("shutdown", { reason: "benchmark-failed" });
        lifecycleActive = false;
      } catch {
        // The exact child handle is still closed below; failed protocol cleanup
        // remains visible in the incomplete artifact.
      }
    }
    await driver.close();
    const interrupted = cause instanceof BenchmarkInterruptedError;
    await writeIncompleteArtifact(attemptDirectory, {
      attemptId: NodePath.basename(attemptDirectory),
      stage: interrupted
        ? "interrupted"
        : hello === undefined
          ? "driver-handshake"
          : coverage.length === 0
            ? "prepare"
            : "run",
      code: interrupted ? "benchmark-interrupted" : "benchmark-attempt-incomplete",
      message: [
        cause instanceof Error ? cause.message : "Unknown benchmark failure.",
        ...(cleanupFailures.length === 0
          ? []
          : [`Cleanup also failed — ${cleanupFailures.join("; ")}`]),
      ].join(" "),
    });
    throw cause;
  } finally {
    unsubscribeFromInterrupts();
  }
}
