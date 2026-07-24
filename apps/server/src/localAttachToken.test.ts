import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { clearLocalAttachTokenFile, writeLocalAttachTokenFile } from "./localAttachToken.ts";

describe("localAttachToken", () => {
  it.effect("writes the token as a single line with mode 0600", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-local-attach-token-test-",
      });
      const tokenPath = path.join(root, "state", "local-attach-token");

      yield* writeLocalAttachTokenFile({ path: tokenPath, token: "deadbeef" });

      const contents = yield* fileSystem.readFileString(tokenPath);
      assert.equal(contents, "deadbeef\n");

      const stat = yield* fileSystem.stat(tokenPath);
      assert.equal(stat.mode & 0o777, 0o600);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("tightens permissions when rewriting an existing looser file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-local-attach-token-test-",
      });
      const tokenPath = path.join(root, "local-attach-token");
      // Simulate a prior boot leaving a world-readable file.
      yield* fileSystem.writeFileString(tokenPath, "old\n");
      yield* fileSystem.chmod(tokenPath, 0o644);

      yield* writeLocalAttachTokenFile({ path: tokenPath, token: "fresh" });

      const stat = yield* fileSystem.stat(tokenPath);
      assert.equal(stat.mode & 0o777, 0o600);
      assert.equal(yield* fileSystem.readFileString(tokenPath), "fresh\n");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the token file and tolerates a missing file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-local-attach-token-test-",
      });
      const tokenPath = path.join(root, "local-attach-token");

      yield* writeLocalAttachTokenFile({ path: tokenPath, token: "token" });
      assert.isTrue(yield* fileSystem.exists(tokenPath));

      yield* clearLocalAttachTokenFile(tokenPath);
      assert.isFalse(yield* fileSystem.exists(tokenPath));

      // Clearing an already-absent file is a no-op, not a failure.
      yield* clearLocalAttachTokenFile(tokenPath);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
