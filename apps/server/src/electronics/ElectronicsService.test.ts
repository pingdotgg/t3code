import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSettings from "../serverSettings.ts";
import * as ElectronicsService from "./ElectronicsService.ts";

const makeTestLayer = (settingsOverride: Partial<typeof DEFAULT_SERVER_SETTINGS> = {}) => {
  const mockSettings = ServerSettings.layerTest(settingsOverride);
  const mockSpawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        // Simulate binaries not installed so built-in engine is exercised cleanly
        new Error("ENOENT") as never,
      ),
    ),
  );
  return ElectronicsService.layer.pipe(
    Layer.provide(mockSettings),
    Layer.provide(mockSpawner),
    Layer.provideMerge(NodeServices.layer),
  );
};

it.effect(
  "discovers workspace files, blocks symlinks & traversal, and streams live updates + reconnect snapshots",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* ElectronicsService.ElectronicsService;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-electronics-test-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-electronics-outside-" });
      yield* fs.makeDirectory(path.join(dir, "hw"), { recursive: true });
      yield* fs.writeFileString(
        path.join(dir, "hw", "divider.cir"),
        "* Divider\nV1 in 0 5\nR1 in out 10k\nR2 out 0 10k\n.end\n",
      );
      yield* fs.writeFileString(
        path.join(outside, "leaked.cir"),
        "* Outside\nV1 a 0 5\nR1 a 0 1k\n.end\n",
      );
      // Symlink to outside directory must NOT leak filenames through listFiles
      yield* fs.symlink(outside, path.join(dir, "linked-outside"));

      const listed = yield* service.listFiles(dir);
      expect(listed.files.map((f) => f.relativePath)).toEqual(["hw/divider.cir"]);
      expect(listed.toolchain.enabled).toBe(true);
      expect(listed.toolchain.kicadCli.available).toBe(false);

      // Path traversal must be rejected
      const escapeResult = yield* service.inspect(dir, "../etc/passwd").pipe(Effect.flip);
      expect(escapeResult.code).toBe("invalid_path");

      // Subscribe BEFORE mutations: must receive initial empty snapshot + live update
      const threadId = ThreadId.make("thread-elec-1");
      const streamFiber = yield* service.subscribeState.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const sim = yield* service.simulate(
        { cwd: dir, filePath: "hw/divider.cir", kind: "dc_op", outputNode: "out" },
        threadId,
      );
      expect(sim.nodeVoltages.find((n) => n.node === "out")?.voltageV).toBeCloseTo(2.5, 4);

      const events = Array.from(yield* Fiber.join(streamFiber));
      expect(events.length).toBe(2);
      expect(events[0]?.sessions.length).toBe(0);
      expect(events[1]?.sessions[0]?.filePath).toBe("hw/divider.cir");
      expect(events[1]?.sessions[0]?.activeTab).toBe("simulate");

      // Read-only simulation does NOT set panelOpenedAt; explicit openPanel sets and advances it
      expect(events[1]?.sessions[0]?.panelOpenedAt).toBeUndefined();
      const firstOpen = yield* service.openPanel({
        threadId,
        cwd: dir,
        filePath: "hw/divider.cir",
      });
      expect(firstOpen.panelOpenedAt).toBeDefined();
      const secondOpen = yield* service.openPanel({
        threadId,
        cwd: dir,
        filePath: "hw/divider.cir",
      });
      expect(secondOpen.panelOpenedAt).toBeDefined();
      expect(secondOpen.panelOpenedAt! > firstOpen.panelOpenedAt!).toBe(true);

      // Reconnecting subscriber immediately receives the latest session snapshot
      const reconnectSnap = yield* service.subscribeState.pipe(Stream.take(1), Stream.runCollect);
      expect(Array.from(reconnectSnap)[0]?.sessions[0]?.threadId).toBe(threadId);

      yield* service.closePanel(threadId);
      expect(yield* service.getThreadSession(threadId)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
);

it.effect(
  "expands workspace SPICE .include files for built-in MNA and fails on unresolved includes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* ElectronicsService.ElectronicsService;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-electronics-inc-" });
      yield* fs.writeFileString(path.join(dir, "load.inc"), "R2 out 0 10k\n");
      yield* fs.writeFileString(
        path.join(dir, "with_inc.cir"),
        '* Divider with include\nV1 in 0 5\nR1 in out 10k\n.include "load.inc"\n.end\n',
      );
      yield* fs.writeFileString(
        path.join(dir, "missing_inc.cir"),
        '* Missing include\nV1 in 0 5\nR1 in out 10k\n.include "does_not_exist.inc"\n.end\n',
      );

      const sim = yield* service.simulate({
        cwd: dir,
        filePath: "with_inc.cir",
        kind: "dc_op",
        outputNode: "out",
        useExternalToolchain: false,
      });
      expect(sim.nodeVoltages.find((n) => n.node === "out")?.voltageV).toBeCloseTo(2.5, 4);

      const missingErr = yield* service
        .simulate({
          cwd: dir,
          filePath: "missing_inc.cir",
          kind: "dc_op",
          useExternalToolchain: false,
        })
        .pipe(Effect.flip);
      expect(missingErr.code).toBe("simulation_failed");
      expect(missingErr.message).toMatch(/unresolved includes/i);
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
);

