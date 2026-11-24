import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type ProjectTrackedFolder, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TaskFolders from "./TaskFolders.ts";
import * as TaskFolderStore from "./TaskFolderStore.ts";
import {
  layerTaskFoldersWithGit,
  taskFoldersTestProjectId as projectId,
  type TaskFoldersTestState,
} from "./TaskFolders.testkit.ts";

const threadId = ThreadId.make("thread:task-folders");

const layerFor = (state: TaskFoldersTestState) =>
  layerTaskFoldersWithGit(state).pipe(
    Layer.provideMerge(
      GitVcsDriver.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-folders-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  );

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const tmp = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-task-folders-" }),
  );
  const run = (cwd: string, ...args: ReadonlyArray<string>) =>
    git
      .execute({ operation: "task-folders-test", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  const repository = Effect.fnUntraced(function* (relative: string) {
    const folder = path.join(tmp, relative);
    yield* fileSystem.makeDirectory(folder, { recursive: true });
    yield* run(folder, "init", "-b", "main");
    yield* run(folder, "config", "user.email", "task-folders@example.test");
    yield* run(folder, "config", "user.name", "Task folders");
    yield* fileSystem.writeFileString(path.join(folder, "README.md"), `${relative}\n`);
    yield* run(folder, "add", ".");
    yield* run(folder, "commit", "-m", "initial");
    return folder;
  });
  const isLink = (target: string) =>
    fileSystem.readLink(target).pipe(Effect.option, Effect.map(Option.isSome));
  const worktreeCount = (folder: string) =>
    run(folder, "worktree", "list", "--porcelain").pipe(
      Effect.map((listed) => listed.split("\n").filter((line) => line.startsWith("worktree "))),
      Effect.map((worktrees) => worktrees.length),
    );
  return { fileSystem, path, tmp, run, repository, isLink, worktreeCount };
});

const tracked = (...folders: ReadonlyArray<string>): ReadonlyArray<ProjectTrackedFolder> =>
  folders.map((folder) => ({ path: folder, name: folder.split(/[\\/]/).at(-1)! }));

const create = Effect.fnUntraced(function* (
  branch: string,
  repositories?: ReadonlyArray<{ readonly path: string }>,
  baseBranch?: string,
) {
  const taskFolders = yield* TaskFolders.TaskFolders;
  const plan = yield* taskFolders.plan({ projectId, repositories });
  assert.isNotNull(plan);
  return yield* taskFolders.create({
    plan: plan!,
    branch,
    projectStart: { refName: "main", baseRefName: "main" },
    baseBranch,
    startFromOrigin: false,
  });
});

const withState = <A, E>(
  test: (
    state: TaskFoldersTestState,
  ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerFor>> | Scope.Scope>,
) => {
  const state: TaskFoldersTestState = { workspaceRoot: "/unset", trackedFolders: [], thread: null };
  return test(state).pipe(Effect.provide(layerFor(state)), Effect.scoped);
};

it.live("lays a plain wrapper out as links around its repositories' worktrees", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, run, repository, isLink } = yield* fixture;
      const shop = path.join(tmp, "shop");
      const api = yield* repository("shop/services/api");
      const web = yield* repository("shop/web");
      const unpicked = yield* repository("shop/unpicked");
      yield* fileSystem.makeDirectory(path.join(shop, "notes"));
      yield* fileSystem.makeDirectory(path.join(shop, ".git-not"));
      yield* fileSystem.writeFileString(path.join(shop, "AGENTS.md"), "root rules\n");
      yield* fileSystem.writeFileString(path.join(shop, "services", "README.md"), "services\n");
      const unborn = path.join(shop, "unborn");
      yield* fileSystem.makeDirectory(unborn);
      yield* run(unborn, "init", "-b", "main");
      state.workspaceRoot = shop;
      state.trackedFolders = tracked(api, web, unpicked, unborn, path.join(shop, "notes"));

      const { taskFolder, branch } = yield* create("feature", [
        { path: api },
        { path: web },
        { path: unborn },
      ]);
      const root = taskFolder.root;

      assert.equal(branch, "feature");
      assert.deepEqual(
        { ...taskFolder, repositories: taskFolder.repositories.toSorted(byName) },
        {
          root,
          projectId,
          projectRoot: shop,
          anchor: shop,
          projectPath: root,
          projectIsWorktree: false,
          repositories: [
            {
              repositoryPath: api,
              worktreePath: path.join(root, "services", "api"),
              name: "api",
            },
            { repositoryPath: web, worktreePath: path.join(root, "web"), name: "web" },
          ],
        },
      );
      // Shared with the original, never copied.
      assert.equal(
        yield* fileSystem.readLink(path.join(root, "AGENTS.md")),
        path.join(shop, "AGENTS.md"),
      );
      assert.isTrue(yield* isLink(path.join(root, "notes")));
      // The folder leading to a repository is real, and still shows what else it holds.
      assert.isFalse(yield* isLink(path.join(root, "services")));
      assert.isTrue(yield* isLink(path.join(root, "services", "README.md")));
      // A tracked repository that was not chosen is absent: a link would be the original checkout.
      assert.isFalse(yield* fileSystem.exists(path.join(root, "unpicked")));
      // So is a chosen one with no commit yet, which has nothing to branch from.
      assert.isFalse(yield* fileSystem.exists(path.join(root, "unborn")));
      assert.isFalse(yield* fileSystem.exists(path.join(root, ".git")));
      for (const worktree of [path.join(root, "services", "api"), path.join(root, "web")]) {
        assert.equal(yield* run(worktree, "symbolic-ref", "--short", "HEAD"), "feature");
      }
      const taskFolders = yield* TaskFolders.TaskFolders;
      assert.deepEqual(yield* taskFolders.find(path.join(root, "web", "src")), taskFolder);

      // A file of the thread's own keeps the folder, and a folder that stays keeps its links.
      yield* fileSystem.writeFileString(path.join(root, "draft.md"), "mine\n");
      yield* taskFolders.remove({ root, force: false, forget: true });
      assert.equal(
        yield* fileSystem.readLink(path.join(root, "AGENTS.md")),
        path.join(shop, "AGENTS.md"),
      );
    }),
  ),
);

