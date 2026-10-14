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
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
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
  makeTargetedProviderUpdateAction,
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
// Only these may run their own updater without a pinned `package@version`.
const SELF_UPDATING_LOCK_KEY = /^(?:homebrew|grok|muse:.*|.+-native)$/;
const UPDATE_OUTPUT_MAX_BYTES = 10_000;
// Every progress publish resends the provider list to each client, so the
// installer's output is sampled rather than forwarded line by line.
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

class ProviderMaintenanceCommandError extends Data.TaggedError("ProviderMaintenanceCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface VerifiedProviderRefresh {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly verifiedProviders: ReadonlyArray<ServerProvider>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export interface ProviderInstallInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly onProgress?: ((line: string) => Effect.Effect<void>) | undefined;
  /** Called with the installer's pid once it is running, for the install lock. */
  readonly recordChildPid: (pid: number) => Effect.Effect<void>;
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
    // Resolve the executable for the host platform before spawning. On
    // Windows the update tools are batch shims (e.g. `npm` -> `npm.cmd`),
    // which a bare spawn cannot launch (spawn npm ENOENT); resolveSpawnCommand
    // finds the real `.cmd` and routes it through the shell. On Linux/macOS
    // (incl. the WSL backend) this is a no-op.
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
      Effect.sync(() => NodeFS.openSync(logPath, "a")),
      (fd) => Effect.sync(() => NodeFS.closeSync(fd)),
    );

    // Listeners are registered in the spawn tick: Node emits `spawn` and `exit`
    // asynchronously, and a late listener would wait forever.
    const { spawned, exited } = yield* Effect.try({
      try: () => {
        const child = spawnProcess(resolved.command, resolved.args, {
          shell: resolved.shell,
          detached: true,
          windowsHide: true,
          stdio: ["ignore", logFd, logFd],
          ...(input.env ? { env: { ...environment, ...input.env } } : {}),
        });
        const spawned = Deferred.makeUnsafe<number, Error>();
        const exited = Deferred.makeUnsafe<number | null>();
        child.on("error", (cause) => Deferred.doneUnsafe(spawned, Effect.fail(toError(cause))));
        child.once("spawn", () => Deferred.doneUnsafe(spawned, Effect.succeed(child.pid ?? 0)));
        child.once("exit", (code) => Deferred.doneUnsafe(exited, Effect.succeed(code)));
        child.unref();
        return { spawned, exited };
      },
      catch: toError,
    });
    const pid = yield* Deferred.await(spawned);
    yield* input.recordChildPid(pid);

    const readLog = fileSystem.readFile(logPath).pipe(Effect.orElseSucceed(() => new Uint8Array()));
    const onProgress = input.onProgress;
    if (onProgress) {
      yield* readLog.pipe(
        Effect.map((bytes) => {
          const split = splitOutputLines(
            "",
            new TextDecoder().decode(bytes.slice(-UPDATE_OUTPUT_MAX_BYTES)),
          );
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
      stdout: new TextDecoder().decode(output.slice(-UPDATE_OUTPUT_MAX_BYTES)),
      stderr: "",
      exitCode: Option.isSome(code) ? code.value : null,
      timedOut: Option.isNone(code),
      stdoutTruncated: output.length > UPDATE_OUTPUT_MAX_BYTES,
      stderrTruncated: false,
    } satisfies ProviderMaintenanceCommandResult;
  },
  Effect.scoped,
);

export const layerInstaller = Layer.effect(
  ProviderInstaller,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return ProviderInstaller.of({
      run: (input) =>
        runDetachedInstall(input).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)),
    });
  }),
);

/**
 * Split a chunk of installer output into complete lines. `\r` ends a line too,
 * so a redrawn progress bar reports its latest frame.
 */
export function splitOutputLines(
  partialLine: string,
  text: string,
): { readonly lines: ReadonlyArray<string>; readonly partialLine: string } {
  const parts = (partialLine + text).split(/\r\n|\r|\n/);
  return { partialLine: (parts.pop() ?? "").slice(-UPDATE_PARTIAL_LINE_MAX_LENGTH), lines: parts };
}

/** Turn one raw output line into a short status message, or null if it has no text. */
export function toProgressLine(line: string): string | null {
  const text = NodeUtil.stripVTControlCharacters(line).replace(/\s+/g, " ").trim();
  if (text.length === 0) {
    return null;
  }
  return text.length <= UPDATE_PROGRESS_MAX_LENGTH
    ? text
    : `${text.slice(0, UPDATE_PROGRESS_MAX_LENGTH - 1)}…`;
}

/** `claude update` reads better in a status line than the full executable path. */
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

