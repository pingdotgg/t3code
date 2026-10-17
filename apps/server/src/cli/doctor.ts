import { DATABASE_COMPACTION_RECOMMENDED_BYTES } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";

import * as BootService from "../cloud/bootService.ts";
import * as DatabaseMaintenance from "../persistence/DatabaseMaintenance.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
      : `${Math.ceil(bytes / 1024)} KiB`;

export const runDoctor = Effect.fn("runDoctor")(function* (
  databasePath: string,
  options: { readonly fix: boolean; readonly dryRun: boolean; readonly interactive?: boolean },
) {
  const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
  const status = yield* maintenance.inspect(databasePath);
  yield* Console.log(
    `Database: ${formatBytes(status.databaseBytes)}, ${formatBytes(status.reclaimableBytes)} reclaimable.`,
  );
  if (status.legacyDatabaseBytes !== null) {
    yield* Console.log(
      `Database from before 0.1.0: ${formatBytes(status.legacyDatabaseBytes)}, kept for rolling back.`,
    );
  }
  const repairs = [
    ...(status.incrementalVacuumEnabled && status.reclaimableBytes === 0
      ? []
      : [
          {
            id: "database" as const,
            title: "Reclaim database space",
            description: `${
              status.incrementalVacuumEnabled
                ? "Returns unused space to disk."
                : "Returns unused space to disk and turns on automatic shrinking."
            }\n  Pauses the background service, if installed, while it runs and may need temporary disk space.`,
            recommended:
              !status.incrementalVacuumEnabled ||
              status.reclaimableBytes >= DATABASE_COMPACTION_RECOMMENDED_BYTES,
          },
        ]),
    ...(status.legacyDatabaseBytes === null
      ? []
      : [
          {
            id: "legacy" as const,
            title: "Delete the database from before 0.1.0",
            description: `Frees ${formatBytes(status.legacyDatabaseBytes)}. Your threads and settings are already in the current database.\n  Warning: after this, a T3 Code version before 0.1.0 starts with no threads or settings, so you can no longer roll back.`,
            // Never chosen for you: deleting it gives up rolling back.
            recommended: false,
          },
        ]),
  ];
  if (repairs.length === 0) {
    yield* Console.log("Nothing to repair.");
    return;
  }
  for (const repair of repairs) {
    yield* Console.log(
      `\n${repair.title}${repair.recommended ? " (recommended)" : ""}\n  ${repair.description}`,
    );
  }
  if (options.dryRun) {
    yield* Console.log("\nDry run: nothing changed.");
    return;
  }
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!options.fix && !interactive) {
    yield* Console.log(
      "\nRun in a terminal to choose repairs, or pass --fix for the recommended ones.",
    );
    return;
  }
  const selected = options.fix
    ? repairs.filter((repair) => repair.recommended).map((repair) => repair.id)
    : yield* Prompt.run(
        Prompt.MultiSelect({
          message: "Choose repairs to run",
          choices: repairs.map((repair) => ({
            title: repair.title + (repair.recommended ? " (recommended)" : ""),
            value: repair.id,
            selected: repair.recommended,
          })),
        }),
      ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed([]) }));
  if (selected.length === 0) {
    yield* Console.log(
      options.fix
        ? "No recommended repairs; nothing changed."
        : "No repairs selected; nothing changed.",
    );
    return;
  }
  if (selected.includes("database")) {
    const service = yield* BootService.BootService;
    yield* Console.log("\nReclaiming database space. This can take several minutes...");
    // Report inside the pause: a repair that succeeded is worth knowing about
    // even when starting the service again fails afterwards.
    yield* service.withStopped(
      maintenance
        .compact(databasePath)
        .pipe(
          Effect.tap((result) =>
            Console.log(
              `Done: ${formatBytes(result.beforeBytes)} -> ${formatBytes(result.afterBytes)}, ${result.deletedEventCount} superseded events removed.`,
            ),
          ),
        ),
    );
  }
  if (selected.includes("legacy")) {
    // Only versions before 0.1.0 open this file, so the service keeps running;
    // the removal itself refuses while one of those still has it open.
    yield* maintenance.removeLegacyDatabase(databasePath);
    yield* Console.log("\nDeleted the database from before 0.1.0.");
  }
});

export const doctorCommand = Command.make("doctor", {
  ...projectLocationFlags,
  fix: Flag.Boolean("fix").pipe(
    Flag.withDescription("Apply the recommended repairs without prompting."),
    Flag.withDefault(false),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Show the repairs without changing anything, even with --fix."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Inspect this T3 Code data directory and repair it. Pauses and restarts the background service as needed.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      yield* runDoctor(config.dbPath, { fix: flags.fix, dryRun: flags.dryRun }).pipe(
        Effect.provide(Layer.merge(DatabaseMaintenance.layer, CliService.layer(config))),
      );
    }),
  ),
);
