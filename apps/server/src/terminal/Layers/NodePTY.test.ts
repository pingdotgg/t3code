import { FileSystem, Path, Effect } from "effect";
import { assert, it } from "@effect/vitest";

import { ensureNodePtySpawnHelperExecutable } from "./NodePTY.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

it.layer(NodeServices.layer)("ensureNodePtySpawnHelperExecutable", (it) => {
  it.effect("adds executable bits when helper exists but is not executable", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pty-helper-test-" });
      const helperPath = path.join(dir, "spawn-helper");
      yield* fs.writeFileString(helperPath, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(helperPath, 0o644);

      yield* ensureNodePtySpawnHelperExecutable(helperPath);

      const mode = (yield* fs.stat(helperPath)).mode & 0o777;
      assert.equal(mode & 0o111, 0o111);
    }),
  );

  it.effect("keeps executable helper as executable", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pty-helper-test-" });
      const helperPath = path.join(dir, "spawn-helper");
      yield* fs.writeFileString(helperPath, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(helperPath, 0o755);

      yield* ensureNodePtySpawnHelperExecutable(helperPath);

      const mode = (yield* fs.stat(helperPath)).mode & 0o777;
      assert.equal(mode & 0o111, 0o111);
    }),
  );
});
