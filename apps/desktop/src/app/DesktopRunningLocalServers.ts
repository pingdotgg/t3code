import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  LocalServerPairCommandOutput,
  type LocalServerPairingResult,
  type RunningLocalServer,
} from "@t3tools/contracts";
import {
  deriveServerRuntimeStatePath,
  isProcessAlive,
  readPersistedServerRuntimeState,
  type ServerRuntimeStateVariant,
} from "@t3tools/shared/serverRuntimeState";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const LOCAL_SERVER_PAIRING_TIMEOUT = Duration.seconds(10);
const SERVER_RUNTIME_STATE_VARIANTS = ["userdata", "dev"] as const;
const decodePairCommandOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LocalServerPairCommandOutput),
);

export class LocalServerPairingError extends Schema.TaggedErrorClass<LocalServerPairingError>()(
  "LocalServerPairingError",
  {
    reason: Schema.Literals(["not_found", "request_failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const isLocalServerPairingError = Schema.is(LocalServerPairingError);

type ProbeEnvironment = (
  httpBaseUrl: string,
) => Effect.Effect<ExecutionEnvironmentDescriptor | null>;

export interface DesktopRunningLocalServersOptions {
  readonly baseDir: string;
  readonly backendEntryPath: string;
  readonly backendCwd: string;
  readonly executablePath: string;
  readonly probeEnvironment: ProbeEnvironment;
  readonly processIsAlive?: (pid: number) => boolean;
}

export class DesktopRunningLocalServers extends Context.Service<
  DesktopRunningLocalServers,
  {
    readonly discover: Effect.Effect<ReadonlyArray<RunningLocalServer>>;
    readonly pairLocalServer: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<LocalServerPairingResult, LocalServerPairingError>;
  }
>()("@t3tools/desktop/app/DesktopRunningLocalServers") {}

export function isValidLocalServerPairingUrl(input: {
  readonly pairingUrl: string;
  readonly httpBaseUrl: string;
  readonly token: string;
}): boolean {
  try {
    const pairingUrl = new URL(input.pairingUrl);
    const httpBaseUrl = new URL(input.httpBaseUrl);
    const token = new URLSearchParams(pairingUrl.hash.slice(1)).get("token")?.trim();
    return (
      pairingUrl.origin === httpBaseUrl.origin &&
      pairingUrl.username === "" &&
      pairingUrl.password === "" &&
      pairingUrl.pathname === "/pair" &&
      pairingUrl.search === "" &&
      token !== undefined &&
      token.length > 0 &&
      token === input.token
    );
  } catch {
    return false;
  }
}

function parseUrlOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const makePairCommand = (options: DesktopRunningLocalServersOptions, server: RunningLocalServer) =>
  ChildProcess.make(
    options.executablePath,
    [
      options.backendEntryPath,
      "pair",
      "--json",
      "--label",
      "T3 Code Desktop",
      "--base-dir",
      server.baseDir,
    ],
    {
      cwd: options.backendCwd,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: Duration.seconds(2),
    },
  );

export const make = Effect.fn("desktop.runningLocalServers.make")(function* (
  options: DesktopRunningLocalServersOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const processIsAlive = options.processIsAlive ?? isProcessAlive;

  const discover = Effect.gen(function* () {
    const discovered = yield* Effect.forEach(
      SERVER_RUNTIME_STATE_VARIANTS,
      (variant) =>
        Effect.gen(function* () {
          const statePath = deriveServerRuntimeStatePath({
            baseDir: options.baseDir,
            variant,
            joinPath: path.join,
          });
          const state = yield* readPersistedServerRuntimeState(statePath).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          );
          if (Option.isNone(state) || state.value.pid <= 0 || !processIsAlive(state.value.pid)) {
            return null;
          }

          const persistedEnvironmentId = yield* fileSystem
            .readFileString(path.join(path.dirname(statePath), "environment-id"))
            .pipe(
              Effect.map((value) => value.trim()),
              Effect.option,
            );
          if (Option.isNone(persistedEnvironmentId) || persistedEnvironmentId.value.length === 0) {
            return null;
          }

          const descriptor = yield* options.probeEnvironment(state.value.origin);
          if (descriptor === null || descriptor.environmentId !== persistedEnvironmentId.value) {
            return null;
          }

          return {
            statePath,
            baseDir: options.baseDir,
            variant,
            pid: state.value.pid,
            httpBaseUrl: state.value.origin,
            startedAt: state.value.startedAt,
            environmentId: descriptor.environmentId,
            label: descriptor.label,
          } satisfies RunningLocalServer;
        }),
      { concurrency: "unbounded" },
    );

    const byEnvironmentId = new Map<EnvironmentId, RunningLocalServer>();
    for (const server of discovered) {
      if (server !== null && !byEnvironmentId.has(server.environmentId)) {
        byEnvironmentId.set(server.environmentId, server);
      }
    }
    return [...byEnvironmentId.values()].toSorted(
      (left, right) =>
        left.label.localeCompare(right.label) || left.statePath.localeCompare(right.statePath),
    );
  });

  const runPairCommand = (server: RunningLocalServer) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(makePairCommand(options, server));
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
          return yield* new LocalServerPairingError({
            reason: "request_failed",
            detail:
              stderr.trim() || `The local pairing command exited with code ${String(exitCode)}.`,
          });
        }
        return stdout.trim();
      }),
    ).pipe(
      Effect.timeout(LOCAL_SERVER_PAIRING_TIMEOUT),
      Effect.mapError((cause) =>
        isLocalServerPairingError(cause)
          ? cause
          : new LocalServerPairingError({
              reason: "request_failed",
              detail: "Could not run the bundled T3 Code pairing command.",
              cause,
            }),
      ),
    );

  const pairLocalServer = Effect.fn("desktop.runningLocalServers.pair")(function* (
    environmentId: EnvironmentId,
  ) {
    const servers = yield* discover;
    const server = servers.find((candidate) => candidate.environmentId === environmentId);
    if (server === undefined) {
      return yield* new LocalServerPairingError({
        reason: "not_found",
        detail: "This local T3 Code server is no longer running.",
      });
    }

    const rawOutput = yield* runPairCommand(server);
    const output = yield* decodePairCommandOutput(rawOutput).pipe(
      Effect.mapError(
        (cause) =>
          new LocalServerPairingError({
            reason: "request_failed",
            detail: "The local T3 Code pairing command returned invalid JSON.",
            cause,
          }),
      ),
    );

    const outputOrigin = parseUrlOrigin(output.origin);
    const discoveredOrigin = parseUrlOrigin(server.httpBaseUrl);
    if (outputOrigin === null || discoveredOrigin === null) {
      return yield* new LocalServerPairingError({
        reason: "request_failed",
        detail: "The local T3 Code pairing command returned an invalid server origin.",
      });
    }
    if (
      output.environmentId !== server.environmentId ||
      outputOrigin !== discoveredOrigin ||
      !isValidLocalServerPairingUrl({
        pairingUrl: output.pairingUrl,
        httpBaseUrl: server.httpBaseUrl,
        token: output.token,
      })
    ) {
      return yield* new LocalServerPairingError({
        reason: "request_failed",
        detail: "The local T3 Code pairing command returned an invalid pairing link.",
      });
    }

    return {
      pairingUrl: output.pairingUrl,
      pairingExpiresAt: output.expiresAt,
    } satisfies LocalServerPairingResult;
  });

  return DesktopRunningLocalServers.of({ discover, pairLocalServer });
});

export const layer = Layer.effect(
  DesktopRunningLocalServers,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const httpClient = yield* HttpClient.HttpClient;
    return yield* make({
      baseDir: environment.baseDir,
      backendEntryPath: environment.backendEntryPath,
      backendCwd: environment.backendCwd,
      executablePath: process.execPath,
      probeEnvironment: (httpBaseUrl) =>
        fetchRemoteEnvironmentDescriptor({ httpBaseUrl, timeoutMs: 2_000 }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.orElseSucceed(() => null),
        ),
    });
  }),
);
