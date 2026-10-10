import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorktreeRevivalService from "./WorktreeRevivalService.ts";
import * as WorktreeService from "./WorktreeService.ts";
import {
  addWorktree,
  initializeRepository,
  makeHarness,
  makeProject,
  projectId,
} from "./WorktreeService.testkit.ts";

it.effect(
  "lists, removes and revives default, current and previous worktrees after settings change",
  () => {
    const { state, layer } = makeHarness();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const settings = yield* ServerSettings.ServerSettingsService;
      const worktrees = yield* WorktreeService.WorktreeService;
      const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
      const repositoryRoot = yield* initializeRepository();
      state.projects = [makeProject(repositoryRoot)];
      const previousRoot = yield* fs.makeTempDirectoryScoped({ prefix: "previous-worktrees-" });
      const currentRoot = yield* fs.makeTempDirectoryScoped({ prefix: "current-worktrees-" });
      const paths = [
        yield* addWorktree(repositoryRoot, "default"),
        yield* addWorktree(repositoryRoot, "previous", { root: previousRoot }),
        yield* addWorktree(repositoryRoot, "current", { root: currentRoot }),
      ];
      yield* settings.updateSettings({ worktreesDirectory: previousRoot });
      assert.sameMembers(
        (yield* worktrees.listWorktrees({})).worktrees.map((entry) => entry.path),
        paths.slice(0, 2),
      );
      yield* settings.updateSettings({
        worktreesDirectory: currentRoot,
      });
      const inventory = yield* worktrees.listWorktrees({});
      assert.sameMembers(
        inventory.worktrees.map((entry) => entry.path),
        paths,
      );
      const removed = yield* worktrees.pruneWorktrees({ projectId, paths });
      assert.sameMembers(
        removed.removed.map((entry) => entry.path),
        paths,
      );
      assert.deepEqual(removed.skipped, []);
      for (const entry of inventory.worktrees) {
        assert.isFalse(yield* fs.exists(entry.path));
        const restored = yield* revival.reviveForThread({
          threadId: ThreadId.make(`revive-${entry.path}`),
          projectId,
          worktreePath: entry.path,
          branch: entry.branch ?? assert.fail("Expected a named worktree branch"),
        });
        assert.deepEqual(restored, { revived: true, generation: 1 });
        assert.isTrue(yield* fs.exists(entry.path));
      }
      assert.sameMembers(
        (yield* worktrees.listWorktrees({})).worktrees.map((entry) => entry.path),
        paths,
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "canonicalizes configured symlink roots and expands previous roots relative to home",
  () => {
    const { state, layer } = makeHarness();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const settings = yield* ServerSettings.ServerSettingsService;
      const worktrees = yield* WorktreeService.WorktreeService;
      const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
      const repositoryRoot = yield* initializeRepository();
      state.projects = [makeProject(repositoryRoot)];
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "worktrees-home-" });
      const currentRoot = path.join(home, "current");
      const previousRoot = path.join(home, "previous");
      const rootAlias = path.join(home, "current-link");
      yield* fs.makeDirectory(currentRoot);
      yield* fs.makeDirectory(previousRoot);
      yield* fs.symlink(currentRoot, rootAlias);
      const current = yield* addWorktree(repositoryRoot, "current-alias", { root: currentRoot });
      const previous = yield* addWorktree(repositoryRoot, "previous-home", { root: previousRoot });
      yield* settings.updateSettings({ worktreesDirectory: "~/previous" });
      yield* settings.updateSettings({ worktreesDirectory: currentRoot });
      yield* settings.updateSettings({ worktreesDirectory: rootAlias });

      yield* Effect.gen(function* () {
        const inventory = yield* worktrees.listWorktrees({});
        assert.sameMembers(
          inventory.worktrees.map((entry) => entry.path),
          [current, previous],
        );
        const aliasedPath = path.join(rootAlias, "current-alias");
        const removed = yield* worktrees.pruneWorktrees({
          projectId,
          paths: [aliasedPath, previous],
        });
        assert.sameMembers(
          removed.removed.map((entry) => entry.path),
          [current, previous],
        );
        assert.deepEqual(removed.skipped, []);
        for (const [worktreePath, branch] of [
          [aliasedPath, "feature/current-alias"],
          [previous, "feature/previous-home"],
        ] as const) {
          const result = yield* revival.reviveForThread({
            threadId: ThreadId.make(`revive-${worktreePath}`),
            projectId,
            worktreePath,
            branch,
          });
          assert.isTrue(result.revived);
          assert.isTrue(yield* fs.exists(worktreePath));
        }
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "rejects filesystem roots, symlinks to roots and non-absolute configured directories",
  () => {
    const { state, layer } = makeHarness();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const settings = yield* ServerSettings.ServerSettingsService;
      const worktrees = yield* WorktreeService.WorktreeService;
      const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
      const repositoryRoot = yield* initializeRepository();
      state.projects = [makeProject(repositoryRoot)];
      const externalRoot = yield* fs.makeTempDirectoryScoped({ prefix: "unmanaged-worktrees-" });
      const external = yield* addWorktree(repositoryRoot, "external", { root: externalRoot });
      const rootAlias = path.join(externalRoot, "filesystem-root");
      yield* fs.symlink(path.parse(externalRoot).root, rootAlias);
      yield* settings.updateSettings({ worktreesDirectory: path.parse(externalRoot).root });
      yield* settings.updateSettings({ worktreesDirectory: "relative/worktrees" });
      yield* settings.updateSettings({ worktreesDirectory: rootAlias });
      assert.deepEqual((yield* worktrees.listWorktrees({})).worktrees, []);
      const removal = yield* worktrees.removeIfSafe({
        intent: "manual",
        workspaceRoot: repositoryRoot,
        path: external,
      });
      assert.deepEqual(removal, { outcome: "skipped", reason: "protected_path" });
      assert.isTrue(yield* fs.exists(external));
      yield* fs.remove(external, { recursive: true });
      const error = yield* revival
        .reviveForThread({
          threadId: ThreadId.make("outside-managed-root"),
          projectId,
          worktreePath: external,
          branch: "feature/external",
        })
        .pipe(Effect.flip);
      assert.equal(error.stage, "outside_managed_root");
      assert.isFalse(yield* fs.exists(external));
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "protects configured roots and checkouts containing them even inside another managed root",
  () => {
    const { state, layer } = makeHarness();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettings.ServerSettingsService;
      const worktrees = yield* WorktreeService.WorktreeService;
      const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
      const repositoryRoot = yield* initializeRepository();
      state.projects = [makeProject(repositoryRoot)];
      const nestedRoot = yield* addWorktree(repositoryRoot, "nested-root");
      yield* settings.updateSettings({ worktreesDirectory: path.join(nestedRoot, "child-root") });
      assert.deepEqual((yield* worktrees.listWorktrees({})).worktrees, []);
      assert.deepEqual(
        yield* worktrees.removeIfSafe({
          intent: "manual",
          workspaceRoot: repositoryRoot,
          path: nestedRoot,
        }),
        { outcome: "skipped", reason: "protected_path" },
      );
      yield* settings.updateSettings({ worktreesDirectory: nestedRoot });
      assert.deepEqual((yield* worktrees.listWorktrees({})).worktrees, []);
      assert.deepEqual(
        yield* worktrees.removeIfSafe({
          intent: "manual",
          workspaceRoot: repositoryRoot,
          path: nestedRoot,
        }),
        { outcome: "skipped", reason: "protected_path" },
      );
      assert.isTrue(yield* fs.exists(nestedRoot));
      const missingRoot = path.join(config.worktreesDir, "missing-root");
      yield* settings.updateSettings({ worktreesDirectory: missingRoot });
      const error = yield* revival
        .reviveForThread({
          threadId: ThreadId.make("managed-root-itself"),
          projectId,
          worktreePath: missingRoot,
          branch: "feature/nested-root",
        })
        .pipe(Effect.flip);
      assert.equal(error.stage, "outside_managed_root");
      assert.isFalse(yield* fs.exists(missingRoot));
    }).pipe(Effect.provide(layer));
  },
);

it.effect("rejects checkout paths that escape a configured root through a symlink", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settings = yield* ServerSettings.ServerSettingsService;
    const worktrees = yield* WorktreeService.WorktreeService;
    const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    const configuredRoot = yield* fs.makeTempDirectoryScoped({ prefix: "configured-worktrees-" });
    const externalRoot = yield* fs.makeTempDirectoryScoped({ prefix: "external-worktrees-" });
    const external = yield* addWorktree(repositoryRoot, "escape", { root: externalRoot });
    const escapeLink = path.join(configuredRoot, "escape-link");
    yield* fs.symlink(externalRoot, escapeLink);
    const escapedPath = path.join(escapeLink, "escape");
    yield* settings.updateSettings({ worktreesDirectory: configuredRoot });
    assert.deepEqual((yield* worktrees.listWorktrees({})).worktrees, []);
    assert.deepEqual(
      yield* worktrees.removeIfSafe({
        intent: "manual",
        workspaceRoot: repositoryRoot,
        path: escapedPath,
      }),
      { outcome: "skipped", reason: "protected_path" },
    );
    assert.isTrue(yield* fs.exists(external));
    yield* fs.remove(external, { recursive: true });
    const error = yield* revival
      .reviveForThread({
        threadId: ThreadId.make("escaped-root"),
        projectId,
        worktreePath: escapedPath,
        branch: "feature/escape",
      })
      .pipe(Effect.flip);
    assert.equal(error.stage, "outside_managed_root");
    assert.isFalse(yield* fs.exists(external));
  }).pipe(Effect.provide(layer));
});
