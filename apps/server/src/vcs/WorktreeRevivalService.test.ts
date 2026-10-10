import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  GitCommandError,
  ProjectId,
  ThreadId,
  type Project,
  type WorktreeSubmodules,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as WorktreeLifecycle from "./WorktreeLifecycle.ts";
import * as WorktreeRevivalService from "./WorktreeRevivalService.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-worktree-revival-test-",
});
const serverConfigLiveLayer = serverConfigLayer.pipe(Layer.provide(NodeServices.layer));
const gitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(serverConfigLiveLayer),
  Layer.provideMerge(NodeServices.layer),
);

const projectId = ProjectId.make("project-worktree-revival");
const threadId = ThreadId.make("thread-worktree-revival");

const makeProject = (workspaceRoot: string): Project => ({
  id: projectId,
  title: "Revival project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [
    {
      id: "setup",
      name: "Setup",
      command: "vp i",
      icon: "configure",
      runOnWorktreeCreate: true,
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const initializeRepository = Effect.fn("WorktreeRevivalServiceTest.initializeRepository")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repositoryRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-worktree-revival-repo-",
    });

    yield* git.execute({
      operation: "WorktreeRevivalServiceTest.init",
      cwd: repositoryRoot,
      args: ["init", "-b", "main"],
    });
    yield* git.execute({
      operation: "WorktreeRevivalServiceTest.userEmail",
      cwd: repositoryRoot,
      args: ["config", "user.email", "test@example.com"],
    });
    yield* git.execute({
      operation: "WorktreeRevivalServiceTest.userName",
      cwd: repositoryRoot,
      args: ["config", "user.name", "T3 Test"],
    });
    yield* fs.writeFileString(path.join(repositoryRoot, "README.md"), "hello\n");
    yield* git.execute({
      operation: "WorktreeRevivalServiceTest.add",
      cwd: repositoryRoot,
      args: ["add", "README.md"],
    });
    yield* git.execute({
      operation: "WorktreeRevivalServiceTest.commit",
      cwd: repositoryRoot,
      args: ["commit", "-m", "initial"],
    });
    yield* git.execute({
      operation: "WorktreeRevivalServiceTest.branch",
      cwd: repositoryRoot,
      args: ["branch", "feature/revival"],
    });

    return repositoryRoot;
  },
);

const makeRevivalLayer = (
  project: Project,
  runForThread: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"],
  options: {
    readonly config?: ServerConfig.ServerConfig["Service"];
    readonly projects?: readonly Project[];
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
    readonly git?: GitVcsDriver.GitVcsDriver["Service"];
  } = {},
) =>
  WorktreeRevivalService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        options.config === undefined
          ? serverConfigLiveLayer
          : Layer.succeed(ServerConfig.ServerConfig, options.config),
        NodeServices.layer,
        options.git === undefined
          ? gitLayer
          : Layer.succeed(GitVcsDriver.GitVcsDriver, options.git),
        WorktreeLifecycle.layer,
        ServerSettings.layerTest(options.settings),
        Layer.mock(ProjectService.ProjectService)({
          getById: (requestedProjectId) =>
            Effect.succeed(
              Option.fromNullishOr(
                (options.projects ?? [project]).find(
                  (project) => project.id === requestedProjectId,
                ),
              ),
            ),
          snapshot: Effect.succeed({
            projects: options.projects ?? [project],
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        }),
        Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, { runForThread }),
      ),
    ),
  );

