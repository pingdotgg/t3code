import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { GitManagerError, type GitWorkflowProgressUpdate } from "@t3tools/contracts";
import { make } from "./BranchStackWorkflow.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stack-test-" });
  const cwd = path.join(root, "repo");
  yield* fs.makeDirectory(cwd);
  const git = Effect.fn("fixture.git")(function* (args: ReadonlyArray<string>) {
    return (yield* process.run({
      operation: "test.stack",
      command: "git",
      args,
      cwd,
    })).stdout.trim();
  });
  for (const remote of ["origin", "fork"]) {
    yield* git(["init", "--bare", path.join(root, remote)]);
  }
  yield* git(["init", "--initial-branch=main"]);
  yield* git(["config", "user.email", "test@example.com"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "commit.gpgsign", "false"]);
  yield* git(["config", "core.autocrlf", "false"]);
  const commit = Effect.fn("fixture.commit")(function* (file: string, content: string) {
    yield* fs.writeFileString(path.join(cwd, file), content);
    yield* git(["add", file]);
    yield* git(["commit", "-m", `Change ${file}`]);
    return yield* git(["rev-parse", "HEAD"]);
  });
  yield* commit("shared.txt", "base\n");
  for (const branch of ["a", "b", "c"]) {
    yield* git(["checkout", "-b", branch]);
    yield* commit(`${branch}.txt`, `${branch}\n`);
  }
  for (const remote of ["origin", "fork"]) {
    yield* git(["remote", "add", remote, path.join(root, remote)]);
    yield* git(["push", remote, "main", "a", "b", "c"]);
  }
  yield* git(["config", "remote.pushDefault", "fork"]);
  yield* git(["checkout", "b"]);
  const stacks = yield* make;
  const adopt = stacks.manage({ cwd, action: "adopt", base: "main", branches: ["a", "b", "c"] });
  const remoteHead = (remote: string, branch: string) =>
    git([`--git-dir=${path.join(root, remote)}`, "rev-parse", `refs/heads/${branch}`]);
  return { fs, path, root, cwd, git, commit, stacks, adopt, remoteHead };
});

