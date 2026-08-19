import {
  ServerAutomaticUpdateDeferredError,
  ServerSelfUpdateError,
  type ServerSelfUpdateCapability,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import { hasAutomaticServerUpdateActiveWork } from "@t3tools/shared/automaticServerUpdate";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ensurePinnedRuntimeInstalled,
  PinnedRuntimeInstallError,
  PinnedRuntimePreflightBlockedError,
} from "./pinnedRuntime.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { isExactServiceVersion, SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import packageJson from "../../package.json" with { type: "json" };

const PREFLIGHT_TIMEOUT = Duration.seconds(30);

export function resolveServerSelfUpdateCapability(input: {
  readonly desktopManaged: boolean;
  readonly launcherManaged: boolean;
}): ServerSelfUpdateCapability | null {
  if (input.desktopManaged) return "desktop-managed" as const;
  return input.launcherManaged ? ("boot-service" as const) : null;
}

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (stage: ServerSelfUpdateProgressStage) => Effect.Effect<void>,
    ) => Effect.Effect<
      ServerSelfUpdateResult,
      ServerSelfUpdateError | ServerAutomaticUpdateDeferredError
    >;
    readonly withCommandAdmission: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ServerSelfUpdateError, R>;
  }
>()("t3/cloud/selfUpdate/ServerSelfUpdate") {}

export class ServerSelfUpdateIdleCheck extends Context.Service<
  ServerSelfUpdateIdleCheck,
  {
    readonly assertIdle: (
      targetVersion: string,
    ) => Effect.Effect<void, ServerSelfUpdateError | ServerAutomaticUpdateDeferredError>;
  }
>()("t3/cloud/selfUpdate/ServerSelfUpdateIdleCheck") {}

const idleCheckLayer = Layer.effect(
  ServerSelfUpdateIdleCheck,
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    return ServerSelfUpdateIdleCheck.of({
      assertIdle: (targetVersion) =>
        projections.getShellSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new ServerSelfUpdateError({
                reason: "Automatic update could not verify that this server is idle.",
                cause,
              }),
          ),
          Effect.flatMap((snapshot) =>
            hasAutomaticServerUpdateActiveWork(snapshot.threads)
              ? new ServerAutomaticUpdateDeferredError({
                  reason: "new work started while downloading",
                  targetVersion,
                })
              : Effect.void,
          ),
        ),
    });
  }),
);

