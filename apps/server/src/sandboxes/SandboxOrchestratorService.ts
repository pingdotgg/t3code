import {
  CloudSandboxRecord,
  SandboxId,
  SandboxListResult,
  SandboxOperationError,
  type SandboxDestroyResult,
  type SandboxIdInput,
  type SandboxProviderKind,
  type SandboxResumeResult,
  type SandboxSnapshotInput,
  type SandboxSnapshotResult,
  type SandboxSpawnInput,
  type SandboxSpawnResult,
  type SandboxStopResult,
} from "@t3tools/contracts";
import { SandboxError, SandboxProviderRegistry } from "@t3tools/sandbox-providers";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import {
  bootstrapSandbox,
  buildEnvironmentIdCommand,
  buildHeadlessServerStartCommand,
  buildPairingCommand,
  extractEnvironmentId,
  extractPairingUrl,
  rewritePairingUrlForPublicOrigin,
} from "./SandboxBootstrap.ts";
import { SANDBOX_SERVER_PORT, SandboxConfig } from "./SandboxConfig.ts";
import { SandboxRepository, SandboxRepositoryError } from "./SandboxRepository.ts";

function mapSandboxError(
  operation: SandboxOperationError["operation"],
  error: SandboxError | SandboxRepositoryError,
): SandboxOperationError {
  if (error._tag === "SandboxRepositoryError") {
    return new SandboxOperationError({
      operation,
      category: "persistence_error",
      reason: error.message,
    });
  }
  return new SandboxOperationError({
    operation,
    category: error.category,
    provider: error.provider,
    ...(error.sandboxId !== undefined ? { sandboxId: error.sandboxId } : {}),
    reason: error.message,
  });
}

function buildSandboxName(provider: SandboxProviderKind, id: string): string {
  const shortId = id.replaceAll("-", "").slice(0, 8);
  return `kbcode-${provider}-${shortId}`;
}

export class SandboxOrchestratorService extends Context.Service<
  SandboxOrchestratorService,
  {
    readonly listSandboxes: () => Effect.Effect<SandboxListResult, SandboxOperationError>;
    readonly subscribeSandboxes: Stream.Stream<SandboxListResult>;
    readonly spawnSandbox: (
      input: SandboxSpawnInput,
    ) => Effect.Effect<SandboxSpawnResult, SandboxOperationError>;
    readonly resumeSandbox: (
      input: SandboxIdInput,
    ) => Effect.Effect<SandboxResumeResult, SandboxOperationError>;
    readonly snapshotSandbox: (
      input: SandboxSnapshotInput,
    ) => Effect.Effect<SandboxSnapshotResult, SandboxOperationError>;
    readonly stopSandbox: (
      input: SandboxIdInput,
    ) => Effect.Effect<SandboxStopResult, SandboxOperationError>;
    readonly destroySandbox: (
      input: SandboxIdInput,
    ) => Effect.Effect<SandboxDestroyResult, SandboxOperationError>;
    readonly publishRefresh: () => Effect.Effect<void>;
  }
>()("t3/sandboxes/SandboxOrchestratorService") {}