const byName = (left: { readonly name: string }, right: { readonly name: string }) =>
  left.name.localeCompare(right.name);

it.live("keeps a Git project and its sibling repository side by side", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, run, repository, worktreeCount } = yield* fixture;
      const ctx = yield* repository("x/ctx");
      const app = yield* repository("x/app");
      // A submodule comes with its repository's worktree, however that repository sets it up.
      const lib = yield* repository("x/app/vendor/lib");
      yield* fileSystem.writeFileString(
        path.join(app, ".gitmodules"),
        '[submodule "lib"]\n\tpath = vendor/lib\n',
      );
      state.workspaceRoot = ctx;
      state.trackedFolders = tracked(app, lib);

      // Named by a client that cannot tell it apart, the submodule is left to its repository.
      const { taskFolder } = yield* create("feature", [{ path: app }, { path: lib }]);

      assert.equal(taskFolder.anchor, path.dirname(ctx));
      assert.equal(taskFolder.projectPath, path.join(taskFolder.root, "ctx"));
      assert.isTrue(taskFolder.projectIsWorktree);
      assert.deepEqual(taskFolder.repositories, [
        { repositoryPath: app, worktreePath: path.join(taskFolder.root, "app"), name: "app" },
      ]);
      // `../app` from the thread's folder is the thread's own checkout of it.
      assert.equal(
        yield* run(
          path.join(taskFolder.projectPath, "..", "app"),
          "symbolic-ref",
          "--short",
          "HEAD",
        ),
        "feature",
      );
      assert.equal(
        yield* run(taskFolder.projectPath, "symbolic-ref", "--short", "HEAD"),
        "feature",
      );
      assert.equal(yield* worktreeCount(ctx), 2);
      assert.equal(yield* worktreeCount(lib), 1);

      // A file the thread left beside its checkouts keeps the folder, and the record of it.
      const taskFolders = yield* TaskFolders.TaskFolders;
      const { root } = taskFolder;
      yield* fileSystem.writeFileString(path.join(root, "notes.md"), "mine\n");
      const first = yield* taskFolders.remove({ root, force: false, forget: true });
      assert.deepEqual(
        first.kept.map((entry) => entry.path),
        [root],
      );
      assert.isNotNull(yield* taskFolders.find(root));
      const second = yield* taskFolders.remove({ root, force: true, forget: true });
      assert.deepEqual(second.kept, []);
      assert.isFalse(yield* fileSystem.exists(root));
      assert.isNull(yield* taskFolders.find(root));
    }),
  ),
);

it.effect("finds no common folder for two Windows drives instead of climbing forever", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    assert.equal(
      TaskFolders.commonAncestor(path, ["C:\\work\\shop", "C:\\work\\libs\\api"]),
      "C:\\work",
    );
    assert.isNull(TaskFolders.commonAncestor(path, ["C:\\work\\shop", "D:\\api"]));
    // A repository on another drive is left out of the layout, not in the way of the rest.
    assert.deepEqual(
      TaskFolders.layoutAnchor(path, "C:\\work\\shop", ["D:\\api", "C:\\work\\libs\\api"]),
      { anchor: "C:\\work", unreachable: ["D:\\api"] },
    );
  }).pipe(Effect.provide(NodePath.layerWin32)),
);

