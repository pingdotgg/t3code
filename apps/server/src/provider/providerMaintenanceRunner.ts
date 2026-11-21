import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ServerProviderUpdateError,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdatedPayload,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeUtil from "node:util";

import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderInstallationGate from "./ProviderInstallationGate.ts";
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
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

// Native updaters (`claude update`) download a ~300 MB binary without printing
// progress, and killing one mid-download leaves a truncated binary that the
// next run treats as installed. Allow a slow connection to finish.
const UPDATE_TIMEOUT_MINUTES = 30;
const UPDATE_TIMEOUT_MS = UPDATE_TIMEOUT_MINUTES * 60_000;
const UPDATE_OUTPUT_MAX_BYTES = 10_000;
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

const OPENCODE_SERVER_RESTART_MESSAGE =
  "OpenCode CLI updated. Restart the configured local OpenCode server to use the new version.";

const needsOpenCodeServerRestart = (providers: ReadonlyArray<ServerProvider>) =>
  providers.some(
    (provider) =>
      provider.driver === ProviderDriverKind.make("opencode") &&
      provider.installedVersion != null &&
      provider.version != null &&
      provider.installedVersion !== provider.version,
  );

const runProviderMaintenanceCommandWithSpawner = Effect.fn("ProviderMaintenanceRunner.runCommand")(
  function* (input: {
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env?: NodeJS.ProcessEnv;
    readonly onProgress?: (line: string) => Effect.Effect<void>;
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
              // Nothing answers an update command, so one that reads stdin must see EOF, not wait.
              stdin: "ignore",
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
      Effect.timeoutOption(Duration.millis(UPDATE_TIMEOUT_MS)),
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
  },
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

// Updaters report on stderr, but may follow their error with hints (`claude update`
// ends with "Try running claude doctor"), so prefer the last line naming an error.
function failureReason(result: ProviderMaintenanceCommandResult): string | null {
  const streams = [result.stderr, result.stdout].map((output) =>
    output
      .split(/\r\n|\r|\n/)
      .map(toProgressLine)
      .filter((line) => line !== null),
  );
  return (
    streams.map((lines) => lines.findLast((line) => /error|fail/i.test(line))).find(Boolean) ??
    streams.map((lines) => lines.at(-1)).find(Boolean) ??
    null
  );
}

function failureMessage(result: ProviderMaintenanceCommandResult): string {
  if (result.timedOut) {
    return `Update timed out after ${UPDATE_TIMEOUT_MINUTES} minutes.`;
  }
  const summary =
    result.exitCode !== null && result.exitCode !== 0
      ? `Update command exited with code ${result.exitCode}`
      : "Update command failed";
  const reason = failureReason(result);
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
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
  const installationGate = yield* ProviderInstallationGate.ProviderInstallationGate;
  const serviceScope = yield* Effect.scope;
  const runMaintenanceCommand = (
    update: ProviderMaintenanceCommandAction,
    onProgress: (line: string) => Effect.Effect<void>,
  ) =>
    runProviderMaintenanceCommandWithSpawner({
      spawner,
      command: update.executable,
      args: update.args,
      onProgress,
      ...(update.env ? { env: update.env } : {}),
    });
  // Instances with other homes or accounts can still run the binary this update replaces. The
  // lock key names the package manager location, so other drivers there keep their own package.
  const instancesSharingInstallation = Effect.fn(
    "ProviderMaintenanceRunner.instancesSharingInstallation",
  )(function* (instanceId: ProviderInstanceId, provider: ProviderDriverKind, lockKey: string) {
    const providers = yield* providerRegistry.getProviders;
    const shared = yield* Effect.forEach(
      providers.filter(
        (candidate) => candidate.instanceId !== instanceId && candidate.driver === provider,
      ),
      (candidate) =>
        providerRegistry
          .getProviderMaintenanceCapabilitiesForInstance(candidate.instanceId, candidate.driver)
          .pipe(
            Effect.map((capabilities) =>
              capabilities.update?.lockKey === lockKey ? [candidate.instanceId] : [],
            ),
          ),
      { concurrency: "unbounded" },
    );
    return [instanceId, ...shared.flat()];
  });
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
    const targetKey = `instance:${instanceId}`;
    const capabilities = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
      instanceId,
      provider,
    );
    const update = capabilities.update;
    const managedUpdate = update === null ? (capabilities.managedUpdate ?? null) : null;
    const lockKey = update?.lockKey ?? managedUpdate?.lockKey ?? null;
    if (!lockKey) {
      return yield* new ServerProviderUpdateError({
        provider,
        reason: "This provider does not support one-click updates.",
      });
    }

    const startedAtRef = yield* Ref.make<string | null>(null);
    const settled = yield* Ref.make(false);
    const setUpdateState = (state: ServerProviderUpdateState | null) =>
      providerRegistry.setProviderMaintenanceActionState({
        instanceId,
        action: "update",
        state,
        targetVersion,
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
        // Uninterruptible, so a dropped request cannot leave settled set without the state.
        const finish = (state: ServerProviderUpdateState) =>
          Ref.set(settled, true).pipe(
            Effect.andThen(setUpdateState(state)),
            Effect.map((providers) => ({ providers })),
            Effect.uninterruptible,
          );

        const runCommandAndVerify = Effect.fn("ProviderMaintenanceRunner.runCommandAndVerify")(
          function* () {
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
            const freshManagedUpdate = freshUpdate === null ? (fresh.managedUpdate ?? null) : null;
            const freshLockKey = freshUpdate?.lockKey ?? freshManagedUpdate?.lockKey ?? null;
            if (!freshLockKey || freshLockKey !== lockKey) {
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
            // Check compatibility against what an unpinned command would install now.
            const candidateVersion =
              targetVersion ??
              (yield* invalidateLatestProviderVersion(fresh).pipe(
                Effect.andThen(resolveLatestProviderVersion(fresh)),
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.provideService(
                  ProviderLatestVersions.ProviderLatestVersions,
                  latestVersions,
                ),
              ));
            const advisory = ModelManifest.providerCompatibility(
              manifest,
              provider,
              candidateVersion,
            );
            const command =
              freshUpdate !== null
                ? targetVersion !== undefined
                  ? makeTargetedProviderUpdateAction(fresh, targetVersion)
                  : resolveLatestProviderUpdateAction(fresh, candidateVersion)
                : null;
            const managedAction = targetVersion === undefined ? freshManagedUpdate : null;
            const managedMissingCandidate =
              command === null && managedAction !== null && candidateVersion === null;
            const rejected =
              targetVersion !== undefined
                ? !command ||
                  advisory?.recommendedVersion !== targetVersion ||
                  advisory.status !== "supported"
                : advisory?.status === "broken" || advisory?.status === "unsupported";
            if (managedMissingCandidate || rejected || (!command && !managedAction)) {
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt: yield* nowIso,
                  message: managedMissingCandidate
                    ? "Could not determine the latest provider version. Check your network connection and try again."
                    : targetVersion !== undefined
                      ? "This version is no longer recommended or this installer cannot install a specific version. Refresh provider settings."
                      : "The latest provider version is incompatible with this T3 Code release. Review provider settings.",
                }),
              );
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
                    message: needsOpenCodeServerRestart(precheck.verifiedProviders)
                      ? OPENCODE_SERVER_RESTART_MESSAGE
                      : "Already up to date.",
                  }),
                );
              }
            }

            let finishedAt: string;
            let updateOutput: string | null = null;
            if (command !== null) {
              const sharingInstances = yield* instancesSharingInstallation(
                instanceId,
                provider,
                lockKey,
              );
              yield* setRunningMessage("Waiting for running provider work to finish.");
              const result = yield* installationGate.update(
                sharingInstances,
                setRunningMessage(`Running ${describeCommand(command)}`).pipe(
                  Effect.andThen(runMaintenanceCommand(command, setRunningMessage)),
                ),
              );
              finishedAt = yield* nowIso;
              updateOutput = commandOutput(result);
              if (result.timedOut || result.exitCode !== 0) {
                yield* Effect.logWarning("Provider update command failed", {
                  provider,
                  command: describeCommand(command),
                  exitCode: result.exitCode,
                  timedOut: result.timedOut,
                  output: updateOutput,
                });
                return yield* finish(
                  makeUpdateState({
                    status: "failed",
                    startedAt,
                    finishedAt,
                    message: failureMessage(result),
                    output: updateOutput,
                  }),
                );
              }
            } else if (managedAction !== null) {
              // Managed runtimes download into a versioned directory and swap active.json atomically,
              // so live sessions keep their leased binaries without blocking on the installation gate.
              yield* setRunningMessage("Updating managed runtime");
              const managedResult = yield* managedAction.run(setRunningMessage);
              finishedAt = yield* nowIso;
              if (managedResult.status === "failed") {
                yield* Effect.logWarning("Managed provider update failed", {
                  provider,
                  message: managedResult.message,
                });
                return yield* finish(
                  makeUpdateState({
                    status: "failed",
                    startedAt,
                    finishedAt,
                    message: managedResult.message,
                    output: null,
                  }),
                );
              }
            } else {
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt: yield* nowIso,
                  message: "This provider does not support one-click updates.",
                  output: null,
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
                  (targetVersion !== undefined &&
                    installedVersion?.replace(/^v/, "") !== targetVersion)
                );
              });
            const stillOutdated =
              targetVersion === undefined &&
              verifiedProviders.some((verifiedProvider) => isOutdatedProvider(verifiedProvider));
            const completionSubject = command !== null ? "Update command" : "Provider update";
            return yield* finish(
              makeUpdateState({
                status: couldNotVerify || stillOutdated ? "unchanged" : "succeeded",
                startedAt,
                finishedAt,
                message: couldNotVerify
                  ? `${completionSubject} completed, but T3 Code could not verify the provider version.`
                  : stillOutdated
                    ? `${completionSubject} completed, but T3 Code still detects an outdated provider version.`
                    : needsOpenCodeServerRestart(verifiedProviders)
                      ? OPENCODE_SERVER_RESTART_MESSAGE
                      : "Provider updated.",
                output: updateOutput,
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

        return yield* runCommandAndVerify().pipe(Effect.catchCause(recordFailedUpdate));
      },
    );

    const coordinated = commandCoordinator
      .withCommandLock({
        targetKey,
        lockKey,
        onQueued: setQueuedState,
        run: runProviderUpdate(),
      })
      .pipe(
        // A dropped request interrupts a CLI update; a "running" state would spin until restart.
        // Managed updates run in serviceScope below so a client disconnect cannot strand their
        // background installer, and only server shutdown triggers this handler.
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            // A finished state stays, even if the request drops while it is being written.
            if (yield* Ref.get(settled)) return;
            yield* setUpdateState(
              makeUpdateState({
                status: "failed",
                startedAt: yield* Ref.get(startedAtRef),
                finishedAt: yield* nowIso,
                message: "Update stopped before it finished.",
              }),
            );
          }).pipe(Effect.ignore),
        ),
        Effect.mapError((error) =>
          isServerProviderUpdateError(error)
            ? new ServerProviderUpdateError({
                provider,
                reason: error.reason,
              })
            : error,
        ),
      );

    if (managedUpdate !== null) {
      // Managed installers fork into their own service scope and outlive a dropped RPC; keep
      // lock ownership, progress updates, and post-install verification alive with them.
      const fiber = yield* Effect.forkIn(coordinated, serviceScope, { startImmediately: true });
      return yield* Fiber.join(fiber);
    }

    return yield* coordinated;
  });

  return ProviderMaintenanceRunner.of({
    updateProvider,
  });
});
