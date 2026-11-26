import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { acquireDevRunnerLock } from "./dev-runner-lock.ts";

it.layer(NodeServices.layer)("acquireDevRunnerLock", (it) => {
  it.effect("refuses a second runner on the same state directory and names the owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const stateDir = path.join(root, "userdata");

        yield* acquireDevRunnerLock(stateDir, "pid 1, dev:server");
        const error = yield* Effect.scoped(acquireDevRunnerLock(stateDir, "pid 2, dev")).pipe(
          Effect.flip,
        );
        assert.equal(error._tag, "DevRunnerStateDirInUseError");
        assert.include(error.message, "pid 1, dev:server");

        yield* Effect.scoped(acquireDevRunnerLock(path.join(root, "other"), "pid 3, dev"));
      }),
    ),
  );

  it.effect("lets the next runner start once the owner exits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped();

        yield* Effect.scoped(acquireDevRunnerLock(stateDir, "pid 1, dev"));
        yield* Effect.scoped(acquireDevRunnerLock(stateDir, "pid 2, dev"));
      }),
    ),
  );
});