function failureMessage(result: ProviderMaintenanceCommandResult): string {
  if (result.timedOut) {
    return "Update timed out.";
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    return `Update command exited with code ${result.exitCode}.`;
  }
  return "Update command failed.";
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

/** @public Service construction is part of the canonical Effect module API. */
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

  const verifyRefreshedProvider = (
    provider: ProviderDriverKind,
    maintenanceCapabilities: ProviderMaintenanceCapabilities,
    instanceId: ProviderInstanceId,
  ): Effect.Effect<VerifiedProviderRefresh> =>
    providerRegistry.getProviders.pipe(
      Effect.map((providers) => {
        const instanceIds: Array<ProviderInstanceId> = [];
        for (const candidate of providers) {
          if (candidate.driver === provider && candidate.instanceId === instanceId) {
            instanceIds.push(candidate.instanceId);
          }
        }
        return instanceIds;
      }),
      Effect.flatMap((instanceIds) =>
        instanceIds.length === 0
          ? providerRegistry.refreshInstance(instanceId)
          : Effect.forEach(
              instanceIds,
              (instanceId) => providerRegistry.refreshInstance(instanceId),
              {
                concurrency: "unbounded",
                discard: true,
              },
            ).pipe(Effect.andThen(providerRegistry.getProviders)),
      ),
      Effect.flatMap((providers) => {
        const refreshedProviders = providers.filter(
          (candidate) => candidate.driver === provider && candidate.instanceId === instanceId,
        );
        if (refreshedProviders.length === 0) {
          return Effect.succeed<VerifiedProviderRefresh>({
            providers,
            verifiedProviders: [],
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
          })),
          Effect.catchCause((cause) =>
            Effect.logWarning("Provider post-update version verification failed", {
              provider,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.as<VerifiedProviderRefresh>({
                providers,
                verifiedProviders: refreshedProviders,
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
          function* (recordChildPid: (pid: number) => Effect.Effect<void>) {
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

            // The cached capabilities chose the lock; re-derive ownership
            // now so the command that runs matches the executable as it is
            // at click time, not as it was at the last health refresh.
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
            const candidateVersion =
              targetVersion ??
              (yield* resolveLatestProviderVersion(fresh).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.provideService(
                  ProviderLatestVersions.ProviderLatestVersions,
                  latestVersions,
                ),
              ));
            const advisory =
              resolveProviderCompatibility(manifest.compatibility, provider, candidateVersion) ??
              resolveProviderCompatibility(
                ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
                provider,
                candidateVersion,
              );
            const pinnedCommand =
              targetVersion !== undefined
                ? makeTargetedProviderUpdateAction(fresh, targetVersion)
                : null;
            // Unattended installs run a pinned `package@version`; only a native
            // self-updater or Homebrew may run unpinned.
            const command = background
              ? (pinnedCommand ??
                (SELF_UPDATING_LOCK_KEY.test(freshUpdate.lockKey) ? freshUpdate : null))
              : targetVersion !== undefined
                ? pinnedCommand
                : freshUpdate;
            const incompatible =
              advisory?.status === "broken" || advisory?.status === "unsupported";
            const rejected = background
              ? incompatible || targetVersion === undefined
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
              if (
                !current?.enabled ||
                !current.installed ||
                (current.version && compareVersions(current.version, candidateVersion) >= 0)
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
            yield* setRunningMessage(`Running ${describeCommand(command)}`);
            const result = yield* installer.run({
              command: command.executable,
              args: command.args,
              env: command.env,
              // Nobody watches a background install, so its output is not sampled.
              onProgress: background ? undefined : setRunningMessage,
              recordChildPid,
            });
            const finishedAt = yield* nowIso;
            if (result.timedOut || result.exitCode !== 0) {
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
            // Homebrew's "latest" moves once the upgrade lands; read it again.
            const verified = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
              instanceId,
              provider,
              { fresh: true },
            );
            const { verifiedProviders } = yield* verifyRefreshedProvider(
              provider,
              verified,
              instanceId,
            );
            // "Succeeded" needs the provider to still be installed: an
            // installer that exits 0 and leaves the binary missing is not a
            // success. A missing version alone is not held against it, since
            // Cursor's `about` probe can fail transiently on a healthy binary.
            // A background install must reach its target, so a missing version
            // counts there; a self-updater may land on a newer one.
            const couldNotVerify =
              verifiedProviders.length === 0 ||
              verifiedProviders.some(
                (verifiedProvider) =>
                  !isStillInstalled(verifiedProvider) ||
                  (background
                    ? !verifiedProvider.version ||
                      !candidateVersion ||
                      compareVersions(verifiedProvider.version, candidateVersion) < 0
                    : targetVersion !== undefined &&
                      verifiedProvider.version?.replace(/^v/, "") !== targetVersion),
              );
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
        return yield* installLock.tryRun(update.lockKey, runCommandAndVerify).pipe(
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
