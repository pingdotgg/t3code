import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { IsoDateTime, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectCheckoutInspector from "./ProjectCheckoutInspector.ts";

const NOW = IsoDateTime.make("2026-11-03T00:00:00.000Z");

const layerHost = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-checkout-inspector-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerWithProjects = (projects: ReadonlyArray<{ id: string; workspaceRoot: string }>) =>
  ProjectCheckoutInspector.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () =>
          Effect.succeed(
            projects.map((project) => ({
              id: ProjectId.make(project.id),
              title: project.id,
              workspaceRoot: project.workspaceRoot,
              scripts: [],
              defaultModelSelection: null,
              createdAt: NOW,
              updatedAt: NOW,
            })),
          ),
      }),
    ),
    Layer.provide(WorkspacePaths.layer),
  );

const scratchRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The temp directory itself is a symlink on macOS, and Git only reports physical paths.
  const parent = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkout-inspector-" }),
  );
  const root = path.join(parent, "repo");
  yield* fileSystem.makeDirectory(root);
  return { parent, root };
});

const inspect = (path: string) =>
  ProjectCheckoutInspector.ProjectCheckoutInspector.use((inspector) => inspector.inspect({ path }));

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  GitVcsDriver.GitVcsDriver.use((driver) =>
    driver.execute({ operation: "project-checkout-inspector-test", cwd, args }),
  );

const initRepository = (root: string) =>
  Effect.gen(function* () {
    yield* git(root, "init", "--initial-branch=feature/base");
    yield* git(root, "config", "user.email", "test@example.com");
    yield* git(root, "config", "user.name", "Test");
    yield* git(root, "commit", "--allow-empty", "-m", "initial");
  });

it.layer(layerHost)("ProjectCheckoutInspector", (it) => {
  it.effect("reports the branch of a repository's main checkout", () =>
    Effect.gen(function* () {
      const { root } = yield* scratchRepository;
      yield* initRepository(root);

      expect(yield* inspect(root)).toEqual({
        projectId: null,
        checkout: {
          selectedPath: root,
          root,
          rootProjectId: null,
          branch: "feature/base",
          isLinkedWorktree: false,
        },
      });
    }).pipe(Effect.scoped, Effect.provide(layerWithProjects([]))),
  );

  it.effect("resolves a nested folder to its repository root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root } = yield* scratchRepository;
      yield* initRepository(root);
      const nested = path.join(root, "apps", "web");
      yield* fileSystem.makeDirectory(nested, { recursive: true });

      const { checkout } = yield* inspect(nested);

      expect(checkout?.selectedPath).toBe(nested);
      expect(checkout?.root).toBe(root);
      expect(checkout?.isLinkedWorktree).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layerWithProjects([]))),
  );

  it.effect("tells a linked worktree from the main checkout, also from inside it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { parent, root } = yield* scratchRepository;
      yield* initRepository(root);
      const worktree = path.join(parent, "linked");
      yield* git(root, "worktree", "add", "-b", "linked-branch", worktree);
      const nested = path.join(worktree, "src");
      yield* fileSystem.makeDirectory(nested);

      const atRoot = yield* inspect(worktree);
      expect(atRoot.checkout?.root).toBe(worktree);
      expect(atRoot.checkout?.branch).toBe("linked-branch");
      expect(atRoot.checkout?.isLinkedWorktree).toBe(true);

      const fromNested = yield* inspect(nested);
      expect(fromNested.checkout?.root).toBe(worktree);
      expect(fromNested.checkout?.isLinkedWorktree).toBe(true);

      expect((yield* inspect(root)).checkout?.isLinkedWorktree).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layerWithProjects([]))),
  );

  it.effect("reports a detached HEAD without a branch and an unborn branch with one", () =>
    Effect.gen(function* () {
      const { root } = yield* scratchRepository;
      yield* git(root, "init", "--initial-branch=unborn");
      expect((yield* inspect(root)).checkout?.branch).toBe("unborn");

      yield* git(root, "config", "user.email", "test@example.com");
      yield* git(root, "config", "user.name", "Test");
      yield* git(root, "commit", "--allow-empty", "-m", "initial");
      yield* git(root, "checkout", "--detach");
      const { checkout } = yield* inspect(root);
      expect(checkout?.root).toBe(root);
      expect(checkout?.branch).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layerWithProjects([]))),
  );

  it.effect("keeps the selected spelling when a symlink points at the repository root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { parent, root } = yield* scratchRepository;
      yield* initRepository(root);
      const alias = path.join(parent, "alias");
      yield* fileSystem.symlink(root, alias);

      const { checkout } = yield* inspect(alias);

      expect(checkout?.selectedPath).toBe(alias);
      expect(checkout?.root).toBe(alias);
      expect(checkout?.isLinkedWorktree).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layerWithProjects([]))),
  );

  it.effect("finds no checkout in a plain folder, a missing folder, or a Git directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { parent, root } = yield* scratchRepository;
      const plain = path.join(parent, "plain");
      yield* fileSystem.makeDirectory(plain);
      yield* initRepository(root);

      const none = { projectId: null, checkout: null };
      expect(yield* inspect(plain)).toEqual(none);
      expect(yield* inspect(path.join(parent, "missing"))).toEqual(none);
      expect(yield* inspect(path.join(root, ".git"))).toEqual(none);
    }).pipe(Effect.scoped, Effect.provide(layerWithProjects([]))),
  );

  it.effect("matches a project registered through a symlink, at the folder and at its root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { parent, root } = yield* scratchRepository;
      yield* initRepository(root);
      const alias = path.join(parent, "alias");
      yield* fileSystem.symlink(root, alias);
      const nested = path.join(root, "apps");
      yield* fileSystem.makeDirectory(nested);

      const inspection = yield* inspect(nested).pipe(
        Effect.provide(layerWithProjects([{ id: "aliased", workspaceRoot: alias }])),
      );
      expect(inspection.projectId).toBeNull();
      expect(inspection.checkout?.rootProjectId).toBe("aliased");

      const atRoot = yield* inspect(root).pipe(
        Effect.provide(layerWithProjects([{ id: "aliased", workspaceRoot: alias }])),
      );
      expect(atRoot.projectId).toBe("aliased");
      expect(atRoot.checkout?.rootProjectId).toBe("aliased");

      const plain = path.join(parent, "plain");
      yield* fileSystem.makeDirectory(plain);
      const plainAtProject = yield* inspect(plain).pipe(
        Effect.provide(layerWithProjects([{ id: "plain", workspaceRoot: plain }])),
      );
      expect(plainAtProject).toEqual({ projectId: "plain", checkout: null });
    }).pipe(Effect.scoped),
  );
});