it.live.each([{ projectIsRepository: false }, { projectIsRepository: true }])(
  "gives two creations on one branch a folder each, project is a repository=$projectIsRepository",
  ({ projectIsRepository }) =>
    withState((state) =>
      Effect.gen(function* () {
        const { fileSystem, path, tmp, repository } = yield* fixture;
        const shop = projectIsRepository ? yield* repository("shop") : path.join(tmp, "shop");
        const api = yield* repository("shop/api");
        state.workspaceRoot = shop;
        state.trackedFolders = tracked(api);

        // Git gives the branch to one of them; the other's rollback must leave that one's folder.
        const exits = yield* Effect.all(
          [Effect.exit(create("feature")), Effect.exit(create("feature"))],
          {
            concurrency: 2,
          },
        );

        const created = exits.flatMap((exit) =>
          Exit.isSuccess(exit) ? [exit.value.taskFolder] : [],
        );
        assert.isAtLeast(created.length, 1);
        assert.equal(new Set(created.map((taskFolder) => taskFolder.root)).size, created.length);
        for (const taskFolder of created) {
          assert.isTrue(yield* fileSystem.exists(path.join(taskFolder.root, "api", "README.md")));
        }
      }),
    ),
);

it.live.each([{ projectIsRepository: true }, { projectIsRepository: false }])(
  "answers an existing thread's worktree request with a task folder, project is a repository=$projectIsRepository",
  ({ projectIsRepository }) =>
    withState((state) =>
      Effect.gen(function* () {
        const { path, tmp, run, repository } = yield* fixture;
        const shop = projectIsRepository ? yield* repository("shop") : path.join(tmp, "shop");
        const api = yield* repository("shop/api");
        const web = yield* repository("web");
        state.workspaceRoot = shop;
        state.trackedFolders = tracked(api, web);
        const taskFolders = yield* TaskFolders.TaskFolders;
        const request = { cwd: shop, refName: "main", newRefName: "feature", path: null };

        const created = yield* taskFolders.createForProjectFolder(request);

        const taskFolder = yield* taskFolders.find(created!.worktree.path);
        assert.deepEqual(created, {
          worktree: { path: taskFolder!.projectPath, refName: "feature" },
        });
        assert.equal(taskFolder!.projectIsWorktree, projectIsRepository);
        assert.sameMembers(
          taskFolder!.repositories.map((entry) => entry.repositoryPath),
          [api, web],
        );
        for (const worktree of [
          ...(projectIsRepository ? [taskFolder!.projectPath] : []),
          ...taskFolder!.repositories.map((entry) => entry.worktreePath),
        ]) {
          assert.equal(yield* run(worktree, "symbolic-ref", "--short", "HEAD"), "feature");
        }
        // A chosen path, an existing branch and a folder that is no project stay single worktrees.
        for (const single of [
          { ...request, path: path.join(tmp, "elsewhere") },
          { cwd: shop, refName: "main", path: null },
          { ...request, cwd: web },
        ]) {
          assert.isNull(yield* taskFolders.createForProjectFolder(single));
        }
      }),
    ),
);

it.live("puts a clone the project ignores inside the project's worktree", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, run, repository } = yield* fixture;
      const project = yield* repository("p");
      yield* fileSystem.writeFileString(path.join(project, ".gitignore"), "vendor/\n");
      yield* run(project, "add", ".");
      yield* run(project, "commit", "-m", "ignore vendor");
      const lib = yield* repository("p/vendor/lib");
      state.workspaceRoot = project;
      state.trackedFolders = tracked(lib);

      const { taskFolder } = yield* create("feature");

      assert.equal(taskFolder.projectPath, taskFolder.root);
      assert.equal(
        taskFolder.repositories[0]?.worktreePath,
        path.join(taskFolder.root, "vendor", "lib"),
      );
      assert.equal(
        yield* run(path.join(taskFolder.root, "vendor", "lib"), "symbolic-ref", "--short", "HEAD"),
        "feature",
      );
      assert.equal(yield* run(taskFolder.root, "status", "--porcelain"), "");
    }),
  ),
);

it.live("creates the task folder when the project's checkout hook already linked a clone", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, run, repository } = yield* fixture;
      const project = yield* repository("p");
      yield* fileSystem.writeFileString(path.join(project, ".gitignore"), "vendor/\n");
      yield* run(project, "add", ".");
      yield* run(project, "commit", "-m", "ignore vendor");
      const lib = yield* repository("p/vendor/lib");
      // Like many projects with vendored clones, a new worktree links them back to the checkout.
      const hooks = path.join(tmp, "hooks");
      yield* fileSystem.makeDirectory(hooks);
      yield* fileSystem.writeFileString(
        path.join(hooks, "post-checkout"),
        `#!/bin/sh\nmkdir -p vendor && ln -s "${lib}" vendor/lib\n`,
        { mode: 0o755 },
      );
      yield* run(project, "config", "core.hooksPath", hooks);
      state.workspaceRoot = project;
      state.trackedFolders = tracked(lib);

      const created = yield* create("feature").pipe(Effect.exit);

      assert.isTrue(Exit.isSuccess(created), String(Exit.isFailure(created) && created.cause));
    }),
  ),
);

