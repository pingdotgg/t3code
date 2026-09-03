import {
  ClaudeSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderReauthenticateError,
  ServerProviderUpdateError,
  type ServerProvider,
  type ServerProviderReauthenticateBeginInput,
  type ServerProviderReauthenticateCodeInput,
  type ServerProviderReauthenticateInput,
  type ServerProviderReauthenticateStatusInput,
  type ServerProviderReauthenticateStatusResult,
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
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import * as ProviderService from "./Services/ProviderService.ts";
import { makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { makeProviderMaintenanceCommandCoordinator } from "./providerMaintenanceCommandCoordinator.ts";
import { enrichProviderSnapshotWithVersionAdvisory } from "./providerMaintenance.ts";
import type { ProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import * as ClaudeAuthFlow from "./claudeAuthFlow.ts";
import { continueProviderThreadAfterReauthentication } from "./providerThreadContinuation.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectionThreadMessages from "../persistence/Services/ProjectionThreadMessages.ts";
import * as ProjectionTurns from "../persistence/Services/ProjectionTurns.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { ServerSettingsService } from "../serverSettings.ts";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const UPDATE_OUTPUT_MAX_BYTES = 10_000;
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

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
        },
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderUpdateError>;
  readonly reauthenticateProvider: (
    input: ServerProviderReauthenticateInput,
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderReauthenticateError>;
  readonly beginProviderReauthentication: (
    input: ServerProviderReauthenticateBeginInput,
  ) => Effect.Effect<ServerProviderReauthenticateStatusResult, ServerProviderReauthenticateError>;
  readonly submitProviderReauthenticationCode: (
    input: ServerProviderReauthenticateCodeInput,
  ) => Effect.Effect<ServerProviderReauthenticateStatusResult, ServerProviderReauthenticateError>;
  readonly getProviderReauthenticationStatus: (
    input: ServerProviderReauthenticateStatusInput,
  ) => Effect.Effect<ServerProviderReauthenticateStatusResult, ServerProviderReauthenticateError>;
  readonly cancelProviderReauthentication: (
    input: ServerProviderReauthenticateStatusInput,
  ) => Effect.Effect<ServerProviderReauthenticateStatusResult, ServerProviderReauthenticateError>;
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

export interface ProviderMaintenanceRunnerOptions {
  readonly onProviderReauthenticated?: (input: {
    readonly threadId: ServerProviderReauthenticateBeginInput["threadId"];
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<void>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runProviderMaintenanceCommandWithSpawner = Effect.fn("ProviderMaintenanceRunner.runCommand")(
  function* (input: {
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly stdin?: ChildProcess.CommandInput | undefined;
  }) {
    const collectCommandResult = Effect.fn("ProviderMaintenanceRunner.collectCommandResult")(
      function* () {
        // Resolve the executable for the host platform before spawning. On
        // Windows the update tools are batch shims (e.g. `npm` -> `npm.cmd`),
        // which a bare ChildProcess.spawn cannot launch (spawn npm ENOENT);
        // resolveSpawnCommand finds the real `.cmd` and routes it through the
        // shell. On Linux/macOS (incl. the WSL backend) this is a no-op.
        const resolved = yield* resolveSpawnCommand(
          input.command,
          input.args,
          input.env === undefined ? undefined : { env: input.env },
        );
        const child = yield* input.spawner
          .spawn(
            ChildProcess.make(resolved.command, resolved.args, {
              env: input.env,
              shell: resolved.shell,
              ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
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

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({
              stream: child.stdout,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            collectUint8StreamText({
              stream: child.stderr,
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

export const make = Effect.fn("ProviderMaintenanceRunner.make")(function* (
  options?: ProviderMaintenanceRunnerOptions,
) {
  const providerRegistry = yield* ProviderRegistry;
  const serverSettings = yield* ServerSettingsService;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const claudeAuthFlow = yield* ClaudeAuthFlow.make;
  const runMaintenanceCommand = (command: string, args: ReadonlyArray<string>) =>
    runProviderMaintenanceCommandWithSpawner({
      spawner,
      command,
      args,
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
            ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
          {
            concurrency: "unbounded",
          },
        ).pipe(
          Effect.map(
            (verifiedProviders): VerifiedProviderRefresh => ({
              providers,
              verifiedProviders,
            }),
          ),
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

  const resolveClaudeAuthenticationConfig = Effect.fn(
    "ProviderMaintenanceRunner.resolveClaudeAuthenticationConfig",
  )(function* (input: {
    readonly provider: ProviderDriverKind;
    readonly instanceId?: ProviderInstanceId | undefined;
  }) {
    if (input.provider !== CLAUDE_DRIVER) {
      return yield* new ServerProviderReauthenticateError({
        provider: input.provider,
        reason: `Reauthentication is not supported for ${input.provider}`,
      });
    }

    const defaultInstanceId = defaultInstanceIdForDriver(CLAUDE_DRIVER);
    const instanceId = input.instanceId ?? defaultInstanceId;
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ServerProviderReauthenticateError({
            provider: input.provider,
            reason: "Failed to read provider settings.",
            cause,
          }),
      ),
    );
    const instance = settings.providerInstances[instanceId];
    if (
      input.instanceId !== undefined &&
      instance === undefined &&
      instanceId !== defaultInstanceId
    ) {
      return yield* new ServerProviderReauthenticateError({
        provider: input.provider,
        reason: `Provider instance ${instanceId} was not found.`,
      });
    }
    if (instance !== undefined && instance.driver !== CLAUDE_DRIVER) {
      return yield* new ServerProviderReauthenticateError({
        provider: input.provider,
        reason: `Provider instance ${instanceId} is not a Claude instance.`,
      });
    }

    const claudeSettings = yield* decodeClaudeSettings(
      instance === undefined
        ? settings.providers.claudeAgent
        : instance.config === undefined
          ? {}
          : instance.config,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ServerProviderReauthenticateError({
            provider: input.provider,
            reason: `Provider instance ${instanceId} has invalid Claude settings.`,
            cause,
          }),
      ),
    );
    const environment = yield* makeClaudeEnvironment(
      claudeSettings,
      mergeProviderInstanceEnvironment(instance?.environment),
    ).pipe(Effect.provideService(Path.Path, path));

    return {
      instanceId,
      command: claudeSettings.binaryPath,
      environment,
    };
  });

  const updateProvider: ProviderMaintenanceRunnerShape["updateProvider"] = Effect.fn(
    "ProviderMaintenanceRunner.updateProvider",
  )(function* (target) {
    const provider = typeof target === "string" ? target : target.provider;
    const instanceId =
      typeof target === "string"
        ? defaultInstanceIdForDriver(provider)
        : (target.instanceId ?? defaultInstanceIdForDriver(provider));
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
            yield* setUpdateState(
              makeUpdateState({
                status: "running",
                startedAt,
                finishedAt: null,
                message: "Updating provider.",
              }),
            );

            const result = yield* runMaintenanceCommand(update.executable, update.args);
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

            const { verifiedProviders } = yield* verifyRefreshedProvider(
              provider,
              capabilities,
              instanceId,
            );
            const couldNotVerify = verifiedProviders.length === 0;
            const stillOutdated =
              couldNotVerify ||
              verifiedProviders.some((verifiedProvider) => isOutdatedProvider(verifiedProvider));
            return yield* finish(
              makeUpdateState({
                status: stillOutdated ? "unchanged" : "succeeded",
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

  const beginProviderReauthentication: ProviderMaintenanceRunnerShape["beginProviderReauthentication"] =
    Effect.fn("ProviderMaintenanceRunner.beginProviderReauthentication")(function* (input) {
      const configuration = yield* resolveClaudeAuthenticationConfig(input);
      return yield* claudeAuthFlow.begin({
        provider: input.provider,
        instanceId: configuration.instanceId,
        threadId: input.threadId,
        command: configuration.command,
        args: ["auth", "login"],
        // `true` is Claude's no-browser sentinel. Without it, Claude opens a
        // browser on the server and withholds the URL remote clients need.
        env: { ...configuration.environment, BROWSER: "true" },
        onSuccess: () =>
          Effect.gen(function* () {
            const providers = yield* providerRegistry.refreshInstance(configuration.instanceId);
            if (options?.onProviderReauthenticated !== undefined) {
              yield* options.onProviderReauthenticated({
                threadId: input.threadId,
                instanceId: configuration.instanceId,
              });
            }
            return { providers };
          }),
      });
    });

  const submitProviderReauthenticationCode: ProviderMaintenanceRunnerShape["submitProviderReauthenticationCode"] =
    Effect.fn("ProviderMaintenanceRunner.submitProviderReauthenticationCode")(function* (input) {
      return yield* claudeAuthFlow.submitCode(input);
    });

  const getProviderReauthenticationStatus: ProviderMaintenanceRunnerShape["getProviderReauthenticationStatus"] =
    Effect.fn("ProviderMaintenanceRunner.getProviderReauthenticationStatus")(function* (input) {
      return yield* claudeAuthFlow.status(input.attemptId);
    });

  const cancelProviderReauthentication: ProviderMaintenanceRunnerShape["cancelProviderReauthentication"] =
    Effect.fn("ProviderMaintenanceRunner.cancelProviderReauthentication")(function* (input) {
      return yield* claudeAuthFlow.cancel(input.attemptId);
    });

  const reauthenticateProvider: ProviderMaintenanceRunnerShape["reauthenticateProvider"] =
    Effect.fn("ProviderMaintenanceRunner.reauthenticateProvider")(function* (input) {
      if (input.provider !== CLAUDE_DRIVER) {
        return yield* new ServerProviderReauthenticateError({
          provider: input.provider,
          reason: `Reauthentication is not supported for ${input.provider}`,
        });
      }

      const defaultInstanceId = defaultInstanceIdForDriver(CLAUDE_DRIVER);
      const instanceId = input.instanceId ?? defaultInstanceId;
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ServerProviderReauthenticateError({
              provider: input.provider,
              reason: "Failed to read provider settings.",
              cause,
            }),
        ),
      );
      const instance = settings.providerInstances[instanceId];
      if (
        input.instanceId !== undefined &&
        instance === undefined &&
        instanceId !== defaultInstanceId
      ) {
        return yield* new ServerProviderReauthenticateError({
          provider: input.provider,
          reason: `Provider instance ${instanceId} was not found.`,
        });
      }
      if (instance !== undefined && instance.driver !== CLAUDE_DRIVER) {
        return yield* new ServerProviderReauthenticateError({
          provider: input.provider,
          reason: `Provider instance ${instanceId} is not a Claude instance.`,
        });
      }

      const claudeSettings = yield* decodeClaudeSettings(
        instance === undefined
          ? settings.providers.claudeAgent
          : instance.config === undefined
            ? {}
            : instance.config,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ServerProviderReauthenticateError({
              provider: input.provider,
              reason: `Provider instance ${instanceId} has invalid Claude settings.`,
              cause,
            }),
        ),
      );
      const environment = yield* makeClaudeEnvironment(
        claudeSettings,
        mergeProviderInstanceEnvironment(instance?.environment),
      ).pipe(Effect.provideService(Path.Path, path));
      const result = yield* runProviderMaintenanceCommandWithSpawner({
        spawner,
        command: claudeSettings.binaryPath,
        args: ["auth", "login"],
        env: environment,
        stdin: "ignore",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ServerProviderReauthenticateError({
              provider: input.provider,
              reason: "Failed to run claude auth login.",
              cause,
            }),
        ),
      );

      if (result.timedOut) {
        return yield* new ServerProviderReauthenticateError({
          provider: input.provider,
          reason: "claude auth login timed out after 5 minutes.",
        });
      }
      if (result.exitCode !== 0) {
        return yield* new ServerProviderReauthenticateError({
          provider: input.provider,
          reason: `claude auth login exited with code ${result.exitCode}.`,
        });
      }

      const providers = yield* providerRegistry.refreshInstance(instanceId);
      return { providers };
    });

  return ProviderMaintenanceRunner.of({
    updateProvider,
    reauthenticateProvider,
    beginProviderReauthentication,
    submitProviderReauthenticationCode,
    getProviderReauthenticationStatus,
    cancelProviderReauthentication,
  });
});

export const layer = Layer.effect(ProviderMaintenanceRunner, make());

export const layerWithThreadContinuation = Layer.effect(
  ProviderMaintenanceRunner,
  Effect.gen(function* () {
    const providerService = yield* ProviderService.ProviderService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const projectionThreadMessages =
      yield* ProjectionThreadMessages.ProjectionThreadMessageRepository;
    const projectionTurns = yield* ProjectionTurns.ProjectionTurnRepository;
    return yield* make({
      onProviderReauthenticated: ({ threadId, instanceId }) =>
        continueProviderThreadAfterReauthentication({
          threadId,
          instanceId,
          getThreadDetailById: projectionSnapshotQuery.getThreadDetailById,
          getTurnByTurnId: projectionTurns.getByTurnId,
          getPendingTurnStartByThreadId: projectionTurns.getPendingTurnStartByThreadId,
          getMessageById: projectionThreadMessages.getByMessageId,
          getCapabilities: providerService.getCapabilities,
          sendTurn: providerService.sendTurn,
        }).pipe(
          Effect.asVoid,
          Effect.catchCause(() =>
            Effect.logWarning(
              "Claude was reauthenticated, but its failed thread could not be continued.",
              { threadId, providerInstanceId: instanceId },
            ),
          ),
        ),
    });
  }),
);
