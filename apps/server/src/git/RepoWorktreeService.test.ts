import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as RepoWorktreeService from "./RepoWorktreeService.ts";

const projectId = ProjectId.make("project:repo-worktrees");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in repository worktree tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-repo-worktree-test-",
}).pipe(Layer.provide(NodeServices.layer));

const layerGitDriver = GitVcsDriver.layer.pipe(
  Layer.provide(layerServerConfig),
  Layer.provideMerge(NodeServices.layer),
);

// GitWorkflowService adds project settings and caching on top of the driver;
// these tests exercise the real git operations underneath it.
const layerGitWorkflow = Layer.unwrap(
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return Layer.mock(GitWorkflowService.GitWorkflowService)({
      remoteExists: git.remoteExists,
      fetchRemote: git.fetchRemote,
      resolveRemoteTrackingCommit: git.resolveRemoteTrackingCommit,
      pruneWorktrees: git.pruneWorktrees,
      createWorktree: (input, options) => git.createWorktree(input, options),
      removeWorktree: git.removeWorktree,
      deleteLocalBranch: git.deleteLocalBranch,
      invalidateStatus: () => Effect.void,
    });
  }),
);

function makeLayer(input: { readonly workspaceRoot: string; readonly worktreesDirectory: string }) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "repo-worktrees" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerSettings = ServerSettings.layerTest({
    repoWorktrees: true,
    worktreesDirectory: input.worktreesDirectory,
    newWorktreesStartFromOrigin: false,
  });
  const layerThreads = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const layerProjects = Layer.mock(ProjectService.ProjectService)({
    getById: () =>
      Effect.succeed(Option.some({ id: projectId, workspaceRoot: input.workspaceRoot } as never)),
  });
  return RepoWorktreeService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(layerThreads, layerSettings, layerProjects, layerGitWorkflow),
    ),
    Layer.provideMerge(layerGitDriver),
    Layer.provideMerge(layerServerConfig),
  );
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "RepoWorktreeService.test",
      cwd,
      args,
      timeoutMs: 30_000,
    });
    return result.stdout.trim();
  });

const gitExitCode = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "RepoWorktreeService.test",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: 30_000,
    });
    return result.exitCode;
  });

const configureIdentity = (cwd: string) =>
  Effect.gen(function* () {
    yield* git(cwd, ["config", "user.email", "test@example.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* git(cwd, ["config", "commit.gpgsign", "false"]);
  });

const initRepo = (cwd: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(cwd, { recursive: true });
    yield* git(cwd, ["init", "--initial-branch=main"]);
    yield* configureIdentity(cwd);
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), `# ${path.basename(cwd)}\n`);
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial"]);
  });

const commitFile = (cwd: string, file: string, contents: string, message: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(cwd, file), contents);
    yield* git(cwd, ["add", file]);
    yield* git(cwd, ["commit", "-m", message]);
    return yield* git(cwd, ["rev-parse", "HEAD"]);
  });

/** A plain folder (not a repository) holding two repositories; `server` has a submodule. */
const fixturePaths = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-repo-worktrees-" }),
  );
  // Submodules clone from a local path in these fixtures.
  const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = "file";
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (previousAllowedProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
      else process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
    }),
  );
  return {
    root,
    folder: path.join(root, "folder"),
    alpha: path.join(root, "folder", "alpha"),
    server: path.join(root, "folder", "server"),
    frameworkSource: path.join(root, "framework-source"),
    worktrees: path.join(root, "worktrees"),
  };
});

type Fixture = Effect.Success<typeof fixturePaths>;

const buildRepositories = (fixture: Fixture) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* initRepo(fixture.alpha);
    yield* initRepo(fixture.frameworkSource);
    yield* initRepo(fixture.server);
    yield* git(fixture.server, ["submodule", "add", fixture.frameworkSource, "framework"]);
    yield* git(fixture.server, ["commit", "-m", "add framework"]);
    yield* configureIdentity(path.join(fixture.server, "framework"));
  });

