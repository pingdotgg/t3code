import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, GlobalFlag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";

class ProjectionServerRunningError extends Schema.TaggedError<ProjectionServerRunningError>()(
  "ProjectionServerRunningError",
  {},
) {
  override get message(): string {
    return "Stop the T3 Code server for this data directory before verifying or rebuilding projections.";
  }
}

class ProjectionVerificationFailedError extends Schema.TaggedError<ProjectionVerificationFailedError>()(
  "ProjectionVerificationFailedError",
  {
    action: Schema.Literals(["verify", "rebuild"]),
    unreadableThreadIds: Schema.Array(Schema.String),
    missingThreadIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const affected = [...new Set([...this.unreadableThreadIds, ...this.missingThreadIds])];
    const named =
      affected.length === 0
        ? ""
        : ` Affected threads, also listed in the report above: ${affected
            .slice(0, 5)
            .join(", ")}${affected.length > 5 ? ` and ${affected.length - 5} more` : ""}.`;
    if (this.action === "verify") {
      return `Projection verification failed.${named} Run \`t3 projections rebuild\` with the same location flags to rebuild thread data from the event history.`;
    }
    return `Rebuild finished but thread data is still unverifiable, so the event history no longer reproduces it.${named} Restore the backup you took before rebuilding, then report this.`;
  }
}

export const projectionsCommand = Command.make("projections", {
  action: Argument.Literals("action", ["verify", "rebuild"]),
  ...authLocationFlags,
}).pipe(
  Command.withDescription("Verify or rebuild thread projections while the server is stopped."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isSome(state) && isProcessAlive(state.value.pid)) {
        return yield* new ProjectionServerRunningError();
      }
      // Do not turn a mistyped location into a new, apparently healthy database.
      const fs = yield* FileSystem.FileSystem;
      yield* fs.access(config.dbPath);
      const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(SqlitePersistence.layerConfig),
      );
      const maintenanceLayer = ProjectionMaintenance.layer.pipe(
        Layer.provide(stores),
        Layer.provide(ServerConfig.layer(config)),
      );
      const verification = yield* Effect.gen(function* () {
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        return yield* flags.action === "rebuild" ? maintenance.rebuild : maintenance.verify;
      }).pipe(Effect.provide(maintenanceLayer));
      const output = yield* Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown))({
        dbPath: config.dbPath,
        ...verification,
      });
      yield* Console.log(output);
      if (!verification.valid) {
        return yield* new ProjectionVerificationFailedError({
          action: flags.action,
          unreadableThreadIds: verification.unreadableThreadIds,
          missingThreadIds: verification.missingThreadIds,
        });
      }
    }),
  ),
);