it.live("leaves a hook's link to an empty folder alone", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, run, repository } = yield* fixture;
      const project = yield* repository("p");
      yield* fileSystem.writeFileString(path.join(project, ".gitignore"), "vendor/\n");
      yield* run(project, "add", ".");
      yield* run(project, "commit", "-m", "ignore vendor");
      const lib = yield* repository("p/vendor/lib");
      const target = path.join(tmp, "empty");
      yield* fileSystem.makeDirectory(target);
      const hooks = path.join(tmp, "hooks");
      yield* fileSystem.makeDirectory(hooks);
      yield* fileSystem.writeFileString(
        path.join(hooks, "post-checkout"),
        `#!/bin/sh\nmkdir -p vendor && ln -s "${target}" vendor/lib\n`,
        { mode: 0o755 },
      );
      yield* run(project, "config", "core.hooksPath", hooks);
      state.workspaceRoot = project;
      state.trackedFolders = tracked(lib);

      const created = yield* create("feature").pipe(Effect.exit);

      assert.isTrue(Exit.isSuccess(created), String(Exit.isFailure(created) && created.cause));
      assert.deepStrictEqual(yield* fileSystem.readDirectory(target), []);
    }),
  ),
);

it.live("treats a project folder inside a larger repository as plain", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, repository, worktreeCount } = yield* fixture;
      const big = yield* repository("big");
      const pkg = path.join(big, "pkg");
      const tool = yield* repository("big/pkg/tool");
      yield* fileSystem.writeFileString(path.join(pkg, "notes.md"), "notes\n");
      state.workspaceRoot = pkg;
      state.trackedFolders = tracked(tool);

      const { taskFolder } = yield* create("feature");

      assert.isFalse(taskFolder.projectIsWorktree);
      assert.equal(taskFolder.projectPath, taskFolder.root);
      assert.isFalse(yield* fileSystem.exists(path.join(taskFolder.root, ".git")));
      assert.equal(
        yield* fileSystem.readLink(path.join(taskFolder.root, "notes.md")),
        path.join(pkg, "notes.md"),
      );
      // The parent repository is never checked out.
      assert.equal(yield* worktreeCount(big), 1);
      assert.equal(yield* worktreeCount(tool), 2);
    }),
  ),
);

it.live("adopts the checkouts a project's own layout command makes, and runs its teardown", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, run, repository, worktreeCount } = yield* fixture;
      const shop = path.join(tmp, "shop");
      const api = yield* repository("shop/api");
      const web = yield* repository("shop/web");
      // The project checks `api` out itself, copies its build cache and leaves `web` out.
      yield* fileSystem.writeFileString(
        path.join(shop, "t3.json"),
        JSON.stringify({
          worktreeLayout: {
            // A plain project's folder is no worktree, even when the command leaves a `.git` there.
            create:
              'mkdir -p "$T3_WORKTREE_PROJECT_PATH/cache" && git init -q "$T3_WORKTREE_PROJECT_PATH" && printf %s "$T3_WORKTREE_REPOSITORIES" > "$T3_WORKTREE_PROJECT_PATH/chosen" && git -C "$T3_PROJECT_ROOT/api" worktree add -q -b "$T3_WORKTREE_BRANCH" "$T3_WORKTREE_PROJECT_PATH/api" "$T3_WORKTREE_BASE"',
            // Cleanup never deletes files that exist only here, so the teardown clears its own.
            remove:
              'touch "$T3_PROJECT_ROOT/torn-down" && rm -rf "$T3_WORKTREE_PROJECT_PATH/cache" "$T3_WORKTREE_PROJECT_PATH/chosen" "$T3_WORKTREE_PROJECT_PATH/.git"',
          },
        }),
      );
      state.workspaceRoot = shop;
      state.trackedFolders = tracked(api, web);

      const { taskFolder } = yield* create("feature", undefined, "main");

      assert.isFalse(taskFolder.projectIsWorktree);
      assert.deepEqual(taskFolder.repositories, [
        { repositoryPath: api, worktreePath: path.join(taskFolder.root, "api"), name: "api" },
      ]);
      assert.isTrue(yield* fileSystem.exists(path.join(taskFolder.root, "cache")));
      assert.equal(
        yield* fileSystem.readFileString(path.join(taskFolder.root, "chosen")),
        `${api}\n${web}`,
      );
      assert.equal(
        yield* run(path.join(taskFolder.root, "api"), "symbolic-ref", "--short", "HEAD"),
        "feature",
      );
      assert.equal(yield* worktreeCount(web), 1);

      // Storage cleanup inspects each checkout; the teardown runs once all of them may go.
      yield* (yield* TaskFolders.TaskFolders).remove({
        root: taskFolder.root,
        force: true,
        forget: true,
        inspect: () => Effect.succeed({ keep: null, force: true }),
      });
      assert.isTrue(yield* fileSystem.exists(path.join(shop, "torn-down")));
      // What the teardown left is removed as usual.
      assert.equal(yield* worktreeCount(api), 1);
      assert.isFalse(yield* fileSystem.exists(taskFolder.root));
    }),
  ),
);

