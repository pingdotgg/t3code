// @effect-diagnostics nodeBuiltinImport:off - the detached installer needs a raw spawn and a log fd
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ServerProviderUpdateError,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdatedPayload,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { HttpClient } from "effect/http";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import * as ModelManifest from "./ModelManifest.ts";
import { resolveProviderCompatibility } from "./providerCompatibility.ts";
import * as ProviderInstallLock from "./ProviderInstallLock.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { makeProviderMaintenanceCommandCoordinator } from "./providerMaintenanceCommandCoordinator.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  invalidateLatestProviderVersion,
  makeTargetedProviderUpdateAction,
  resolveLatestProviderUpdateAction,
  resolveLatestProviderVersion,
  type ProviderMaintenanceCommandAction,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import type { ProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

// An installer is never cut off mid-write for taking long; this only frees the
// install lock and held turn starts from one that hangs.
const INSTALL_BACKSTOP = Duration.minutes(30);
const INSTALL_GO_TIMEOUT = Duration.seconds(30);
// Only these may run their own updater without a pinned `package@version`.
const SELF_UPDATING_LOCK_KEY = /^(?:homebrew|grok|muse:.*|.+-native)$/;
const UPDATE_OUTPUT_MAX_BYTES = 10_000;
const INSTALL_LOG_MAX_BYTES = 1_048_576;
// Sample installer output because every progress update resends the provider list to all clients.
const UPDATE_PROGRESS_INTERVAL = Duration.seconds(1);
const UPDATE_PROGRESS_MAX_LENGTH = 200;
// An installer may write for minutes without a line ending; only its tail matters.
const UPDATE_PARTIAL_LINE_MAX_LENGTH = 4_096;

export interface ProviderMaintenanceCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProviderMaintenanceRunnerShape {
  readonly updateProvider: (
    target:
      | ProviderDriverKind
      | {
          readonly provider: ProviderDriverKind;
          readonly instanceId?: ProviderInstanceId | undefined;
          readonly targetVersion?: string | undefined;
          /**
           * Install `targetVersion` unattended: publishes no update state, refuses
           * anything but a pinned (or self-updating) install, and skips when the
           * installed version already reaches the target.
           */
          readonly background?: boolean | undefined;
          /** Last check before a background install starts, run under the install lock. */
          readonly beforeInstall?: Effect.Effect<boolean> | undefined;
        },
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderUpdateError>;
}

export class ProviderMaintenanceRunner extends Context.Service<
  ProviderMaintenanceRunner,
  ProviderMaintenanceRunnerShape
>()("t3/provider/providerMaintenanceRunner") {}

class ProviderMaintenanceCommandError extends Schema.TaggedError<ProviderMaintenanceCommandError>()(
  "ProviderMaintenanceCommandError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

interface VerifiedProviderRefresh {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly verifiedProviders: ReadonlyArray<ServerProvider>;
  readonly advisoryEnriched: boolean;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export interface ProviderInstallInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly onProgress?: ((line: string) => Effect.Effect<void>) | undefined;
  /** Must record the gated wrapper's pid before allowing it to start the installer. */
  readonly recordChildPid: (pid: number) => Effect.Effect<void, Error>;
}

/** Runs one provider installer to completion. */
export class ProviderInstaller extends Context.Service<
  ProviderInstaller,
  {
    readonly run: (
      input: ProviderInstallInput,
    ) => Effect.Effect<ProviderMaintenanceCommandResult, Error>;
  }
>()("t3/provider/providerMaintenanceRunner/ProviderInstaller") {}

const noop = () => {};

const encodeInstallWrapperInput = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      command: Schema.String,
      args: Schema.Array(Schema.String),
      shell: Schema.Boolean,
      runAsNode: Schema.optional(Schema.String),
    }),
  ),
);

