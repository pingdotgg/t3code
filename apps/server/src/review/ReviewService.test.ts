import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ReviewService from "./ReviewService.ts";

const services = ReviewService.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(GitVcsDriver.layer),
);

describe("ReviewService", () => {
  it.effect("switches previews and file contents between projects and external worktrees", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-switch-" });
      const launchDir = path.join(root, "server");
      const projectA = path.join(root, "project-a");
      const projectB = path.join(root, "project-b");
      const worktree = path.join(root, "external-worktree");
      yield* fs.makeDirectory(launchDir);
      yield* Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        const review = yield* ReviewService.ReviewService;
        const runGit = (cwd: string, args: ReadonlyArray<string>) =>
          git.execute({ operation: "ReviewService.test.git", cwd, args });
        for (const cwd of [projectA, projectB]) {
          yield* fs.makeDirectory(cwd);
          yield* runGit(cwd, ["init"]);
          yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
          yield* runGit(cwd, ["config", "user.name", "Test"]);
          yield* fs.writeFileString(path.join(cwd, "file.txt"), "original\n");
          yield* runGit(cwd, ["add", "."]);
          yield* runGit(cwd, ["commit", "-m", "initial"]);
        }
        yield* runGit(projectA, ["worktree", "add", "-b", "external", worktree]);
        const changes = new Map([
          [projectA, "project A\n"],
          [projectB, "project B\nsecond line\n"],
          [worktree, "external worktree\nsecond line\nthird line\n"],
        ]);
        for (const [cwd, content] of changes) {
          yield* fs.writeFileString(path.join(cwd, "file.txt"), content);
        }
        for (const cwd of [projectA, projectB, worktree, projectA]) {
          const content = changes.get(cwd)!;
          const preview = yield* review.getDiffPreview({ cwd });
          assert.strictEqual(preview.cwd, cwd);
          const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
          assert.include(dirty.diff, `+${content.split("\n")[0]}`);
          const contents = yield* review.getDiffFileContents({
            cwd,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.txt",
            newPath: "file.txt",
          });
          assert.strictEqual(contents.oldContents, "original\n");
          assert.strictEqual(contents.newContents, content);
        }
        const empty = yield* review.getDiffPreview({ cwd: launchDir });
        assert.strictEqual(empty.cwd, launchDir);
        assert.deepStrictEqual(empty.sources, []);

        const escaped = yield* review
          .getDiffFileContents({
            cwd: projectA,
            sourceKind: "working-tree",
            changeType: "new",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "../project-b/file.txt",
            newPath: "../project-b/file.txt",
          })
          .pipe(Effect.flip);
        assert.strictEqual(escaped._tag, "GitCommandError");
        if (escaped._tag === "GitCommandError") assert.include(escaped.detail, "outside");
      }).pipe(
        Effect.provide(
          services.pipe(Layer.provide(ServerConfig.layerTest(launchDir, path.join(root, "state")))),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
