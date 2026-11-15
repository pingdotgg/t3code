import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { makeIsWorktreeContainer } from "./worktreeContainer.ts";

const git = Effect.fn("worktreeContainerTest.git")(function* (
  cwd: string,
  ...args: ReadonlyArray<string>
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  return yield* processRunner.run({
    command: "git",
    args: ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
  });
});

it.layer(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer)))(
  "isWorktreeContainer",
  (it) => {
    it.effect("is true only for a folder of worktrees around metadata that is no checkout", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const isWorktreeContainer = yield* makeIsWorktreeContainer;
        const fixture = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-container-test-" });

        const source = path.join(fixture, "source");
        yield* fileSystem.makeDirectory(source);
        yield* git(source, "init", "-b", "develop");
        yield* fileSystem.writeFileString(path.join(source, "README.md"), "readme\n");
        yield* git(source, "add", "README.md");
        yield* git(source, "commit", "-m", "init");

        const makeContainer = Effect.fn(function* (name: string, coreBare: boolean) {
          const root = path.join(fixture, name);
          yield* fileSystem.makeDirectory(root);
          yield* git(fixture, "clone", "--bare", source, path.join(root, ".bare"));
          yield* fileSystem.writeFileString(path.join(root, ".git"), "gitdir: ./.bare\n");
          yield* git(root, "worktree", "add", "develop", "develop");
          yield* git(root, "config", "core.bare", String(coreBare));
          return root;
        });
        const makeSeparateGitDirCheckout = Effect.fn(function* (name: string) {
          const root = path.join(fixture, name);
          yield* fileSystem.makeDirectory(root);
          yield* git(root, "init", "-b", "develop", "--separate-git-dir", ".metadata", ".");
          return root;
        });

        const container = yield* makeContainer("container", false);
        assert.isTrue(yield* isWorktreeContainer(container), "container");
        assert.isFalse(yield* isWorktreeContainer(path.join(container, "develop")), "its worktree");

        const linked = path.join(fixture, "link");
        yield* fileSystem.symlink(container, linked);
        assert.isTrue(yield* isWorktreeContainer(linked), "container through a symlink");

        // The issue's steps leave core.bare set; Initialize Git would clear it later.
        const bare = yield* makeContainer("bare", true);
        assert.isTrue(yield* isWorktreeContainer(bare), "core.bare container");

        // Git allows an orphan worktree before the first commit: no index, yet a valid checkout.
        const fresh = yield* makeSeparateGitDirCheckout("fresh");
        yield* git(fresh, "worktree", "add", "--orphan", "-b", "feature", "../fresh-feature");
        assert.isFalse(yield* isWorktreeContainer(fresh), "fresh checkout with an orphan worktree");

        const checkout = yield* makeSeparateGitDirCheckout("checkout");
        yield* fileSystem.writeFileString(path.join(checkout, "README.md"), "readme\n");
        yield* git(checkout, "add", "README.md");
        yield* git(checkout, "commit", "-m", "init");
        yield* git(checkout, "worktree", "add", "worktrees/feature", "-b", "feature");
        assert.isFalse(yield* isWorktreeContainer(checkout), "checkout with a nested worktree");

        const outside = path.join(fixture, "outside");
        yield* git(
          fixture,
          "clone",
          "--no-checkout",
          "--separate-git-dir",
          path.join(outside, ".metadata"),
          source,
          outside,
        );
        yield* git(outside, "worktree", "add", "../outside-feature", "-b", "feature");
        assert.isFalse(yield* isWorktreeContainer(outside), "worktrees outside the folder");
      }),
    );
  },
);
