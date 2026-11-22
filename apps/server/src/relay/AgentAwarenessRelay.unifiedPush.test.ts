import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentKeys from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as UnifiedPushDelivery from "../unifiedPush/UnifiedPushDelivery.ts";
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

const THREAD_ID = ThreadId.make("push-thread");
const PROJECT_ID = ProjectId.make("push-project");
const NOW = "2026-11-22T12:00:00.000Z";

const shell = (
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  activeRunId: null,
  latestVisibleMessage: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  lastVisitedAt: null,
  deletedAt: null,
  branch: null,
  linkedPullRequest: null,
  status: "running",
  activityRunStatus: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestRunId: null,
  latestRunRequestedAt: null,
  latestRunStartedAt: null,
  latestRunCompletedAt: null,
  latestUserMessageAt: null,
  createdAt: DateTime.makeUnsafe(NOW),
  updatedAt: DateTime.makeUnsafe(NOW),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  ...overrides,
});

describe("AgentAwarenessRelay UnifiedPush delivery", () => {
  it.effect("publishes a completion to UnifiedPush once while the relay is unlinked", () =>
    Effect.gen(function* () {
      const values = new Map<string, Uint8Array>();
      const secrets = ServerSecretStore.ServerSecretStore.of({
        get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
        set: (name, value) => Effect.sync(() => void values.set(name, value)),
        create: (name, value) => Effect.sync(() => void values.set(name, value)),
        remove: (name) => Effect.sync(() => void values.delete(name)),
        getOrCreateRandom: () => Effect.die("unused"),
      });
      const currentShell = yield* Ref.make(shell());
      const project = {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/workspace",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      };
      const pushed: Array<RelayAgentActivityState | null> = [];
      let relayRequests = 0;
      const fetch: typeof globalThis.fetch = Object.assign(
        () => {
          relayRequests += 1;
          return Promise.resolve(Response.json({ ok: true, deliveries: [] }));
        },
        { preconnect: () => {} },
      );
      const relay = yield* AgentAwarenessRelay.make.pipe(
        Effect.provide(EnvironmentKeys.layer),
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getAgentAwarenessSnapshot: () =>
                Ref.get(currentShell).pipe(
                  Effect.map((thread) => ({ snapshotSequence: 1, threads: [thread] })),
                ),
              listActiveShellIndex: () => Effect.succeed([]),
              streamDomainEvents: Stream.empty,
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: () => Effect.succeedSome(project),
            }),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("push-environment")),
            }),
          ),
        ),
        Effect.provideService(
          UnifiedPushDelivery.UnifiedPushDelivery,
          UnifiedPushDelivery.UnifiedPushDelivery.of({
            register: () => Effect.die("unused"),
            unregister: () => Effect.die("unused"),
            publish: (_threadId, state) => Effect.sync(() => void pushed.push(state)),
          }),
        ),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provide(NodeCrypto.layer),
      );
      const phases = () => pushed.map((state) => state?.phase ?? null);

      yield* relay.publishThread(THREAD_ID);
      assert.deepEqual(phases(), ["running"]);

      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      assert.deepEqual(phases(), ["running"]);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(phases(), ["running", "completed"]);

      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(phases(), ["running", "completed"]);
      assert.equal(relayRequests, 0);
    }),
  );
});
