// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { resolveCursorCloudRepository } from "./cursorCloudWorkspace.ts";

/** A checkout on `main` whose tip is on `origin/main`, plus a git runner for it. */
const makeRepository = (remoteUrl: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-cloud-workspace-" });
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
    const commit = (message: string) =>
      git(
        "-c",
        "user.name=T3",
        "-c",
        "user.email=t3@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        message,
      );
    git("init", "--quiet", "-b", "main");
    commit("init");
    git("remote", "add", "origin", remoteUrl);
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("config", "branch.main.remote", "origin");
    git("config", "branch.main.merge", "refs/heads/main");
    return { cwd, git, commit };
  });

it.layer(NodeServices.layer)("resolveCursorCloudRepository", (it) => {
  it.effect("starts from the branch when the checkout sits on its pushed tip", () =>
    Effect.gen(function* () {
      const { cwd } = yield* makeRepository("git@github.com:Acme/Widgets.git");
      expect(yield* resolveCursorCloudRepository(cwd)).toEqual({
        url: "https://github.com/Acme/Widgets",
        startingRef: "main",
        hasUnpushedLocalWork: false,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("starts from a chosen pushed branch and flags local work it leaves behind", () =>
    Effect.gen(function* () {
      const { cwd, commit } = yield* makeRepository("https://github.com/acme/widgets.git");
      commit("local only");
      const repository = yield* resolveCursorCloudRepository(cwd, "main");
      expect(repository.startingRef).toBe("main");
      expect(repository.hasUnpushedLocalWork).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("uses the selected remote's repository and branch", () =>
    Effect.gen(function* () {
      const { cwd, git } = yield* makeRepository("https://github.com/fork/widgets.git");
      git("remote", "add", "upstream", "https://github.com/acme/widgets.git");
      git("update-ref", "refs/remotes/upstream/feature/nested", "HEAD");
      expect(yield* resolveCursorCloudRepository(cwd, "upstream/feature/nested")).toEqual({
        url: "https://github.com/acme/widgets",
        startingRef: "feature/nested",
        hasUnpushedLocalWork: false,
      });
      expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
    }).pipe(Effect.scoped),
  );

  it.effect("prefers a local branch over a matching remote prefix", () =>
    Effect.gen(function* () {
      const { cwd, git } = yield* makeRepository("https://github.com/fork/widgets.git");
      git("remote", "add", "upstream", "https://github.com/acme/widgets.git");
      git("branch", "upstream/main");
      git("update-ref", "refs/remotes/origin/upstream/main", "HEAD");
      expect(yield* resolveCursorCloudRepository(cwd, "upstream/main")).toMatchObject({
        url: "https://github.com/fork/widgets",
        startingRef: "upstream/main",
      });
    }).pipe(Effect.scoped),
  );

  for (const selection of ["feature", "origin/main"]) {
    it.effect(`warns about unpublished work when selecting ${selection}`, () =>
      Effect.gen(function* () {
        const { cwd, git, commit } = yield* makeRepository("https://github.com/acme/widgets.git");
        git("checkout", "-qb", "feature");
        git("config", "branch.feature.remote", "origin");
        git("config", "branch.feature.merge", "refs/heads/main");
        commit("unpublished feature work");
        git("checkout", "-q", "main");
        expect((yield* resolveCursorCloudRepository(cwd, selection)).hasUnpushedLocalWork).toBe(
          true,
        );
      }).pipe(Effect.scoped),
    );
  }

  it.effect("warns about a dirty checkout when selecting its remote branch", () =>
    Effect.gen(function* () {
      const { cwd, git } = yield* makeRepository("https://github.com/acme/widgets.git");
      yield* (yield* FileSystem.FileSystem).writeFileString(NodePath.join(cwd, "a.txt"), "x");
      git("add", "a.txt");
      expect((yield* resolveCursorCloudRepository(cwd, "origin/main")).hasUnpushedLocalWork).toBe(
        true,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a chosen branch that is not on GitHub", () =>
    Effect.gen(function* () {
      const { cwd, git } = yield* makeRepository("https://github.com/acme/widgets.git");
      git("branch", "feature");
      const error = yield* Effect.flip(resolveCursorCloudRepository(cwd, "feature"));
      expect(error.detail).toMatch(/Branch 'feature' is not on GitHub yet/);
    }).pipe(Effect.scoped),
  );

  it.effect("starts from the exact commit when the branch has moved on without it", () =>
    Effect.gen(function* () {
      const { cwd, git, commit } = yield* makeRepository("https://github.com/acme/widgets.git");
      const pushed = git("rev-parse", "HEAD");
      commit("pushed later");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      git("reset", "--quiet", "--hard", pushed);
      yield* (yield* FileSystem.FileSystem).writeFileString(NodePath.join(cwd, "a.txt"), "x");
      git("add", "a.txt");

      const repository = yield* resolveCursorCloudRepository(cwd);
      expect(repository.startingRef).toBe(pushed);
      expect(repository.hasUnpushedLocalWork).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a commit that is not on GitHub yet", () =>
    Effect.gen(function* () {
      const { cwd, commit } = yield* makeRepository("https://github.com/acme/widgets.git");
      commit("local only");
      const error = yield* Effect.flip(resolveCursorCloudRepository(cwd));
      expect(error.detail).toMatch(/is not on GitHub yet/);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a repository hosted somewhere other than GitHub", () =>
    Effect.gen(function* () {
      const { cwd } = yield* makeRepository("https://gitlab.com/acme/widgets.git");
      const error = yield* Effect.flip(resolveCursorCloudRepository(cwd));
      expect(error.detail).toMatch(/only works with GitHub/);
    }).pipe(Effect.scoped),
  );
});
