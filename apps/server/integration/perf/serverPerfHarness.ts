import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  type OrchestrationEvent,
  type TerminalEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Scope,
  Stream,
  type Scope as ScopeService,
} from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import {
  summarizeLatencySamples,
  summarizeLatencyValues,
  type PerfLatencySample,
  type PerfLatencySummary,
  writeJsonArtifact,
} from "@t3tools/shared/perf/artifact";
import type {
  PerfProviderScenarioId,
  PerfSeedScenarioId,
} from "@t3tools/shared/perf/scenarioCatalog";
import { seedPerfState, type PerfSeededState } from "./seedPerfState.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const PERF_ARTIFACT_DIR_ENV = "T3CODE_PERF_ARTIFACT_DIR";
const PERF_PROVIDER_ENV = "T3CODE_PERF_PROVIDER";
const PERF_SCENARIO_ENV = "T3CODE_PERF_SCENARIO";
const AUTO_BOOTSTRAP_PROJECT_ENV = "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD";

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

export interface ServerCommandLatencyMeasurement {
  readonly commandType: string;
  readonly loadProfile: string;
  readonly startedAt: string;
  readonly dispatchToAckMs: number;
  readonly dispatchToEventMs: number;
  readonly ackToEventMs: number;
  readonly resultSequence: number;
  readonly eventSequence: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ServerCommandLatencySummary {
  readonly count: number;
  readonly dispatchToAckMs: PerfLatencySummary;
  readonly dispatchToEventMs: PerfLatencySummary;
  readonly ackToEventMs: PerfLatencySummary;
}

export interface ServerCommandLatencySeries {
  readonly name: string;
  readonly loadProfile: string;
  readonly summary: ServerCommandLatencySummary;
  readonly samples: ReadonlyArray<ServerCommandLatencyMeasurement>;
}

export interface ServerRpcLatencySeries {
  readonly name: string;
  readonly loadProfile: string;
  readonly summary: PerfLatencySummary;
  readonly samples: ReadonlyArray<PerfLatencySample>;
}

export interface ServerPerfRunArtifact {
  readonly suite: string;
  readonly scenarioId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly commandLatency: ReadonlyArray<ServerCommandLatencySeries>;
  readonly rpcLatency: ReadonlyArray<ServerRpcLatencySeries>;
  readonly metadata?: Record<string, unknown>;
}

interface StartServerPerfHarnessOptions {
  readonly suite: string;
  readonly seedScenarioId: PerfSeedScenarioId;
  readonly providerScenarioId?: PerfProviderScenarioId;
}

interface FinishServerPerfRunOptions {
  readonly artifactBasename?: string;
  readonly artifact: ServerPerfRunArtifact;
}

export interface ServerPerfHarness {
  readonly seededState: PerfSeededState;
  readonly wsUrl: string;
  readonly artifactDir: string;
  readonly rpc: PerfWsRpcClient;
  readonly finishRun: (options: FinishServerPerfRunOptions) => Promise<{
    readonly artifactPath: string;
    readonly artifact: ServerPerfRunArtifact;
  }>;
  readonly dispose: () => Promise<void>;
}

const wsRpcProtocolLayer = (wsUrl: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerWebSocket(wsUrl)),
    Layer.provide(RpcSerialization.layerJson),
  );

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
    process.env[PERF_ARTIFACT_DIR_ENV] ?? join(repoRoot, "artifacts/perf/server"),
  );
  const runId = `${suite}-${scenarioId}-${Date.now().toString()}`;
  const artifactDir = join(baseArtifactDir, runId);
  await mkdir(artifactDir, { recursive: true });
  return artifactDir;
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

function buildPerfServerEnv(
  baseEnv: NodeJS.ProcessEnv,
  providerScenarioId?: PerfProviderScenarioId,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    [AUTO_BOOTSTRAP_PROJECT_ENV]: "false",
  };

  if (!providerScenarioId) {
    delete env[PERF_PROVIDER_ENV];
    delete env[PERF_SCENARIO_ENV];
    return env;
  }

  return {
    ...env,
    [PERF_PROVIDER_ENV]: "1",
    [PERF_SCENARIO_ENV]: providerScenarioId,
  };
}