export const make = Effect.fn("cloud.server_self_update.make")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const execPath = yield* HostProcessExecutablePath;
  const idleCheck = yield* ServerSelfUpdateIdleCheck;
  const inFlight = yield* Ref.make(false);
  const lastFailedTarget = yield* Ref.make<string | null>(null);
  const automaticHandoffPending = yield* Ref.make(false);
  const commandAdmission = yield* Semaphore.make(1);

  const withCommandAdmission = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ServerSelfUpdateError, R> => {
    const admitted = Ref.get(automaticHandoffPending).pipe(
      Effect.flatMap((blocked): Effect.Effect<A, E | ServerSelfUpdateError, R> => {
        if (!blocked) return effect as Effect.Effect<A, E | ServerSelfUpdateError, R>;
        return Effect.fail(
          new ServerSelfUpdateError({
            reason: "The server is activating an automatic update and cannot start new work.",
          }),
        );
      }),
    );
    return commandAdmission.withPermits(1)(admitted);
  };

  const capability: ServerSelfUpdateCapability | null =
    serverConfig.mode === "desktop" ? "desktop-managed" : launcher.managed ? "boot-service" : null;
  const failWith = (reason: string, cause?: unknown) =>
    cause === undefined
      ? new ServerSelfUpdateError({ reason })
      : new ServerSelfUpdateError({ reason, cause });

  const update: ServerSelfUpdate["Service"]["update"] = Effect.fn(
    "cloud.server_self_update.update",
  )(function* (input, reportProgress = () => Effect.void) {
    if (capability === "desktop-managed") {
      return yield* failWith(
        "This server is managed by the T3 Code desktop app on its machine; update the desktop app to update it.",
      );
    }
    if (capability === null) {
      return yield* failWith(
        "Remote updates require the T3 Code background service. Run `t3 service install` on the server machine.",
      );
    }

    const targetVersion = input.targetVersion.trim();
    if (!isExactServiceVersion(targetVersion)) {
      return yield* failWith(`'${targetVersion}' is not an exact t3 version.`);
    }
    if (
      input.automatic === true &&
      compareSemverVersions(targetVersion, packageJson.version) <= 0
    ) {
      return yield* failWith("Automatic updates must move the server to a newer version.");
    }
    const previousFailedTarget = yield* Ref.get(lastFailedTarget);
    if (input.automatic === true && previousFailedTarget === targetVersion) {
      return yield* failWith(
        "An automatic update to this version already failed. Retry it manually before automatic updates resume.",
      );
    }
    if (yield* Ref.getAndSet(inFlight, true)) {
      return yield* failWith("A server update is already in progress.");
    }
    let automaticUpdateDeferred = false;
    const operation = Effect.gen(function* () {
      if (input.automatic !== true && previousFailedTarget === targetVersion) {
        yield* Ref.set(lastFailedTarget, null);
      }
      yield* reportProgress("downloading");
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir: serverConfig.baseDir,
        version: targetVersion,
        fs,
        path,
        runner,
        validate: (runtime) =>
          runner
            .run({
              command: execPath,
              args: [
                runtime.entryPath,
                "__service-preflight",
                "--database-path",
                serverConfig.dbPath,
                "--launcher-protocol",
                String(SERVICE_LAUNCHER_PROTOCOL),
              ],
              timeout: PREFLIGHT_TIMEOUT,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PinnedRuntimeInstallError({
                    step: "running the staged service preflight",
                    cause,
                  }),
              ),
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<
                  void,
                  PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError
                > => {
                  if (result.code !== 0) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "running the staged service preflight",
                        exitCode: Number(result.code),
                        stdoutLength: result.stdout.length,
                        stderrLength: result.stderr.length,
                      }),
                    );
                  }
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(result.stdout.trim());
                  } catch (cause) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "decoding the staged service preflight",
                        cause,
                      }),
                    );
                  }
                  const preflight = decodeServicePreflightResult(parsed);
                  if (preflight === undefined || preflight.version !== targetVersion) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "verifying the staged service preflight",
                      }),
                    );
                  }
                  return preflight.status === "ready"
                    ? Effect.void
                    : Effect.fail(
                        new PinnedRuntimePreflightBlockedError({
                          version: targetVersion,
                          reason: preflight.reason,
                        }),
                      );
                },
              ),
            ),
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "PinnedRuntimePreflightBlockedError"
            ? failWith(error.reason, error)
            : failWith(`Could not prepare t3@${targetVersion}.`, error),
        ),
        Effect.interruptible,
      );

      const activatePreparedUpdate = Effect.gen(function* () {
        yield* reportProgress("installing");
        const updateId = yield* launcher
          .requestUpdate({ targetVersion, dbPath: serverConfig.dbPath })
          .pipe(
            Effect.mapError((error) =>
              failWith(
                error._tag === "ServiceLauncherRejectedError"
                  ? error.reason
                  : "Could not ask the service launcher to activate the prepared update.",
                error,
              ),
            ),
          );

        yield* Effect.logInfo("Server update prepared; handing off to the service launcher.", {
          updateId,
          targetVersion,
          runtimePath: paths.entryPath,
        });
        return { targetVersion, method: "boot-service" as const, updateId };
      });
      if (input.automatic !== true) return yield* activatePreparedUpdate;

      return yield* commandAdmission
        .withPermits(1)(
          Effect.gen(function* () {
            yield* idleCheck.assertIdle(targetVersion).pipe(
              Effect.catchTags({
                ServerAutomaticUpdateDeferredError: (error) =>
                  Effect.sync(() => {
                    automaticUpdateDeferred = true;
                  }).pipe(Effect.andThen(error)),
              }),
            );
            yield* Ref.set(automaticHandoffPending, true);
          }),
        )
        .pipe(Effect.andThen(activatePreparedUpdate));
    }).pipe(
      Effect.onError((cause) =>
        Effect.all(
          [
            Ref.set(inFlight, false),
            Ref.set(automaticHandoffPending, false),
            Ref.set(
              lastFailedTarget,
              automaticUpdateDeferred || Cause.hasInterruptsOnly(cause)
                ? previousFailedTarget
                : input.automatic === true ||
                    previousFailedTarget === null ||
                    previousFailedTarget === targetVersion
                  ? targetVersion
                  : previousFailedTarget,
            ),
          ],
          { discard: true },
        ),
      ),
    );
    return yield* input.automatic === true ? Effect.uninterruptible(operation) : operation;
  });

  return ServerSelfUpdate.of({ update, withCommandAdmission });
});

export const layer = Layer.effect(ServerSelfUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provide(idleCheckLayer),
);
