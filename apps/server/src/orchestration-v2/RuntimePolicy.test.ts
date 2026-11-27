import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ManagedPolicySummary,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";
import * as TaskFolderStore from "../workspace/TaskFolderStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const antigravityInstanceId = ProviderInstanceId.make("antigravity");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
  [antigravityInstanceId, ["approval-required", "auto-accept-edits", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const projectAndProviderLayers = Layer.mergeAll(
  Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
    listInstances: Effect.succeed([]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  }),
  Layer.mock(ProjectStore.ProjectStoreV2)({
    get: () =>
      Effect.succeedSome({
        projectId,
        title: "Project",
        workspaceRoot: "/project-root",
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        hasCustomTitle: false,
        autoPull: false,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        trackedFolders: [],
        pinnedAt: null,
        archivedAt: null,
        createdAt: "2026-06-21T00:00:00.000Z",
        updatedAt: "2026-06-21T00:00:00.000Z",
        deletedAt: null,
      }),
  }),
);

const noWorkspace = { folders: [], extraRoots: [] };
const trackedWorkspace = {
  folders: [
    { name: "api", path: "/project-root/api", isGitRepository: true },
    { name: "docs", path: "/elsewhere/docs", isGitRepository: false },
  ],
  extraRoots: ["/elsewhere/docs"],
};

const layerWorkspaceFoldersTest = Layer.mock(WorkspaceFolders.WorkspaceFolders)({
  forThread: (input) =>
    Effect.succeed(input.worktreePath === null ? trackedWorkspace : noWorkspace),
});

const layerWithPolicy = (
  policy?: ManagedPolicySummary,
  layerWorkspaceFolders: Layer.Layer<WorkspaceFolders.WorkspaceFolders> = layerWorkspaceFoldersTest,
) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(Layer.mergeAll(projectAndProviderLayers, ServerSettings.layerTest({}, policy))),
    Layer.provide(layerWorkspaceFolders),
  );

const layerTest = layerWithPolicy();

// The real folder resolution over a recorded task folder, for a project that tracks `/tracked/api`.
const layerTaskFolderStore = TaskFolderStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(NodeServices.layer),
);
const layerTaskFolderPolicy = layerWithPolicy(
  undefined,
  WorkspaceFolders.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerTaskFolderStore,
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeedSome({
              projectId,
              workspaceRoot: "/project-root",
              trackedFolders: [{ name: "api", path: "/tracked/api" }],
            } as never),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.orDie,
  ),
).pipe(Layer.provideMerge(layerTaskFolderStore));

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("asks for Antigravity command approval when a stored Auto thread falls back", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolve = (runtimeMode: RuntimeMode) =>
        policy.resolve({
          thread: makeThread({ now, worktreePath: null, runtimeMode }),
          modelSelection: { instanceId: antigravityInstanceId, model: "test-model" },
        });
      const request = {
        sessionId: "session-1",
        toolCall: { toolCallId: "command-1", title: "Run command", kind: "execute" as const },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
      };
      const auto = yield* resolve("auto");
      assert.equal(auto.runtimeMode, "approval-required");
      assert.equal(acpPermissionDisposition(auto, request), "ask");
      assert.equal(acpPermissionDisposition(yield* resolve("auto-accept-edits"), request), "ask");
      assert.equal(acpPermissionDisposition(yield* resolve("full-access"), request), "allow");
    }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );

  it.effect("carries tracked folders only for a thread in the project's own checkout", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolve = (worktreePath: string | null) =>
        policy.resolve({ thread: makeThread({ now, worktreePath }), modelSelection });

      assert.deepEqual((yield* resolve(null)).workspace, trackedWorkspace);
      assert.notProperty(yield* resolve("/work"), "workspace");
    }),
  );
});

it.layer(layerTaskFolderPolicy)("RuntimePolicyV2 in a task folder", (it) => {
  it.effect("reaches the task folder's worktrees, never the checkouts they were made from", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const taskFolders = yield* TaskFolderStore.TaskFolderStore;
      const worktreePath = "/worktrees/task/project-root";
      yield* taskFolders.put({
        root: "/worktrees/task",
        projectId,
        projectRoot: "/project-root",
        anchor: "/",
        projectPath: worktreePath,
        projectIsWorktree: true,
        repositories: [
          {
            repositoryPath: "/tracked/api",
            worktreePath: "/worktrees/task/tracked/api",
            name: "api",
          },
        ],
      });

      const { workspace } = yield* policy.resolve({
        thread: makeThread({ now: yield* DateTime.now, worktreePath }),
        modelSelection,
      });

      assert.deepEqual(
        { folders: workspace?.folders.map((folder) => folder.path), roots: workspace?.extraRoots },
        { folders: ["/worktrees/task/tracked/api"], roots: ["/worktrees/task/tracked/api"] },
      );
    }),
  );
});

