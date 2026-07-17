import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { buildSshChildEnvironment, type SshAuthOptions } from "@t3tools/ssh/auth";
import {
  buildSshHostSpecEffect,
  collectProcessOutput,
  runSshCommand,
  targetConnectionKey,
} from "@t3tools/ssh/command";
import { SshCommandError, SshInvalidTargetError } from "@t3tools/ssh/errors";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const MOSH_READY_TIMEOUT = Duration.seconds(20);
const MOSH_SHUTDOWN_TIMEOUT_MS = 2_000;
const MOSH_PROBE_TIMEOUT_MS = 10_000;
const MOSH_READY_MARKER = "T3_MOSH_CONTROL_READY";
const MOSH_CONTROL_COMMAND = `printf '${MOSH_READY_MARKER}\\n'; exec sh -c 'while :; do sleep 3600; done'`;

export class MoshUnsupportedPlatformError extends Schema.TaggedErrorClass<MoshUnsupportedPlatformError>()(
  "MoshUnsupportedPlatformError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Mosh-managed environments are not supported on ${this.platform}.`;
  }
}

export class MoshClientUnavailableError extends Schema.TaggedErrorClass<MoshClientUnavailableError>()(
  "MoshClientUnavailableError",
  { cause: Schema.optionalKey(Schema.Defect()) },
) {
  override get message(): string {
    return "The mosh client is not installed on this machine.";
  }
}

export class MoshServerUnavailableError extends Schema.TaggedErrorClass<MoshServerUnavailableError>()(
  "MoshServerUnavailableError",
  { cause: Schema.optionalKey(Schema.Defect()) },
) {
  override get message(): string {
    return "mosh-server is not installed on the remote machine.";
  }
}

export class MoshSessionStartError extends Schema.TaggedErrorClass<MoshSessionStartError>()(
  "MoshSessionStartError",
  {
    command: Schema.Array(Schema.String),
    stderr: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.stderr.trim() || "The mosh control session exited during startup.";
  }
}

const isMoshSessionStartError = Schema.is(MoshSessionStartError);

export type MoshControlError =
  | MoshUnsupportedPlatformError
  | MoshClientUnavailableError
  | MoshServerUnavailableError
  | MoshSessionStartError
  | SshCommandError
  | SshInvalidTargetError;

export interface MoshControlSession {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly pid: number;
  readonly startedAt: number;
}

interface MoshSessionEntry extends MoshControlSession {
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Scope;
}

export function buildMoshSshCommand(target: DesktopSshEnvironmentTarget): string {
  return target.port === null ? "ssh" : `ssh -p ${target.port}`;
}

export function buildMoshArgs(
  target: DesktopSshEnvironmentTarget,
  input: { readonly udpPortRange?: string } = {},
): Effect.Effect<readonly string[], SshInvalidTargetError> {
  return buildSshHostSpecEffect(target).pipe(
    Effect.map((hostSpec) => [
      "--predict=adaptive",
      `--ssh=${buildMoshSshCommand(target)}`,
      ...(input.udpPortRange ? [`--port=${input.udpPortRange}`] : []),
      hostSpec,
      "--",
      "sh",
      "-lc",
      MOSH_CONTROL_COMMAND,
    ]),
  );
}

const probeLocalMosh = Effect.fn("mosh.probeLocal")(function* () {
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") {
    return yield* new MoshUnsupportedPlatformError({ platform });
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const result = yield* Effect.scoped(
    spawner.spawn(ChildProcess.make("mosh", ["--version"])).pipe(
      Effect.flatMap((child) => child.exitCode),
      Effect.timeoutOption(Duration.millis(MOSH_PROBE_TIMEOUT_MS)),
    ),
  ).pipe(Effect.mapError((cause) => new MoshClientUnavailableError({ cause })));
  if (result._tag === "None" || Number(result.value) !== 0) {
    return yield* new MoshClientUnavailableError({});
  }
});

const probeRemoteMoshServer = Effect.fn("mosh.probeRemoteServer")(function* (
  target: DesktopSshEnvironmentTarget,
  auth?: SshAuthOptions,
) {
  yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-lc", "command -v mosh-server >/dev/null 2>&1"],
    timeoutMs: MOSH_PROBE_TIMEOUT_MS,
    ...(auth?.authSecret === undefined ? {} : { authSecret: auth.authSecret }),
    ...(auth?.batchMode === undefined ? {} : { batchMode: auth.batchMode }),
    ...(auth?.interactiveAuth === undefined ? {} : { interactiveAuth: auth.interactiveAuth }),
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof SshCommandError && cause.exitCode !== null
        ? new MoshServerUnavailableError({ cause })
        : cause,
    ),
  );
});

export interface MoshControlManagerShape {
  readonly ensure: (
    target: DesktopSshEnvironmentTarget,
    options?: { readonly auth?: SshAuthOptions; readonly udpPortRange?: string },
  ) => Effect.Effect<
    MoshControlSession,
    MoshControlError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >;
  readonly disconnect: (target: DesktopSshEnvironmentTarget) => Effect.Effect<void>;
  readonly status: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<MoshControlSession | null>;
}

