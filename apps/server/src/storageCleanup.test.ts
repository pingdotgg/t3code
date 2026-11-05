import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type StorageCleanupSettings,
} from "@t3tools/contracts";
import * as ServerConfig from "./config.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as Settings from "./serverSettings.ts";
import { ServerActivation } from "./serverActivation.ts";
import { describe, expect, it } from "@effect/vitest";

const cleanupFixture = (
  storageCleanup: StorageCleanupSettings = DEFAULT_SERVER_SETTINGS.storageCleanup,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    let settings: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, storageCleanup };
    // Keeps the startup sweep parked so each test's runNow owns its run.
    const context = yield* Layer.build(StorageCleanup.layer).pipe(
      Effect.provideService(Settings.ServerSettingsService, {
        getSettings: Effect.sync(() => settings),
        subscribeChanges: Effect.succeed(Stream.empty),
      } as unknown as Settings.ServerSettingsService["Service"]),
      Effect.provideService(ServerActivation, Effect.never),
    );
    return {
      service: Context.get(context, StorageCleanup.StorageCleanup),
      fs,
      config,
      enableFiles: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            browserArtifactsAfterDays: 8,
            logsAfterDays: 8,
          },
        };
      },
    };
  });

const cleanupTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "storage-cleanup-",
}).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const runCleanupTest = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | ServerConfig.ServerConfig | Path.Path | Scope.Scope
  >,
) => effect.pipe(Effect.provide(cleanupTestLayer), Effect.scoped);

describe("storage cleanup reports and local file policies", () => {
  it.live("serializes concurrent requests and returns each run's report", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, config, enableFiles } = yield* cleanupFixture();
        enableFiles();
        yield* fs.makeDirectory(config.browserArtifactsDir, { recursive: true });
        const file = `${config.browserArtifactsDir}/one.png`;
        yield* fs.writeFileString(file, "capture");
        yield* fs.utimes(file, 1, 1);
        const reports = yield* Effect.all([service.runNow, service.runNow], {
          concurrency: "unbounded",
        });
        yield* service.drain;
        expect(reports.reduce((sum, report) => sum + report.counts.removed, 0)).toBe(1);
        expect(yield* service.latestReport).toEqual(reports[1]);
      }),
    ),
  );
  it.live("aggregates expired artifacts and rotated logs while retaining current logs", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, config, enableFiles } = yield* cleanupFixture();
        enableFiles();
        yield* fs.makeDirectory(config.browserArtifactsDir, { recursive: true });
        yield* fs.makeDirectory(config.logsDir, { recursive: true });
        for (const name of ["one.png", "two.webm"]) {
          const file = config.browserArtifactsDir + "/" + name;
          yield* fs.writeFileString(file, "capture");
          yield* fs.utimes(file, 1, 1);
        }
        for (const name of ["server.log.1", "server.log.2", "server.log"]) {
          const file = config.logsDir + "/" + name;
          yield* fs.writeFileString(file, "log");
          yield* fs.utimes(file, 1, 1);
        }
        const report = yield* service.runNow;
        expect(report.entries).toMatchObject([
          {
            kind: "browser-artifacts",
            outcome: "removed",
            reason: "Removed 2 browser artifacts",
            bytes: 14,
            files: 2,
          },
          {
            kind: "logs",
            outcome: "removed",
            reason: "Removed 2 rotated logs",
            bytes: 6,
            files: 2,
          },
        ]);
        expect(report.bytesFreed).toBe(20);
        expect(yield* fs.readDirectory(config.browserArtifactsDir)).toEqual([]);
        expect(yield* fs.exists(config.logsDir + "/server.log")).toBe(true);
        expect(yield* fs.exists(config.logsDir + "/server.log.1")).toBe(false);
        expect(yield* fs.exists(config.logsDir + "/server.log.2")).toBe(false);
      }),
    ),
  );
  it.live.each([
    { linked: "home", outcome: "removed", reason: "Removed 1 rotated logs" },
    { linked: "logs folder", outcome: "kept", reason: "No expired files" },
  ] as const)(
    "rotated logs behind a symlinked $linked are $outcome",
    ({ linked, outcome, reason }) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig.ServerConfig;
          const disk = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
          yield* fs.makeDirectory(`${disk}/real/logs`, { recursive: true });
          if (linked === "home") {
            yield* fs.symlink(`${disk}/real`, `${disk}/home`);
          } else {
            yield* fs.makeDirectory(`${disk}/home`);
            yield* fs.symlink(`${disk}/real/logs`, `${disk}/home/logs`);
          }
          yield* fs.writeFileString(`${disk}/real/logs/server.log.1`, "log");
          yield* fs.utimes(`${disk}/real/logs/server.log.1`, 1, 1);
          const { service, enableFiles } = yield* cleanupFixture().pipe(
            Effect.provideService(ServerConfig.ServerConfig, {
              ...config,
              logsDir: `${disk}/home/logs`,
            }),
          );
          enableFiles();
          const report = yield* service.runNow;
          expect(report.entries.filter((entry) => entry.kind === "logs")).toMatchObject([
            { outcome, reason },
          ]);
          expect(yield* fs.exists(`${disk}/real/logs/server.log.1`)).toBe(outcome === "kept");
        }),
      ),
  );
});
