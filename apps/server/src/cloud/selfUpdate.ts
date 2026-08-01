import {
  ServerSelfUpdateError,
  type ServerSelfUpdateCapability,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerShutdown from "../serverShutdown.ts";
import { ensurePinnedRuntimeInstalled, PinnedRuntimeInstallError } from "./pinnedRuntime.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import { isServiceLauncherManaged, ServiceLauncherClient } from "./serviceLauncherClient.ts";
import {
  isExactServiceVersion,
  SERVICE_HANDOFF_EXIT_CODE,
  SERVICE_LAUNCHER_PROTOCOL,
} from "./serviceProtocol.ts";

const PREFLIGHT_TIMEOUT = Duration.seconds(30);
const HANDOFF_DELAY = Duration.seconds(2);

export const resolveServerSelfUpdateCapability = Effect.fn(
  "cloud.server_self_update.resolve_capability",
)((input: { readonly desktopManaged: boolean }) =>
  Effect.succeed(
    input.desktopManaged
      ? ("desktop-managed" as const)
      : isServiceLauncherManaged()
        ? ("boot-service" as const)
        : null,
  ),
);

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (stage: ServerSelfUpdateProgressStage) => Effect.Effect<void>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
  }
>()("t3/cloud/selfUpdate/ServerSelfUpdate") {}

export const make = Effect.fn("cloud.server_self_update.make")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const launcher = yield* ServiceLauncherClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const execPath = yield* HostProcessExecutablePath;
  const inFlight = yield* Ref.make(false);

  const capability: ServerSelfUpdateCapability | null =
    serverConfig.mode === "desktop" ? "desktop-managed" : launcher.managed ? "boot-service" : null;
  const failWith = (reason: string) => new ServerSelfUpdateError({ reason });

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
    if (yield* Ref.getAndSet(inFlight, true)) {
      return yield* failWith("A server update is already in progress.");
    }

    return yield* Effect.gen(function* () {
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
              Effect.flatMap((result) => {
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
                      new PinnedRuntimeInstallError({
                        step: preflight.reason,
                      }),
                    );
              }),
            ),
      }).pipe(
        Effect.mapError((error) =>
          failWith(
            error.step.startsWith("This version includes") ||
              error.step.startsWith("This release requires")
              ? error.step
              : `Could not prepare t3@${targetVersion}: ${error.message}`,
          ),
        ),
      );

      yield* reportProgress("installing");
      const pending = yield* launcher
        .requestUpdate({ fromVersion: packageJson.version, targetVersion })
        .pipe(Effect.mapError((error) => failWith(error.reason)));

      yield* Effect.sleep(HANDOFF_DELAY).pipe(
        Effect.andThen(ServerShutdown.request(SERVICE_HANDOFF_EXIT_CODE)),
        Effect.forkDetach({ startImmediately: true }),
      );

      yield* Effect.logInfo("Server update prepared; handing off to the service launcher.", {
        updateId: pending.id,
        targetVersion,
        runtimePath: paths.entryPath,
      });
      return { targetVersion, method: "boot-service" as const, updateId: pending.id };
    }).pipe(Effect.onError(() => Ref.set(inFlight, false)));
  });

  return ServerSelfUpdate.of({ update });
});

export const layer = Layer.effect(ServerSelfUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