const make = Effect.fn("mosh.MoshControlManager.make")(function* () {
  const managerScope = yield* Scope.Scope;
  const sessions = new Map<string, MoshSessionEntry>();

  const close = Effect.fn("mosh.MoshControlManager.close")(function* (entry: MoshSessionEntry) {
    sessions.delete(entry.key);
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
  });

  yield* Scope.addFinalizer(
    managerScope,
    Effect.sync(() => [...sessions.values()]).pipe(
      Effect.flatMap((entries) => Effect.forEach(entries, close, { concurrency: "unbounded" })),
      Effect.ignore,
    ),
  );

  const status = Effect.fn("mosh.MoshControlManager.status")(function* (
    target: DesktopSshEnvironmentTarget,
  ) {
    const entry = sessions.get(targetConnectionKey(target));
    if (entry === undefined) return null;
    const running = yield* entry.process.isRunning.pipe(Effect.orElseSucceed(() => false));
    if (!running) {
      yield* close(entry);
      return null;
    }
    return entry;
  });

  const ensure = Effect.fn("mosh.MoshControlManager.ensure")(function* (
    target: DesktopSshEnvironmentTarget,
    options?: { readonly auth?: SshAuthOptions; readonly udpPortRange?: string },
  ): Effect.fn.Return<
    MoshControlSession,
    MoshControlError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    const existing = yield* status(target);
    if (existing !== null) return existing;

    yield* probeLocalMosh();
    yield* probeRemoteMoshServer(target, options?.auth);
    const args = yield* buildMoshArgs(
      target,
      options?.udpPortRange === undefined ? {} : { udpPortRange: options.udpPortRange },
    );
    const env = yield* buildSshChildEnvironment({
      ...(options?.auth?.authSecret === undefined ? {} : { authSecret: options.auth.authSecret }),
      ...(options?.auth?.interactiveAuth === undefined
        ? {}
        : { interactiveAuth: options.auth.interactiveAuth }),
    }).pipe(
      Effect.mapError(
        (cause) => new MoshSessionStartError({ command: ["mosh"], stderr: "", cause }),
      ),
    );
    const command = ["mosh", ...args];
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const entryScope = yield* Scope.make("sequential");
    const child = yield* spawner
      .spawn(
        ChildProcess.make("mosh", args, {
          env: { ...env, TERM: env.TERM || "xterm-256color" },
          extendEnv: true,
          stdin: { stream: Stream.never, endOnDone: true },
        }),
      )
      .pipe(
        Effect.mapError((cause) => new MoshClientUnavailableError({ cause })),
        Effect.provideService(Scope.Scope, entryScope),
      );
    yield* Scope.addFinalizer(
      entryScope,
      child
        .kill({ killSignal: "SIGTERM", forceKillAfter: MOSH_SHUTDOWN_TIMEOUT_MS })
        .pipe(Effect.ignore),
    );
    const ready = child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.includes(MOSH_READY_MARKER)),
      Stream.runHead,
      Effect.flatMap((marker) =>
        marker._tag === "Some"
          ? Effect.void
          : Effect.fail(new MoshSessionStartError({ command, stderr: "" })),
      ),
      Effect.mapError((cause) =>
        isMoshSessionStartError(cause)
          ? cause
          : new MoshSessionStartError({ command, stderr: "", cause }),
      ),
    );
    const exited = child.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        collectProcessOutput(child.stderr).pipe(
          Effect.orElseSucceed(() => ""),
          Effect.flatMap((stderr) =>
            Effect.fail(
              new MoshSessionStartError({
                command,
                stderr:
                  stderr.trim() || `The mosh control session exited with code ${Number(exitCode)}.`,
              }),
            ),
          ),
        ),
      ),
      Effect.mapError((cause) =>
        isMoshSessionStartError(cause)
          ? cause
          : new MoshSessionStartError({ command, stderr: "", cause }),
      ),
    );
    const readiness = yield* Effect.raceFirst(ready, exited).pipe(
      Effect.timeoutOption(MOSH_READY_TIMEOUT),
      Effect.tapError(() => Scope.close(entryScope, Exit.void).pipe(Effect.ignore)),
    );
    if (readiness._tag === "None") {
      yield* Scope.close(entryScope, Exit.void).pipe(Effect.ignore);
      return yield* new MoshSessionStartError({
        command,
        stderr:
          "Mosh did not establish its roaming UDP session within 20 seconds. Check the remote UDP firewall and mosh port range.",
      });
    }
    const entry: MoshSessionEntry = {
      key: targetConnectionKey(target),
      target,
      pid: Number(child.pid),
      startedAt: yield* Clock.currentTimeMillis,
      process: child,
      scope: entryScope,
    };
    sessions.set(entry.key, entry);
    return entry;
  });

  const disconnect = Effect.fn("mosh.MoshControlManager.disconnect")(function* (
    target: DesktopSshEnvironmentTarget,
  ) {
    const entry = sessions.get(targetConnectionKey(target));
    if (entry !== undefined) yield* close(entry);
  });

  return MoshControlManager.of({ ensure, disconnect, status });
});

export class MoshControlManager extends Context.Service<
  MoshControlManager,
  MoshControlManagerShape
>()("@t3tools/mosh/MoshControlManager") {
  static readonly layer = Layer.effect(MoshControlManager)(make());
}
