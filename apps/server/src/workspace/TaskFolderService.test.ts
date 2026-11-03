import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type GitPreparePullRequestThreadResult,
  type OrchestrationProjectShell,
  type Project,
  ProjectId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as TaskFolders from "./TaskFolders.ts";
import * as TaskFolderService from "./TaskFolderService.ts";
import { WorkspaceRepositories, type ThreadRepository } from "./WorkspaceRepositories.ts";

const projectId = ProjectId.make("project:task-folders");

interface Fixture {
  readonly base: string;
  readonly home: string;
  readonly tracked: ReadonlyArray<{ readonly name: string; readonly path: string }>;
}

// Resolves a project like the real service: home plus tracked Git folders, or task folder rows.
const layerWorkspaces = (fixture: () => Fixture) =>
  Layer.effect(
    WorkspaceRepositories,
    Effect.gen(function* () {
      const store = yield* TaskFolders.TaskFolderStore;
      return WorkspaceRepositories.of({
        resolveThreadWorkspace: ({ worktreePath }) =>
          Effect.gen(function* () {
            const { home, tracked } = fixture();
            const record =
              worktreePath === null
                ? Option.none()
                : yield* store.findContaining(worktreePath).pipe(Effect.orDie);
            const repositories: ReadonlyArray<ThreadRepository> = Option.isSome(record)
              ? record.value.repositories.map((row) => ({
                  name: row.name,
                  cwd: row.worktreePath,
                  originalPath: row.originalPath,
                  relativePath: row.relativePath,
                  kind: row.kind,
                }))
              : [
                  { name: "web", cwd: home, originalPath: home, relativePath: "", kind: "home" },
                  ...tracked.map((folder) => ({
                    name: folder.name,
                    cwd: folder.path,
                    originalPath: folder.path,
                    relativePath: folder.path,
                    kind: "repository" as const,
                  })),
                ];
            return {
              cwd: worktreePath ?? home,
              repositories,
              references: [],
              taskFolder: Option.getOrNull(record),
            };
          }),
        listForClient: () => Effect.die("unused"),
        scanFolders: () => Effect.die("unused"),
        previewHomeGitInit: () => Effect.die("unused"),
        initializeHomeGit: () => Effect.die("unused"),
      });
    }),
  );

const layerGitManager = Layer.effect(
  GitManager.GitManager,
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const service: Pick<
      GitManager.GitManager["Service"],
      | "createWorktree"
      | "invalidateLocalStatus"
      | "invalidateRemoteStatus"
      | "invalidateStatus"
      | "preparePullRequestThread"
    > = {
      createWorktree: (input, options) => driver.createWorktree(input, options),
      invalidateLocalStatus: () => Effect.void,
      invalidateRemoteStatus: () => Effect.void,
      invalidateStatus: () => Effect.void,
      // Materializes the PR head as `pr-7`, then hands checkout to the caller like GitManager.
      preparePullRequestThread: (input, options) =>
        Effect.gen(function* () {
          yield* driver.execute({
            operation: "TaskFolderService.test.materializePullRequest",
            cwd: input.cwd,
            args: ["branch", "pr-7", "pr-head"],
          });
          const checkout = yield* options!.checkout!("pr-7");
          return {
            pullRequest: { number: 7 } as GitPreparePullRequestThreadResult["pullRequest"],
            branch: checkout.branch,
            worktreePath: checkout.worktreePath,
            isOnPullRequestHead: true,
          };
        }),
    };
    return service as GitManager.GitManager["Service"];
  }),
);

const makeLayer = (fixture: () => Fixture, baseDir: string) =>
  TaskFolderService.layer.pipe(
    Layer.provideMerge(layerWorkspaces(fixture)),
    Layer.provideMerge(TaskFolders.layer),
    Layer.provide(
      GitWorkflowService.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
        Layer.provide(layerGitManager),
      ),
    ),
    Layer.provide(
      // The service reads only a project's id, folder, and tracked folders.
      Layer.mock(ProjectService.ProjectService)({
        getByWorkspaceRoot: (root) =>
          Effect.sync(() =>
            root === fixture().home
              ? Option.some(project(fixture()) as unknown as Project)
              : Option.none(),
          ),
        listShells: () =>
          Effect.sync(() => [
            {
              id: projectId,
              trackedFolders: fixture().tracked,
            } as unknown as OrchestrationProjectShell,
          ]),
        getById: () => Effect.sync(() => Option.some(project(fixture()) as unknown as Project)),
      }),
    ),
    Layer.provideMerge(GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

const git = Effect.fn(function* (cwd: string, args: ReadonlyArray<string>) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  return yield* driver.execute({
    operation: "TaskFolderService.test",
    cwd,
    args: ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
  });
});

