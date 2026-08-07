import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ProjectId, ThreadId, type Project } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
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
) =>
  WorktreeRevivalService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        serverConfigLiveLayer,
        NodeServices.layer,
        gitLayer,
        WorktreeLifecycle.layer,
        Layer.mock(ProjectService.ProjectService)({
          getById: (requestedProjectId) =>
            Effect.succeed(
              requestedProjectId === project.id ? Option.some(project) : Option.none(),
            ),
          snapshot: Effect.succeed({
            projects: [project],
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
        return yield* revival.reviveWorktree({
          workspaceRoot: repositoryRoot,
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
      assert.match(error.message, /outside the managed worktrees directory/);
      assert.isFalse(yield* fs.exists(escapedPath));
    }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("runs project setup after physically recreating a thread worktree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repositoryRoot = yield* initializeRepository();
    const worktreePath = path.join(config.worktreesDir, "setup", "revived");
    const project = makeProject(repositoryRoot);
    const setupCalls: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput[] = [];
    const layer = makeRevivalLayer(project, (input) =>
      Effect.sync(() => {
        setupCalls.push(input);
        return { status: "no-script" } as const;
      }),
    );

    const first = yield* Effect.gen(function* () {
      const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
      return yield* revival.reviveForThread({
        threadId,
        projectId,
        worktreePath,
        branch: "feature/revival",
      });
    }).pipe(Effect.provide(layer));
    const second = yield* Effect.gen(function* () {
      const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
      return yield* revival.reviveForThread({
        threadId,
        projectId,
        worktreePath,
        branch: "feature/revival",
      });
    }).pipe(Effect.provide(layer));

    assert.isTrue(first.revived);
    assert.isFalse(second.revived);
    assert.isTrue(yield* fs.exists(worktreePath));
    assert.equal(setupCalls.length, 1);
    assert.deepInclude(setupCalls[0], {
      threadId,
      projectId,
      projectCwd: repositoryRoot,
      worktreePath,
    });
    assert.deepEqual(setupCalls[0]?.project, {
      workspaceRoot: repositoryRoot,
      scripts: project.scripts,
    });
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("surfaces setup failure after recreation before revival succeeds", () =>
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

    const error = yield* Effect.gen(function* () {
      const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
      return yield* revival.reviveForThread({
        threadId,
        projectId,
        worktreePath,
        branch: "feature/revival",
      });
    }).pipe(
      Effect.provide(
        makeRevivalLayer(makeProject(repositoryRoot), () => Effect.fail(setupFailure)),
      ),
      Effect.flip,
    );

    assert.equal(error._tag, "WorktreeMutationError");
    assert.equal(error.message, "Failed to run the project setup script after revival.");
    assert.strictEqual(error.cause, setupFailure);
    assert.isTrue(yield* fs.exists(worktreePath));
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);