it.live(
  "removes what a failed layout command checked out, and refuses a checkout it cannot own",
  () =>
    withState((state) =>
      Effect.gen(function* () {
        const { fileSystem, path, tmp, run, repository, worktreeCount } = yield* fixture;
        const shop = path.join(tmp, "shop");
        const api = yield* repository("shop/api");
        // Not chosen, so the thread's branch name is not moved past the `feature` it has.
        const web = yield* repository("shop/web");
        yield* run(web, "branch", "feature");
        state.workspaceRoot = shop;
        const taskFolders = yield* TaskFolders.TaskFolders;
        const attempt = Effect.fnUntraced(function* (command: string) {
          yield* fileSystem.writeFileString(
            path.join(shop, "t3.json"),
            JSON.stringify({ worktreeLayout: { create: command } }),
          );
          const plan = yield* taskFolders.plan({ projectId, repositories: [{ path: api }] });
          return yield* taskFolders
            .create({
              plan: plan!,
              branch: "feature",
              projectStart: { refName: "main", baseRefName: "main" },
              startFromOrigin: false,
            })
            .pipe(Effect.flip);
        });

        yield* attempt(
          'mkdir -p "$T3_WORKTREE_PROJECT_PATH" && git -C "$T3_PROJECT_ROOT/api" worktree add -q -b "$T3_WORKTREE_BRANCH" "$T3_WORKTREE_PROJECT_PATH/api" && exit 1',
        );
        assert.equal(yield* worktreeCount(api), 1);

        // A clone has no worktree registration to remove, and no thread branch to rename.
        const refused = yield* attempt(
          'mkdir -p "$T3_WORKTREE_PROJECT_PATH" && git clone -q "$T3_PROJECT_ROOT/api" "$T3_WORKTREE_PROJECT_PATH/api"',
        );
        assert.include(refused.detail, "is not a Git worktree of");

        // The refused checkout's folder is deleted, so its registration must go too.
        const wrongBranch = yield* attempt(
          'mkdir -p "$T3_WORKTREE_PROJECT_PATH" && git -C "$T3_PROJECT_ROOT/api" worktree add -q -b other "$T3_WORKTREE_PROJECT_PATH/api"',
        );
        assert.include(wrongBranch.detail, "is not on the branch feature");
        assert.equal(yield* worktreeCount(api), 1);

        // A branch that was there before the command checked it out outlives the rollback.
        yield* attempt(
          'mkdir -p "$T3_WORKTREE_PROJECT_PATH" && git -C "$T3_PROJECT_ROOT/web" worktree add -q "$T3_WORKTREE_PROJECT_PATH/web" "$T3_WORKTREE_BRANCH" && exit 1',
        );
        assert.equal(yield* worktreeCount(web), 1);
        assert.deepEqual((yield* run(web, "branch", "--format=%(refname:short)")).split("\n"), [
          "feature",
          "main",
        ]);
      }),
    ),
);

// A project that is itself a linked worktree registers its worktrees in the repository it follows.
it.live.each([{ linked: false }, { linked: true }])(
  "runs the layout command of a project that tracks no other repository, linked worktree=$linked",
  ({ linked }) =>
    withState((state) =>
      Effect.gen(function* () {
        const { fileSystem, path, tmp, run, repository, worktreeCount } = yield* fixture;
        const origin = yield* repository(linked ? "origin" : "mono");
        const mono = path.join(tmp, "mono");
        if (linked) yield* run(origin, "worktree", "add", "-q", "-b", "dev", mono);
        yield* fileSystem.writeFileString(
          path.join(mono, "t3.json"),
          JSON.stringify({
            worktreeLayout: {
              create:
                '(git worktree add -q "$T3_WORKTREE_PROJECT_PATH" "$T3_WORKTREE_BRANCH" 2>/dev/null || git worktree add -q -b "$T3_WORKTREE_BRANCH" "$T3_WORKTREE_PROJECT_PATH") && touch "$T3_WORKTREE_PROJECT_PATH/prepared"',
            },
          }),
        );
        state.workspaceRoot = mono;
        state.trackedFolders = [];

        const { taskFolder } = yield* create("feature");

        assert.isTrue(taskFolder.projectIsWorktree);
        assert.deepEqual(taskFolder.repositories, []);
        assert.equal(
          yield* run(taskFolder.projectPath, "symbolic-ref", "--short", "HEAD"),
          "feature",
        );
        const prepared = path.join(taskFolder.projectPath, "prepared");
        assert.isTrue(yield* fileSystem.exists(prepared));

        // A folder that went missing is rebuilt by the same command, not as a bare checkout.
        const taskFolders = yield* TaskFolders.TaskFolders;
        yield* fileSystem.remove(taskFolder.root, { recursive: true });
        yield* run(mono, "worktree", "prune");
        yield* taskFolders.restore({
          taskFolder,
          branch: "feature",
          recreate: () => Effect.die("the layout command rebuilds the folder"),
        });
        assert.isTrue(yield* fileSystem.exists(prepared));

        yield* taskFolders.remove({ root: taskFolder.root, force: true, forget: true });
        assert.equal(yield* worktreeCount(mono), linked ? 2 : 1);
      }),
    ),
);

