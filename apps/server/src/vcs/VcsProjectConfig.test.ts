import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path } from "effect";
import { describe } from "vitest";

import { VcsProjectConfig, layer as VcsProjectConfigLayer } from "./VcsProjectConfig.ts";

const TestLayer = VcsProjectConfigLayer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(NodeServices.layer),
);

describe("VcsProjectConfig", () => {
  it.layer(TestLayer)("uses an explicit requested VCS kind before config", (it) => {
    it.effect("returns the requested kind", () =>
      Effect.gen(function* () {
        const config = yield* VcsProjectConfig;
        const kind = yield* config.resolveKind({
          cwd: "/repo",
          requestedKind: "jj",
        });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(TestLayer)("discovers .t3code/vcs.json from nested workspaces", (it) => {
    it.effect("returns the configured kind", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        const nested = path.join(root, "packages", "app");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          JSON.stringify({ vcs: { kind: "jj" } }),
        );

        const config = yield* VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: nested });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(TestLayer)("falls back to auto when no config exists", (it) => {
    it.effect("returns auto", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const config = yield* VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
      }),
    );
  });
});
