import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { makeManagedWorktreePaths } from "./managedWorktreePaths.ts";

const layerTest = Layer.mergeAll(GitVcsDriver.layer, ServerSettings.layerTest()).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-paths-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.effect("anchors in-project worktree folders at the project's own main checkout", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-managed-paths-" }),
    );
    const run = (cwd: string, args: ReadonlyArray<string>) =>
      git.execute({ operation: "test.managedWorktreePaths", cwd, args });
    const initRepository = (repository: string) =>
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(repository);
        yield* run(repository, ["init", "-b", "main"]);
        yield* run(repository, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "base",
        ]);
      });
    const main = path.join(root, "project");
    const other = path.join(root, "other");
    const linkedStorage = path.join(root, "linked-storage");
    yield* Effect.forEach([main, other, linkedStorage], initRepository);
    const subfolder = path.join(main, "packages", "app");
    yield* fileSystem.makeDirectory(subfolder, { recursive: true });
    const linked = path.join(root, "linked");
    yield* run(main, ["worktree", "add", "-b", "linked", linked]);
    const bare = path.join(root, "bare.git");
    const bareLinked = path.join(root, "bare-linked");
    yield* run(root, ["clone", "--bare", main, bare]);
    yield* run(root, ["--git-dir", bare, "worktree", "add", "--detach", bareLinked, "main"]);
    // A storage folder that is a link leads out of the checkout.
    const elsewhere = path.join(root, "elsewhere");
    yield* fileSystem.makeDirectory(path.join(elsewhere, "worktrees"), { recursive: true });
    if (symlinksSupported) {
      yield* fileSystem.symlink(elsewhere, path.join(linkedStorage, ".claude"));
    }

    const { isProjectWorktreePath } = yield* makeManagedWorktreePaths;
    const previous = {
      worktreesDirectory: "",
      previousWorktreesDirectories: [".claude/worktrees"],
    };
    const owned = path.join(main, ".claude", "worktrees", "feature");
    const cases = [
      ["the main checkout's project", main, owned, previous, true],
      [
        "the current setting",
        main,
        owned,
        { ...previous, worktreesDirectory: ".claude/worktrees", previousWorktreesDirectories: [] },
        true,
      ],
      ["a project in a subfolder", subfolder, owned, previous, true],
      ["a project in a linked checkout", linked, owned, previous, true],
      [
        "a folder inside the linked checkout",
        linked,
        path.join(linked, ".claude", "worktrees", "feature"),
        previous,
        false,
      ],
      [
        "another repository's folder",
        main,
        path.join(other, ".claude", "worktrees", "feature"),
        previous,
        false,
      ],
      ["a folder nested below a worktree", main, path.join(owned, "nested"), previous, false],
      ["the storage folder itself", main, path.dirname(owned), previous, false],
      ["the main checkout itself", main, main, previous, false],
      ["Git's own folder name", main, path.join(path.dirname(owned), ".git"), previous, false],
      ["'..' segments", main, `${path.dirname(owned)}/../worktrees/feature`, previous, false],
      ["a relative path", main, ".claude/worktrees/feature", previous, false],
      [
        "absolute settings only",
        main,
        owned,
        { worktreesDirectory: "/tmp/worktrees", previousWorktreesDirectories: [] },
        false,
      ],
      [
        "a bare repository",
        bareLinked,
        path.join(bare, ".claude", "worktrees", "feature"),
        previous,
        false,
      ],
      ...(symlinksSupported
        ? [
            [
              "a linked storage folder",
              linkedStorage,
              path.join(linkedStorage, ".claude", "worktrees", "feature"),
              previous,
              false,
            ] as const,
          ]
        : []),
      ["a project that is not a repository", elsewhere, owned, previous, false],
    ] as const;
    for (const [label, projectRoot, worktreePath, settings, expected] of cases) {
      assert.strictEqual(
        yield* isProjectWorktreePath({ projectRoot, worktreePath, settings }),
        expected,
        label,
      );
    }
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
