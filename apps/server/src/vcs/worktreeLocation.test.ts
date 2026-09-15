import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ProjectId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

it.effect(
  "uses live environment settings, project overrides, resets, and explicit paths for new worktrees",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-worktree-location-" });
      const cwd = path.join(root, "repo");
      yield* fs.makeDirectory(cwd);
      const alias = path.join(root, "repo-alias");
      yield* fs.symlink(cwd, alias);
      const projectId = ProjectId.make("project");
      const settingsLayer = ServerSettings.layerTest();
      const missingRoot = path.join(root, "missing-checkout");
      const fileRoot = path.join(root, "not-a-directory");
      yield* fs.writeFileString(fileRoot, "stale project path");
      const configLayer = ServerConfig.layerTest(missingRoot, path.join(root, "t3"));
      const layer = GitVcsDriver.layer.pipe(
        Layer.provideMerge(settingsLayer),
        Layer.provideMerge(configLayer),
        Layer.provideMerge(
          Layer.mock(ProjectionProjectRepository)({
            listAll: () =>
              Effect.succeed(
                [missingRoot, fileRoot, alias].map((workspaceRoot) => ({
                  projectId:
                    workspaceRoot === alias
                      ? projectId
                      : ProjectId.make(path.basename(workspaceRoot)),
                  title: "Project",
                  workspaceRoot,
                  defaultModelSelection: null,
                  defaultThreadEnvMode: null,
                  autoPull: false,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  deletedAt: null,
                })),
              ),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        const settings = yield* ServerSettings.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        for (const args of [
          ["init"],
          ["config", "user.email", "test@example.com"],
          ["config", "user.name", "Test"],
          ["commit", "--allow-empty", "-m", "initial"],
        ]) {
          yield* git.execute({ operation: "test", cwd, args });
        }
        const create = (name: string, explicitPath: string | null = null) =>
          git.createWorktree({ cwd, refName: "HEAD", newRefName: name, path: explicitPath });
        const defaultDescendant = path.join(cwd, "packages", "default-app");
        yield* fs.makeDirectory(defaultDescendant, { recursive: true });
        assert.strictEqual(
          (yield* git.createWorktree({
            cwd: defaultDescendant,
            refName: "HEAD",
            newRefName: "default-descendant",
            path: null,
          })).worktree.path,
          path.join(config.worktreesDir, "repo", "default-descendant"),
        );
        const original = yield* create("original");
        assert.strictEqual(
          original.worktree.path,
          path.join(config.worktreesDir, "repo", "original"),
        );
        const environmentRoot = path.join(root, "custom folder");
        yield* settings.updateSettings({ worktreeBaseDirectory: environmentRoot });
        const environment = yield* create("feature/environment");
        assert.strictEqual(
          environment.worktree.path,
          path.join(environmentRoot, "repo", "feature-environment"),
        );
        const homeRelativeRoot = `~/${path.relative(NodeOS.homedir(), root)}/home-worktrees`;
        yield* settings.updateSettings({ worktreeBaseDirectory: homeRelativeRoot });
        assert.strictEqual(
          (yield* create("home")).worktree.path,
          path.join(root, "home-worktrees", "repo", "home"),
        );
        yield* settings.updateSettings({ worktreeBaseDirectory: environmentRoot });
        const projectRoot = path.join(root, "project-worktrees");
        yield* settings.updateSettings({
          projectSettingsOverrides: { [projectId]: { worktreeBaseDirectory: projectRoot } },
        });
        assert.strictEqual(
          (yield* create("override")).worktree.path,
          path.join(projectRoot, "repo", "override"),
        );
        assert.strictEqual(
          (yield* git.createWorktree({
            cwd: alias,
            refName: "HEAD",
            newRefName: "alias-override",
            path: null,
          })).worktree.path,
          path.join(projectRoot, "repo-alias", "alias-override"),
        );
        const explicitPath = path.join(root, "explicit");
        assert.strictEqual((yield* create("explicit", explicitPath)).worktree.path, explicitPath);
        yield* settings.updateSettings({
          projectSettingsOverrides: { [projectId]: { worktreeBaseDirectory: "" } },
        });
        assert.strictEqual(
          (yield* create("builtin")).worktree.path,
          path.join(config.worktreesDir, "repo", "builtin"),
        );
        yield* settings.updateSettings({ projectSettingsOverrides: { [projectId]: null } });
        assert.strictEqual(
          (yield* create("inherited")).worktree.path,
          path.join(environmentRoot, "repo", "inherited"),
        );
        yield* settings.updateSettings({ worktreeBaseDirectory: "" });
        assert.strictEqual(
          (yield* create("reset")).worktree.path,
          path.join(config.worktreesDir, "repo", "reset"),
        );
        yield* settings.updateSettings({ worktreePathLayout: "flat" });
        assert.strictEqual(
          (yield* git.createWorktree({
            cwd: defaultDescendant,
            refName: "HEAD",
            newRefName: "flat-default-descendant",
            path: null,
          })).worktree.path,
          path.join(config.worktreesDir, "repo-flat-default-descendant"),
        );
        assert.strictEqual(
          (yield* create("feature/flat")).worktree.path,
          path.join(config.worktreesDir, "repo-feature-flat"),
        );
        yield* settings.updateSettings({
          projectSettingsOverrides: { [projectId]: { worktreePathLayout: "nested" } },
        });
        assert.strictEqual(
          (yield* create("nested-override")).worktree.path,
          path.join(config.worktreesDir, "repo", "nested-override"),
        );
        yield* settings.updateSettings({
          worktreePathLayout: "nested",
          worktreeBaseDirectory: environmentRoot,
          projectSettingsOverrides: { [projectId]: { worktreePathLayout: "flat" } },
        });
        assert.strictEqual(
          (yield* create("flat-override")).worktree.path,
          path.join(environmentRoot, "repo-flat-override"),
        );
        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [projectId]: { worktreeBaseDirectory: projectRoot, worktreePathLayout: "flat" },
          },
        });
        const descendant = path.join(cwd, "packages", "app");
        yield* fs.makeDirectory(descendant, { recursive: true });
        for (const descendantCwd of [descendant, path.join(alias, "packages", "app")]) {
          const branch = descendantCwd === descendant ? "descendant" : "descendant-alias";
          assert.strictEqual(
            (yield* git.createWorktree({
              cwd: descendantCwd,
              refName: "HEAD",
              newRefName: branch,
              path: null,
            })).worktree.path,
            path.join(projectRoot, `repo-${branch}`),
          );
        }
        const flatExplicitPath = path.join(root, "flat-explicit");
        assert.strictEqual(
          (yield* create("flat-explicit", flatExplicitPath)).worktree.path,
          flatExplicitPath,
        );
        yield* settings.updateSettings({ projectSettingsOverrides: { [projectId]: null } });
        assert.strictEqual(
          (yield* create("layout-inherited")).worktree.path,
          path.join(environmentRoot, "repo", "layout-inherited"),
        );
        yield* settings.updateSettings({ worktreeBaseDirectory: "" });
        assert.isTrue(yield* fs.exists(original.worktree.path));
        assert.isTrue(yield* fs.exists(environment.worktree.path));
        const review = yield* ReviewService.make.pipe(
          Effect.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({ detect: () => Effect.succeed(null) }),
          ),
        );
        const reviewed = yield* review.getDiffPreview({ cwd: environment.worktree.path });
        assert.strictEqual(reviewed.cwd, environment.worktree.path);
        const outside = path.join(root, "outside");
        yield* fs.makeDirectory(outside);
        const error = yield* review.getDiffPreview({ cwd: outside }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);