export class PerfWsRpcClient {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private readonly clientScope: Scope.Closeable;
  private readonly clientPromise: Promise<WsRpcClient>;
  private disposed = false;

  constructor(private readonly wsUrl: string) {
    this.runtime = ManagedRuntime.make(wsRpcProtocolLayer(wsUrl));
    this.clientScope = this.runtime.runSync(Scope.make());
    this.clientPromise = this.runtime.runPromise(Scope.provide(this.clientScope)(makeWsRpcClient));
  }

  async request<TSuccess, TError>(
    execute: (client: WsRpcClient) => Effect.Effect<TSuccess, TError, never>,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error(`WebSocket RPC client disposed for ${this.wsUrl}`);
    }

    const client = await this.clientPromise;
    return await this.runtime.runPromise(Effect.suspend(() => execute(client)));
  }

  subscribe<TValue>(
    connect: (client: WsRpcClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    const cancel = this.runtime.runCallback(
      Effect.promise(() => this.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
            Effect.sync(() => {
              if (!active) {
                return;
              }
              listener(value);
            }),
          ),
        ),
      ),
    );

    return () => {
      active = false;
      cancel();
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.runtime.runPromise(Scope.close(this.clientScope, Exit.void));
    await this.runtime.dispose();
  }
}

async function waitForRpcReady(wsUrl: string, process: ChildProcess): Promise<void> {
  const startedAtMs = performance.now();
  const timeoutMs = 45_000;

  while (performance.now() - startedAtMs < timeoutMs) {
    if (process.exitCode !== null) {
      throw new Error(`Perf server exited early with code ${process.exitCode}.`);
    }

    const client = new PerfWsRpcClient(wsUrl);
    try {
      await client.request((rpcClient) => rpcClient[WS_METHODS.serverGetSettings]({}));
      await client.dispose();
      return;
    } catch {
      await client.dispose().catch(() => undefined);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
  }

  throw new Error(`Timed out waiting for websocket readiness at ${wsUrl}.`);
}

export function summarizeCommandLatencyMeasurements(
  samples: ReadonlyArray<ServerCommandLatencyMeasurement>,
): ServerCommandLatencySummary {
  return {
    count: samples.length,
    dispatchToAckMs: summarizeLatencyValues(samples.map((sample) => sample.dispatchToAckMs)),
    dispatchToEventMs: summarizeLatencyValues(samples.map((sample) => sample.dispatchToEventMs)),
    ackToEventMs: summarizeLatencyValues(samples.map((sample) => sample.ackToEventMs)),
  };
}

export function summarizeRpcLatencySeries(
  samples: ReadonlyArray<PerfLatencySample>,
): PerfLatencySummary {
  return summarizeLatencySamples(samples);
}

export async function startServerPerfHarness(
  options: StartServerPerfHarnessOptions,
): Promise<ServerPerfHarness> {
  const seededState = await seedPerfState(options.seedScenarioId);
  const artifactDir = await ensureArtifactDir(options.suite, options.seedScenarioId);
  const port = await pickFreePort();
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const env = buildPerfServerEnv(process.env, options.providerScenarioId);

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let finished = false;
  const serverProcess = spawn(
    "bun",
    [
      "run",
      "apps/server/src/bin.ts",
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

  const cleanup = async () => {
    if (finished) {
      return;
    }
    finished = true;
    await stopChildProcess(serverProcess);
    await rm(seededState.runParentDir, { recursive: true, force: true });
  };

  try {
    await waitForRpcReady(wsUrl, serverProcess);
    const rpc = new PerfWsRpcClient(wsUrl);

    return {
      seededState,
      wsUrl,
      artifactDir,
      rpc,
      finishRun: async ({ artifactBasename, artifact }) => {
        const basename = artifactBasename ?? `${artifact.suite}-${artifact.scenarioId}`;
        await rpc.dispose();
        await cleanup();
        await writeServerLogs(artifactDir, stdoutBuffer, stderrBuffer, basename);
        const artifactPath = join(artifactDir, `${basename}.json`);
        await writeJsonArtifact(artifactPath, artifact);
        return {
          artifactPath,
          artifact,
        };
      },
      dispose: async () => {
        await rpc.dispose().catch(() => undefined);
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export type { OrchestrationEvent, ScopeService, TerminalEvent, WsRpcClient };