it.live("starts each repository from the base branch where it has one", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { path, tmp, run, repository } = yield* fixture;
      const api = yield* repository("shop/api");
      const web = yield* repository("shop/web");
      yield* run(api, "checkout", "-b", "release");
      yield* run(api, "commit", "--allow-empty", "-m", "release work");
      yield* run(api, "checkout", "main");
      state.workspaceRoot = path.join(tmp, "shop");
      state.trackedFolders = tracked(api, web);

      const { taskFolder } = yield* create("feature", undefined, "release");

      const head = (cwd: string, ref: string) => run(cwd, "rev-parse", ref);
      assert.equal(
        yield* head(path.join(taskFolder.root, "api"), "HEAD"),
        yield* head(api, "release"),
      );
      assert.equal(
        yield* head(path.join(taskFolder.root, "web"), "HEAD"),
        yield* head(web, "main"),
      );
      // A worktree an existing thread asks for starts its repositories from the chosen base too.
      const requested = yield* (yield* TaskFolders.TaskFolders).createForProjectFolder({
        cwd: state.workspaceRoot,
        refName: "release",
        newRefName: "later",
        path: null,
      });
      assert.equal(
        yield* head(path.join(requested!.worktree.path, "api"), "HEAD"),
        yield* head(api, "release"),
      );

      // `HEAD` is what a client sends for no base: the local default branch, unpushed work and
      // all, not the remote's last-fetched one.
      yield* run(tmp, "clone", "-q", "--bare", web, "web-origin.git");
      yield* run(web, "remote", "add", "origin", path.join(tmp, "web-origin.git"));
      yield* run(web, "fetch", "-q", "origin");
      yield* run(web, "remote", "set-head", "origin", "main");
      yield* run(web, "commit", "--allow-empty", "-m", "unpushed");
      const unset = yield* create("no-base", [{ path: web }], "HEAD");
      assert.equal(
        yield* head(path.join(unset.taskFolder.root, "web"), "HEAD"),
        yield* head(web, "main"),
      );
    }),
  ),
);

it.live("gives every repository one branch name when one of them already has it", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { path, tmp, run, repository } = yield* fixture;
      const api = yield* repository("shop/api");
      const web = yield* repository("shop/web");
      yield* run(web, "branch", "feature");
      state.workspaceRoot = path.join(tmp, "shop");
      state.trackedFolders = tracked(api, web);

      const { taskFolder, branch } = yield* create("feature");

      assert.equal(branch, "feature-2");
      for (const repositoryWorktree of taskFolder.repositories) {
        assert.equal(
          yield* run(repositoryWorktree.worktreePath, "symbolic-ref", "--short", "HEAD"),
          "feature-2",
        );
      }
      assert.deepEqual((yield* run(api, "branch", "--format=%(refname:short)")).split("\n"), [
        "feature-2",
        "main",
      ]);

      const renamed = yield* (yield* TaskFolders.TaskFolders).renameBranch({
        root: taskFolder.root,
        oldBranch: "feature-2",
        // Taken in `web` only, so every checkout moves past it together.
        newBranch: "feature",
      });
      assert.equal(renamed.branch, "feature-2");
      yield* run(api, "branch", "fix-login");
      assert.deepEqual(
        yield* (yield* TaskFolders.TaskFolders).renameBranch({
          root: taskFolder.root,
          oldBranch: "feature-2",
          newBranch: "fix-login",
        }),
        { branch: "fix-login-2" },
      );
      assert.equal(
        yield* run(path.join(taskFolder.root, "web"), "symbolic-ref", "--short", "HEAD"),
        "fix-login-2",
      );
    }),
  ),
);

it.live("removes what it created when one repository fails", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, run, repository, worktreeCount } = yield* fixture;
      const api = yield* repository("shop/api");
      // Git keeps its worktrees in a folder of this name, so none can be added here.
      const broken = yield* repository("shop/broken");
      yield* fileSystem.writeFileString(path.join(broken, ".git", "worktrees"), "");
      yield* fileSystem.writeFileString(path.join(tmp, "shop", "AGENTS.md"), "rules\n");
      state.workspaceRoot = path.join(tmp, "shop");
      state.trackedFolders = tracked(api, broken);
      const config = yield* ServerConfig.ServerConfig;

      const error = yield* create("feature").pipe(Effect.flip);

      assert.include(String((error as { readonly detail?: string }).detail), "broken worktree");
      assert.equal(yield* worktreeCount(api), 1);
      assert.equal(yield* run(api, "branch", "--format=%(refname:short)"), "main");
      assert.deepEqual(yield* fileSystem.readDirectory(path.join(config.worktreesDir, "shop")), []);
      assert.deepEqual(yield* (yield* TaskFolderStore.TaskFolderStore).list, []);
      assert.isTrue(yield* fileSystem.exists(path.join(tmp, "shop", "AGENTS.md")));
    }),
  ),
);

