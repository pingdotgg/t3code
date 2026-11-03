import { assert, describe, it } from "@effect/vitest";
import {
  type ManagedPolicySummary,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  type ProjectTrackedFolder,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import {
  type ThreadRepository,
  type ThreadWorkspace,
  WorkspaceRepositories,
} from "../workspace/WorkspaceRepositories.ts";
import { TaskFolderStore } from "../workspace/TaskFolders.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

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

const makeLayer = (input: {
  readonly workspaceRoot: string;
  readonly trackedFolders?: ReadonlyArray<ProjectTrackedFolder>;
  readonly workspace?: ThreadWorkspace;
  /** Provides a task folder store that records this workspace's task folder. */
  readonly recordTaskFolder?: boolean;
  readonly policy?: ManagedPolicySummary;
}) => {
  const workspace = input.workspace;
  const taskFolder = workspace?.taskFolder ?? null;
  return RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(ServerSettings.layerTest({}, input.policy)),
    Layer.provide(
      input.recordTaskFolder === true && taskFolder !== null
        ? Layer.mock(TaskFolderStore)({ findContaining: () => Effect.succeedSome(taskFolder) })
        : Layer.empty,
    ),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeedSome({
            projectId,
            title: "Project",
            workspaceRoot: input.workspaceRoot,
            trackedFolders: input.trackedFolders ?? [],
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            pinnedAt: null,
            archivedAt: null,
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
      }),
    ),
    Layer.provide(
      // Without a workspace, a call fails the test: single-repo threads must not look up repos.
      Layer.mock(WorkspaceRepositories)(
        workspace === undefined ? {} : { resolveThreadWorkspace: () => Effect.succeed(workspace) },
      ),
    ),
    Layer.provide(Path.layer),
  );
};

const repository = (
  name: string,
  cwd: string,
  originalPath: string,
  relativePath: string,
  kind: ThreadRepository["kind"] = "repository",
): ThreadRepository => ({ name, cwd, originalPath, relativePath, kind });

it.layer(makeLayer({ workspaceRoot: "/project-root" }))("RuntimePolicyV2", (it) => {
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
});

it.layer(
  makeLayer({
    workspaceRoot: "/project-root",
    policy: {
      organization: "Example Corp",
      lockedSettings: [],
      limits: { maxRuntimeMode: "auto-accept-edits" },
    },
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

const resolvePolicy = (worktreePath: string | null) =>
  Effect.gen(function* () {
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    return yield* policy.resolve({
      thread: makeThread({ now: yield* DateTime.now, worktreePath }),
      modelSelection,
    });
  });

describe("RuntimePolicyV2 workspace", () => {
  it.effect("keeps single-repo policies to today's fields without a repo lookup", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* resolvePolicy(null), {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/work/web",
      });
      assert.deepStrictEqual(yield* resolvePolicy("/worktrees/web/fix"), {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/worktrees/web/fix",
      });
    }).pipe(Effect.provide(makeLayer({ workspaceRoot: "/work/web" }))),
  );

  it.effect("gives a local thread its other checkouts and lists references read-only", () =>
    Effect.gen(function* () {
      const policy = yield* resolvePolicy(null);
      assert.deepStrictEqual(policy.workspace, {
        repositories: [
          { name: "web", path: "/work/web" },
          { name: "ui", path: "/work/web/packages/ui" },
          { name: "api", path: "/work/api" },
        ],
        referenceFolders: [{ name: "design", path: "/notes/design" }],
        // The child repo is inside the cwd, and references are never writable.
        extraRoots: ["/work/api"],
        relativePathsDiffer: false,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          workspaceRoot: "/work/web",
          trackedFolders: [
            { path: "/work/web/packages/ui", name: "ui" },
            { path: "/work/api", name: "api" },
            { path: "/notes/design", name: "design" },
          ],
          workspace: {
            cwd: "/work/web",
            repositories: [
              repository("web", "/work/web", "/work/web", "", "home"),
              repository("ui", "/work/web/packages/ui", "/work/web/packages/ui", "packages/ui"),
              repository("api", "/work/api", "/work/api", "../api"),
            ],
            references: [{ name: "design", path: "/notes/design" }],
            taskFolder: null,
          },
        }),
      ),
    ),
  );

  it.effect("gives a task folder thread its worktrees and never the original checkouts", () =>
    Effect.gen(function* () {
      const policy = yield* resolvePolicy("/tasks/fix/web");
      assert.deepStrictEqual(policy.workspace?.extraRoots, ["/tasks/fix/api"]);
      // `../api` from the web worktree is not `../../srv/api` from the original web checkout.
      assert.isTrue(policy.workspace?.relativePathsDiffer);
    }).pipe(
      Effect.provide(
        makeLayer({
          workspaceRoot: "/work/web",
          trackedFolders: [
            { path: "/srv/api", name: "api" },
            { path: "/srv/tools", name: "tools" },
          ],
          workspace: {
            cwd: "/tasks/fix/web",
            repositories: [
              repository("web", "/tasks/fix/web", "/work/web", "", "home"),
              repository("api", "/tasks/fix/api", "/srv/api", "../api"),
              repository("tools", "/srv/tools", "/srv/tools", "../../../srv/tools"),
            ],
            references: [],
            taskFolder: {
              root: "/tasks/fix",
              projectId,
              homeWorktreePath: "/tasks/fix/web",
              repositories: [],
              createdAt: "2026-06-21T00:00:00.000Z",
              updatedAt: "2026-06-21T00:00:00.000Z",
            },
          },
        }),
      ),
    ),
  );

  it.effect("keeps a task folder's repos after the project stops tracking them", () =>
    Effect.gen(function* () {
      const policy = yield* resolvePolicy("/tasks/fix/web");
      assert.deepStrictEqual(policy.workspace?.extraRoots, ["/tasks/fix/api"]);
    }).pipe(
      Effect.provide(
        makeLayer({
          workspaceRoot: "/work/web",
          trackedFolders: [],
          recordTaskFolder: true,
          workspace: {
            cwd: "/tasks/fix/web",
            repositories: [
              repository("web", "/tasks/fix/web", "/work/web", "", "home"),
              repository("api", "/tasks/fix/api", "/work/web/api", "api"),
            ],
            references: [],
            taskFolder: {
              root: "/tasks/fix",
              projectId,
              homeWorktreePath: "/tasks/fix/web",
              repositories: [],
              createdAt: "2026-06-21T00:00:00.000Z",
              updatedAt: "2026-06-21T00:00:00.000Z",
            },
          },
        }),
      ),
    ),
  );
});