it.effect(
  "rejects a missing destination whose existing symlink ancestor escapes the managed root",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const repositoryRoot = yield* initializeRepository();
      const outsideRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-worktree-revival-outside-",
      });
      const symlinkPath = path.join(config.worktreesDir, "outside-link");
      const requestedPath = path.join(symlinkPath, "revived");
      const escapedPath = path.join(outsideRoot, "revived");
      yield* fs.symlink(outsideRoot, symlinkPath);

      const error = yield* Effect.gen(function* () {
        const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
        return yield* revival.reviveForThread({
          threadId,
          projectId,
          worktreePath: requestedPath,
          branch: "feature/revival",
        });
      }).pipe(
        Effect.provide(
          makeRevivalLayer(makeProject(repositoryRoot), () =>
            Effect.succeed({ status: "no-script" }),
          ),
        ),
        Effect.flip,
      );

      assert.equal(error._tag, "WorktreeMutationError");
      assert.deepInclude(error, { stage: "outside_managed_root" });
      assert.isFalse(yield* fs.exists(escapedPath));
    }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("revives worktrees whose first path segment starts with two dots", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repositoryRoot = yield* initializeRepository();
    const worktreePath = path.join(config.worktreesDir, "..cache", "revived");

    const result = yield* Effect.gen(function* () {
      const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
      return yield* revival.reviveForThread({
        threadId,
        projectId,
        worktreePath,
        branch: "feature/revival",
      });
    }).pipe(
      Effect.provide(
        makeRevivalLayer(makeProject(repositoryRoot), () =>
          Effect.succeed({ status: "no-script" }),
        ),
      ),
    );

    assert.isTrue(result.revived);
    assert.isTrue(yield* fs.exists(worktreePath));
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

const addWorktree = Effect.fn("WorktreeRevivalServiceTest.addWorktree")(function* (
  repositoryRoot: string,
  worktreePath: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  yield* git.execute({
    operation: "WorktreeRevivalServiceTest.worktreeAdd",
    cwd: repositoryRoot,
    args: ["worktree", "add", worktreePath, "feature/revival"],
  });
});

it.effect("leaves an existing worktree alone when its HEAD is detached", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repositoryRoot = yield* initializeRepository();
    const worktreePath = path.join(config.worktreesDir, "detached");
    yield* addWorktree(repositoryRoot, worktreePath);
    yield* git.execute({
      operation: "WorktreeRevivalServiceTest.detach",
      cwd: worktreePath,
      args: ["checkout", "--detach"],
    });

    const result = yield* Effect.gen(function* () {
      const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
      return yield* revival.reviveForThread({
        threadId,
        projectId,
        worktreePath,
        branch: "feature/revival",
      });
    }).pipe(
      Effect.provide(
        makeRevivalLayer(makeProject(repositoryRoot), () =>
          Effect.succeed({ status: "no-script" }),
        ),
      ),
    );

    assert.deepEqual(result, { revived: false, generation: 0 });
    const head = yield* git.execute({
      operation: "WorktreeRevivalServiceTest.symbolicRef",
      cwd: worktreePath,
      args: ["symbolic-ref", "-q", "HEAD"],
      allowNonZeroExit: true,
    });
    assert.notEqual(head.exitCode, 0, "HEAD must stay detached");
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("leaves an existing checkout outside the managed root alone", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repositoryRoot = yield* initializeRepository();
    const outsideRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-worktree-revival-outside-",
    });
    const worktreePath = path.join(outsideRoot, "checkout");
    yield* addWorktree(repositoryRoot, worktreePath);

    const result = yield* Effect.gen(function* () {
      const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
      return yield* revival.reviveForThread({
        threadId,
        projectId,
        worktreePath,
        branch: "feature/revival",
      });
    }).pipe(
      Effect.provide(
        makeRevivalLayer(makeProject(repositoryRoot), () =>
          Effect.succeed({ status: "no-script" }),
        ),
      ),
    );

    assert.deepEqual(result, { revived: false, generation: 0 });
    assert.isTrue(yield* fs.exists(path.join(worktreePath, "README.md")));
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("leaves a complete checkout when the turn start is cancelled during creation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const repositoryRoot = yield* initializeRepository();
    const worktreePath = path.join(config.worktreesDir, "interruption", "revived");
    const project = makeProject(repositoryRoot);
    const createEntered = yield* Deferred.make<void>();
    const releaseCreate = yield* Deferred.make<void>();
    let setupAttempts = 0;
    const runSetup = () =>
      Effect.sync(() => {
        setupAttempts++;
        return { status: "no-script" as const };
      });
    const layer = WorktreeRevivalService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ServerConfig.ServerConfig, config),
          NodeServices.layer,
          ServerSettings.layerTest(),
          Layer.succeed(GitVcsDriver.GitVcsDriver, {
            ...driver,
            createWorktree: (input, options) =>
              Deferred.succeed(createEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCreate)),
                Effect.andThen(driver.createWorktree(input, options)),
              ),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeed(Option.some(project)),
            snapshot: Effect.succeed({
              projects: [project],
              updatedAt: "2026-01-01T00:00:00.000Z",
            }),
          }),
          Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
            runForThread: runSetup,
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
      const lifecycle = yield* WorktreeLifecycle.WorktreeLifecycle;
      const revivalFiber = yield* revival
        .reviveForThread({ threadId, projectId, worktreePath, branch: "feature/revival" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(createEntered);
      const interruptionFiber = yield* Fiber.interrupt(revivalFiber).pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseCreate, undefined);
      yield* Fiber.join(interruptionFiber);

      assert.isTrue(yield* fs.exists(path.join(worktreePath, "README.md")));
      assert.equal(yield* lifecycle.revision, 1);
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(WorktreeLifecycle.layer))));
    assert.equal(setupAttempts, 0);
    yield* Effect.flatMap(WorktreeRevivalService.WorktreeRevivalService, (service) =>
      service.reviveForThread({ threadId, projectId, worktreePath, branch: "feature/revival" }),
    ).pipe(Effect.provide(makeRevivalLayer(project, runSetup, { config })));
    assert.equal(
      setupAttempts,
      1,
      "creation cancellation must retain pending setup across restart",
    );
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("retries setup after a recreated worktree's first setup attempt fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repositoryRoot = yield* initializeRepository();
    const worktreePath = path.join(config.worktreesDir, "setup", "failure");
    const setupFailure = new ProjectSetupScriptRunner.ProjectSetupScriptOperationError({
      threadId,
      projectId,
      projectCwd: repositoryRoot,
      worktreePath,
      operation: "openTerminal",
      cause: "simulated setup failure",
    });
    let setupAttempts = 0;
    const layer = makeRevivalLayer(makeProject(repositoryRoot), () =>
      Effect.suspend(() => {
        setupAttempts += 1;
        return setupAttempts === 1
          ? Effect.fail(setupFailure)
          : Effect.succeed({ status: "no-script" as const });
      }),
    );

    const { error, retry } = yield* Effect.gen(function* () {
      const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
      const error = yield* revival
        .reviveForThread({
          threadId,
          projectId,
          worktreePath,
          branch: "feature/revival",
        })
        .pipe(Effect.flip);
      const retry = yield* revival.reviveForThread({
        threadId,
        projectId,
        worktreePath,
        branch: "feature/revival",
      });
      return { error, retry };
    }).pipe(Effect.provide(layer));

    assert.equal(error._tag, "WorktreeMutationError");
    assert.equal(error.message, "Failed to run the project setup script after revival.");
    assert.strictEqual(error.cause, setupFailure);
    assert.isFalse(retry.revived);
    assert.equal(retry.generation, 1);
    assert.equal(setupAttempts, 2);
    assert.isTrue(yield* fs.exists(worktreePath));
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

/** A setup script that has started and settles when `completion` does. */
const startedSetup = (
  worktreePath: string,
  async: boolean,
  completion: Effect.Effect<ProjectSetupScriptRunner.ProjectSetupScriptCompletion>,
) =>
  ({
    status: "started",
    scriptId: "setup",
    scriptName: "Setup",
    scriptCommand: "vp i",
    terminalId: "setup-setup",
    cwd: worktreePath,
    async,
    completion,
  }) as const;

it.effect(
  "keeps a required setup running once when the turn start that began it is cancelled",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const repositoryRoot = yield* initializeRepository();
      const worktreePath = path.join(config.worktreesDir, "setup", "required");
      const setupStarted = yield* Deferred.make<void>();
      const setupFinished =
        yield* Deferred.make<ProjectSetupScriptRunner.ProjectSetupScriptCompletion>();
      let setupRuns = 0;
      const layer = makeRevivalLayer(makeProject(repositoryRoot), () =>
        Effect.sync(() => {
          setupRuns += 1;
        }).pipe(
          Effect.andThen(Deferred.succeed(setupStarted, undefined)),
          Effect.as(startedSetup(worktreePath, false, Deferred.await(setupFinished))),
        ),
      );
      const input = { threadId, projectId, worktreePath, branch: "feature/revival" };

      const result = yield* Effect.gen(function* () {
        const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
        const cancelled = yield* revival.reviveForThread(input).pipe(Effect.forkChild);
        yield* Deferred.await(setupStarted);
        yield* Fiber.interrupt(cancelled);
        const next = yield* revival.reviveForThread(input).pipe(Effect.forkChild);
        yield* Deferred.succeed(setupFinished, { exitCode: 0, durationMs: 1 });
        return yield* Fiber.join(next);
      }).pipe(Effect.provide(layer));

      assert.deepEqual(result, { revived: false, generation: 1 });
      assert.equal(setupRuns, 1);
    }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("fails a revival whose required setup exits non-zero and reruns it next time", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repositoryRoot = yield* initializeRepository();
    const worktreePath = path.join(config.worktreesDir, "setup", "exit-code");
    const exitCodes = [1, 0];
    const layer = makeRevivalLayer(makeProject(repositoryRoot), () =>
      Effect.sync(() =>
        startedSetup(
          worktreePath,
          false,
          Effect.succeed({ exitCode: exitCodes.shift() ?? 0, durationMs: 1 }),
        ),
      ),
    );
    const input = { threadId, projectId, worktreePath, branch: "feature/revival" };

    const { error, retry } = yield* Effect.gen(function* () {
      const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
      const error = yield* revival.reviveForThread(input).pipe(Effect.flip);
      const retry = yield* revival.reviveForThread(input);
      return { error, retry };
    }).pipe(Effect.provide(layer));

    assert.equal(error.stage, "setup_exit_nonzero");
    assert.equal(error.exitCode, 1);
    assert.equal(error.message, "Project setup exited with 1 after worktree revival.");
    assert.deepEqual(retry, { revived: false, generation: 1 });
    assert.deepEqual(exitCodes, []);
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("does not wait for a setup script that lets the agent start alongside it", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repositoryRoot = yield* initializeRepository();
    const worktreePath = path.join(config.worktreesDir, "setup", "async");
    const layer = makeRevivalLayer(makeProject(repositoryRoot), () =>
      Effect.succeed(startedSetup(worktreePath, true, Effect.never)),
    );

    const result = yield* Effect.gen(function* () {
      const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
      return yield* revival.reviveForThread({
        threadId,
        projectId,
        worktreePath,
        branch: "feature/revival",
      });
    }).pipe(Effect.provide(layer));

    assert.deepEqual(result, { revived: true, generation: 1 });
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("retries required setup after restart and remembers success on the next restart", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repositoryRoot = yield* initializeRepository();
    const worktreePath = path.join(config.worktreesDir, "setup", "restart");
    let attempts = 0;
    const layer = makeRevivalLayer(
      makeProject(repositoryRoot),
      () =>
        Effect.sync(() =>
          startedSetup(
            worktreePath,
            false,
            Effect.succeed({
              exitCode: ++attempts === 1 ? 1 : 0,
              durationMs: 1,
            }),
          ),
        ),
      { config },
    );
    const start = Effect.flatMap(WorktreeRevivalService.WorktreeRevivalService, (service) =>
      service.reviveForThread({ threadId, projectId, worktreePath, branch: "feature/revival" }),
    );
    const error = yield* start.pipe(Effect.flip, Effect.provide(layer));
    assert.equal(error.stage, "setup_exit_nonzero");
    const retry = yield* start.pipe(Effect.provide(Layer.fresh(layer)));
    assert.deepEqual(retry, { revived: false, generation: 0 });
    assert.equal(attempts, 2);
    yield* start.pipe(Effect.provide(Layer.fresh(layer)));
    assert.equal(attempts, 2, "successful setup must survive another restart");
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("remembers async setup startup across restart without waiting for completion", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repositoryRoot = yield* initializeRepository();
    const worktreePath = path.join(config.worktreesDir, "setup", "async-restart");
    let attempts = 0;
    const layer = makeRevivalLayer(
      makeProject(repositoryRoot),
      () =>
        Effect.sync(() => {
          attempts++;
          return startedSetup(worktreePath, true, Effect.never);
        }),
      { config },
    );
    const start = Effect.flatMap(WorktreeRevivalService.WorktreeRevivalService, (service) =>
      service.reviveForThread({ threadId, projectId, worktreePath, branch: "feature/revival" }),
    );
    yield* start.pipe(Effect.provide(layer));
    yield* start.pipe(Effect.provide(Layer.fresh(layer)));
    assert.equal(attempts, 1);
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("invalidates a failed creation and retains setup readiness for its checkout", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const repositoryRoot = yield* initializeRepository();
    const worktreePath = path.join(config.worktreesDir, "setup", "create-failure");
    let attempts = 0;
    const runSetup = () =>
      Effect.sync(() => {
        attempts++;
        return { status: "no-script" as const };
      });
    const project = makeProject(repositoryRoot);
    const start = Effect.flatMap(WorktreeRevivalService.WorktreeRevivalService, (service) =>
      service.reviveForThread({ threadId, projectId, worktreePath, branch: "feature/revival" }),
    );
    const failureLayer = makeRevivalLayer(project, runSetup, {
      config,
      git: {
        ...driver,
        createWorktree: (input, options) =>
          driver.createWorktree(input, options).pipe(
            Effect.andThen(
              Effect.fail(
                new GitCommandError({
                  operation: "createWorktree",
                  command: "git",
                  cwd: repositoryRoot,
                  detail: "simulated creation failure",
                  cause: "failure after checkout creation",
                }),
              ),
            ),
          ),
      },
    });
    yield* Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle.WorktreeLifecycle;
      const revisionBefore = yield* lifecycle.revision;
      const error = yield* start.pipe(Effect.flip);
      assert.equal(error.stage, "create_worktree");
      assert.equal(attempts, 0);
      assert.isAbove(yield* lifecycle.revision, revisionBefore);
      const retry = yield* start;
      assert.deepEqual(retry, { revived: false, generation: 1 });
      assert.equal(attempts, 1);
    }).pipe(Effect.provide(failureLayer.pipe(Layer.provideMerge(WorktreeLifecycle.layer))));
    yield* start.pipe(Effect.provide(makeRevivalLayer(project, runSetup, { config })));
    assert.equal(attempts, 1, "successful setup must survive a restart");
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("does not retry async setup after its later non-zero exit", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repositoryRoot = yield* initializeRepository();
    const worktreePath = path.join(config.worktreesDir, "setup", "async-failure");
    const finished = yield* Deferred.make<ProjectSetupScriptRunner.ProjectSetupScriptCompletion>();
    const observed = yield* Deferred.make<void>();
    let attempts = 0;
    const layer = makeRevivalLayer(
      makeProject(repositoryRoot),
      () =>
        Effect.sync(() => {
          attempts++;
          return startedSetup(
            worktreePath,
            true,
            Deferred.await(finished).pipe(Effect.tap(() => Deferred.succeed(observed, undefined))),
          );
        }),
      { config },
    );
    const start = Effect.flatMap(WorktreeRevivalService.WorktreeRevivalService, (service) =>
      service.reviveForThread({ threadId, projectId, worktreePath, branch: "feature/revival" }),
    );
    yield* Effect.gen(function* () {
      yield* start;
      yield* Deferred.succeed(finished, { exitCode: 1, durationMs: 1 });
      yield* Deferred.await(observed);
      yield* start;
      assert.equal(attempts, 1);
    }).pipe(Effect.provide(layer));
    yield* start.pipe(Effect.provide(Layer.fresh(layer)));
    assert.equal(attempts, 1);
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("an older setup completion cannot clear a replacement checkout's pending setup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repositoryRoot = yield* initializeRepository();
    const worktreePath = path.join(config.worktreesDir, "setup", "replacement");
    const firstStarted = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const firstFinished =
      yield* Deferred.make<ProjectSetupScriptRunner.ProjectSetupScriptCompletion>();
    let attempts = 0;
    const layer = makeRevivalLayer(
      makeProject(repositoryRoot),
      () =>
        Effect.suspend(() => {
          attempts++;
          if (attempts === 1)
            return Deferred.succeed(firstStarted, undefined).pipe(
              Effect.as(startedSetup(worktreePath, false, Deferred.await(firstFinished))),
            );
          if (attempts === 2)
            return Deferred.succeed(secondStarted, undefined).pipe(
              Effect.as(startedSetup(worktreePath, false, Effect.never)),
            );
          return Effect.succeed(
            startedSetup(worktreePath, false, Effect.succeed({ exitCode: 0, durationMs: 1 })),
          );
        }),
      { config },
    );
    const input = { threadId, projectId, worktreePath, branch: "feature/revival" };
    yield* Effect.gen(function* () {
      const service = yield* WorktreeRevivalService.WorktreeRevivalService;
      const first = yield* service.reviveForThread(input).pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      yield* fs.remove(worktreePath, { recursive: true });
      const second = yield* service.reviveForThread(input).pipe(Effect.forkChild);
      yield* Deferred.await(secondStarted);
      yield* Deferred.succeed(firstFinished, { exitCode: 0, durationMs: 1 });
      const stale = yield* Fiber.join(first).pipe(Effect.flip);
      assert.equal(stale.stage, "setup_readiness_changed");
      assert.equal(
        stale.message,
        "Worktree readiness changed during project setup. Retry the turn.",
      );
      yield* Fiber.interrupt(second);
    }).pipe(Effect.provide(layer));
    const retry = yield* Effect.flatMap(WorktreeRevivalService.WorktreeRevivalService, (service) =>
      service.reviveForThread(input),
    ).pipe(Effect.provide(Layer.fresh(layer)));
    assert.deepEqual(retry, { revived: false, generation: 0 });
    assert.equal(attempts, 3);
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "retries setup in the same shell until the checkout is replaced, then starts a fresh shell",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const repositoryRoot = yield* initializeRepository();
      const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "t3-revival-shell-" });
      const attemptsPath = path.join(scratch, "attempts");
      const scriptPath = path.join(scratch, "setup.cjs");
      yield* fs.writeFileString(
        scriptPath,
        [
          'const fs = require("node:fs");',
          "const cwd = process.cwd();",
          `const attemptsPath = ${JSON.stringify(attemptsPath)};`,
          "const attempts = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath)) : 0;",
          "fs.writeFileSync(attemptsPath, String(attempts + 1));",
          "if (attempts < 2) process.exit(1);",
          'fs.writeFileSync("ready", cwd);',
        ].join("\n"),
      );
      const worktreePath = path.join(config.worktreesDir, "setup", "replacement-shell");
      const project = {
        ...makeProject(repositoryRoot),
        scripts: [
          {
            id: "setup",
            name: "Setup",
            icon: "configure",
            runOnWorktreeCreate: true,
            async: false,
            command: `'${process.execPath.replaceAll("'", "'\\''")}' '${scriptPath.replaceAll("'", "'\\''")}'`,
          },
        ],
      } satisfies Project;
      const nativePty = yield* NodePtyAdapter.make();
      let spawns = 0;
      const terminal = yield* TerminalManager.makeWithOptions({
        logsDir: path.join(scratch, "logs"),
        shellResolver: () => "/bin/bash",
        env: { ...process.env, SHELL: "/bin/bash" },
        ptyAdapter: {
          spawn: (input) =>
            nativePty.spawn({ ...input, args: ["--noprofile", "--norc"] }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  spawns++;
                }),
              ),
            ),
        },
      });
      const runner = yield* ProjectSetupScriptRunner.make.pipe(
        Effect.provideService(TerminalManager.TerminalManager, terminal),
        Effect.provideService(HostProcess.Environment, { ...process.env, SHELL: "/bin/bash" }),
        Effect.provide(
          Layer.mergeAll(Layer.mock(ProjectService.ProjectService)({}), ServerSettings.layerTest()),
        ),
      );
      yield* Effect.gen(function* () {
        const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
        const input = { threadId, projectId, worktreePath, branch: "feature/revival" };
        for (let attempt = 0; attempt < 2; attempt++) {
          const error = yield* revival.reviveForThread(input).pipe(Effect.flip);
          assert.equal(error.stage, "setup_exit_nonzero");
          assert.equal(error.exitCode, 1);
        }
        assert.equal(spawns, 1);
        yield* fs.remove(worktreePath, { recursive: true });
        const replacement = yield* revival.reviveForThread(input);
        assert.deepEqual(replacement, { revived: true, generation: 2 });
        assert.equal(spawns, 2);
        assert.equal(
          yield* fs.readFileString(path.join(worktreePath, "ready")),
          yield* fs.realPath(worktreePath),
        );
        yield* revival.reviveForThread(input);
        assert.equal(yield* fs.readFileString(attemptsPath), "3");
      }).pipe(Effect.provide(makeRevivalLayer(project, runner.runForThread, { config })));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          serverConfigLiveLayer,
          NodeServices.layer,
          gitLayer,
          ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
);