it.live("selects every tracked repository up to eight and none beyond", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, repository } = yield* fixture;
      const taskFolders = yield* TaskFolders.TaskFolders;
      // Outside the project folder, so the stored list alone says which are tracked.
      const folders = yield* Effect.forEach(
        Array.from({ length: 9 }, (_, index) => `repos/r${index}`),
        repository,
        { concurrency: 3 },
      );
      const plain = path.join(tmp, "shop", "notes");
      yield* fileSystem.makeDirectory(plain, { recursive: true });
      state.workspaceRoot = path.join(tmp, "shop");

      state.trackedFolders = tracked(plain);
      assert.isNull(yield* taskFolders.plan({ projectId }));
      // A named choice is refused, not dropped, when the project has no repository left.
      assert.include(
        (yield* taskFolders.plan({ projectId, repositories: [{ path: plain }] }).pipe(Effect.flip))
          .detail,
        "is not a Git repository",
      );

      state.trackedFolders = tracked(...folders.slice(0, 8), plain);
      assert.lengthOf((yield* taskFolders.plan({ projectId }))!.repositories, 8);

      state.trackedFolders = tracked(...folders, plain);
      assert.lengthOf((yield* taskFolders.plan({ projectId }))!.repositories, 0);
      const chosen = yield* taskFolders.plan({
        projectId,
        repositories: [{ path: folders[8]! }, { path: `${folders[8]!}${path.sep}` }],
      });
      assert.deepEqual(chosen?.repositories, [{ name: "r8", path: folders[8]! }]);
      assert.isFalse(chosen?.projectIsRepository);

      for (const [requested, detail] of [
        [path.join(tmp, "shop", "untracked"), "is not a tracked folder"],
        [plain, "is not a Git repository"],
      ] as const) {
        const error = yield* taskFolders
          .plan({ projectId, repositories: [{ path: requested }] })
          .pipe(Effect.flip);
        assert.include(error.detail, detail);
      }
    }),
  ),
);

it.live("adds a repository to an existing task folder on the thread's branch", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, run, repository, isLink } = yield* fixture;
      const taskFolders = yield* TaskFolders.TaskFolders;
      const shop = path.join(tmp, "shop");
      const api = yield* repository("shop/api");
      const web = yield* repository("shop/web");
      yield* fileSystem.makeDirectory(path.join(shop, "tools"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(shop, "taken"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(shop, "unborn"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(shop, "tools", "run.sh"), "#!/bin/sh\n");
      state.workspaceRoot = shop;
      const { taskFolder } = yield* create("feature", [{ path: api }]);
      const root = taskFolder.root;
      assert.isTrue(yield* isLink(path.join(root, "tools")));
      state.thread = { worktreePath: root, branch: "feature" };
      // `late` and `taken` become repositories only after the task folder exists.
      const late = yield* repository("shop/tools/late");
      const taken = yield* repository("shop/taken");

      const withWeb = yield* taskFolders.addRepository({ threadId, repositoryPath: web });
      assert.deepEqual(
        withWeb.repositories.map((entry) => entry.worktreePath),
        [path.join(root, "api"), path.join(root, "web")],
      );
      assert.equal(
        yield* run(path.join(root, "web"), "symbolic-ref", "--short", "HEAD"),
        "feature",
      );

      // The thread's record can lag a rename of its branch; the checkouts say which one it is.
      state.thread = { worktreePath: root, branch: "name-before-the-rename" };
      // The link that stood for `tools` becomes a folder: the worktree, and links to the rest.
      yield* taskFolders.addRepository({ threadId, repositoryPath: late });
      assert.isFalse(yield* isLink(path.join(root, "tools")));
      assert.equal(
        yield* fileSystem.readLink(path.join(root, "tools", "run.sh")),
        path.join(shop, "tools", "run.sh"),
      );
      assert.equal(
        yield* run(path.join(root, "tools", "late"), "symbolic-ref", "--short", "HEAD"),
        "feature",
      );
      assert.equal(yield* run(late, "symbolic-ref", "--short", "HEAD"), "main");

      // The link to the original checkout is one this service made; a folder with files is not.
      yield* fileSystem.remove(path.join(root, "taken"));
      yield* fileSystem.makeDirectory(path.join(root, "taken"));
      yield* fileSystem.writeFileString(path.join(root, "taken", "draft.md"), "mine\n");
      for (const [repositoryPath, detail] of [
        [taken, "already holds files"],
        [web, "already has a worktree"],
        [path.join(shop, "nowhere"), "is not a tracked folder"],
      ] as const) {
        const error = yield* taskFolders
          .addRepository({ threadId, repositoryPath })
          .pipe(Effect.flip);
        assert.include(error.detail, detail);
      }
      assert.lengthOf((yield* taskFolders.find(root))!.repositories, 3);

      // A repository with no commit gets no worktree, and the link it stood behind comes back.
      const unborn = path.join(shop, "unborn");
      yield* run(unborn, "init", "-b", "main");
      yield* taskFolders.addRepository({ threadId, repositoryPath: unborn }).pipe(Effect.flip);
      assert.equal(yield* fileSystem.readLink(path.join(root, "unborn")), unborn);

      // A copy of a checkout Git registered elsewhere is not the thread's worktree: it is not
      // restored over, nor resumed in.
      const webWorktree = path.join(root, "web");
      const moved = path.join(tmp, "web-moved");
      yield* run(web, "worktree", "move", webWorktree, moved);
      yield* fileSystem.copy(moved, webWorktree);
      const refused = yield* taskFolders
        .restore({
          taskFolder: (yield* taskFolders.find(root))!,
          branch: "feature",
          recreate: () => Effect.die("an existing checkout is never recreated"),
        })
        .pipe(Effect.flip);
      assert.include(refused.detail, "is not a worktree of");
    }),
  ),
);

