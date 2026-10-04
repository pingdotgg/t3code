import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  LocalServerPairCommandOutput,
  type LocalServerPairingResult,
  type RunningLocalServer,
} from "@t3tools/contracts";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";
import {
  deriveServerRuntimeStatePath,
  isProcessAlive,
  readPersistedServerRuntimeState,
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

import serverPackageJson from "../../../server/package.json" with { type: "json" };
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const LOCAL_SERVER_PAIRING_TIMEOUT = Duration.seconds(10);
const decodePairCommandOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LocalServerPairCommandOutput),
);

export class LocalServerPairingError extends Schema.TaggedError<LocalServerPairingError>()(
  "LocalServerPairingError",
  {
    reason: Schema.Literals(["not_found", "version_mismatch", "request_failed"]),
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
  // Version of the server bundled with this desktop, i.e. of the `t3 pair` it runs.
  readonly bundledServerVersion: string;
  readonly runsOwnBackend: Effect.Effect<boolean>;
  readonly probeEnvironment: ProbeEnvironment;
  readonly processIsAlive?: (pid: number) => boolean;
}

export class DesktopRunningLocalServers extends Context.Service<
  DesktopRunningLocalServers,
  {
    // The live server that owns this desktop's T3 home, unless it is this launch's own backend.
    readonly discover: Effect.Effect<ReadonlyArray<RunningLocalServer>>;
    readonly pairLocalServer: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<LocalServerPairingResult, LocalServerPairingError>;
  }
>()("@t3tools/desktop/app/DesktopRunningLocalServers") {}

const makePairCommand = (options: DesktopRunningLocalServersOptions) =>
  ChildProcess.make(
    options.executablePath,
    [
      options.backendEntryPath,
      "pair",
      "--json",
      "--label",
      "T3 Code Desktop",
      "--base-dir",
      options.baseDir,
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

  // Only the packaged "userdata" server: dev servers pair through their Vite origin.
  const findHomeServer = Effect.gen(function* () {
    const statePath = deriveServerRuntimeStatePath({
      baseDir: options.baseDir,
      variant: "userdata",
      joinPath: path.join,
    });
    const state = yield* readPersistedServerRuntimeState(statePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    if (Option.isNone(state) || !processIsAlive(state.value.pid)) {
      return Option.none();
    }

    const persistedEnvironmentId = yield* fileSystem
      .readFileString(path.join(path.dirname(statePath), "environment-id"))
      .pipe(
        Effect.map((value) => value.trim()),
        Effect.option,
      );
    if (Option.isNone(persistedEnvironmentId) || persistedEnvironmentId.value.length === 0) {
      return Option.none();
    }

    const descriptor = yield* options.probeEnvironment(state.value.origin);
    if (descriptor === null || descriptor.environmentId !== persistedEnvironmentId.value) {
      return Option.none();
    }

    return Option.some<RunningLocalServer>({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: state.value.origin,
      serverVersion: descriptor.serverVersion,
      pairing:
        descriptor.serverVersion === options.bundledServerVersion
          ? "available"
          : "version-mismatch",
    });
  });

  // While this launch runs its own backend, that backend is the server owning the home.
  const discover = Effect.gen(function* () {
    if (yield* options.runsOwnBackend) return [];
    return Option.toArray(yield* findHomeServer);
  });

  const runPairCommand = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(makePairCommand(options));
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

    // `t3 pair` opens the server's database and runs its migrations.
    if (server.pairing !== "available") {
      return yield* new LocalServerPairingError({
        reason: "version_mismatch",
        detail: `This local server runs T3 Code ${server.serverVersion}, but this app bundles ${options.bundledServerVersion}. Pair it with \`t3 pair\` from the same version instead.`,
      });
    }

    const rawOutput = yield* runPairCommand;
    // No cause: decode issues can quote stdout, which carries the credential.
    const output = yield* decodePairCommandOutput(rawOutput).pipe(
      Effect.mapError(
        () =>
          new LocalServerPairingError({
            reason: "request_failed",
            detail: "The local T3 Code pairing command returned invalid JSON.",
          }),
      ),
    );
    if (output.environmentId !== server.environmentId) {
      return yield* new LocalServerPairingError({
        reason: "request_failed",
        detail: "The local T3 Code pairing command paired a different environment.",
      });
    }

    return {
      pairingUrl: setPairingTokenOnUrl(
        new URL("/pair", server.httpBaseUrl),
        output.token,
      ).toString(),
    } satisfies LocalServerPairingResult;
  });

  return DesktopRunningLocalServers.of({ discover, pairLocalServer });
});

export const layer = Layer.effect(
  DesktopRunningLocalServers,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const httpClient = yield* HttpClient.HttpClient;
    return yield* make({
      baseDir: environment.baseDir,
      backendEntryPath: environment.backendEntryPath,
      backendCwd: environment.backendCwd,
      executablePath: process.execPath,
      // The server inlines this same package.json as its reported serverVersion.
      bundledServerVersion: serverPackageJson.version,
      // Toggling Local environment relaunches the app, so the saved value is this launch's.
      runsOwnBackend: appSettings.get.pipe(
        Effect.map((settings) => settings.localEnvironmentEnabled),
      ),
      probeEnvironment: (httpBaseUrl) =>
        fetchRemoteEnvironmentDescriptor({ httpBaseUrl, timeoutMs: 2_000 }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.orElseSucceed(() => null),
        ),
    });
  }),
);