const out = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).pipe(Effect.map((result) => result.stdout.trim()));

const initRepo = Effect.fn(function* (
  cwd: string,
  branch: string,
  ignore: ReadonlyArray<string> = [],
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cwd, { recursive: true });
  yield* git(cwd, ["init", "-q", "-b", branch]);
  yield* fs.writeFileString(`${cwd}/README.md`, `${cwd}\n`);
  if (ignore.length > 0) yield* fs.writeFileString(`${cwd}/.gitignore`, `${ignore.join("\n")}\n`);
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-q", "-m", "init"]);
});

/** Runs `body` against a fresh temp folder, with the service reading the fixture it sets. */
const withFolders = <A, E>(
  body: (input: {
    readonly base: string;
    readonly setFixture: (fixture: Fixture) => void;
  }) => Effect.Effect<
    A,
    E,
    | TaskFolderService.TaskFolderService
    | TaskFolders.TaskFolderStore
    | GitVcsDriver.GitVcsDriver
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-task-folders-" }),
    );
    let fixture: Fixture | undefined;
    return yield* body({
      base,
      setFixture: (next) => {
        fixture = next;
      },
    }).pipe(Effect.provide(makeLayer(() => fixture!, base)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const project = (fixture: Fixture) => ({
  id: projectId,
  workspaceRoot: fixture.home,
  trackedFolders: fixture.tracked,
});

const childFixture = Effect.fn(function* (base: string) {
  const home = `${base}/code/web`;
  yield* initRepo(home, "main", ["/app/", "/packages/lib/"]);
  yield* initRepo(`${home}/app`, "main");
  yield* initRepo(`${home}/packages/lib`, "trunk");
  return {
    base,
    home,
    tracked: [
      { name: "app", path: `${home}/app` },
      { name: "lib", path: `${home}/packages/lib` },
    ],
  } satisfies Fixture;
});

it.live("creates child repos inside the home worktree on one task branch", () =>
  withFolders(({ base, setFixture }) =>
    Effect.gen(function* () {
      const fixture = yield* childFixture(base);
      setFixture(fixture);
      const service = yield* TaskFolderService.TaskFolderService;
      const config = yield* ServerConfig.ServerConfig;
      const plan = yield* service.plan({ project: project(fixture) });
      assert.isNotNull(plan);
      const created = yield* service.create({
        plan: plan!,
        branch: "t3/abc12345",
        baseRef: "main",
        startFromOrigin: false,
      });
      assert.deepEqual(created.failed, []);
      const homeWorktree = `${config.worktreesDir}/web/t3-abc12345`;
      assert.equal(created.record.root, homeWorktree);
      assert.equal(created.record.homeWorktreePath, homeWorktree);
      assert.deepEqual(created.record.repositories[0]?.kind, "home");
      assert.deepEqual(
        created.record.repositories.map((row) => [row.relativePath, row.branch]).toSorted(),
        [
          ["", "t3/abc12345"],
          ["app", "t3/abc12345"],
          ["packages/lib", "t3/abc12345"],
        ],
      );
      // Each repo starts from its own default branch.
      assert.equal(
        yield* out(`${homeWorktree}/packages/lib`, ["rev-parse", "HEAD"]),
        yield* out(`${fixture.home}/packages/lib`, ["rev-parse", "trunk"]),
      );
      assert.equal(yield* out(`${homeWorktree}/app`, ["branch", "--show-current"]), "t3/abc12345");
      // Home ignores its nested repos.
      assert.equal(yield* out(homeWorktree, ["status", "--porcelain"]), "");
      const stored = yield* (yield* TaskFolders.TaskFolderStore).findContaining(
        `${homeWorktree}/app`,
      );
      assert.equal(Option.getOrThrow(stored).repositories.length, 3);
    }),
  ),
);

it.live("mirrors a sibling layout so ../ paths keep working", () =>
  withFolders(({ base, setFixture }) =>
    Effect.gen(function* () {
      const home = `${base}/code/web`;
      yield* initRepo(home, "main");
      yield* initRepo(`${base}/code/api`, "main");
      const fixture: Fixture = { base, home, tracked: [{ name: "api", path: `${base}/code/api` }] };
      setFixture(fixture);
      const service = yield* TaskFolderService.TaskFolderService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const plan = yield* service.plan({ project: project(fixture) });
      const created = yield* service.create({
        plan: plan!,
        branch: "feature/sibling",
        baseRef: "main",
        startFromOrigin: false,
      });
      const root = `${config.worktreesDir}/web/feature-sibling`;
      assert.equal(created.record.root, root);
      assert.equal(created.record.homeWorktreePath, `${root}/web`);
      assert.equal(created.record.repositories[1]?.relativePath, "../api");
      assert.isTrue(yield* fs.exists(`${root}/web/../api/README.md`));
    }),
  ),
);

it.live("names unrelated repos by folder when their only common folder is the user home", () =>
  withFolders(({ base, setFixture }) =>
    Effect.gen(function* () {
      const home = `${base}/code/web`;
      yield* initRepo(home, "main");
      yield* initRepo(`${base}/elsewhere/web`, "main");
      const fixture: Fixture = {
        base,
        home,
        tracked: [{ name: "other web", path: `${base}/elsewhere/web` }],
      };
      setFixture(fixture);
      const service = yield* TaskFolderService.TaskFolderService;
      const plan = yield* service.plan({ project: project(fixture) });
      const created = yield* service
        .create({ plan: plan!, branch: "task", baseRef: "main", startFromOrigin: false })
        .pipe(Effect.provideService(HostProcess.HomeDirectory, base));
      assert.deepEqual(
        created.record.repositories.map((row) =>
          row.worktreePath.slice(created.record.root.length),
        ),
        ["/web", "/web-2"],
      );
    }),
  ),
);

it.live("uses a per-repo base and renames the branch for every repo when any repo has it", () =>
  withFolders(({ base, setFixture }) =>
    Effect.gen(function* () {
      const fixture = yield* childFixture(base);
      setFixture(fixture);
      yield* git(`${fixture.home}/app`, ["branch", "release"]);
      yield* git(`${fixture.home}/app`, ["commit", "-q", "--allow-empty", "-m", "after release"]);
      yield* git(`${fixture.home}/packages/lib`, ["branch", "task"]);
      const service = yield* TaskFolderService.TaskFolderService;
      const plan = yield* service.plan({
        project: project(fixture),
        repositories: [
          { path: `${fixture.home}/app`, baseRef: "release" },
          { path: `${fixture.home}/packages/lib` },
        ],
      });
      const created = yield* service.create({
        plan: plan!,
        branch: "task",
        baseRef: "main",
        startFromOrigin: false,
      });
      assert.deepEqual(
        created.record.repositories.map((row) => row.branch),
        ["task-1", "task-1", "task-1"],
      );
      assert.equal(created.record.homeWorktreePath.endsWith("/web/task-1"), true);
      const app = created.record.repositories.find((row) => row.name === "app")!;
      assert.equal(
        yield* out(app.worktreePath, ["rev-parse", "HEAD"]),
        yield* out(`${fixture.home}/app`, ["rev-parse", "release"]),
      );
    }),
  ),
);

it.live("keeps the made worktrees when one repo fails and completes it on retry", () =>
  withFolders(({ base, setFixture }) =>
    Effect.gen(function* () {
      const fixture = yield* childFixture(base);
      setFixture(fixture);
      const service = yield* TaskFolderService.TaskFolderService;
      const fs = yield* FileSystem.FileSystem;
      const plan = yield* service.plan({
        project: project(fixture),
        repositories: [
          { path: `${fixture.home}/app`, baseRef: "missing-base" },
          { path: `${fixture.home}/packages/lib` },
        ],
      });
      const created = yield* service.create({
        plan: plan!,
        branch: "task",
        baseRef: "main",
        startFromOrigin: false,
      });
      assert.deepEqual(
        created.failed.map((failure) => failure.name),
        ["app"],
      );
      assert.deepEqual(
        created.record.repositories.map((row) => row.name),
        ["web", "lib"],
      );
      const homeWorktreePath = created.record.homeWorktreePath;
      assert.isTrue(yield* fs.exists(`${homeWorktreePath}/packages/lib/README.md`));

      const skipped = yield* service.complete({
        plan: plan!,
        homeWorktreePath,
        startFromOrigin: false,
        skipRepositoryPaths: [`${fixture.home}/app`],
      });
      assert.deepEqual(Option.getOrThrow(skipped).failed, []);
      assert.equal(Option.getOrThrow(skipped).record.repositories.length, 2);

      yield* git(`${fixture.home}/app`, ["branch", "missing-base"]);
      const retried = yield* service.complete({
        plan: plan!,
        homeWorktreePath,
        startFromOrigin: false,
      });
      assert.deepEqual(
        Option.getOrThrow(retried).record.repositories.map((row) => [row.name, row.branch]),
        [
          ["web", "task"],
          ["lib", "task"],
          ["app", "task"],
        ],
      );
    }),
  ),
);

it.live("renames the task branch in every repo still on it", () =>
  withFolders(({ base, setFixture }) =>
    Effect.gen(function* () {
      const fixture = yield* childFixture(base);
      setFixture(fixture);
      const service = yield* TaskFolderService.TaskFolderService;
      const store = yield* TaskFolders.TaskFolderStore;
      const plan = yield* service.plan({ project: project(fixture) });
      const created = yield* service.create({
        plan: plan!,
        branch: "t3/abc12345",
        baseRef: "main",
        startFromOrigin: false,
      });
      const lib = created.record.repositories.find((row) => row.name === "lib")!;
      // A Git action moved this repo to its own branch.
      yield* git(lib.worktreePath, ["switch", "-q", "-c", "lib-only"]);
      yield* store.upsert({
        ...created.record,
        repositories: created.record.repositories.map((row) =>
          row === lib ? { ...row, branch: "lib-only" } : row,
        ),
      });
      // The name is taken in app only, so every renamed repo gets the next free name.
      yield* git(`${fixture.home}/app`, ["branch", "fix-login"]);
      const renamed = yield* service.renameBranch({
        worktreePath: created.record.homeWorktreePath,
        oldBranch: "t3/abc12345",
        newBranch: "fix-login",
      });
      assert.equal(Option.getOrThrow(renamed).branch, "fix-login-1");
      const record = Option.getOrThrow(yield* store.get(created.record.root));
      assert.deepEqual(record.repositories.map((row) => [row.name, row.branch]).toSorted(), [
        ["app", "fix-login-1"],
        ["lib", "lib-only"],
        ["web", "fix-login-1"],
      ]);
      assert.equal(
        yield* out(created.record.homeWorktreePath, ["branch", "--show-current"]),
        "fix-login-1",
      );
    }),
  ),
);

it.live("removes clean children before home and keeps a dirty child with its folder", () =>
  withFolders(({ base, setFixture }) =>
    Effect.gen(function* () {
      const fixture = yield* childFixture(base);
      setFixture(fixture);
      const service = yield* TaskFolderService.TaskFolderService;
      const store = yield* TaskFolders.TaskFolderStore;
      const fs = yield* FileSystem.FileSystem;
      const plan = yield* service.plan({ project: project(fixture) });
      const created = yield* service.create({
        plan: plan!,
        branch: "task",
        baseRef: "main",
        startFromOrigin: false,
      });
      const home = created.record.homeWorktreePath;
      yield* fs.writeFileString(`${home}/app/work.txt`, "unsaved\n");

      const kept = Option.getOrThrow(yield* service.remove({ path: home, force: true }));
      assert.isFalse(kept.removed);
      assert.deepEqual(kept.repositories.map((entry) => [entry.name, entry.outcome]).toSorted(), [
        ["app", "kept"],
        ["lib", "removed"],
      ]);
      assert.isTrue(yield* fs.exists(`${home}/app/work.txt`));
      assert.isFalse(yield* fs.exists(`${home}/packages/lib`));
      assert.deepEqual(
        Option.getOrThrow(yield* store.get(created.record.root)).repositories.map(
          (row) => row.name,
        ),
        ["web", "app"],
      );

      yield* fs.remove(`${home}/app/work.txt`);
      const removed = Option.getOrThrow(yield* service.remove({ path: home, force: true }));
      assert.isTrue(removed.removed);
      assert.isFalse(yield* fs.exists(home));
      assert.isTrue(Option.isNone(yield* store.get(created.record.root)));
      // Not a task folder: callers remove it the single-repo way.
      assert.isTrue(Option.isNone(yield* service.remove({ path: `${base}/other` })));
    }),
  ),
);

it.live("keeps a repo that holds a nested repo with changes", () =>
  withFolders(({ base, setFixture }) =>
    Effect.gen(function* () {
      const home = `${base}/code/web`;
      yield* initRepo(home, "main", ["/app/"]);
      yield* initRepo(`${home}/app`, "main", ["/plugin/"]);
      yield* initRepo(`${home}/app/plugin`, "main");
      const fixture: Fixture = {
        base,
        home,
        tracked: [
          { name: "app", path: `${home}/app` },
          { name: "plugin", path: `${home}/app/plugin` },
        ],
      };
      setFixture(fixture);
      const service = yield* TaskFolderService.TaskFolderService;
      const fs = yield* FileSystem.FileSystem;
      const plan = yield* service.plan({ project: project(fixture) });
      const created = yield* service.create({
        plan: plan!,
        branch: "task",
        baseRef: "main",
        startFromOrigin: false,
      });
      const worktree = created.record.homeWorktreePath;
      yield* fs.writeFileString(`${worktree}/app/plugin/work.txt`, "unsaved\n");

      // Removing app's worktree would delete plugin's, which has changes.
      const removal = Option.getOrThrow(yield* service.remove({ path: worktree, force: true }));
      assert.isFalse(removal.removed);
      assert.deepEqual(
        removal.repositories.map((entry) => [entry.name, entry.outcome]).toSorted(),
        [
          ["app", "kept"],
          ["plugin", "kept"],
        ],
      );
      const direct = Option.getOrThrow(yield* service.remove({ path: `${worktree}/app` }));
      assert.deepEqual(
        direct.repositories.map((entry) => entry.outcome),
        ["kept", "kept"],
      );
      assert.isTrue(yield* fs.exists(`${worktree}/app/plugin/work.txt`));
    }),
  ),
);

it.live("retries a sibling repo inside the recorded folder after the branch was renamed", () =>
  withFolders(({ base, setFixture }) =>
    Effect.gen(function* () {
      const home = `${base}/code/web`;
      yield* initRepo(home, "main");
      yield* initRepo(`${base}/code/api`, "main");
      const fixture: Fixture = { base, home, tracked: [{ name: "api", path: `${base}/code/api` }] };
      setFixture(fixture);
      const service = yield* TaskFolderService.TaskFolderService;
      const fs = yield* FileSystem.FileSystem;
      const plan = yield* service.plan({
        project: project(fixture),
        repositories: [{ path: `${base}/code/api`, baseRef: "missing-base" }],
      });
      const created = yield* service.create({
        plan: plan!,
        branch: "t3/abc12345",
        baseRef: "main",
        startFromOrigin: false,
      });
      assert.deepEqual(
        created.failed.map((failure) => failure.name),
        ["api"],
      );
      yield* service.renameBranch({
        worktreePath: created.record.homeWorktreePath,
        oldBranch: "t3/abc12345",
        newBranch: "fix-login",
      });

      yield* git(`${base}/code/api`, ["branch", "missing-base"]);
      const retried = Option.getOrThrow(
        yield* service.complete({
          plan: plan!,
          homeWorktreePath: created.record.homeWorktreePath,
          startFromOrigin: false,
        }),
      );
      const api = retried.record.repositories.find((row) => row.name === "api");
      assert.equal(api?.worktreePath, `${created.record.root}/api`);
      assert.equal(api?.branch, "fix-login");
      assert.isTrue(yield* fs.exists(`${created.record.homeWorktreePath}/../api/README.md`));
    }),
  ),
);

it.live("recreates a removed folder home first, then its repos", () =>
  withFolders(({ base, setFixture }) =>
    Effect.gen(function* () {
      const fixture = yield* childFixture(base);
      setFixture(fixture);
      const service = yield* TaskFolderService.TaskFolderService;
      const fs = yield* FileSystem.FileSystem;
      const plan = yield* service.plan({ project: project(fixture) });
      const created = yield* service.create({
        plan: plan!,
        branch: "task",
        baseRef: "main",
        startFromOrigin: false,
      });
      const home = created.record.homeWorktreePath;
      yield* fs.remove(home, { recursive: true });
      assert.isTrue(yield* service.repair(home));
      assert.equal(yield* out(`${home}/app`, ["branch", "--show-current"]), "task");
      assert.equal(yield* out(`${home}/packages/lib`, ["branch", "--show-current"]), "task");
      assert.isFalse(yield* service.repair(`${base}/not-a-folder`));
    }),
  ),
);

it.live("bases an isolated delegate's repos on the parent's current HEADs", () =>
  withFolders(({ base, setFixture }) =>
    Effect.gen(function* () {
      const fixture = yield* childFixture(base);
      setFixture(fixture);
      const service = yield* TaskFolderService.TaskFolderService;
      const plan = yield* service.plan({ project: project(fixture) });
      const parent = yield* service.create({
        plan: plan!,
        branch: "parent",
        baseRef: "main",
        startFromOrigin: false,
      });
      const app = parent.record.repositories.find((row) => row.name === "app")!;
      yield* git(app.worktreePath, ["commit", "-q", "--allow-empty", "-m", "parent work"]);
      const heads = yield* service.repositoryHeads({
        project: project(fixture),
        worktreePath: parent.record.homeWorktreePath,
      });
      const childPlan = yield* service.plan({ project: project(fixture), repositories: heads! });
      const child = yield* service.create({
        plan: childPlan!,
        branch: "child",
        baseRef: yield* out(parent.record.homeWorktreePath, ["rev-parse", "HEAD"]),
        startFromOrigin: false,
      });
      const childApp = child.record.repositories.find((row) => row.name === "app")!;
      assert.equal(
        yield* out(childApp.worktreePath, ["rev-parse", "HEAD"]),
        yield* out(app.worktreePath, ["rev-parse", "HEAD"]),
      );
      assert.notEqual(childApp.worktreePath, app.worktreePath);
    }),
  ),
);

it.live("returns no plan for a project without tracked folders", () =>
  withFolders(({ base, setFixture }) =>
    Effect.gen(function* () {
      const fixture: Fixture = { base, home: `${base}/solo`, tracked: [] };
      setFixture(fixture);
      const service = yield* TaskFolderService.TaskFolderService;
      assert.isNull(yield* service.plan({ project: project(fixture) }));
    }),
  ),
);

it.live("checks out a pull request in its repo and the same branch name everywhere else", () =>
  withFolders(({ base, setFixture }) =>
    Effect.gen(function* () {
      const fixture = yield* childFixture(base);
      setFixture(fixture);
      const app = `${fixture.home}/app`;
      yield* git(app, ["switch", "-q", "-c", "pr-head"]);
      yield* git(app, ["commit", "-q", "--allow-empty", "-m", "pull request work"]);
      yield* git(app, ["switch", "-q", "main"]);
      const service = yield* TaskFolderService.TaskFolderService;
      const result = yield* service.preparePullRequestThread({
        cwd: app,
        reference: "#7",
        mode: "worktree",
      });
      const record = Option.getOrThrow(yield* service.find(result.worktreePath!));
      assert.equal(result.worktreePath, record.homeWorktreePath);
      assert.equal(result.branch, "pr-7");
      const heads = yield* Effect.forEach(record.repositories, (row) =>
        out(row.worktreePath, ["rev-parse", "HEAD"]).pipe(
          Effect.map((head) => [row.name, head] as const),
        ),
      );
      assert.deepEqual(
        new Map(heads),
        new Map([
          ["web", yield* out(fixture.home, ["rev-parse", "main"])],
          ["app", yield* out(app, ["rev-parse", "pr-head"])],
          ["lib", yield* out(`${fixture.home}/packages/lib`, ["rev-parse", "trunk"])],
        ]),
      );
      assert.deepEqual(
        record.repositories.map((row) => row.branch),
        ["pr-7", "pr-7", "pr-7"],
      );
    }),
  ),
);
