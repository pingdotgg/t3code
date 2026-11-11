import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
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

const layerWithProject = (options: {
  readonly workspaceRoot?: string;
  readonly policy?: ManagedPolicySummary;
}) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(ServerSettings.layerTest({}, options.policy)),
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
            workspaceRoot: options.workspaceRoot ?? "/project-root",
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
  );

const layerTest = layerWithProject({});

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
});

// A project rooted in a repository subdirectory, with a thread in a worktree of
// that repository. A clone's `.git` is a directory and a worktree's is a file.
const makeSubdirectoryProject = Effect.fn(function* (options: {
  readonly worktreeIos: "directory" | "file" | "missing";
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "runtime-policy-subdir-" });
  const repoRoot = path.join(base, "repo");
  const worktreePath = path.join(base, "worktree");
  yield* fileSystem.makeDirectory(path.join(repoRoot, ".git"), { recursive: true });
  yield* fileSystem.makeDirectory(path.join(repoRoot, "ios"), { recursive: true });
  yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
  yield* fileSystem.writeFileString(path.join(worktreePath, ".git"), "gitdir: elsewhere\n");
  if (options.worktreeIos === "directory") {
    yield* fileSystem.makeDirectory(path.join(worktreePath, "ios"));
  }
  if (options.worktreeIos === "file") {
    yield* fileSystem.writeFileString(path.join(worktreePath, "ios"), "not a directory\n");
  }
  return { projectRoot: path.join(repoRoot, "ios"), worktreePath, path };
});

const resolveWorktreeCwd = (options: { readonly worktreeIos: "directory" | "file" | "missing" }) =>
  Effect.gen(function* () {
    const fixture = yield* makeSubdirectoryProject(options);
    const now = yield* DateTime.now;
    const resolved = yield* Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      return yield* policy.resolve({
        thread: makeThread({ now, worktreePath: fixture.worktreePath }),
        modelSelection,
      });
    }).pipe(Effect.provide(layerWithProject({ workspaceRoot: fixture.projectRoot })));
    return { cwd: resolved.cwd, ...fixture };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("starts worktree threads in the project's subdirectory of the worktree", () =>
  Effect.gen(function* () {
    const { cwd, worktreePath, path } = yield* resolveWorktreeCwd({ worktreeIos: "directory" });
    assert.equal(cwd, path.join(worktreePath, "ios"));
  }),
);

it.effect(
  "starts at the worktree root when its branch has no directory at the project's path",
  () =>
    Effect.gen(function* () {
      for (const worktreeIos of ["missing", "file"] as const) {
        const { cwd, worktreePath } = yield* resolveWorktreeCwd({ worktreeIos });
        assert.equal(cwd, worktreePath);
      }
    }),
);

it.layer(
  layerWithProject({
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
