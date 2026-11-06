import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as Path from "effect/Path";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
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
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerCheckpoints = CheckpointService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      CheckpointStore.layer.pipe(
        Layer.provide(
          VcsDriverRegistry.layer.pipe(
            Layer.provide(VcsProcess.layer),
            Layer.provide(layerServerConfig),
          ),
        ),
      ),
      IdAllocator.layer,
    ),
  ),
);

type CreateWorktree = GitWorkflowService.GitWorkflowService["Service"]["createWorktree"];

// GitWorkflowService adds project settings and caching on top of the driver;
// these tests exercise the real git operations underneath it.
const layerGitWorkflow = (
  createWorktree?: (git: GitVcsDriver.GitVcsDriver["Service"]) => CreateWorktree,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      return Layer.mock(GitWorkflowService.GitWorkflowService)({
        remoteExists: git.remoteExists,
        fetchRemote: git.fetchRemote,
        resolveRemoteTrackingCommit: git.resolveRemoteTrackingCommit,
        pruneWorktrees: git.pruneWorktrees,
        createWorktree:
          createWorktree?.(git) ?? ((input, options) => git.createWorktree(input, options)),
        removeWorktree: git.removeWorktree,
        deleteLocalBranch: git.deleteLocalBranch,
        invalidateStatus: () => Effect.void,
      });
    }),
  );

function makeLayer(input: {
  readonly workspaceRoot: string;
  readonly worktreesDirectory: string;
  readonly createWorktree?: (git: GitVcsDriver.GitVcsDriver["Service"]) => CreateWorktree;
}) {
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
      Effect.succeedSome({ id: projectId, workspaceRoot: input.workspaceRoot } as never),
  });
  return RepoWorktreeService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerThreads,
        layerSettings,
        layerProjects,
        layerGitWorkflow(input.createWorktree),
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        layerCheckpoints,
      ),
    ),
    Layer.provideMerge(layerGitDriver),
    Layer.provideMerge(layerServerConfig),
    Layer.provideMerge(layerDatabase),
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
  return {
    root,
    folder: path.join(root, "folder"),
    alpha: path.join(root, "folder", "alpha"),
    server: path.join(root, "folder", "server"),
    frameworkSource: path.join(root, "framework-source"),
    worktrees: path.join(root, "worktrees"),
    /** The configured worktree location, which may be a link to `worktrees`. */
    worktreesDirectory: path.join(root, "worktrees"),
  };
});

type Fixture = Effect.Success<typeof fixturePaths>;

/**
 * `folder/beta` cloned from a remote that also has `develop`, so the clone has
 * a local main and only origin/develop.
 */
const cloneWithRemoteOnlyBranch = (fixture: Fixture) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const seed = path.join(fixture.root, "beta-seed");
    const remote = path.join(fixture.root, "remotes", "beta.git");
    const beta = path.join(fixture.folder, "beta");
    yield* initRepo(seed);
    yield* git(seed, ["switch", "-c", "develop"]);
    const developCommit = yield* commitFile(seed, "develop.txt", "develop\n", "develop work");
    yield* git(seed, ["switch", "main"]);
    yield* git(fixture.root, ["clone", "--quiet", "--bare", seed, remote]);
    yield* git(fixture.root, ["clone", "--quiet", remote, beta]);
    yield* configureIdentity(beta);
    return { beta, developCommit };
  });

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
const createThreadIn = (
  workspace: { readonly branch: string; readonly worktreePath: string } | null,
) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(`thread:repo-worktrees:${++threadCounter}`);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: workspace === null ? "Folder thread" : "Worktree thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: workspace?.branch ?? null,
      worktreePath: workspace?.worktreePath ?? null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });
const createThread = createThreadIn(null);

const readThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return (yield* threads.getThreadRecords(threadId, [])).thread;
  });

const requestReason = (error: RepoWorktreeService.RepoWorktreeFailure) =>
  error._tag === "RepoWorktreeRequestError" ? error.reason : error._tag;

/** Saves README.md as the Files editor does, through the real workspace authorization. */
const saveReadme = (workspaceRoot: string, cwd: string) =>
  Effect.gen(function* () {
    const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    yield* files.writeFile({ cwd, relativePath: "README.md", contents: "saved\n" });
    return "saved";
  }).pipe(
    Effect.catchTags({ UnknownWorkspaceError: () => Effect.succeed("refused") }),
    Effect.provide(
      WorkspaceFileSystem.layer.pipe(
        Layer.provide(KnownWorkspaces.layer),
        Layer.provide(
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () =>
              Effect.succeed([
                {
                  id: projectId,
                  title: "Folder",
                  workspaceRoot,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              ]),
          }),
        ),
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        ),
      ),
    ),
  );