const make = Effect.gen(function* () {
  const config = yield* SandboxConfig;
  const registry = yield* SandboxProviderRegistry;
  const repository = yield* SandboxRepository;
  const random = yield* SecureRandom.SecureRandom;
  const updates = yield* PubSub.unbounded<SandboxListResult>();

  const buildListResult = Effect.fn("SandboxOrchestratorService.buildListResult")(function* () {
    const [sandboxes, providers] = yield* Effect.all([
      repository.listAll().pipe(Effect.mapError((error) => mapSandboxError("list", error))),
      registry.listAvailability(),
    ]);
    return {
      sandboxes,
      providers,
      defaultIdleTimeoutMinutes: config.defaultIdleTimeoutMinutes,
    } satisfies SandboxListResult;
  });

  const publishRefresh = Effect.fn("SandboxOrchestratorService.publishRefresh")(function* () {
    const snapshot = yield* buildListResult().pipe(Effect.option);
    if (Option.isSome(snapshot)) {
      yield* PubSub.publish(updates, snapshot.value);
    }
  });

  const mergedBootstrapEnv = (extraEnv?: Readonly<Record<string, string>>) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.passthroughSecrets)) {
      env[key] = Redacted.value(value);
    }
    if (extraEnv !== undefined) {
      for (const [key, value] of Object.entries(extraEnv)) {
        env[key] = value;
      }
    }
    return env;
  };

  const requireRecord = Effect.fn("SandboxOrchestratorService.requireRecord")(function* (
    operation: SandboxOperationError["operation"],
    id: SandboxId,
  ) {
    const found = yield* repository
      .findById(id)
      .pipe(Effect.mapError((error) => mapSandboxError(operation, error)));
    if (Option.isNone(found)) {
      return yield* new SandboxOperationError({
        operation,
        category: "not_found",
        sandboxId: id,
        reason: `Sandbox '${id}' was not found.`,
      });
    }
    return found.value;
  });

  const subscribeSandboxes: Stream.Stream<SandboxListResult> = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(updates);
      const initial = yield* buildListResult().pipe(
        Effect.orElseSucceed((): SandboxListResult => ({
          sandboxes: [],
          providers: [],
          defaultIdleTimeoutMinutes: config.defaultIdleTimeoutMinutes,
        })),
      );
      return Stream.concat(Stream.succeed(initial), Stream.fromSubscription(subscription));
    }),
  );

  return SandboxOrchestratorService.of({
    listSandboxes: buildListResult,
    subscribeSandboxes,
    publishRefresh,

    spawnSandbox: Effect.fn("SandboxOrchestratorService.spawnSandbox")(function* (input) {
      const driver = yield* registry
        .get(input.provider)
        .pipe(Effect.mapError((error) => mapSandboxError("spawn", error)));

      const id = SandboxId.make(yield* random.uuidV4());
      const name = input.name ?? buildSandboxName(input.provider, id);
      const idleTimeoutMinutes = input.idleTimeoutMinutes ?? config.defaultIdleTimeoutMinutes;
      const requestedSnapshotId =
        input.snapshotId ?? registry.defaultSnapshotFor(input.provider) ?? undefined;
      const env = mergedBootstrapEnv(input.env);
      const nowIso = DateTime.formatIso(yield* DateTime.now);

      const created = yield* driver
        .create({
          name,
          ...(requestedSnapshotId !== undefined ? { snapshotId: requestedSnapshotId } : {}),
          idleTimeoutMinutes,
          port: SANDBOX_SERVER_PORT,
          env,
          ...(env.GITHUB_TOKEN !== undefined ? { gitToken: env.GITHUB_TOKEN } : {}),
        })
        .pipe(Effect.mapError((error) => mapSandboxError("spawn", error)));

      const initialRecord: CloudSandboxRecord = {
        id,
        provider: input.provider,
        providerSandboxId: created.providerSandboxId,
        name,
        snapshotId: created.snapshotId ?? requestedSnapshotId ?? null,
        baseSnapshotId: null,
        repoUrl: input.repoUrl ?? null,
        branch: input.branch ?? null,
        agentHarness: input.agentHarness ?? null,
        connectionUrl: created.connectionUrl ?? null,
        environmentId: null,
        state: "bootstrapping",
        idleTimeoutMinutes,
        startedAt: nowIso,
        lastActivityAt: nowIso,
        pausedAt: null,
        vercelWarnedAt: null,
        lastError: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      yield* repository
        .insert(initialRecord)
        .pipe(Effect.mapError((error) => mapSandboxError("spawn", error)));
      yield* publishRefresh();

      const bootstrapped = yield* bootstrapSandbox({
        driver,
        providerSandboxId: created.providerSandboxId,
        name,
        port: SANDBOX_SERVER_PORT,
        bootedFromSnapshot: requestedSnapshotId !== undefined,
        createBaseSnapshot: input.createBaseSnapshot,
        repoUrl: input.repoUrl,
        branch: input.branch,
        agentHarness: input.agentHarness,
        cliPackageSpec: config.cliPackageSpec,
        forwardHostOAuth: input.forwardHostOAuth ?? config.forwardHostOAuth,
        env,
        connectionUrlHint: created.connectionUrl,
      }).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            const failedAt = DateTime.formatIso(yield* DateTime.now);
            yield* repository
              .update(id, {
                state: "error",
                lastError: error.message,
                updatedAt: failedAt,
              })
              .pipe(Effect.ignore);
            yield* publishRefresh();
          }),
        ),
        Effect.mapError((error) => mapSandboxError("spawn", error)),
      );

      const readyIso = DateTime.formatIso(yield* DateTime.now);
      const updatedOption = yield* repository
        .update(id, {
          state: "running",
          connectionUrl: bootstrapped.connectionUrl,
          environmentId: bootstrapped.environmentId,
          ...(bootstrapped.baseSnapshotId !== null
            ? {
                baseSnapshotId: bootstrapped.baseSnapshotId,
                snapshotId: bootstrapped.baseSnapshotId,
              }
            : {}),
          startedAt: readyIso,
          lastActivityAt: readyIso,
          pausedAt: null,
          vercelWarnedAt: null,
          lastError: null,
          updatedAt: readyIso,
        })
        .pipe(Effect.mapError((error) => mapSandboxError("spawn", error)));

      yield* publishRefresh();
      const sandbox = Option.getOrElse(updatedOption, () => ({
        ...initialRecord,
        state: "running" as const,
        connectionUrl: bootstrapped.connectionUrl,
        environmentId: bootstrapped.environmentId,
        baseSnapshotId: bootstrapped.baseSnapshotId,
        startedAt: readyIso,
        lastActivityAt: readyIso,
        updatedAt: readyIso,
      }));
      return {
        sandbox,
        ...(bootstrapped.pairingUrl !== undefined ? { pairingUrl: bootstrapped.pairingUrl } : {}),
      };
    }),

    resumeSandbox: Effect.fn("SandboxOrchestratorService.resumeSandbox")(function* (input) {
      const existing = yield* requireRecord("resume", input.id);
      const driver = yield* registry
        .get(existing.provider)
        .pipe(Effect.mapError((error) => mapSandboxError("resume", error)));

      const resumed = yield* driver
        .resume(existing.providerSandboxId, { port: SANDBOX_SERVER_PORT })
        .pipe(Effect.mapError((error) => mapSandboxError("resume", error)));

      const env = mergedBootstrapEnv();
      const workspaceCwd = existing.repoUrl !== null ? "$HOME/workspace" : "$HOME";
      yield* driver
        .exec({
          providerSandboxId: resumed.providerSandboxId,
          command: buildHeadlessServerStartCommand({
            port: SANDBOX_SERVER_PORT,
            cwd: workspaceCwd,
          }),
          env: { ...env, T3CODE_ENVIRONMENT_MACHINE_KIND: "cloud" },
          detached: true,
        })
        .pipe(Effect.ignore);

      const connectionUrl =
        resumed.connectionUrl ??
        (yield* driver
          .getPublicUrl(resumed.providerSandboxId, SANDBOX_SERVER_PORT)
          .pipe(Effect.orElseSucceed(() => existing.connectionUrl))) ??
        existing.connectionUrl;

      const pairExec = yield* driver
        .exec({
          providerSandboxId: resumed.providerSandboxId,
          command: buildPairingCommand(SANDBOX_SERVER_PORT),
          env: { ...env, T3CODE_ENVIRONMENT_MACHINE_KIND: "cloud" },
        })
        .pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })));
      const pairingUrl =
        pairExec.exitCode === 0
          ? rewritePairingUrlForPublicOrigin(extractPairingUrl(pairExec.stdout), connectionUrl)
          : undefined;

      const resolvedEnvironmentId =
        existing.environmentId ??
        extractEnvironmentId(
          (yield* driver
            .exec({
              providerSandboxId: resumed.providerSandboxId,
              command: buildEnvironmentIdCommand(SANDBOX_SERVER_PORT),
            })
            .pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })))).stdout,
        );

      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const updatedOption = yield* repository
        .update(existing.id, {
          providerSandboxId: resumed.providerSandboxId,
          connectionUrl,
          ...(resolvedEnvironmentId !== null ? { environmentId: resolvedEnvironmentId } : {}),
          state: "running",
          startedAt: nowIso,
          lastActivityAt: nowIso,
          pausedAt: null,
          vercelWarnedAt: null,
          lastError: null,
          updatedAt: nowIso,
        })
        .pipe(Effect.mapError((error) => mapSandboxError("resume", error)));

      yield* publishRefresh();
      const sandbox = Option.getOrElse(updatedOption, () => ({
        ...existing,
        providerSandboxId: resumed.providerSandboxId,
        connectionUrl,
        state: "running" as const,
        startedAt: nowIso,
        lastActivityAt: nowIso,
        pausedAt: null,
        vercelWarnedAt: null,
        lastError: null,
        updatedAt: nowIso,
      }));
      return {
        sandbox,
        ...(pairingUrl !== undefined ? { pairingUrl } : {}),
      };
    }),

    snapshotSandbox: Effect.fn("SandboxOrchestratorService.snapshotSandbox")(function* (input) {
      const existing = yield* requireRecord("snapshot", input.id);
      const driver = yield* registry
        .get(existing.provider)
        .pipe(Effect.mapError((error) => mapSandboxError("snapshot", error)));

      const startIso = DateTime.formatIso(yield* DateTime.now);
      yield* repository
        .update(existing.id, { state: "snapshotting", updatedAt: startIso })
        .pipe(Effect.mapError((error) => mapSandboxError("snapshot", error)));
      yield* publishRefresh();

      const snap = yield* driver
        .snapshot({
          providerSandboxId: existing.providerSandboxId,
          name: input.name ?? `${existing.name}-snapshot`,
        })
        .pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              const failedAt = DateTime.formatIso(yield* DateTime.now);
              yield* repository
                .update(existing.id, {
                  state: existing.state,
                  lastError: error.message,
                  updatedAt: failedAt,
                })
                .pipe(Effect.ignore);
              yield* publishRefresh();
            }),
          ),
          Effect.mapError((error) => mapSandboxError("snapshot", error)),
        );

      const doneIso = DateTime.formatIso(yield* DateTime.now);
      const nextState = snap.stoppedAfterSnapshot ? ("paused" as const) : ("running" as const);
      const updatedOption = yield* repository
        .update(existing.id, {
          state: nextState,
          snapshotId: snap.snapshotId,
          ...(input.markAsBase ? { baseSnapshotId: snap.snapshotId } : {}),
          ...(snap.stoppedAfterSnapshot ? { pausedAt: doneIso } : {}),
          lastActivityAt: doneIso,
          lastError: null,
          updatedAt: doneIso,
        })
        .pipe(Effect.mapError((error) => mapSandboxError("snapshot", error)));

      yield* publishRefresh();
      const sandbox = Option.getOrElse(updatedOption, () => ({
        ...existing,
        state: nextState,
        snapshotId: snap.snapshotId,
        baseSnapshotId: input.markAsBase ? snap.snapshotId : existing.baseSnapshotId,
        pausedAt: snap.stoppedAfterSnapshot ? doneIso : existing.pausedAt,
        lastActivityAt: doneIso,
        lastError: null,
        updatedAt: doneIso,
      }));
      return { sandbox, snapshotId: snap.snapshotId };
    }),

    stopSandbox: Effect.fn("SandboxOrchestratorService.stopSandbox")(function* (input) {
      const existing = yield* requireRecord("stop", input.id);
      const driver = yield* registry
        .get(existing.provider)
        .pipe(Effect.mapError((error) => mapSandboxError("stop", error)));

      const result = yield* driver
        .pauseOrStop(existing.providerSandboxId)
        .pipe(Effect.mapError((error) => mapSandboxError("stop", error)));

      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const updatedOption = yield* repository
        .update(existing.id, {
          state: result.state,
          ...(result.snapshotId !== undefined ? { snapshotId: result.snapshotId } : {}),
          pausedAt: nowIso,
          lastError: null,
          updatedAt: nowIso,
        })
        .pipe(Effect.mapError((error) => mapSandboxError("stop", error)));

      yield* publishRefresh();
      const sandbox = Option.getOrElse(updatedOption, () => ({
        ...existing,
        state: result.state,
        snapshotId: result.snapshotId ?? existing.snapshotId,
        pausedAt: nowIso,
        lastError: null,
        updatedAt: nowIso,
      }));
      return { sandbox };
    }),

    destroySandbox: Effect.fn("SandboxOrchestratorService.destroySandbox")(function* (input) {
      const existing = yield* requireRecord("destroy", input.id);
      const driver = yield* registry
        .get(existing.provider)
        .pipe(Effect.mapError((error) => mapSandboxError("destroy", error)));

      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* repository
        .update(existing.id, { state: "destroying", updatedAt: nowIso })
        .pipe(Effect.mapError((error) => mapSandboxError("destroy", error)));
      yield* publishRefresh();

      yield* driver.destroy(existing.providerSandboxId).pipe(
        Effect.catchTags({
          SandboxError: (error) =>
            error.category === "not_found"
              ? Effect.void
              : Effect.fail(mapSandboxError("destroy", error)),
        }),
      );

      yield* repository
        .deleteById(existing.id)
        .pipe(Effect.mapError((error) => mapSandboxError("destroy", error)));
      yield* publishRefresh();
      return { id: existing.id };
    }),
  });
});

export const layer = Layer.effect(SandboxOrchestratorService, make);