let threadCounter = 0;
const createThread = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadId = ThreadId.make(`thread:repo-worktrees:${++threadCounter}`);
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId,
    title: "Folder thread",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

const readThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return (yield* threads.getThreadRecords(threadId, [])).thread;
  });

const requestReason = (error: RepoWorktreeService.RepoWorktreeFailure) =>
  error._tag === "RepoWorktreeRequestError" ? error.reason : error._tag;

const withFixture = <A, E, R>(test: (fixture: Fixture) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fixture = yield* fixturePaths;
    return yield* Effect.gen(function* () {
      yield* buildRepositories(fixture);
      return yield* test(fixture);
    }).pipe(
      Effect.provide(
        makeLayer({ workspaceRoot: fixture.folder, worktreesDirectory: fixture.worktrees }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("RepoWorktreeService", () => {
  it.effect("creates a worktree for a repository in the folder while the thread stays put", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const service = yield* RepoWorktreeService.RepoWorktreeService;
        const threadId = yield* createThread;

        const result = yield* service.ensure({
          threadId,
          repository: "alpha",
          branch: "feature/one",
          baseRef: "main",
        });

        const expectedPath = path.join(fixture.worktrees, "alpha", "feature-one");
        assert.equal(result.status, "created");
        assert.isTrue(result.branchCreated);
        assert.equal(result.repoWorktree.worktreePath, expectedPath);
        assert.isTrue(yield* fileSystem.exists(path.join(expectedPath, "README.md")));
        assert.equal(yield* git(expectedPath, ["branch", "--show-current"]), "feature/one");
        assert.equal(yield* git(fixture.alpha, ["branch", "--show-current"]), "main");

        const thread = yield* readThread(threadId);
        assert.isNull(thread.worktreePath);
        assert.isNull(thread.branch);
        assert.deepEqual(
          thread.repoWorktrees?.map((entry) => [
            entry.repository,
            entry.repositoryPath,
            entry.branch,
            entry.baseRef,
            entry.origin,
          ]),
          [["alpha", fixture.alpha, "feature/one", "main", "created"]],
        );

        // Mid-task, the same thread adds a second repository.
        yield* service.ensure({
          threadId,
          repository: path.join(fixture.server, "framework"),
          branch: "feature/one",
          baseRef: "main",
        });
        assert.deepEqual(
          (yield* readThread(threadId)).repoWorktrees?.map((entry) => entry.repository),
          ["alpha", "server/framework"],
        );
      }),
    ),
  );

  it.effect("reuses the worktree that has the branch and keeps its edits", () =>
    withFixture(() =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const service = yield* RepoWorktreeService.RepoWorktreeService;
        const first = yield* createThread;
        const second = yield* createThread;

        const created = yield* service.ensure({
          threadId: first,
          repository: "alpha",
          branch: "feature/shared",
          baseRef: "main",
        });
        const worktreePath = created.repoWorktree.worktreePath;
        yield* fileSystem.writeFileString(path.join(worktreePath, "README.md"), "edited\n");
        yield* fileSystem.writeFileString(path.join(worktreePath, "notes.txt"), "draft\n");

        const reused = yield* service.ensure({
          threadId: second,
          repository: "alpha",
          branch: "feature/shared",
        });
        assert.equal(reused.status, "reused");
        assert.isFalse(reused.alreadyAttached);
        assert.equal(reused.uncommittedFiles, 2);
        assert.equal(reused.repoWorktree.worktreePath, worktreePath);
        assert.equal(reused.repoWorktree.origin, "reused");
        assert.equal(
          yield* fileSystem.readFileString(path.join(worktreePath, "README.md")),
          "edited\n",
        );
        assert.equal(
          yield* fileSystem.readFileString(path.join(worktreePath, "notes.txt")),
          "draft\n",
        );

        const again = yield* service.ensure({
          threadId: first,
          repository: "alpha",
          branch: "feature/shared",
        });
        assert.equal(again.status, "reused");
        assert.isTrue(again.alreadyAttached);
        assert.equal(again.repoWorktree.origin, "created");
        assert.equal((yield* readThread(first)).repoWorktrees?.length, 1);
      }),
    ),
  );

  it.effect("needs an explicit choice before touching an existing or source branch", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const service = yield* RepoWorktreeService.RepoWorktreeService;
        const threadId = yield* createThread;
        yield* git(fixture.alpha, ["branch", "topic"]);

        const attempts = [
          { branch: "topic", baseRef: "main" },
          { branch: "main", baseRef: "main" },
          { branch: "brand-new" },
          { branch: "missing", useExistingBranch: true },
          { branch: "bad..name", baseRef: "main" },
        ];
        const refusals = yield* Effect.forEach(attempts, (attempt) =>
          service
            .ensure({ threadId, repository: "alpha", ...attempt })
            .pipe(Effect.flip, Effect.map(requestReason)),
        );
        assert.deepEqual(refusals, [
          "branch_exists",
          "branch_in_source_checkout",
          "base_ref_required",
          "branch_missing",
          "invalid_branch",
        ]);
        assert.deepEqual((yield* readThread(threadId)).repoWorktrees ?? [], []);

        const continued = yield* service.ensure({
          threadId,
          repository: "alpha",
          branch: "topic",
          useExistingBranch: true,
        });
        assert.equal(continued.status, "created");
        assert.isFalse(continued.branchCreated);
        assert.equal(
          yield* git(continued.repoWorktree.worktreePath, ["branch", "--show-current"]),
          "topic",
        );
      }),
    ),
  );

  it.effect("refuses repositories outside the folder", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const service = yield* RepoWorktreeService.RepoWorktreeService;
        const threadId = yield* createThread;
        const reasons = yield* Effect.all(
          [fixture.frameworkSource, "../framework-source", "missing-repo"].map((repository) =>
            service
              .ensure({ threadId, repository, branch: "feature/x", baseRef: "main" })
              .pipe(Effect.flip, Effect.map(requestReason)),
          ),
        );
        assert.deepEqual(reasons, ["outside_project", "outside_project", "not_a_repository"]);
      }),
    ),
  );

  it.effect("never overwrites an unrelated folder at the default location", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const service = yield* RepoWorktreeService.RepoWorktreeService;
        const threadId = yield* createThread;
        const occupied = path.join(fixture.worktrees, "alpha", "feature-two");
        yield* fileSystem.makeDirectory(occupied, { recursive: true });
        yield* fileSystem.writeFileString(path.join(occupied, "keep.txt"), "unrelated\n");

        const result = yield* service.ensure({
          threadId,
          repository: "alpha",
          branch: "feature/two",
          baseRef: "main",
        });

        assert.equal(result.repoWorktree.worktreePath, `${occupied}-2`);
        assert.equal(
          yield* fileSystem.readFileString(path.join(occupied, "keep.txt")),
          "unrelated\n",
        );
      }),
    ),
  );

  it.effect("pins a parent worktree's submodule to commits from the submodule's worktree", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const service = yield* RepoWorktreeService.RepoWorktreeService;
        const threadId = yield* createThread;
        const sourceSubmodule = path.join(fixture.server, "framework");
        const sourceSubmoduleHead = yield* git(sourceSubmodule, ["rev-parse", "HEAD"]);

        const parent = (yield* service.ensure({
          threadId,
          repository: "server",
          branch: "feature/server",
          baseRef: "main",
        })).repoWorktree.worktreePath;
        const framework = (yield* service.ensure({
          threadId,
          repository: "server/framework",
          branch: "feature/framework",
          baseRef: "main",
        })).repoWorktree.worktreePath;
        assert.equal(framework, path.join(fixture.worktrees, "framework", "feature-framework"));
        const parentSubmodule = path.join(parent, "framework");
        assert.isTrue(yield* fileSystem.exists(path.join(parentSubmodule, "README.md")));

        const firstCommit = yield* commitFile(framework, "lib.txt", "v1\n", "framework v1");
        const first = yield* service.setSubmoduleCommit({
          threadId,
          worktreePath: parent,
          submodulePath: "framework",
          sourceWorktreePath: framework,
        });
        assert.deepEqual(
          [first.commit, first.previousCommit, first.fetched, first.staged],
          [firstCommit, sourceSubmoduleHead, true, true],
        );
        assert.equal(yield* git(parentSubmodule, ["rev-parse", "HEAD"]), firstCommit);
        assert.notEqual(yield* gitExitCode(parentSubmodule, ["symbolic-ref", "-q", "HEAD"]), 0);
        assert.equal(yield* git(parent, ["diff", "--cached", "--name-only"]), "framework");
        assert.equal(
          yield* git(parentSubmodule, ["remote", "get-url", "origin"]),
          fixture.frameworkSource,
        );

        const secondCommit = yield* commitFile(framework, "lib.txt", "v2\n", "framework v2");
        const second = yield* service.setSubmoduleCommit({
          threadId,
          worktreePath: parent,
          submodulePath: "framework",
          sourceWorktreePath: framework,
        });
        assert.deepEqual([second.commit, second.previousCommit], [secondCommit, firstCommit]);
        yield* git(parent, ["commit", "-m", "Pin framework"]);
        assert.include(yield* git(parent, ["ls-tree", "HEAD", "framework"]), secondCommit);

        // The source checkouts never moved.
        assert.equal(yield* git(sourceSubmodule, ["rev-parse", "HEAD"]), sourceSubmoduleHead);
        assert.equal(yield* git(fixture.server, ["status", "--porcelain"]), "");
        assert.equal(yield* git(fixture.server, ["branch", "--show-current"]), "main");

        // Edits in the parent's submodule checkout are never overwritten.
        yield* commitFile(framework, "lib.txt", "v3\n", "framework v3");
        yield* fileSystem.writeFileString(path.join(parentSubmodule, "README.md"), "local edit\n");
        const refused = yield* service
          .setSubmoduleCommit({
            threadId,
            worktreePath: parent,
            submodulePath: "framework",
            sourceWorktreePath: framework,
          })
          .pipe(Effect.flip, Effect.map(requestReason));
        assert.equal(refused, "submodule_changes");
        assert.equal(
          yield* fileSystem.readFileString(path.join(parentSubmodule, "README.md")),
          "local edit\n",
        );
        assert.equal(yield* git(parentSubmodule, ["rev-parse", "HEAD"]), secondCommit);

        const notAttached = yield* service
          .setSubmoduleCommit({
            threadId,
            worktreePath: fixture.server,
            submodulePath: "framework",
            sourceWorktreePath: framework,
          })
          .pipe(Effect.flip, Effect.map(requestReason));
        assert.equal(notAttached, "not_attached");
      }),
    ),
  );

  it.effect("detaches without touching files, also after the project turns it off", () =>
    withFixture(() =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const service = yield* RepoWorktreeService.RepoWorktreeService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const threadId = yield* createThread;
        const { worktreePath } = (yield* service.ensure({
          threadId,
          repository: "alpha",
          branch: "feature/detach",
          baseRef: "main",
        })).repoWorktree;

        yield* settings.updateSettings({ repoWorktrees: false });
        const disabled = yield* service
          .ensure({ threadId, repository: "alpha", branch: "feature/other", baseRef: "main" })
          .pipe(Effect.flip);
        assert.equal(disabled._tag, "RepoWorktreesDisabledError");

        assert.deepEqual(yield* service.detach({ threadId, worktreePath }), {
          detached: true,
          worktreePath,
        });
        assert.deepEqual((yield* readThread(threadId)).repoWorktrees, []);
        assert.isTrue(yield* fileSystem.exists(worktreePath));
        assert.deepEqual(yield* service.detach({ threadId, worktreePath }), {
          detached: false,
          worktreePath,
        });
      }),
    ),
  );
});
