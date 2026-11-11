import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { buildStartingMap, discoverStartingMap, WHEN_MAP_RUNS_OUT } from "./StartingMap.ts";

describe("buildStartingMap", () => {
  it("prefers .agents/STARTING_MAP.md as the trailhead and keeps absent routes visible", () => {
    const map = buildStartingMap({
      root: "/repo",
      present: new Set([".agents/STARTING_MAP.md", "README.md", "docs/"]),
    });
    assert.equal(map.trailhead, ".agents/STARTING_MAP.md");
    assert.deepEqual(
      map.routes.filter((route) => route.present).map((route) => route.path),
      [".agents/STARTING_MAP.md", "README.md", "docs/"],
    );
    assert.isFalse(map.routes.find((route) => route.path === "AGENTS.md")?.present);
    assert.deepEqual(map.whenMapRunsOut, [...WHEN_MAP_RUNS_OUT]);
  });

  it("falls back to AGENTS.md when STARTING_MAP.md is missing", () => {
    const map = buildStartingMap({
      root: "/repo",
      present: new Set(["AGENTS.md", "CLAUDE.md"]),
    });
    assert.equal(map.trailhead, "AGENTS.md");
  });
});

describe("discoverStartingMap", () => {
  it.effect("probes files and directories without reading their contents", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-starting-map-" });
      yield* fileSystem.writeFileString(
        path.join(root, "README.md"),
        "# Huge body that stays on disk\n",
      );
      yield* fileSystem.makeDirectory(path.join(root, "docs"));
      yield* fileSystem.writeFileString(path.join(root, "docs", "guide.md"), "detail\n");
      yield* fileSystem.makeDirectory(path.join(root, ".agents"));
      yield* fileSystem.writeFileString(
        path.join(root, ".agents", "STARTING_MAP.md"),
        "trailhead\n",
      );

      const map = yield* discoverStartingMap(root);
      assert.equal(map.trailhead, ".agents/STARTING_MAP.md");
      assert.isTrue(map.routes.find((route) => route.path === "README.md")?.present);
      assert.isTrue(map.routes.find((route) => route.path === "docs/")?.present);
      assert.isFalse(map.routes.find((route) => route.path === "AGENTS.md")?.present);
      // Discovery returns paths only; contents are never inlined.
      assert.isFalse(JSON.stringify(map).includes("Huge body"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