it.layer(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))("branch stacks", (it) => {
  it.effect(
    "edits an adopted hierarchy without rewriting branches and preserves it on invalid edits",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.adopt;
        const original = yield* f.git(["show-ref", "--heads"]);
        yield* f.git(["branch", "inserted", "a"]);
        const edited = yield* f.stacks.manage({
          cwd: f.cwd,
          action: "edit",
          base: "main",
          branches: ["a", "inserted", "b", "c"],
        });
        expect(edited.layers.map((layer) => layer.branch)).toEqual(["a", "inserted", "b", "c"]);
        expect(edited.baseIsDefault).toBe(true);
        yield* f.stacks
          .manage({ cwd: f.cwd, action: "edit", base: "main", branches: ["c", "b"] })
          .pipe(Effect.flip);
        expect((yield* f.stacks.inspect(f.cwd)).layers.map((layer) => layer.branch)).toEqual([
          "a",
          "inserted",
          "b",
          "c",
        ]);
        const trimmed = yield* f.stacks.manage({
          cwd: f.cwd,
          action: "edit",
          base: "a",
          branches: ["b", "c"],
        });
        expect(trimmed.baseIsDefault).toBe(false);
        expect(trimmed.layers.map((layer) => layer.branch)).toEqual(["b", "c"]);
        yield* f.git(["branch", "-D", "inserted"]);
        expect(yield* f.git(["show-ref", "--heads"])).toBe(original);
      }).pipe(Effect.scoped),
  );
  it.effect(
    "restacks a descendant with multiple commits, publishes only to the configured fork, and returns to the edited layer",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const oldA = yield* f.git(["rev-parse", "a"]);
        const oldC = yield* f.git(["rev-parse", "c"]);
        const status = yield* f.adopt;
        expect(status.remote).toBe("fork");
        yield* f.commit("b.txt", "updated\n");
        const newB = yield* f.commit("b-extra.txt", "another logical commit\n");
        expect((yield* f.stacks.inspect(f.cwd)).layers[2]?.needsRestack).toBe(true);
        const updates: GitWorkflowProgressUpdate[] = [];
        yield* f.stacks.update(f.cwd, {
          onProgress: (update) =>
            Effect.sync(() => {
              updates.push(update);
            }),
        });
        const hooks = updates.find((update) =>
          update.steps.some((step) => step.id === "c:hooks" && step.state === "running"),
        );
        expect(
          hooks?.steps
            .filter((step) => step.id.endsWith(":push"))
            .every((step) => step.state === "completed" || step.state === "skipped"),
        ).toBe(true);
        expect(updates.at(-1)?.steps.find((step) => step.id === "a:hooks")?.state).toBe("skipped");
        expect(yield* f.git(["branch", "--show-current"])).toBe("b");
        expect(yield* f.git(["rev-parse", "a"])).toBe(oldA);
        expect(yield* f.git(["rev-parse", "b"])).toBe(newB);
        expect(yield* f.git(["show", "c:b-extra.txt"])).toBe("another logical commit");
        expect(yield* f.remoteHead("origin", "c")).toBe(oldC);
        expect(yield* f.remoteHead("fork", "c")).toBe(yield* f.git(["rev-parse", "c"]));
        expect((yield* f.stacks.inspect(f.cwd)).operation).toBeNull();
        yield* f.git(["checkout", "c"]);
        const top = yield* f.commit("top-extra.txt", "top fix\n");
        yield* f.stacks.pushCurrent(f.cwd, "c");
        expect(yield* f.remoteHead("fork", "c")).toBe(top);
        expect(yield* f.remoteHead("origin", "c")).toBe(oldC);
        expect(yield* f.git(["rev-parse", "b"])).toBe(newB);
      }).pipe(Effect.scoped),
  );
  it.effect.each(["abort", "continue"] as const)(
    "keeps conflict recovery durable and supports %s",
    (action) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.git(["checkout", "c"]);
        yield* f.commit("shared.txt", "top change\n");
        yield* f.git(["push", "fork", "c"]);
        yield* f.git(["checkout", "b"]);
        yield* f.adopt;
        const oldC = yield* f.git(["rev-parse", "c"]);
        yield* f.commit("shared.txt", "middle change\n");
        const failure = yield* f.stacks.update(f.cwd).pipe(Effect.flip);
        expect(failure.message).toContain("stopped at c");
        const resumed = yield* make;
        expect((yield* resumed.inspect(f.cwd)).operation?.branch).toBe("c");
        if (action === "continue") {
          yield* f.fs.writeFileString(f.path.join(f.cwd, "shared.txt"), "both changes\n");
          yield* f.git(["add", "shared.txt"]);
        }
        yield* resumed.manage({ cwd: f.cwd, action });
        expect(yield* f.git(["branch", "--show-current"])).toBe("b");
        expect((yield* resumed.inspect(f.cwd)).operation).toBeNull();
        if (action === "abort") expect(yield* f.git(["rev-parse", "c"])).toBe(oldC);
        else expect(yield* f.git(["show", "c:shared.txt"])).toBe("both changes");
      }).pipe(Effect.scoped),
  );
  it.effect.each(["dirty", "worktree", "remote"] as const)(
    "stops before rewriting when %s state is unsafe",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.adopt;
        const oldC = yield* f.git(["rev-parse", "c"]);
        if (mode === "dirty") yield* f.fs.writeFileString(f.path.join(f.cwd, "b.txt"), "dirty\n");
        if (mode === "worktree")
          yield* f.git(["worktree", "add", f.path.join(f.root, "other"), "c"]);
        if (mode === "remote")
          yield* f.git([
            `--git-dir=${f.path.join(f.root, "fork")}`,
            "update-ref",
            "refs/heads/c",
            "refs/heads/main",
          ]);
        yield* f.stacks.update(f.cwd).pipe(Effect.flip);
        expect(yield* f.git(["rev-parse", "c"])).toBe(oldC);
        expect((yield* f.stacks.inspect(f.cwd)).operation).toBeNull();
      }).pipe(Effect.scoped),
  );
  it.effect(
    "keeps multi-branch publication atomic and resumes a rejected push without rebasing twice",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.adopt;
        const oldB = yield* f.remoteHead("fork", "b");
        const oldC = yield* f.remoteHead("fork", "c");
        yield* f.commit("review.txt", "review fix\n");
        const remoteDir = `--git-dir=${f.path.join(f.root, "fork")}`;
        yield* f.git([remoteDir, "config", "receive.denyNonFastForwards", "true"]);
        yield* f.stacks.update(f.cwd).pipe(Effect.flip);
        expect(yield* f.remoteHead("fork", "b")).toBe(oldB);
        expect(yield* f.remoteHead("fork", "c")).toBe(oldC);
        expect((yield* f.stacks.inspect(f.cwd)).operation?.phase).toBe("push");
        const rebased = yield* f.git(["rev-parse", "c"]);
        yield* f.git([remoteDir, "config", "receive.denyNonFastForwards", "false"]);
        yield* f.stacks.manage({ cwd: f.cwd, action: "continue", expectedBranch: "b" });
        expect(yield* f.remoteHead("fork", "c")).toBe(rebased);
        expect(yield* f.git(["rev-parse", "c"])).toBe(rebased);
        expect((yield* f.stacks.inspect(f.cwd)).operation).toBeNull();
      }).pipe(Effect.scoped),
  );
  it.effect(
    "resumes only unfinished post-push hooks after restart without accessing the remote again",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.adopt;
        yield* f.commit("review.txt", "fix\n");
        const calls: string[] = [];
        const afterPush = Effect.fn("test.afterPush")(function* (cwd: string, branch: string) {
          expect(yield* f.git(["branch", "--show-current"]).pipe(Effect.orDie)).toBe(branch);
          expect(cwd).toBe(f.cwd);
          calls.push(branch);
          if (branch === "c" && calls.filter((name) => name === "c").length === 1)
            return yield* new GitManagerError({ operation: "test", cwd, detail: "Hook failed" });
        });
        yield* f.stacks.update(f.cwd, { afterPush }).pipe(Effect.flip);
        expect(calls).toEqual(["b", "c"]);
        expect((yield* f.stacks.inspect(f.cwd)).operation).toMatchObject({
          phase: "hooks",
          branch: "c",
        });
        expect(yield* f.git(["branch", "--show-current"]).pipe(Effect.orDie)).toBe("b");
        const top = yield* f.remoteHead("fork", "c");
        yield* f.git(["remote", "set-url", "fork", f.path.join(f.root, "missing")]);
        const restarted = yield* make;
        yield* restarted.manage({ cwd: f.cwd, action: "continue" }, [], afterPush);
        expect(calls).toEqual(["b", "c", "c"]);
        expect(yield* f.git(["branch", "--show-current"]).pipe(Effect.orDie)).toBe("b");
        expect(yield* f.remoteHead("fork", "c")).toBe(top);
        expect((yield* restarted.inspect(f.cwd)).operation).toBeNull();
      }).pipe(Effect.scoped),
  );
  it.effect("fetches a remote fast-forward and propagates it into descendants", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.adopt;
      const oldB = yield* f.git(["rev-parse", "b"]);
      const remoteB = yield* f.commit("suggestion.txt", "reviewer suggestion\n");
      yield* f.git(["push", "fork", "b"]);
      yield* f.git(["reset", "--hard", oldB]);
      yield* f.stacks.update(f.cwd);
      expect(yield* f.git(["rev-parse", "b"])).toBe(remoteB);
      expect(yield* f.git(["show", "c:suggestion.txt"])).toBe("reviewer suggestion");
    }).pipe(Effect.scoped),
  );
  it.effect("handles a squash-merged layer whose remote branch was deleted", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.adopt;
      yield* f.git(["checkout", "main"]);
      yield* f.git(["merge", "--squash", "a"]);
      yield* f.git(["commit", "-m", "Squash merged a"]);
      yield* f.git(["push", "origin", "main"]);
      yield* f.git(["push", "fork", "--delete", "a"]);
      yield* f.git(["checkout", "b"]);
      const parents: string[] = [];
      const result = yield* f.stacks.update(f.cwd, {
        mergedBranches: ["a"],
        afterPush: Effect.fn("test.parentAfterPush")(function* (_cwd: string, branch: string) {
          parents.push(
            yield* f.git(["config", "--get", `branch.${branch}.t3-merge-base`]).pipe(Effect.orDie),
          );
        }),
      });
      expect(parents).toEqual(["main", "b"]);
      expect(result.layers.map((layer) => layer.branch)).toEqual(["b", "c"]);
      expect(yield* f.git(["show", "c:a.txt"])).toBe("a");
      expect(yield* f.git(["rev-list", "--count", "main..c"])).toBe("2");
    }).pipe(Effect.scoped),
  );
  it.effect.each(["glab", "parents", "ancestry", "ancestry-base", "ancestry-remote-base"] as const)(
    "discovers branch order from %s without changing its metadata",
    (source) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        if (source === "ancestry-remote-base") {
          yield* f.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
          yield* f.git(["branch", "-D", "main"]);
        } else if (source === "ancestry-base") {
          yield* f.git(["config", "branch.b.t3-merge-base", "origin/main"]);
          yield* f.git(["config", "branch.c.t3-merge-base", "origin/main"]);
        } else if (source === "parents") {
          yield* f.git(["config", "branch.b.t3-merge-base", "a"]);
          yield* f.git(["config", "branch.c.gh-merge-base", "b"]);
        } else if (source === "glab") {
          const root = f.path.join(f.cwd, ".git", "stacked", "feature");
          yield* f.fs.makeDirectory(root, { recursive: true });
          yield* f.fs.writeFileString(f.path.join(root, "BASE_BRANCH"), "main\n");
          yield* f.fs.writeFileString(
            f.path.join(root, "1.json"),
            '{"sha":"1","branch":"a","prev":"","next":"2"}',
          );
          yield* f.fs.writeFileString(
            f.path.join(root, "2.json"),
            '{"sha":"2","branch":"b","prev":"1","next":"3"}',
          );
          yield* f.fs.writeFileString(
            f.path.join(root, "3.json"),
            '{"sha":"3","branch":"c","prev":"2","next":""}',
          );
        }
        expect((yield* f.stacks.inspect(f.cwd)).layers.map((layer) => layer.branch)).toEqual([
          "a",
          "b",
          "c",
        ]);
        yield* f.adopt;
        if (source === "glab")
          expect(
            yield* f.fs.readFileString(f.path.join(f.cwd, ".git", "stacked", "feature", "2.json")),
          ).toBe('{"sha":"2","branch":"b","prev":"1","next":"3"}');
      }).pipe(Effect.scoped),
  );
  it.effect(
    "only includes newer main when requested and removes merged prefix layers without deleting their branches",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.adopt;
        yield* f.git(["checkout", "main"]);
        yield* f.commit("main-extra.txt", "upstream\n");
        yield* f.git(["push", "origin", "main"]);
        yield* f.git(["checkout", "b"]);
        yield* f.stacks.update(f.cwd);
        expect((yield* f.git(["ls-tree", "--name-only", "c"])).includes("main-extra.txt")).toBe(
          false,
        );
        yield* f.stacks.update(f.cwd, { includeLatestBase: true });
        expect(yield* f.git(["show", "c:main-extra.txt"])).toBe("upstream");
        const result = yield* f.stacks.update(f.cwd, { mergedBranches: ["a"] });
        expect(result.layers.map((layer) => layer.branch)).toEqual(["b", "c"]);
        expect(result.layers[0]?.parent).toBe("main");
        expect(yield* f.git(["rev-parse", "a"])).not.toBe("");
        yield* f.stacks.manage({ cwd: f.cwd, action: "untrack" });
        expect((yield* f.stacks.inspect(f.cwd)).managed).toBe(false);
      }).pipe(Effect.scoped),
  );
});
