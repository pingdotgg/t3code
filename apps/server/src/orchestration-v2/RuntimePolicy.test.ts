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
import * as Layer from "effect/Layer";
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

const layerWithPolicy = (policy?: ManagedPolicySummary) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(ServerSettings.layerTest({}, policy)),
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
            workspaceRoot: "/project-root",
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

const layerTest = layerWithPolicy();

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
      assert.equal(auto.runtimeMode, "auto-accept-edits");
      assert.equal(acpPermissionDisposition(auto, request), "ask");
      assert.equal(acpPermissionDisposition(yield* resolve("auto-accept-edits"), request), "ask");
      assert.equal(acpPermissionDisposition(yield* resolve("full-access"), request), "allow");
    }),
  );

  it.effect("steps an unsupported mode down to the broadest supported mode below it", () =>
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