const withFixture = <A, E, R>(
  test: (fixture: Fixture) => Effect.Effect<A, E, R>,
  options: {
    /** Configure the worktree location through a link, as /tmp is on macOS. */
    readonly linkedWorktreesDirectory?: boolean;
    readonly createWorktree?: (git: GitVcsDriver.GitVcsDriver["Service"]) => CreateWorktree;
  } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fixture = yield* fixturePaths;
    let worktreesDirectory = fixture.worktrees;
    if (options.linkedWorktreesDirectory === true) {
      worktreesDirectory = `${fixture.worktrees}-link`;
      yield* fileSystem.makeDirectory(fixture.worktrees, { recursive: true });
      yield* fileSystem.symlink(fixture.worktrees, worktreesDirectory);
    }
    return yield* Effect.gen(function* () {
      yield* buildRepositories(fixture);
      return yield* test({ ...fixture, worktreesDirectory });
    }).pipe(
      Effect.provide(
        makeLayer({
          workspaceRoot: fixture.folder,
          worktreesDirectory,
          ...(options.createWorktree === undefined
            ? {}
            : { createWorktree: options.createWorktree }),
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

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
        // Over 256 KiB of status output; a rename and a name Git quotes count once each.
        for (let index = 0; index < 1_100; index++) {
          yield* fileSystem.writeFileString(
            path.join(worktreePath, `${index}-${"x".repeat(240)}.txt`),
            "",
          );
        }
        yield* commitFile(worktreePath, "old-name.txt", "old\n", "add old name");
        yield* git(worktreePath, ["mv", "old-name.txt", "new-name.txt"]);
        yield* fileSystem.writeFileString(path.join(worktreePath, "line\nbreak.txt"), "");

        const reused = yield* service.ensure({
          threadId: second,
          repository: "alpha",
          branch: "feature/shared",
        });
        assert.equal(reused.status, "reused");
        assert.isFalse(reused.alreadyAttached);
        assert.equal(reused.uncommittedFiles, 1_104);
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
        const path = yield* Path.Path;
        yield* git(fixture.alpha, ["branch", "topic"]);
        // A repository in the folder can itself be a linked worktree of a checkout elsewhere.
        yield* git(fixture.alpha, [
          "worktree",
          "add",
          "--quiet",
          "-b",
          "linked-topic",
          path.join(fixture.folder, "linked"),
        ]);

        const attempts = [
          { branch: "topic", baseRef: "main" },
          { branch: "main", baseRef: "main" },
          { repository: "linked", branch: "linked-topic", useExistingBranch: true },
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
        const reasons = yield* Effect.forEach(
          [fixture.frameworkSource, "../framework-source", "missing-repo"],
          (repository) =>
            service
              .ensure({ threadId, repository, branch: "feature/x", baseRef: "main" })
              .pipe(Effect.flip, Effect.map(requestReason)),
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

        // Nor are ignored files there that the new commit tracks.
        yield* git(parentSubmodule, ["checkout", "--", "README.md"]);
        yield* fileSystem.writeFileString(path.join(parentSubmodule, ".gitignore"), "local.env\n");
        yield* fileSystem.writeFileString(path.join(parentSubmodule, "local.env"), "mine\n");
        yield* commitFile(framework, "local.env", "theirs\n", "track local.env");
        const ignoredRefusal = yield* service
          .setSubmoduleCommit({
            threadId,
            worktreePath: parent,
            submodulePath: "framework",
            sourceWorktreePath: framework,
          })
          .pipe(Effect.flip, Effect.map(requestReason));
        assert.equal(ignoredRefusal, "GitCommandError");
        assert.equal(
          yield* fileSystem.readFileString(path.join(parentSubmodule, "local.env")),
          "mine\n",
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
        // A client's own detach command, sent again by a double tap or another device.
        yield* (yield* ThreadManagement.ThreadManagementService).dispatch({
          type: "thread.repo-worktree.detach",
          commandId: CommandId.make("detach:again"),
          threadId,
          worktreePath,
        });
      }),
    ),
  );

  // Given an unresolvable start point, `git worktree add -b feature/b <path>
  // develop` creates and checks out develop from origin/develop instead.
  it.effect("starts a new branch from a base only origin has without Git guessing", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* RepoWorktreeService.RepoWorktreeService;
        const threadId = yield* createThread;
        const { beta, developCommit } = yield* cloneWithRemoteOnlyBranch(fixture);
        const hasLocalDevelop = gitExitCode(beta, [
          "show-ref",
          "--verify",
          "--quiet",
          "refs/heads/develop",
        ]);

        const refused = yield* service
          .ensure({
            threadId,
            repository: "beta",
            branch: "feature/b",
            baseRef: "develop",
            startFromOrigin: false,
          })
          .pipe(Effect.flip);
        assert.equal(requestReason(refused), "base_missing");
        assert.include(refused.message, "only origin has it");
        assert.isFalse(yield* fileSystem.exists(path.join(fixture.worktrees, "beta")));
        assert.notEqual(yield* hasLocalDevelop, 0);
        assert.deepEqual((yield* readThread(threadId)).repoWorktrees ?? [], []);

        // Explicit remote base without a fetch, and a fetched one.
        for (const request of [
          { branch: "feature/b", baseRef: "origin/develop", startFromOrigin: false },
          { branch: "feature/c", baseRef: "develop", startFromOrigin: true },
        ]) {
          const created = yield* service.ensure({ threadId, repository: "beta", ...request });
          const worktreePath = created.repoWorktree.worktreePath;
          assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), request.branch);
          assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), developCommit);
          assert.equal(created.repoWorktree.branch, request.branch);
        }
        assert.notEqual(yield* hasLocalDevelop, 0);
        assert.equal(yield* git(beta, ["branch", "--show-current"]), "main");

        // Continuing origin's branch itself takes an explicit choice, and tracks it.
        const continueDevelop = { threadId, repository: "beta", branch: "develop" };
        const unconfirmed = yield* service.ensure(continueDevelop).pipe(Effect.flip);
        assert.equal(requestReason(unconfirmed), "branch_exists");
        const continued = yield* service.ensure({ ...continueDevelop, useExistingBranch: true });
        const developPath = continued.repoWorktree.worktreePath;
        assert.equal(yield* git(developPath, ["branch", "--show-current"]), "develop");
        assert.equal(yield* git(developPath, ["rev-parse", "HEAD"]), developCommit);
        assert.equal(
          yield* git(developPath, ["rev-parse", "--abbrev-ref", "develop@{upstream}"]),
          "origin/develop",
        );
      }),
    ),
  );

  it.effect("never attaches a worktree on a branch other than the one requested", () =>
    withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const service = yield* RepoWorktreeService.RepoWorktreeService;
          const threadId = yield* createThread;

          const refused = yield* service
            .ensure({ threadId, repository: "alpha", branch: "feature/b", baseRef: "main" })
            .pipe(Effect.flip);
          assert.equal(requestReason(refused), "branch_mismatch");
          assert.include(refused.message, "'surprise' instead of 'feature/b'");
          assert.isFalse(
            yield* fileSystem.exists(path.join(fixture.worktrees, "alpha", "feature-b")),
          );
          assert.notEqual(
            yield* gitExitCode(fixture.alpha, [
              "show-ref",
              "--verify",
              "--quiet",
              "refs/heads/feature/b",
            ]),
            0,
          );
          assert.deepEqual((yield* readThread(threadId)).repoWorktrees ?? [], []);
        }),
      {
        // A real checkout of another branch, standing in for Git choosing one.
        createWorktree: (git) => (input, options) =>
          git.createWorktree({ ...input, newRefName: "surprise" }, options),
      },
    ),
  );

  it.effect("relabels an attached worktree after its checkout switched branch", () =>
    withFixture(() =>
      Effect.gen(function* () {
        const service = yield* RepoWorktreeService.RepoWorktreeService;
        const threadId = yield* createThread;
        const { worktreePath } = (yield* service.ensure({
          threadId,
          repository: "alpha",
          branch: "feature/first",
          baseRef: "main",
        })).repoWorktree;
        yield* git(worktreePath, ["switch", "--quiet", "-c", "feature/second"]);

        const reused = yield* service.ensure({
          threadId,
          repository: "alpha",
          branch: "feature/second",
        });
        assert.deepEqual(
          [reused.status, reused.alreadyAttached, reused.repoWorktree.branch],
          ["reused", true, "feature/second"],
        );
        assert.deepEqual(
          (yield* readThread(threadId)).repoWorktrees?.map((entry) => [
            entry.worktreePath,
            entry.branch,
          ]),
          [[worktreePath, "feature/second"]],
        );
      }),
    ),
  );

  it.effect("records a switched branch for every thread with the checkout, never reattaching", () =>
    withFixture(() =>
      Effect.gen(function* () {
        const service = yield* RepoWorktreeService.RepoWorktreeService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const first = yield* createThread;
        const second = yield* createThread;
        const detached = yield* createThread;
        const unrelated = yield* createThread;
        const { repoWorktree } = yield* service.ensure({
          threadId: first,
          repository: "alpha",
          branch: "feature/shared",
          baseRef: "main",
        });
        for (const threadId of [second, detached]) {
          yield* service.ensure({ threadId, repository: "alpha", branch: "feature/shared" });
        }
        yield* service.detach({ threadId: detached, worktreePath: repoWorktree.worktreePath });
        // As a Git action does from the thread's Changes view.
        yield* git(repoWorktree.worktreePath, ["switch", "--quiet", "-c", "feature/renamed"]);

        yield* service.recordBranch({ cwd: repoWorktree.worktreePath });
        for (const threadId of [first, second]) {
          assert.deepEqual(
            (yield* readThread(threadId)).repoWorktrees?.map((entry) => entry.branch),
            ["feature/renamed"],
          );
        }
        assert.deepEqual((yield* readThread(detached)).repoWorktrees ?? [], []);
        assert.deepEqual((yield* readThread(unrelated)).repoWorktrees ?? [], []);

        // A relabel read before that detach landed is a no-op and leaves it detached.
        yield* threads.dispatch({
          type: "thread.repo-worktree.attach",
          commandId: CommandId.make("relabel:after-detach"),
          threadId: detached,
          repoWorktree: { ...repoWorktree, branch: "feature/renamed" },
          relabelOnly: true,
        });
        assert.deepEqual((yield* readThread(detached)).repoWorktrees ?? [], []);
      }),
    ),
  );

  it.effect("treats a linked worktree location and Git's real path as one checkout", () =>
    withFixture(
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const service = yield* RepoWorktreeService.RepoWorktreeService;
          const first = yield* createThread;
          const second = yield* createThread;
          const request = { repository: "alpha", branch: "feature/shared", baseRef: "main" };

          const created = yield* service.ensure({ threadId: first, ...request });
          const reused = yield* service.ensure({ threadId: second, ...request });
          assert.equal(
            yield* fileSystem.realPath(created.repoWorktree.worktreePath),
            reused.repoWorktree.worktreePath,
          );
          assert.notEqual(created.repoWorktree.worktreePath, reused.repoWorktree.worktreePath);

          const again = yield* service.ensure({ threadId: first, ...request });
          assert.isTrue(again.alreadyAttached);
          assert.equal((yield* readThread(first)).repoWorktrees?.length, 1);
          assert.deepEqual(
            yield* service.detach({
              threadId: first,
              worktreePath: reused.repoWorktree.worktreePath,
            }),
            { detached: true, worktreePath: created.repoWorktree.worktreePath },
          );
        }),
      { linkedWorktreesDirectory: true },
    ),
  );

  it.effect("keeps a worktree that a folder thread attached when its own thread deletes it", () =>
    withFixture(
      (fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const service = yield* RepoWorktreeService.RepoWorktreeService;
          // An ordinary thread's worktree, made through the linked location.
          const worktreePath = path.join(fixture.worktreesDirectory, "alpha", "feature-login");
          yield* git(fixture.alpha, [
            "worktree",
            "add",
            "-b",
            "feature/login",
            worktreePath,
            "main",
          ]);
          yield* fileSystem.writeFileString(path.join(worktreePath, "draft.txt"), "draft\n");
          yield* createThreadIn({ branch: "feature/login", worktreePath });
          const folderThread = yield* createThread;
          const attached = yield* service.ensure({
            threadId: folderThread,
            repository: "alpha",
            branch: "feature/login",
          });
          assert.equal(attached.status, "reused");
          assert.equal(attached.uncommittedFiles, 1);

          const refused = yield* service
            .removeWorktree({ cwd: fixture.alpha, path: worktreePath, force: true })
            .pipe(Effect.flip);
          assert.equal(refused._tag, "RepoWorktreeInUseError");
          assert.include(refused.message, '"Folder thread"');
          assert.equal(
            yield* fileSystem.readFileString(path.join(worktreePath, "draft.txt")),
            "draft\n",
          );

          yield* service.detach({ threadId: folderThread, worktreePath });
          yield* service.removeWorktree({ cwd: fixture.alpha, path: worktreePath, force: true });
          assert.isFalse(yield* fileSystem.exists(worktreePath));
        }),
      { linkedWorktreesDirectory: true },
    ),
  );

  it.effect("lets Files save in attached worktrees outside both folders until detached", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* RepoWorktreeService.RepoWorktreeService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outside = path.join(fixture.root, "outside");
        const alphaWorktree = path.join(outside, "alpha");
        const serverWorktree = path.join(outside, "server");
        const serverOther = path.join(outside, "server-other");
        yield* git(fixture.alpha, ["worktree", "add", "-b", "feature/external", alphaWorktree]);
        yield* git(fixture.server, ["worktree", "add", "-b", "feature/external", serverWorktree]);
        yield* git(fixture.server, ["worktree", "add", "-b", "feature/other", serverOther]);
        yield* fileSystem.writeFileString(path.join(alphaWorktree, "draft.txt"), "draft\n");
        const unrelated = path.join(fixture.root, "unrelated");
        const unrelatedWorktree = path.join(fixture.root, "unrelated-feature");
        yield* initRepo(unrelated);
        yield* git(unrelated, ["worktree", "add", "-b", "feature/x", unrelatedWorktree]);
        const linked = path.join(fixture.folder, "linked");
        yield* fileSystem.symlink(unrelated, linked);
        const plain = path.join(fixture.root, "plain");
        yield* fileSystem.makeDirectory(plain);

        // Bound by its own worktree path, which the folder project's Git list lacks.
        yield* createThreadIn({ branch: "feature/external", worktreePath: serverWorktree });
        const threadId = yield* createThread;
        const alpha = yield* service.ensure({
          threadId,
          repository: "alpha",
          branch: "feature/external",
        });
        assert.equal(alpha.status, "reused");
        assert.equal(alpha.uncommittedFiles, 1);
        assert.equal(alpha.repoWorktree.worktreePath, alphaWorktree);
        const server = yield* service.ensure({
          threadId,
          repository: "server",
          branch: "feature/external",
        });
        assert.equal(server.status, "reused");

        assert.equal(yield* saveReadme(fixture.folder, alphaWorktree), "saved");
        assert.equal(yield* saveReadme(fixture.folder, serverWorktree), "saved");
        assert.equal(
          yield* fileSystem.readFileString(path.join(alphaWorktree, "README.md")),
          "saved\n",
        );
        assert.equal(
          yield* fileSystem.readFileString(path.join(alphaWorktree, "draft.txt")),
          "draft\n",
        );

        // Records only the server writes, naming checkouts Git does not list for that repository.
        for (const [repositoryPath, worktreePath] of [
          [fixture.alpha, serverOther],
          [unrelated, unrelatedWorktree],
          [linked, unrelatedWorktree],
          [fixture.alpha, plain],
        ] as const) {
          const forged = yield* createThread;
          yield* threads.dispatch({
            type: "thread.repo-worktree.attach",
            commandId: CommandId.make(`attach:${forged}`),
            threadId: forged,
            repoWorktree: {
              repository: "forged",
              repositoryPath,
              worktreePath,
              branch: "forged",
              baseRef: null,
              origin: "reused",
              attachedAt: "2026-01-01T00:00:00.000Z",
            },
          });
          assert.equal(yield* saveReadme(fixture.folder, worktreePath), "refused");
        }

        yield* service.detach({ threadId, worktreePath: alphaWorktree });
        assert.equal(yield* saveReadme(fixture.folder, alphaWorktree), "refused");
        assert.equal(yield* saveReadme(fixture.folder, serverWorktree), "saved");
        yield* threads.dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`delete:${threadId}`),
          threadId,
        });
        assert.equal(yield* saveReadme(fixture.folder, serverWorktree), "refused");
      }),
    ),
  );
});
