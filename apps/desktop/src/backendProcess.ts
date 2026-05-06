import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { BackendTimeoutError, waitForHttpReadyEffect } from "./backendReadiness.ts";

const DEFAULT_BACKEND_READINESS_TIMEOUT = Duration.minutes(1);
const DEFAULT_BACKEND_TERMINATE_GRACE = Duration.seconds(2);

export interface BackendProcessExit {
  readonly code: number | null;
  readonly reason: string;
  readonly cause: unknown;
}

export interface RunBackendProcessOptions {
  readonly executablePath: string;
  readonly entryPath: string;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly bootstrap: DesktopBackendBootstrapValue;
  readonly httpBaseUrl: URL;
  readonly captureOutput: boolean;
  readonly readinessTimeout?: Duration.Duration;
  readonly onStarted?: (pid: number) => Effect.Effect<void>;
  readonly onReady?: () => Effect.Effect<void>;
  readonly onReadinessFailure?: (error: BackendTimeoutError) => Effect.Effect<void>;
  readonly onOutput?: (streamName: "stdout" | "stderr", chunk: Uint8Array) => Effect.Effect<void>;
}

const encodeBootstrapJson = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));

function describeProcessExit(
  result: Result.Result<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>,
): BackendProcessExit {
  if (Result.isSuccess(result)) {
    const code = Number(result.success);
    return {
      code,
      reason: `code=${code}`,
      cause: result.success,
    };
  }

  return {
    code: null,
    reason: result.failure.message,
    cause: result.failure,
  };
}

function drainBackendOutput(
  streamName: "stdout" | "stderr",
  stream: Stream.Stream<Uint8Array, unknown>,
  onOutput: (streamName: "stdout" | "stderr", chunk: Uint8Array) => Effect.Effect<void>,
): Effect.Effect<void> {
  return stream.pipe(
    Stream.runForEach((chunk) => onOutput(streamName, chunk)),
    Effect.ignore,
  );
}

export const runBackendProcess = Effect.fn("runBackendProcess")(function* (
  options: RunBackendProcessOptions,
): Effect.fn.Return<
  BackendProcessExit,
  unknown,
  ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bootstrapJson = yield* encodeBootstrapJson(options.bootstrap);
  const onOutput = options.onOutput ?? (() => Effect.void);
  const command = ChildProcess.make(
    options.executablePath,
    [options.entryPath, "--bootstrap-fd", "3"],
    {
      cwd: options.cwd,
      env: options.env,
      extendEnv: false,
      // In Electron main, process.execPath points to the Electron binary.
      // Run the child in Node mode so this backend process does not become a GUI app instance.
      stdin: "ignore",
      stdout: options.captureOutput ? "pipe" : "inherit",
      stderr: options.captureOutput ? "pipe" : "inherit",
      killSignal: "SIGTERM",
      forceKillAfter: DEFAULT_BACKEND_TERMINATE_GRACE,
      additionalFds: {
        fd3: {
          type: "input",
          stream: Stream.encodeText(Stream.make(`${bootstrapJson}\n`)),
        },
      },
    },
  );

  const handle = yield* spawner.spawn(command);

  yield* options.onStarted?.(Number(handle.pid)) ?? Effect.void;
  if (options.captureOutput) {
    yield* drainBackendOutput("stdout", handle.stdout, onOutput).pipe(Effect.forkScoped);
    yield* drainBackendOutput("stderr", handle.stderr, onOutput).pipe(Effect.forkScoped);
  }
  yield* waitForHttpReadyEffect(options.httpBaseUrl, {
    timeout: options.readinessTimeout ?? DEFAULT_BACKEND_READINESS_TIMEOUT,
  }).pipe(
    Effect.tap(() => options.onReady?.() ?? Effect.void),
    Effect.catch((error) => options.onReadinessFailure?.(error) ?? Effect.void),
    Effect.forkScoped,
  );

  return describeProcessExit(yield* Effect.result(handle.exitCode));
});
