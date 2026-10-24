import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";

import * as BootService from "../cloud/bootService.ts";
import { runDoctor } from "./doctor.ts";
import { DatabaseMaintenance } from "../persistence/DatabaseMaintenance.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";

it.effect("reports the CLI, running server and launcher Node versions independently", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtimeStatePath = path.join(yield* fs.makeTempDirectoryScoped(), "server-runtime.json");
    const state = yield* makePersistedServerRuntimeState({
      config: { host: undefined, devUrl: undefined },
      port: 3773,
    });
    yield* persistServerRuntimeState({
      path: runtimeStatePath,
      state: {
        ...state,
        nodeVersion: "26.12.1",
        executablePath: "/isolated/new/t3",
        serviceManaged: true,
        launcherRuntime: {
          pid: process.pid,
          nodeVersion: "26.8.2",
          executablePath: "/isolated/old/t3",
        },
      },
    });
    yield* runDoctor("/test/statev2.sqlite", { fix: false, dryRun: true, runtimeStatePath });
    const output = (yield* TestConsole.logLines).join("\n");
    assert.include(output, `CLI: Node ${process.versions.node} (${process.execPath})`);
    assert.include(output, "Server: Node 26.12.1 (/isolated/new/t3");
    assert.include(output, "Service launcher: Node 26.8.2 (/isolated/old/t3");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestConsole.layer,
        Layer.mock(BootService.BootService)({}),
        Layer.mock(DatabaseMaintenance)({
          inspect: () =>
            Effect.succeed({
              databaseBytes: 0,
              reclaimableBytes: 0,
              incrementalVacuumEnabled: true,
              legacyDatabaseBytes: null,
            }),
        }),
      ),
    ),
  ),
);

it.effect(
  "--fix reclaims space with the service paused and keeps the V1 database, and --dry-run changes nothing",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const doctor = (dryRun: boolean) =>
        runDoctor("/test/statev2.sqlite", { fix: true, dryRun, interactive: false }).pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.mock(BootService.BootService)({
                withStopped: (operation) =>
                  Effect.sync(() => calls.push("pause")).pipe(
                    Effect.andThen(operation),
                    Effect.ensuring(Effect.sync(() => calls.push("resume"))),
                  ),
              }),
              Layer.succeed(DatabaseMaintenance, {
                // An unconverted database: reclaiming space is recommended.
                // A database from before 0.1.0 sits beside it; --fix must keep it.
                inspect: () =>
                  Effect.succeed({
                    databaseBytes: 2000,
                    reclaimableBytes: 1000,
                    incrementalVacuumEnabled: false,
                    legacyDatabaseBytes: 4000,
                  }),
                compact: () =>
                  Effect.sync(() => {
                    calls.push("compact");
                    return {
                      beforeBytes: 2000,
                      afterBytes: 1000,
                      deletedEventCount: 1,
                      deletedReceiptCount: 0,
                    };
                  }),
                removeLegacyDatabase: () => Effect.sync(() => calls.push("remove legacy")),
              }),
            ),
          ),
        );
      yield* doctor(true);
      assert.deepEqual(calls, []);
      yield* doctor(false);
      assert.deepEqual(calls, ["pause", "compact", "resume"]);
    }),
);