it.effect("refuses operations when Electronics Workbench is disabled in settings", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const service = yield* ElectronicsService.ElectronicsService;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-electronics-off-" });
    const err = yield* service.listFiles(dir).pipe(Effect.flip);
    expect(err.code).toBe("disabled");
  }).pipe(Effect.scoped, Effect.provide(makeTestLayer({ enableElectronicsWorkbench: false }))),
);

it.effect("does not spawn external binary probes on read-only status or listFiles calls", () =>
  Effect.gen(function* () {
    let spawnCount = 0;
    const mockSettings = ServerSettings.layerTest({ electronicsAllowExternalTools: true });
    const countingSpawner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => {
        spawnCount += 1;
        return Effect.fail(new Error("ENOENT") as never);
      }),
    );
    const layer = ElectronicsService.layer.pipe(
      Layer.provide(mockSettings),
      Layer.provide(countingSpawner),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ElectronicsService.ElectronicsService;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-electronics-ro-" });
      yield* service.getToolchainStatus({ refresh: false, allowSpawn: false });
      yield* service.listFiles(dir);
      expect(spawnCount).toBe(0);

      // Explicit operate-scoped refresh DOES probe binaries (once each for kicad-cli + ngspice)
      yield* service.getToolchainStatus({ refresh: true, allowSpawn: true });
      expect(spawnCount).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(layer));
  }),
);

it.effect(
  "preserves explicit openPanel selection against cross-file traces and overlapping openPanel calls",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* ElectronicsService.ElectronicsService;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-electronics-nav-" });
      yield* fs.writeFileString(
        path.join(dir, "a.cir"),
        "* A\nV1 in 0 5\nR1 in out 1k\nR2 out 0 1k\n.end\n",
      );
      yield* fs.writeFileString(
        path.join(dir, "b.cir"),
        "* B\nV1 in 0 3.3\nR1 in out 2k\nR2 out 0 2k\n.end\n",
      );

      const threadId = ThreadId.make("thread-elec-nav");
      // Overlapping openPanel(a) then openPanel(b) must settle on b.cir
      const [openAFiber, openBFiber] = yield* Effect.all([
        Effect.forkChild(service.openPanel({ threadId, cwd: dir, filePath: "a.cir" })),
        Effect.forkChild(service.openPanel({ threadId, cwd: dir, filePath: "b.cir" })),
      ]);
      yield* Fiber.join(openAFiber);
      yield* Fiber.join(openBFiber);
      const afterOverlap = yield* service.getThreadSession(threadId);
      expect(afterOverlap?.filePath).toBe("b.cir");

      // Cross-file trace on a.cir while b.cir is explicitly open must NOT replace b.cir
      yield* service.tracePath({ cwd: dir, filePath: "a.cir", from: "in", to: "out" }, threadId);
      const afterCrossTrace = yield* service.getThreadSession(threadId);
      expect(afterCrossTrace?.filePath).toBe("b.cir");
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
);