it.live("keeps a repository git will not remove and removes the rest", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, repository, worktreeCount } = yield* fixture;
      const taskFolders = yield* TaskFolders.TaskFolders;
      const shop = path.join(tmp, "shop");
      const api = yield* repository("shop/api");
      const web = yield* repository("shop/web");
      yield* fileSystem.writeFileString(path.join(shop, "AGENTS.md"), "rules\n");
      state.workspaceRoot = shop;
      state.trackedFolders = tracked(api, web);
      const { taskFolder } = yield* create("feature");
      const root = taskFolder.root;
      yield* fileSystem.writeFileString(path.join(root, "api", "README.md"), "uncommitted\n");

      const first = yield* taskFolders.remove({ root, force: false, forget: true });

      assert.deepEqual(first.removed, [path.join(root, "web")]);
      assert.deepEqual(
        first.kept.map((entry) => entry.path),
        [path.join(root, "api")],
      );
      assert.equal(
        yield* fileSystem.readFileString(path.join(root, "api", "README.md")),
        "uncommitted\n",
      );
      assert.equal(yield* worktreeCount(web), 1);
      // The folder stays, so the files it shares with the project stay reachable in it.
      assert.equal(
        yield* fileSystem.readLink(path.join(root, "AGENTS.md")),
        path.join(shop, "AGENTS.md"),
      );
      // The record now lists only what is still on disk.
      assert.deepEqual(
        (yield* taskFolders.find(root))?.repositories.map((entry) => entry.repositoryPath),
        [api],
      );

      const second = yield* taskFolders.remove({ root, force: true, forget: true });

      assert.deepEqual(second.kept, []);
      assert.isFalse(yield* fileSystem.exists(root));
      assert.isNull(yield* taskFolders.find(root));
      assert.equal(yield* worktreeCount(api), 1);
      // Links went; what they pointed at did not.
      assert.equal(yield* fileSystem.readFileString(path.join(shop, "AGENTS.md")), "rules\n");
    }),
  ),
);

it.live("restores a recorded repository the project stopped tracking as its worktree", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, run, repository, isLink } = yield* fixture;
      const shop = path.join(tmp, "shop");
      const api = yield* repository("shop/api");
      const web = yield* repository("shop/web");
      state.workspaceRoot = shop;
      const { taskFolder } = yield* create("feature");
      const root = taskFolder.root;

      yield* fileSystem.remove(root, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(shop, "t3.json"),
        JSON.stringify({ ignoreRepositories: ["web"] }),
      );
      yield* (yield* TaskFolders.TaskFolders).restore({
        taskFolder,
        branch: "feature",
        recreate: ({ repositoryPath, worktreePath }) =>
          run(repositoryPath, "worktree", "prune").pipe(
            Effect.andThen(run(repositoryPath, "worktree", "add", "-q", worktreePath, "feature")),
          ),
      });

      // A link there would be the original checkout, on its own branch.
      for (const repositoryPath of [api, web]) {
        const worktree = path.join(root, path.basename(repositoryPath));
        assert.isFalse(yield* isLink(worktree));
        assert.equal(yield* run(worktree, "symbolic-ref", "--short", "HEAD"), "feature");
      }
      assert.isTrue(yield* isLink(path.join(root, "t3.json")));
    }),
  ),
);

it.live("resumes once an excluded dependency's worktree is replaced by a clone", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, run, repository } = yield* fixture;
      const project = yield* repository("phoenix");
      const dependency = yield* repository("phoenix/deps/heroicons");
      state.workspaceRoot = project;
      const { taskFolder } = yield* create("feature");
      const clone = path.join(taskFolder.projectPath, "deps", "heroicons");
      yield* fileSystem.remove(clone, { recursive: true });
      yield* run(taskFolder.projectPath, "clone", "-q", "--local", dependency, clone);
      yield* fileSystem.writeFileString(
        path.join(project, "t3.json"),
        JSON.stringify({ ignoreRepositories: ["deps"] }),
      );
      const taskFolders = yield* TaskFolders.TaskFolders;
      const restore = taskFolders.restore({
        taskFolder,
        branch: "feature",
        recreate: () => Effect.die("nothing is missing"),
      });

      // Tracked by hand, the clone is still not the thread's worktree.
      state.trackedFolders = tracked(dependency);
      assert.include((yield* Effect.flip(restore)).detail, "is not a worktree of");

      state.trackedFolders = [];
      yield* restore;
      assert.equal(yield* run(clone, "rev-parse", "--git-dir"), ".git");
      assert.deepEqual((yield* taskFolders.find(taskFolder.root))?.repositories, []);
    }),
  ),
);