// EOF or the go deadline aborts without touching the install target. The wrapper
// owns the installer pipes, so a server exit cannot break their reader.
const INSTALL_WRAPPER = `
const goDeadline = performance.now() + ${Duration.toMillis(INSTALL_GO_TIMEOUT)};
const { spawn } = require("node:child_process");
const { command, args, shell, runAsNode } = JSON.parse(process.argv[1]);
let started = false;
const goTimeout = setTimeout(() => process.exit(1), ${Duration.toMillis(INSTALL_GO_TIMEOUT)});
process.stdin.once("end", () => { if (!started) process.exit(1); });
process.stdin.once("data", (data) => {
  if (data[0] !== 103 || performance.now() >= goDeadline) process.exit(1);
  started = true;
  clearTimeout(goTimeout);
  process.stdin.destroy();
  const env = { ...process.env };
  if (runAsNode === undefined) delete env.ELECTRON_RUN_AS_NODE;
  else env.ELECTRON_RUN_AS_NODE = runAsNode;
  const fs = require("node:fs");
  let logBytes = 0;
  const appendLog = (chunk) => {
    try {
      if (logBytes + chunk.length > ${INSTALL_LOG_MAX_BYTES}) {
        const tail = Buffer.alloc(Math.min(logBytes, ${UPDATE_OUTPUT_MAX_BYTES + 1}));
        fs.readSync(1, tail, 0, tail.length, logBytes - tail.length);
        fs.ftruncateSync(1, 0);
        logBytes = fs.writeSync(1, tail);
      }
      logBytes += fs.writeSync(1, chunk);
    } catch {}
  };
  const installer = spawn(command, args, {
    shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env,
  });
  installer.stdout.on("data", appendLog);
  installer.stderr.on("data", appendLog);
  // This backstop survives the server that normally enforces the same limit.
  let timedOut = false;
  const backstop = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(installer.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore",
      });
      killer.once("error", () => process.exit(1));
      killer.once("exit", () => process.exit(1));
    } else {
      try { process.kill(-process.pid, "SIGKILL"); }
      catch (error) { console.error(error); process.exit(1); }
    }
  }, ${Duration.toMillis(INSTALL_BACKSTOP)});
  installer.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  installer.once("exit", (code) => {
    process.exitCode = timedOut ? 1 : code ?? 1;
  });
  installer.once("close", () => clearTimeout(backstop));
});
`;

/**
 * Runs an installer as a detached process whose output goes to a log file. It
 * is not tied to this server: quitting the server neither kills the installer
 * nor breaks its stdio (no EPIPE), so an npm extract is never cut in half. Only
 * the backstop ends it, and a result is returned once it exits.
 */
