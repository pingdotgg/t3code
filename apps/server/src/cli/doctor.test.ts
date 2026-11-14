import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as BootService from "../cloud/bootService.ts";
import { runDoctor } from "./doctor.ts";
import { DatabaseMaintenance } from "../persistence/DatabaseMaintenance.ts";
import * as ProcessRunner from "../processRunner.ts";
import { acquireServerOwnership } from "../serverOwnership.ts";
import { makePersistedServerRuntimeState } from "../serverRuntimeState.ts";

// An empty home, so no boot service unit installed on this machine is read.
const layerHost = Layer.mergeAll(
  ProcessRunner.layer,
  Layer.effect(
    HostProcess.HomeDirectory,
    Effect.gen(function* () {
      return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    }),
  ),
  Layer.succeed(HostProcess.Environment, {}),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

it.effect(
  "--fix locks the home while the service is paused, names a server that holds it, keeps the V1 database, and --dry-run changes nothing",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-doctor-" });
      const serverRuntimeStatePath = path.join(stateDir, "server-runtime.json");
      const calls: string[] = [];
      const services =
        yield* Effect.context<Effect.Services<ReturnType<typeof acquireServerOwnership>>>();
      // Stands in for a server launched for the same home, for example over SSH.
      const startServer = Effect.scoped(acquireServerOwnership(serverRuntimeStatePath)).pipe(
        Effect.result,
        Effect.map((result) =>
          calls.push(result._tag === "Success" ? "server started" : result.failure._tag),
        ),
        Effect.provide(services),
      );
      const doctor = (dryRun: boolean) =>
        runDoctor(
          { dbPath: path.join(stateDir, "statev2.sqlite"), serverRuntimeStatePath },
          { fix: true, dryRun, interactive: false },
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(BootService.BootService)({
                withStopped: (operation) =>
                  Effect.sync(() => calls.push("pause")).pipe(
                    Effect.andThen(operation),
                    Effect.ensuring(Effect.sync(() => calls.push("resume"))),
                  ),
              }),
              Layer.succeed(DatabaseMaintenance, {
                inspect: () =>
                  Effect.succeed({
                    databaseBytes: 2000,
                    reclaimableBytes: 1000,
                    incrementalVacuumEnabled: false,
                    legacyDatabaseBytes: 4000,
                  }),
                compact: () =>
                  startServer.pipe(
                    Effect.map(() => {
                      calls.push("compact");
                      return {
                        beforeBytes: 2000,
                        afterBytes: 1000,
                        deletedEventCount: 1,
                        deletedReceiptCount: 0,
                      };
                    }),
                  ),
                removeLegacyDatabase: () => Effect.sync(() => calls.push("remove legacy")),
              }),
            ),
          ),
        );
      yield* doctor(true);
      assert.deepEqual(calls, []);
      yield* doctor(false);
      yield* startServer;
      assert.deepEqual(calls, [
        "pause",
        "ServerAlreadyRunningError",
        "compact",
        "resume",
        "server started",
      ]);

      calls.length = 0;
      const state = yield* makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 3773,
      });
      const refused = yield* Effect.scoped(
        acquireServerOwnership(serverRuntimeStatePath).pipe(
          Effect.tap((owner) => owner.publish(state)),
          Effect.andThen(doctor(false)),
        ),
      ).pipe(Effect.flip);
      assert.equal(
        refused.message,
        `Stop T3 Code server process ${state.pid}, which the background service did not start, before repairing the database.`,
      );
      assert.deepEqual(calls, ["pause", "resume"]);
    }).pipe(Effect.provide(layerHost)),
);

it.effect("warns how long reclaiming can take and reports each step with its elapsed time", () =>
  Effect.gen(function* () {
    const output: string[] = [];
    const steps = [
      ["prune-events", "65 seconds"],
      ["vacuum", "701 seconds"],
      ["rebuild-search", "1 second"],
      ["checkpoint", "1 second"],
    ] as const;
    const stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const path = yield* Path.Path;
    yield* runDoctor(
      {
        dbPath: path.join(stateDir, "statev2.sqlite"),
        serverRuntimeStatePath: path.join(stateDir, "server-runtime.json"),
      },
      { fix: true, dryRun: false, interactive: false },
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(BootService.BootService)({
            withStopped: (operation) =>
              Effect.sync(() => output.push("<pause>")).pipe(
                Effect.andThen(operation),
                Effect.ensuring(Effect.sync(() => output.push("<resume>"))),
              ),
          }),
          Layer.succeed(DatabaseMaintenance, {
            inspect: () =>
              Effect.succeed({
                databaseBytes: 12.8 * 1024 ** 3,
                reclaimableBytes: 0,
                incrementalVacuumEnabled: false,
                legacyDatabaseBytes: null,
              }),
            compact: (_databasePath, onStep) =>
              Effect.gen(function* () {
                for (const [step, duration] of steps) {
                  if (onStep) yield* onStep(step);
                  yield* TestClock.adjust(duration);
                }
                return {
                  beforeBytes: 12.8 * 1024 ** 3,
                  afterBytes: 12.8 * 1024 ** 3,
                  deletedEventCount: 0,
                  deletedReceiptCount: 0,
                };
              }),
            removeLegacyDatabase: () => Effect.void,
          }),
        ),
      ),
      Effect.provideService(Console.Console, {
        ...globalThis.console,
        log: (...args: ReadonlyArray<unknown>) => {
          output.push(...args.join(" ").split("\n"));
        },
      }),
    );

    const paused = output.indexOf("<pause>");
    const resumed = output.indexOf("<resume>");
    assert.isAbove(paused, -1, "the repair must run with the service paused");
    const beforePause = output.slice(0, paused).join("\n");
    const description = beforePause.slice(beforePause.indexOf("Reclaim database space"));
    assert.include(description, "12.80 GiB", "the repair must state the database size up front");
    assert.match(description, /hour/, "the repair must warn it can take over an hour");
    const progress = output
      .slice(paused + 1, resumed)
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("Done"))
      .map((line) => /\[(\d+:\d{2})\]/.exec(line)?.[1] ?? `unprefixed: ${line}`);
    assert.deepEqual(
      progress,
      ["0:00", "1:05", "12:46", "12:47"],
      "each compaction step must print one line with the elapsed time as it starts",
    );
  }).pipe(Effect.provide(layerHost)),
);