it.effect(
  "keeps separate setup readiness for nested projects and aliases of the same Git repository",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const repositoryRoot = yield* initializeRepository();
      const nestedRoot = path.join(repositoryRoot, "subproject");
      yield* fs.makeDirectory(nestedRoot);
      const aliasRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-revival-alias-" });
      const aliasPath = path.join(aliasRoot, "repository");
      yield* fs.symlink(repositoryRoot, aliasPath);
      const worktreePath = path.join(config.worktreesDir, "setup", "shared-projects");
      const firstProject = makeProject(repositoryRoot);
      const secondProject = { ...makeProject(nestedRoot), id: ProjectId.make("second-project") };
      const aliasProject = {
        ...makeProject(path.join(aliasPath, "subproject")),
        id: ProjectId.make("alias-project"),
      };
      const unrelatedProject = {
        ...makeProject(yield* initializeRepository()),
        id: ProjectId.make("unrelated-project"),
      };
      const nonGitRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-revival-nongit-" });
      const nonGitProject = { ...makeProject(nonGitRoot), id: ProjectId.make("nongit-project") };
      const missingProject = {
        ...makeProject(path.join(nonGitRoot, "missing")),
        id: ProjectId.make("missing-project"),
      };
      const projects = [
        firstProject,
        secondProject,
        aliasProject,
        unrelatedProject,
        nonGitProject,
        missingProject,
      ];
      const attempts: Array<string | undefined> = [];
      const layer = makeRevivalLayer(
        firstProject,
        (input) =>
          Effect.sync(() => {
            attempts.push(input.projectId);
            return startedSetup(
              worktreePath,
              false,
              Effect.succeed({
                exitCode: attempts.length === 2 ? 1 : 0,
                durationMs: 1,
              }),
            );
          }),
        { config, projects },
      );
      const start = (projectId: ProjectId) =>
        Effect.flatMap(WorktreeRevivalService.WorktreeRevivalService, (service) =>
          service.reviveForThread({ threadId, projectId, worktreePath, branch: "feature/revival" }),
        ).pipe(Effect.provide(Layer.fresh(layer)));
      yield* start(firstProject.id);
      const error = yield* start(secondProject.id).pipe(Effect.flip);
      assert.deepInclude(error, { stage: "setup_exit_nonzero", exitCode: 1 });
      yield* start(secondProject.id);
      yield* start(aliasProject.id);
      yield* start(firstProject.id);
      yield* start(secondProject.id);
      yield* start(aliasProject.id);
      yield* start(unrelatedProject.id);
      yield* start(nonGitProject.id);
      yield* start(missingProject.id);
      assert.deepEqual(attempts, [
        firstProject.id,
        secondProject.id,
        secondProject.id,
        aliasProject.id,
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("rejects a missing checkout that contains a configured managed root", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repositoryRoot = yield* initializeRepository();
    const worktreePath = path.join(config.worktreesDir, "ancestor");
    const error = yield* Effect.flatMap(WorktreeRevivalService.WorktreeRevivalService, (service) =>
      service.reviveForThread({ threadId, projectId, worktreePath, branch: "feature/revival" }),
    ).pipe(
      Effect.flip,
      Effect.provide(
        makeRevivalLayer(
          makeProject(repositoryRoot),
          () => Effect.succeed({ status: "no-script" }),
          {
            config,
            settings: { worktreesDirectory: path.join(worktreePath, "managed-root") },
          },
        ),
      ),
    );
    assert.equal(error.stage, "outside_managed_root");
    assert.isFalse(yield* fs.exists(worktreePath));
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("resolves environment and project submodule settings before the checkout's t3.json", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = "file";
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previousAllowedProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
        else process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
      }),
    );
    const nested = yield* initializeRepository();
    const inner = yield* initializeRepository();
    const repositoryRoot = yield* initializeRepository();
    const git = (cwd: string, args: readonly string[]) =>
      driver.execute({
        operation: "WorktreeRevivalServiceTest.submodules",
        cwd,
        args,
      });
    yield* git(inner, ["submodule", "add", nested, "nested"]);
    yield* git(inner, ["commit", "-am", "add nested submodule"]);
    yield* git(repositoryRoot, ["submodule", "add", inner, "inner"]);
    yield* git(repositoryRoot, ["commit", "-am", "add inner submodule"]);
    const cases: readonly {
      name: string;
      file: WorktreeSubmodules | undefined;
      environment: WorktreeSubmodules | null;
      project?: WorktreeSubmodules;
      populated: boolean;
    }[] = [
      { name: "environment-none", file: "recursive", environment: "none", populated: false },
      { name: "environment-recursive", file: "none", environment: "recursive", populated: true },
      {
        name: "project-none",
        file: "recursive",
        environment: "recursive",
        project: "none",
        populated: false,
      },
      {
        name: "project-recursive",
        file: "none",
        environment: "none",
        project: "recursive",
        populated: true,
      },
      { name: "file-none", file: "none", environment: null, populated: false },
      { name: "default-recursive", file: undefined, environment: null, populated: true },
    ];
    for (const testCase of cases) {
      yield* fs.writeFileString(
        path.join(repositoryRoot, "t3.json"),
        JSON.stringify(testCase.file === undefined ? {} : { worktreeSubmodules: testCase.file }),
      );
      yield* git(repositoryRoot, ["add", "t3.json"]);
      yield* git(repositoryRoot, ["commit", "--allow-empty", "-m", testCase.name]);
      const branch = `feature/${testCase.name}`;
      yield* git(repositoryRoot, ["branch", branch]);
      const worktreePath = path.join(config.worktreesDir, testCase.name);
      yield* Effect.flatMap(WorktreeRevivalService.WorktreeRevivalService, (service) =>
        service.reviveForThread({ threadId, projectId, worktreePath, branch }),
      ).pipe(
        Effect.provide(
          makeRevivalLayer(
            makeProject(repositoryRoot),
            () => Effect.succeed({ status: "no-script" }),
            {
              config,
              settings: {
                worktreeSubmodules: testCase.environment,
                projectSettingsOverrides:
                  testCase.project === undefined
                    ? {}
                    : {
                        [projectId]: { worktreeSubmodules: testCase.project },
                      },
              },
            },
          ),
        ),
      );
      assert.equal(
        yield* fs.exists(path.join(worktreePath, "inner", "README.md")),
        testCase.populated,
        testCase.name,
      );
      assert.equal(
        yield* fs.exists(path.join(worktreePath, "inner", "nested", "README.md")),
        testCase.populated,
        testCase.name,
      );
    }
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);