export const runDetachedInstall = Effect.fn("ProviderMaintenanceRunner.runDetachedInstall")(
  function* (
    input: ProviderInstallInput,
    spawnProcess: typeof NodeChildProcess.spawn = NodeChildProcess.spawn,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const environment = yield* HostProcess.Environment;
    const childEnvironment = { ...environment, ...input.env };
    const node = yield* resolveNodeExecutable("Provider CLI updates", childEnvironment);
    // Windows batch shims need shell dispatch through resolveSpawnCommand.
    const resolved = yield* resolveSpawnCommand(input.command, input.args, {
      ...(input.env ? { env: input.env } : {}),
      extendEnv: true,
    });
    const toError = (cause: unknown) =>
      new ProviderMaintenanceCommandError({
        message: `Failed to run update command ${input.command}: ${cause instanceof Error ? cause.message : "unknown error"}`,
        cause,
      });
    const logPath = yield* fileSystem.makeTempFileScoped({ prefix: "t3-provider-install-" });
    // The child gets its own copy of this fd, so it is closed here once the child has spawned.
    const logFd = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.openSync(logPath, "a+")),
      (fd) => Effect.sync(() => NodeFS.closeSync(fd)),
    );

    // Listeners are registered in the spawn tick: Node emits `spawn` and `exit`
    // asynchronously, and a late listener would wait forever.
    const { child, spawned, exited } = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const child = spawnProcess(
            node,
            [
              "-e",
              INSTALL_WRAPPER,
              encodeInstallWrapperInput({
                ...resolved,
                runAsNode: childEnvironment.ELECTRON_RUN_AS_NODE,
              }),
            ],
            {
              detached: true,
              windowsHide: true,
              stdio: ["pipe", logFd, logFd],
              env: {
                ...childEnvironment,
                ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
              },
            },
          );
          const spawned = Deferred.makeUnsafe<number, Error>();
          const exited = Deferred.makeUnsafe<number | null>();
          child.on("error", (cause) => Deferred.doneUnsafe(spawned, Effect.fail(toError(cause))));
          child.once("spawn", () => Deferred.doneUnsafe(spawned, Effect.succeed(child.pid ?? 0)));
          child.once("exit", (code) => Deferred.doneUnsafe(exited, Effect.succeed(code)));
          child.stdin!.on("error", noop);
          child.unref();
          return { child, spawned, exited };
        },
        catch: toError,
      }),
      ({ child }) => Effect.sync(() => child.stdin!.destroy()),
    );
    const pid = yield* Deferred.await(spawned);
    yield* input.recordChildPid(pid).pipe(
      Effect.andThen(
        Effect.callback<void, Error>((resume) => {
          child.stdin!.end("g", (error?: Error | null) =>
            resume(error ? Effect.fail(toError(error)) : Effect.void),
          );
        }),
      ),
      Effect.uninterruptible,
    );

    const readLog = Effect.gen(function* () {
      const file = yield* fileSystem.open(logPath, { flag: "r" });
      const info = yield* file.stat;
      const limit = BigInt(UPDATE_OUTPUT_MAX_BYTES);
      const offset = info.size > limit ? info.size - limit : 0n;
      yield* file.seek(offset, "start");
      const bytes = new Uint8Array(Number(info.size - offset));
      let length = 0;
      while (length < bytes.length) {
        const read = Number(yield* file.read(bytes.subarray(length)));
        if (read === 0) break;
        length += read;
      }
      return { bytes: bytes.subarray(0, length), truncated: offset > 0n };
    }).pipe(
      Effect.scoped,
      Effect.orElseSucceed(() => ({ bytes: new Uint8Array(), truncated: false })),
    );
    const onProgress = input.onProgress;
    if (onProgress) {
      yield* readLog.pipe(
        Effect.map(({ bytes }) => {
          const split = splitOutputLines("", new TextDecoder().decode(bytes));
          // A progress bar that redraws with a leading `\r` keeps its newest
          // frame unterminated, so that frame is the latest status.
          return (
            toProgressLine(split.partialLine) ??
            split.lines.map(toProgressLine).findLast((value) => value !== null) ??
            null
          );
        }),
        Effect.flatMap((line) => (line === null ? Effect.void : onProgress(line))),
        Effect.repeat(Schedule.spaced(UPDATE_PROGRESS_INTERVAL)),
        Effect.forkScoped,
      );
    }

    const code = yield* Deferred.await(exited).pipe(Effect.timeoutOption(INSTALL_BACKSTOP));
    if (Option.isNone(code)) {
      yield* Effect.sync(() => {
        if (platform === "win32") {
          spawnProcess("taskkill", ["/PID", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).on("error", noop);
        } else {
          signalProcessGroup(pid, "SIGKILL");
        }
      }).pipe(Effect.ignore);
    }
    const output = yield* readLog;
    return {
      stdout: new TextDecoder().decode(output.bytes),
      stderr: "",
      exitCode: Option.isSome(code) ? code.value : null,
      timedOut: Option.isNone(code),
      stdoutTruncated: output.truncated,
      stderrTruncated: false,
    } satisfies ProviderMaintenanceCommandResult;
  },
  Effect.scoped,
);

