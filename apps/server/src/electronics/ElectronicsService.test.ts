import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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
  "discovers workspace electronics files, blocks path traversal, and streams thread sessions",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* ElectronicsService.ElectronicsService;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-electronics-test-" });
      yield* fs.makeDirectory(path.join(dir, "hw"), { recursive: true });
      yield* fs.writeFileString(
        path.join(dir, "hw", "divider.cir"),
        "* Divider\nV1 in 0 5\nR1 in out 10k\nR2 out 0 10k\n.end\n",
      );

      const listed = yield* service.listFiles(dir);
      expect(listed.files.map((f) => f.relativePath)).toEqual(["hw/divider.cir"]);
      expect(listed.toolchain.enabled).toBe(true);
      expect(listed.toolchain.kicadCli.available).toBe(false);

      // Path traversal must be rejected
      const escapeResult = yield* service.inspect(dir, "../etc/passwd").pipe(Effect.flip);
      expect(escapeResult.code).toBe("invalid_path");

      // Inspect + trace + validate + simulate + openPanel
      const model = yield* service.inspect(dir, "hw/divider.cir");
      expect(model.components.length).toBe(3);

      const threadId = ThreadId.make("thread-elec-1");
      const trace = yield* service.tracePath(
        { cwd: dir, filePath: "hw/divider.cir", from: "V1.+", to: "out" },
        threadId,
      );
      expect(trace.connected).toBe(true);
      expect(trace.estimatedResistanceOhms).toBe(10_000);

      const sim = yield* service.simulate(
        { cwd: dir, filePath: "hw/divider.cir", kind: "dc_op", outputNode: "out" },
        threadId,
      );
      expect(sim.nodeVoltages.find((n) => n.node === "out")?.voltageV).toBeCloseTo(2.5, 4);

      const session = yield* service.getThreadSession(threadId);
      expect(session?.filePath).toBe("hw/divider.cir");
      expect(session?.activeTab).toBe("simulate");

      yield* service.closePanel(threadId);
      expect(yield* service.getThreadSession(threadId)).toBeUndefined();
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
