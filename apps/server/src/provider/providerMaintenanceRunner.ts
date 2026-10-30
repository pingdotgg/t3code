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
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeUtil from "node:util";

import * as ModelManifest from "./ModelManifest.ts";
import { resolveProviderCompatibility } from "./providerCompatibility.ts";
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

const UPDATE_TIMEOUT_MS = 5 * 60_000;
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

class ProviderMaintenanceCommandError extends Data.TaggedError("ProviderMaintenanceCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface VerifiedProviderRefresh {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly verifiedProviders: ReadonlyArray<ServerProvider>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

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
        // Windows batch shims require shell dispatch through resolveSpawnCommand.
        const resolved = yield* resolveSpawnCommand(input.command, input.args);
        const child = yield* input.spawner
          .spawn(
            ChildProcess.make(resolved.command, resolved.args, {
              shell: resolved.shell,
              ...(input.env ? { env: input.env, extendEnv: true } : {}),
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
  const parts = (partialLine + text).split(/\r\n|\r|\n/);
  return { partialLine: (parts.pop() ?? "").slice(-UPDATE_PARTIAL_LINE_MAX_LENGTH), lines: parts };
}

export function toProgressLine(line: string): string | null {
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
    return "Update timed out.";
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
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
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
    providerRegistry.refreshAfterUpdate(provider, instanceId).pipe(
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
        const finish = (state: ServerProviderUpdateState) =>
          setUpdateState(state).pipe(Effect.map((providers) => ({ providers })));
        const startedAtRef = yield* Ref.make<string | null>(null);

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
            if (!fresh.update || fresh.update.lockKey !== update.lockKey) {
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
            const advisory =
              resolveProviderCompatibility(manifest.compatibility, provider, candidateVersion) ??
              resolveProviderCompatibility(
                ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
                provider,
                candidateVersion,
              );
            const command =
              targetVersion !== undefined
                ? makeTargetedProviderUpdateAction(fresh, targetVersion)
                : resolveLatestProviderUpdateAction(fresh, candidateVersion);
            const rejected =
              targetVersion !== undefined
                ? !command ||
                  advisory?.recommendedVersion !== targetVersion ||
                  advisory.status !== "supported"
                : advisory?.status === "broken" || advisory?.status === "unsupported";
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
            yield* setRunningMessage(`Running ${describeCommand(command)}`);
            const result = yield* runMaintenanceCommand(command, setRunningMessage);
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
            const { verifiedProviders } = yield* verifyRefreshedProvider(
              provider,
              verified,
              instanceId,
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

        return yield* runCommandAndVerify().pipe(Effect.catchCause(recordFailedUpdate));
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

  return ProviderMaintenanceRunner.of({
    updateProvider,
  });
});

export const layer = Layer.effect(ProviderMaintenanceRunner, make());