const runForegroundInstall = Effect.fn("ProviderMaintenanceRunner.runCommand")(function* (input: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly onProgress?: ((line: string) => Effect.Effect<void>) | undefined;
  readonly recordChildPid: ProviderInstallInput["recordChildPid"];
}) {
  const collectCommandResult = Effect.fn("ProviderMaintenanceRunner.collectCommandResult")(
    function* () {
      const env = input.env ? { env: input.env, extendEnv: true } : {};
      // Windows batch shims require shell dispatch through resolveSpawnCommand.
      const resolved = yield* resolveSpawnCommand(input.command, input.args, env);
      const child = yield* input.spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            shell: resolved.shell,
            ...env,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderMaintenanceCommandError({
                message: `Failed to run update command ${input.command}: ${cause.message}`,
                cause,
              }),
          ),
        );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));

      yield* input.recordChildPid(Number(child.pid));

      const pendingProgress = yield* Ref.make<string | null>(null);
      const onProgress = input.onProgress;
      if (onProgress) {
        yield* Ref.getAndSet(pendingProgress, null).pipe(
          Effect.flatMap((line) => (line === null ? Effect.void : onProgress(line))),
          Effect.repeat(Schedule.spaced(UPDATE_PROGRESS_INTERVAL)),
          Effect.forkScoped,
        );
      }
      const trackProgress = <E>(stream: Stream.Stream<Uint8Array, E>) => {
        if (!onProgress) {
          return stream;
        }
        const decoder = new TextDecoder();
        let partialLine = "";
        return stream.pipe(
          Stream.tap((chunk) => {
            const split = splitOutputLines(partialLine, decoder.decode(chunk, { stream: true }));
            partialLine = split.partialLine;
            const line =
              toProgressLine(split.partialLine) ??
              split.lines.map(toProgressLine).findLast((value) => value !== null);
            return line ? Ref.set(pendingProgress, line) : Effect.void;
          }),
        );
      };

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({
            stream: trackProgress(child.stdout),
            maxBytes: UPDATE_OUTPUT_MAX_BYTES,
          }),
          collectUint8StreamText({
            stream: trackProgress(child.stderr),
            maxBytes: UPDATE_OUTPUT_MAX_BYTES,
          }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderMaintenanceCommandError({
              message: cause instanceof Error ? cause.message : "Update command failed to run.",
              cause,
            }),
        ),
      );

      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: Number(exitCode),
        timedOut: false,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      } satisfies ProviderMaintenanceCommandResult;
    },
  );

  return yield* collectCommandResult().pipe(
    Effect.scoped,
    Effect.timeoutOption(INSTALL_BACKSTOP),
    Effect.map((result) =>
      Option.match(result, {
        onSome: (value) => value,
        onNone: () =>
          ({
            stdout: "",
            stderr: "",
            exitCode: null,
            timedOut: true,
            stdoutTruncated: false,
            stderrTruncated: false,
          }) satisfies ProviderMaintenanceCommandResult,
      }),
    ),
  );
});

export const layerInstaller = Layer.effect(
  ProviderInstaller,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ProviderInstaller.of({
      run: Effect.fn("ProviderInstaller.run")((input) =>
        runDetachedInstall(input).pipe(
          Effect.catchTags({
            NodeRuntimeUnavailableError: () => runForegroundInstall({ ...input, spawner }),
          }),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      ),
    });
  }),
);

