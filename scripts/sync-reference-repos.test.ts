import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { referenceRepos } from "./lib/reference-repos.ts";
import { planReferenceRepoSync, resolveReferenceRepoRef } from "./sync-reference-repos.ts";

const effectSmol = referenceRepos[0]!;
const alchemyEffect = referenceRepos[1]!;

it.layer(NodeServices.layer)("sync-reference-repos", (it) => {
  it.effect("resolves reference tags from the root catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-version-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  alchemy: 2.0.0-beta.84\n  effect: 4.0.0-beta.73\n",
      );

      assert.equal(
        yield* resolveReferenceRepoRef(effectSmol, rootDir, false),
        "effect@4.0.0-beta.73",
      );
      assert.equal(yield* resolveReferenceRepoRef(alchemyEffect, rootDir, false), "v2.0.0-beta.84");
    }),
  );

  it.effect("plans an add for a missing subtree and a pull for an existing subtree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-plan-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      const addPlan = yield* planReferenceRepoSync(effectSmol, rootDir, false);
      assert.equal(addPlan.action, "add");
      assert.deepStrictEqual(addPlan.args, [
        "subtree",
        "add",
        "--prefix=.repos/effect-smol",
        "https://github.com/Effect-TS/effect.git",
        "effect@4.0.0-beta.73",
        "--squash",
      ]);

      yield* fs.makeDirectory(path.join(rootDir, effectSmol.prefix), { recursive: true });
      assert.equal((yield* planReferenceRepoSync(effectSmol, rootDir, false)).action, "pull");
    }),
  );
});