it.effect("resolves VCS hints in the thread workspace and honors live settings", () =>
  Effect.gen(function* () {
    let settings = DEFAULT_SERVER_SETTINGS;
    const detected: string[] = [];
    const observedAt = yield* DateTime.now;
    const driver = yield* VcsDriver.VcsDriver.pipe(
      Effect.provide(
        Layer.mock(VcsDriver.VcsDriver)({
          agentContextHint: "Use jj for this workspace.",
          checkpoints: {
            captureCheckpoint: () => Effect.die("unexpected checkpoint capture"),
            resolveCleanHead: () => Effect.die("unexpected clean HEAD lookup"),
            captureHeadCheckpoint: () => Effect.die("unexpected HEAD checkpoint capture"),
            hasCheckpointRef: () => Effect.die("unexpected checkpoint lookup"),
            copyCheckpointRef: () => Effect.die("unexpected checkpoint copy"),
            restoreCheckpoint: () => Effect.die("unexpected checkpoint restore"),
            diffCheckpoints: () => Effect.die("unexpected checkpoint diff"),
            listAuthoredPaths: () => Effect.die("unexpected authored paths lookup"),
            deleteCheckpointRefs: () => Effect.die("unexpected checkpoint deletion"),
          },
          capabilities: {
            kind: "jj",
            supportsWorktrees: true,
            supportsBookmarks: true,
            supportsAtomicSnapshot: true,
            supportsPushDefaultRemote: true,
            ignoreClassifier: "native",
          },
        }),
      ),
    );
    const dependencies = Layer.mergeAll(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.sync(() => settings),
      }),
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: ({ cwd }) => {
          detected.push(cwd);
          return Effect.succeed({
            kind: "jj",
            repository: {
              kind: "jj",
              rootPath: cwd,
              metadataPath: null,
              freshness: { source: "live-local", observedAt, expiresAt: Option.none() },
            },
            driver,
          });
        },
      }),
    );
    yield* Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const thread = makeThread({ now: yield* DateTime.now, worktreePath: "/jj-workspace" });
      assert.equal(
        (yield* policy.resolve({ thread, modelSelection })).vcsAgentHint,
        "Use jj for this workspace.",
      );
      settings = {
        ...settings,
        projectSettingsOverrides: { [projectId]: { enableVcsAgentHints: false } },
      };
      assert.equal((yield* policy.resolve({ thread, modelSelection })).vcsAgentHint, undefined);
      assert.deepEqual(detected, ["/jj-workspace"]);
    }).pipe(
      Effect.provide(
        RuntimePolicy.layerFromProjectStore.pipe(
          Layer.provide(Layer.mergeAll(projectAndProviderLayers, dependencies)),
          Layer.provide(layerWorkspaceFoldersTest),
        ),
      ),
    );
  }),
);
it.layer(
  layerWithPolicy({
    organization: "Example Corp",
    lockedSettings: [],
    limits: { maxRuntimeMode: "auto-accept-edits" },
  }),
)("RuntimePolicyV2 under a runtime mode ceiling", (it) => {
  it.effect("refuses to start a turn above the ceiling, such as one resumed after a restart", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolve = (runtimeMode: RuntimeMode) =>
        policy.resolve({
          thread: makeThread({ now, worktreePath: "/work", runtimeMode }),
          modelSelection,
        });

      const refused = yield* resolve("full-access").pipe(Effect.flip);
      assert.equal(refused._tag, "RuntimePolicyAboveCeilingError");
      assert.equal(
        refused.message,
        "Example Corp limits threads to Auto-accept edits. Switch this thread's mode to continue.",
      );
      const allowed = yield* resolve("auto-accept-edits");
      assert.equal(allowed.runtimeMode, "auto-accept-edits");
      assert.equal(allowed.maxRuntimeMode, "auto-accept-edits");
    }),
  );
});