export function splitOutputLines(
  partialLine: string,
  text: string,
): { readonly lines: ReadonlyArray<string>; readonly partialLine: string } {
  const parts = (partialLine + text).replace(/\x1b\[(?:0*1?G|999D)/g, "\r").split(/\r\n|\r|\n/);
  return { partialLine: (parts.pop() ?? "").slice(-UPDATE_PARTIAL_LINE_MAX_LENGTH), lines: parts };
}

export function toProgressLine(line: string): string | null {
  if (/\x1b(?:\[[0-9]*)?$/.test(line)) {
    return null;
  }
  const text = NodeUtil.stripVTControlCharacters(line).replace(/\s+/g, " ").trim();
  if (text.length === 0) {
    return null;
  }
  return text.length <= UPDATE_PROGRESS_MAX_LENGTH
    ? text
    : `${text.slice(0, UPDATE_PROGRESS_MAX_LENGTH - 1)}…`;
}

function describeCommand(command: ProviderMaintenanceCommandAction): string {
  const executable = command.executable.split(/[\\/]/).pop() || command.executable;
  return [executable, ...command.args].join(" ");
}

function trimNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function commandOutput(result: ProviderMaintenanceCommandResult): string | null {
  const output = trimNullable([result.stderr, result.stdout].filter(Boolean).join("\n\n"));
  if (!output) {
    return null;
  }
  return truncateText(output, UPDATE_OUTPUT_MAX_BYTES);
}

// Updaters print their reason last, usually on stderr.
function lastOutputLine(result: ProviderMaintenanceCommandResult): string | null {
  for (const output of [result.stderr, result.stdout]) {
    const line = output
      .split(/\r\n|\r|\n/)
      .map(toProgressLine)
      .findLast(Boolean);
    if (line) {
      return line;
    }
  }
  return null;
}

function failureMessage(result: ProviderMaintenanceCommandResult): string {
  if (result.timedOut) {
    return `Update timed out after ${Duration.toMinutes(INSTALL_BACKSTOP)} minutes.`;
  }
  const summary =
    result.exitCode !== null && result.exitCode !== 0
      ? `Update command exited with code ${result.exitCode}`
      : "Update command failed";
  const reason = lastOutputLine(result);
  return reason ? `${summary}: ${reason}` : `${summary}.`;
}

function isOutdatedProvider(provider: ServerProvider | undefined): boolean {
  return provider?.versionAdvisory?.status === "behind_latest";
}

function isStillInstalled(provider: ServerProvider): boolean {
  return provider.installed;
}

function makeUpdateState(input: {
  readonly status: ServerProviderUpdateState["status"];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly message: string | null;
  readonly output?: string | null;
}): ServerProviderUpdateState {
  return {
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    message: input.message,
    output: input.output ?? null,
  };
}

/** @public */
export const make = Effect.fn("ProviderMaintenanceRunner.make")(function* () {
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const manifestService = yield* ModelManifest.ModelManifest;
  const installer = yield* ProviderInstaller;
  const installLock = yield* ProviderInstallLock.ProviderInstallLock;
  const httpClient = yield* HttpClient.HttpClient;
  const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
  const commandCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
    makeAlreadyRunningError: () =>
      new ServerProviderUpdateError({
        provider: ProviderDriverKind.make("unknown"),
        reason: "An update is already running for this provider.",
      }),
  });

  const verifyFromRefresh = (
    refresh: Effect.Effect<ReadonlyArray<ServerProvider>>,
    provider: ProviderDriverKind,
    maintenanceCapabilities: ProviderMaintenanceCapabilities,
    instanceId: ProviderInstanceId,
    phase: "pre-update" | "post-update",
  ): Effect.Effect<VerifiedProviderRefresh> =>
    refresh.pipe(
      Effect.flatMap((providers) => {
        const refreshedProviders = providers.filter(
          (candidate) => candidate.driver === provider && candidate.instanceId === instanceId,
        );
        if (refreshedProviders.length === 0) {
          return Effect.succeed<VerifiedProviderRefresh>({
            providers,
            verifiedProviders: [],
            advisoryEnriched: true,
          });
        }
        return Effect.forEach(
          refreshedProviders,
          (refreshedProvider) =>
            enrichProviderSnapshotWithVersionAdvisory(
              refreshedProvider,
              maintenanceCapabilities,
            ).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
            ),
          {
            concurrency: "unbounded",
          },
        ).pipe(
          Effect.map((verifiedProviders): VerifiedProviderRefresh => ({
            providers,
            verifiedProviders,
            advisoryEnriched: true,
          })),
          Effect.catchCause((cause) =>
            Effect.logWarning("Provider version verification failed", {
              provider,
              phase,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.as<VerifiedProviderRefresh>({
                providers,
                verifiedProviders: refreshedProviders,
                advisoryEnriched: false,
              }),
            ),
          ),
        );
      }),
    );

  const updateProvider: ProviderMaintenanceRunnerShape["updateProvider"] = Effect.fn(
    "ProviderMaintenanceRunner.updateProvider",
  )(function* (target) {
    const provider = typeof target === "string" ? target : target.provider;
    const instanceId =
      typeof target === "string"
        ? defaultInstanceIdForDriver(provider)
        : (target.instanceId ?? defaultInstanceIdForDriver(provider));
    const targetVersion = typeof target === "string" ? undefined : target.targetVersion;
    const background = typeof target !== "string" && target.background === true;
    const beforeInstall = typeof target === "string" ? undefined : target.beforeInstall;
    const targetKey = `instance:${instanceId}`;
    const capabilities = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
      instanceId,
      provider,
    );
    const update = capabilities.update;
    if (!update) {
      return yield* new ServerProviderUpdateError({
        provider,
        reason: "This provider does not support one-click updates.",
      });
    }

    // A background install is silent: nobody asked for it, so clients never see its state.
    const setUpdateState = (state: ServerProviderUpdateState | null) =>
      background
        ? providerRegistry.getProviders
        : providerRegistry.setProviderMaintenanceActionState({
            instanceId,
            action: "update",
            state,
          });
    const setQueuedState = setUpdateState(
      makeUpdateState({
        status: "queued",
        startedAt: null,
        finishedAt: null,
        message: "Waiting for another provider update to finish.",
      }),
    ).pipe(Effect.asVoid);

    const runProviderUpdate = Effect.fn("ProviderMaintenanceRunner.runProviderUpdate")(
      function* () {
        const finish = (state: ServerProviderUpdateState) =>
          (background
            ? (state.status === "failed" ? Effect.logWarning : Effect.logInfo)(
                "Background provider update finished",
                { instanceId, status: state.status, message: state.message },
              )
            : Effect.void
          ).pipe(
            Effect.andThen(setUpdateState(state)),
            Effect.map((providers) => ({ providers })),
          );
        const startedAtRef = yield* Ref.make<string | null>(null);

        const runCommandAndVerify = Effect.fn("ProviderMaintenanceRunner.runCommandAndVerify")(
          function* (recordChildPid: ProviderInstallInput["recordChildPid"]) {
            const startedAt = yield* nowIso;
            yield* Ref.set(startedAtRef, startedAt);
            const setRunningMessage = (message: string) =>
              setUpdateState(
                makeUpdateState({
                  status: "running",
                  startedAt,
                  finishedAt: null,
                  message,
                }),
              ).pipe(Effect.asVoid);
            yield* setRunningMessage("Checking for the latest version");

            // Recheck ownership after acquiring the cached lock in case the executable changed.
            const fresh = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
              instanceId,
              provider,
              { fresh: true },
            );
            const freshUpdate = fresh.update;
            if (!freshUpdate || freshUpdate.lockKey !== update.lockKey) {
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt: yield* nowIso,
                  message: "Provider installation changed. Refresh and try again.",
                }),
              );
            }

            const manifest = yield* manifestService.current;
            const pinnedCommand =
              targetVersion !== undefined
                ? makeTargetedProviderUpdateAction(fresh, targetVersion)
                : null;
            // Check compatibility against what an unpinned command would install now.
            const candidateVersion =
              background && !pinnedCommand
                ? fresh.lookupLatestVersion
                  ? yield* fresh.lookupLatestVersion
                  : null
                : (targetVersion ??
                  (yield* invalidateLatestProviderVersion(fresh).pipe(
                    Effect.andThen(resolveLatestProviderVersion(fresh)),
                    Effect.provideService(HttpClient.HttpClient, httpClient),
                    Effect.provideService(
                      ProviderLatestVersions.ProviderLatestVersions,
                      latestVersions,
                    ),
                  )));
            const advisory =
              resolveProviderCompatibility(manifest.compatibility, provider, candidateVersion) ??
              resolveProviderCompatibility(
                ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
                provider,
                candidateVersion,
              );
            // Unattended installs run a pinned `package@version`; only a native
            // self-updater or Homebrew may run unpinned.
            const command = background
              ? (pinnedCommand ??
                (SELF_UPDATING_LOCK_KEY.test(freshUpdate.lockKey) ? freshUpdate : null))
              : targetVersion !== undefined
                ? pinnedCommand
                : resolveLatestProviderUpdateAction(fresh, candidateVersion);
            const incompatible =
              advisory?.status === "broken" || advisory?.status === "unsupported";
            const rejected = background
              ? incompatible ||
                targetVersion === undefined ||
                (!pinnedCommand && (!fresh.lookupLatestVersion || !candidateVersion))
              : targetVersion !== undefined
                ? !command ||
                  advisory?.recommendedVersion !== targetVersion ||
                  advisory.status !== "supported"
                : incompatible;
            if (rejected || !command) {
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt: yield* nowIso,
                  message:
                    targetVersion !== undefined
                      ? "This version is no longer recommended or this installer cannot install a specific version. Refresh provider settings."
                      : "The latest provider version is incompatible with this T3 Code release. Review provider settings.",
                }),
              );
            }
            const compareVersions = fresh.compareVersions ?? compareSemverVersions;
            if (background && candidateVersion) {
              // Re-probe under the lock: another server or a manual update may have won.
              const current = (yield* providerRegistry.refreshInstance(instanceId)).find(
                (candidate) => candidate.instanceId === instanceId,
              );
              const currentVersion =
                current?.installedVersion !== undefined
                  ? current.installedVersion
                  : current?.version;
              if (
                !current?.enabled ||
                !current.installed ||
                (currentVersion && compareVersions(currentVersion, candidateVersion) >= 0)
              ) {
                return yield* finish(
                  makeUpdateState({
                    status: "unchanged",
                    startedAt,
                    finishedAt: yield* nowIso,
                    message: "No newer provider version is available.",
                  }),
                );
              }
              if (beforeInstall && !(yield* beforeInstall)) {
                return yield* finish(
                  makeUpdateState({
                    status: "unchanged",
                    startedAt,
                    finishedAt: yield* nowIso,
                    message: "Background update postponed until nothing is in use.",
                  }),
                );
              }
            }
            if (targetVersion === undefined) {
              const prior = (yield* providerRegistry.getProviders).find(
                (candidate) => candidate.instanceId === instanceId,
              );
              const precheck = yield* verifyFromRefresh(
                providerRegistry.refreshInstance(instanceId),
                provider,
                fresh,
                instanceId,
                "pre-update",
              );
              const alreadyCurrent =
                precheck.advisoryEnriched &&
                prior !== undefined &&
                precheck.verifiedProviders.length > 0 &&
                precheck.verifiedProviders.every(
                  (verified) =>
                    verified.checkedAt !== prior.checkedAt &&
                    verified.installed &&
                    verified.status !== "error" &&
                    verified.versionAdvisory?.status === "current",
                );
              if (alreadyCurrent) {
                return yield* finish(
                  makeUpdateState({
                    status: "succeeded",
                    startedAt,
                    finishedAt: yield* nowIso,
                    message: "Already up to date.",
                  }),
                );
              }
            }

            yield* setRunningMessage(`Running ${describeCommand(command)}`);
            const result = yield* installer.run({
              command: command.executable,
              args: command.args,
              env:
                background && freshUpdate.lockKey === "homebrew"
                  ? { ...command.env, HOMEBREW_NO_AUTO_UPDATE: "1" }
                  : command.env,
              // Nobody watches a background install, so its output is not sampled.
              onProgress: background ? undefined : setRunningMessage,
              recordChildPid,
            });
            const finishedAt = yield* nowIso;
            if (result.timedOut || result.exitCode !== 0) {
              yield* Effect.logWarning("Provider update command failed", {
                provider,
                command: describeCommand(command),
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                output: commandOutput(result),
              });
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt,
                  message: failureMessage(result),
                  output: commandOutput(result),
                }),
              );
            }

            yield* setRunningMessage("Verifying the installed version");
            const verified = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
              instanceId,
              provider,
              { fresh: true },
            );
            yield* invalidateLatestProviderVersion(verified).pipe(
              Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
            );
            const { verifiedProviders } = yield* verifyFromRefresh(
              providerRegistry.refreshAfterUpdate(provider, instanceId),
              provider,
              verified,
              instanceId,
              "post-update",
            );
            // Cursor about probes can fail transiently; missing versions alone do not imply failure.
            const couldNotVerify =
              verifiedProviders.length === 0 ||
              verifiedProviders.some((verifiedProvider) => {
                const installedVersion =
                  verifiedProvider.installedVersion !== undefined
                    ? verifiedProvider.installedVersion
                    : verifiedProvider.version;
                return (
                  !isStillInstalled(verifiedProvider) ||
                  (verifiedProvider.status === "error" &&
                    (verifiedProvider.auth.status !== "unauthenticated" ||
                      !verifiedProvider.version)) ||
                  (background
                    ? !installedVersion ||
                      !candidateVersion ||
                      compareVersions(installedVersion, candidateVersion) < 0
                    : targetVersion !== undefined &&
                      installedVersion?.replace(/^v/, "") !== targetVersion)
                );
              });
            const stillOutdated =
              targetVersion === undefined &&
              verifiedProviders.some((verifiedProvider) => isOutdatedProvider(verifiedProvider));
            return yield* finish(
              makeUpdateState({
                status: couldNotVerify || stillOutdated ? "unchanged" : "succeeded",
                startedAt,
                finishedAt,
                message: couldNotVerify
                  ? "Update command completed, but T3 Code could not verify the provider version."
                  : stillOutdated
                    ? "Update command completed, but T3 Code still detects an outdated provider version."
                    : "Provider updated.",
                output: commandOutput(result),
              }),
            );
          },
        );

        const recordFailedUpdate = Effect.fn("ProviderMaintenanceRunner.recordFailedUpdate")(
          function* (cause: Cause.Cause<unknown>) {
            const failure = Cause.squash(cause);
            const startedAt = yield* Ref.get(startedAtRef);
            return yield* finish(
              makeUpdateState({
                status: "failed",
                startedAt,
                finishedAt: yield* nowIso,
                message: failure instanceof Error ? failure.message : "Update command failed.",
                output: null,
              }),
            );
          },
        );

        // Held until the installer exits, so two servers never run the same installer at once.
        return yield* installLock.tryRun(update.lockKey, runCommandAndVerify, provider).pipe(
          Effect.flatMap(
            Option.match({
              onSome: Effect.succeed,
              onNone: () =>
                nowIso.pipe(
                  Effect.flatMap((finishedAt) =>
                    finish(
                      makeUpdateState({
                        status: "failed",
                        startedAt: null,
                        finishedAt,
                        message: "Another T3 server is already updating this provider.",
                      }),
                    ),
                  ),
                ),
            }),
          ),
          Effect.catchCause(recordFailedUpdate),
        );
      },
    );

    return yield* commandCoordinator
      .withCommandLock({
        targetKey,
        lockKey: update.lockKey,
        onQueued: setQueuedState,
        run: runProviderUpdate(),
      })
      .pipe(
        Effect.mapError((error) =>
          isServerProviderUpdateError(error)
            ? new ServerProviderUpdateError({
                provider,
                reason: error.reason,
              })
            : error,
        ),
      );
  });

  // A previous server may have quit while its detached installer kept running.
  // Wait for it, then pick up the version it installed.
  yield* installLock.anyHeld.pipe(
    Effect.flatMap((held) =>
      held ? installLock.untilIdle.pipe(Effect.andThen(providerRegistry.refresh())) : Effect.void,
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  return ProviderMaintenanceRunner.of({
    updateProvider,
  });
});

export const layer = Layer.effect(ProviderMaintenanceRunner, make());
