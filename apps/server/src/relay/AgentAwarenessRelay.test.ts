import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

const THREAD_ID = ThreadId.make("relay-thread");
const SECOND_THREAD_ID = ThreadId.make("relay-thread-2");
const PROJECT_ID = ProjectId.make("relay-project");
const NOW = "2026-09-04T12:00:00.000Z";

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
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
  };
}

const CHILD_THREAD_ID = ThreadId.make("relay-child-thread");

function waitingChild(
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return shell({
    id: CHILD_THREAD_ID,
    title: "Child",
    lineage: {
      rootThreadId: THREAD_ID,
      parentThreadId: THREAD_ID,
      relationshipToParent: "subagent",
    },
    createdBy: "agent",
    creationSource: "mcp",
    activityRunStatus: "running",
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("child-request"),
      kind: "command",
      createdAt: DateTime.makeUnsafe(NOW),
    },
    ...overrides,
  });
}

const PublishPayload = Schema.Struct({ state: Schema.NullOr(RelayAgentActivityState) });
const decodePublishPayload = Schema.decodeUnknownSync(Schema.fromJsonString(PublishPayload));
const unused = () => Effect.die("Unexpected test dependency call");

describe("startup agent activity", () => {
  it("publishes active work and only terminal runs completed after startup", () => {
    const startedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(NOW));
    const oldCompleted = ThreadId.make("old-completed");
    const newCompleted = ThreadId.make("new-completed");
    const oldFailed = ThreadId.make("old-failed");
    const newFailed = ThreadId.make("new-failed");
    const ids = AgentAwarenessRelay.resolveAgentAwarenessRelayActiveThreadIds({
      environmentId: EnvironmentId.make("relay-env"),
      startedAt,
      projects: [{ id: PROJECT_ID, title: "Project" }],
      threads: [
        shell(),
        shell({
          id: oldCompleted,
          status: "completed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T11:59:00.000Z"),
        }),
        shell({
          id: newCompleted,
          status: "completed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T12:00:01.000Z"),
        }),
        shell({
          id: oldFailed,
          status: "failed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T11:59:00.000Z"),
        }),
        shell({
          id: newFailed,
          status: "failed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T12:00:01.000Z"),
        }),
        shell({ id: ThreadId.make("idle"), status: "idle" }),
        shell({ id: ThreadId.make("missing-project"), projectId: ProjectId.make("missing") }),
      ],
    });
    assert.deepStrictEqual(ids, [THREAD_ID, newCompleted, newFailed]);
  });

  it("publishes a subagent waiting on the user so its parent is republished", () => {
    const ids = AgentAwarenessRelay.resolveAgentAwarenessRelayActiveThreadIds({
      environmentId: EnvironmentId.make("relay-env"),
      startedAt: DateTime.toEpochMillis(DateTime.makeUnsafe(NOW)),
      projects: [{ id: PROJECT_ID, title: "Project" }],
      threads: [shell({ status: "idle" }), waitingChild()],
    });
    assert.deepStrictEqual(ids, [CHILD_THREAD_ID]);
  });
});

const makeTestRelay = Effect.fnUntraced(function* (
  options: {
    readonly respond?: (attempt: number) => Response;
    readonly failSecretRead?: (name: string) => boolean;
    readonly linked?: boolean;
    readonly startupThreads?: ReadonlyArray<OrchestrationV2ThreadShell>;
    readonly readShell?: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null>;
    readonly domainEvents?: Stream.Stream<OrchestrationV2DomainEvent>;
  } = {},
) {
  const values = new Map<string, Uint8Array>(
    options.linked === false
      ? []
      : [
          [PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true")],
          [RELAY_URL_SECRET, new TextEncoder().encode("https://relay.example.test")],
          [RELAY_ISSUER_SECRET, new TextEncoder().encode("https://relay.example.test")],
          [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("credential-1")],
        ],
  );
  const secretReads: string[] = [];
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) =>
      Effect.suspend(() => {
        secretReads.push(name);
        if (options.failSecretRead?.(name)) {
          return Effect.fail(
            new ServerSecretStore.SecretStoreReadError({
              resource: name,
              cause: "temporary read failure",
            }),
          );
        }
        return Effect.succeed(Option.fromUndefinedOr(values.get(name)));
      }),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
    getOrCreateRandom: unused,
  });
  const currentShell = yield* Ref.make<OrchestrationV2ThreadShell | null>(shell());
  const shellReads: ThreadId[] = [];
  const catchUp = { shellSnapshotReads: 0 };
  const threads = ThreadManagementService.ThreadManagementService.of({
    getThreadShell: (threadId) =>
      Effect.sync(() => shellReads.push(threadId)).pipe(
        Effect.andThen(options.readShell?.(threadId) ?? Ref.get(currentShell)),
      ),
    getShellSnapshot: (input) =>
      Effect.sync(() => {
        catchUp.shellSnapshotReads += 1;
        return {
          schemaVersion: 2,
          snapshotSequence: 1,
          threads: (options.startupThreads ?? []).filter((thread) =>
            input?.threadIds?.includes(thread.id),
          ),
          archivedThreads: [],
        };
      }),
    listActiveSubagentThreadIds: unused,
    countThreads: unused,
    listActiveShellIndex: () =>
      Effect.succeed(
        (options.startupThreads ?? []).map((thread) => ({ ...thread, mayBeLive: true })),
      ),
    listOlderSettledThreads: unused,
    readShellSnapshot: unused,
    ensureLegacyTranscript: unused,
    dispatch: unused,
    searchThread: () => Effect.die("unused"),
    searchThreadStream: () => Stream.empty,
    getThreadHistoryPage: () => Effect.die("unused"),
    getTimelinePage: () => Effect.die("Unused timeline read"),
    getMessageCount: () => Effect.die("unused message count"),
    getTurnItem: () => Effect.die("unused turn item read"),
    getThreadRecords: () => Effect.die("unused record read"),
    getThreadProjection: unused,
    getCheckpointContext: unused,
    getThreadSnapshot: unused,
    getThreadTranscript: unused,
    getThreadSnapshotWindow: unused,
    getProjectThreadRecords: () => Effect.die("unused project record read"),
    listProjectThreads: unused,
    sendToThread: unused,
    assertProviderInstanceEnabled: unused,
    isProviderInstanceEnabledForProject: unused,
    hasReceipt: unused,
    waitForThread: unused,
    settleAfterRun: unused,
    settleThread: unused,
    interruptThread: unused,
    stopWorkflow: () => Effect.die("unused stopWorkflow"),
    forceStopThread: () => Effect.die("unused forceStopThread"),
    awaitBackgroundTasks: unused,
    stopDelegatedTasks: unused,
    getThreadEventSequence: unused,
    recoverDelegatedTask: unused,
    delegatedTaskResultPending: unused,
    streamStoredEvents: Stream.empty,
    streamStoredEventsFrom: () => Stream.empty,
    streamDomainEvents: options.domainEvents ?? Stream.empty,
  });
  const publications: Array<{
    readonly url: string;
    readonly authorization: string | null;
    readonly state: RelayAgentActivityState | null;
  }> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const body = init?.body;
      if (typeof body !== "string" && !(body instanceof Uint8Array)) {
        return Promise.reject(new Error("Expected a serialized activity publish payload"));
      }
      const payload = decodePublishPayload(
        typeof body === "string" ? body : new TextDecoder().decode(body),
      );
      publications.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        state: payload.state,
      });
      return Promise.resolve(
        options.respond?.(publications.length) ?? Response.json({ ok: true, deliveries: [] }),
      );
    },
    { preconnect: () => {} },
  );
  const relay = yield* AgentAwarenessRelay.make.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("relay-environment")),
      getDescriptor: unused(),
    }),
    Effect.provideService(ProjectService.ProjectService, {
      create: unused,
      bootstrap: unused,
      update: unused,
      delete: unused,
      getByWorkspaceRoot: unused,
      snapshot: Effect.succeed({ projects: [] } as never),
      listPage: unused,
      getShell: unused,
      listShells: unused,
      getById: () =>
        Effect.succeedSome({
          id: PROJECT_ID,
          title: "Project",
          workspaceRoot: "/workspace",
          defaultModelSelection: null,
          scripts: [],
          createdAt: NOW,
          updatedAt: NOW,
          deletedAt: null,
        }),
    }),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provide(NodeCrypto.layer),
  );
  return { relay, secrets, secretReads, currentShell, shellReads, publications, catchUp };
});

describe("AgentAwarenessRelay", () => {
  it.effect("publishes an approval already waiting at startup", () =>
    Effect.gen(function* () {
      const parent = shell({ status: "idle" });
      const child = waitingChild();
      const { relay, publications } = yield* makeTestRelay({
        startupThreads: [parent, child],
        readShell: (id) => Effect.succeed(id === child.id ? child : parent),
      });
      yield* relay.start();
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      assert.equal(publications[0]?.state?.threadId, THREAD_ID);
      assert.equal(publications[0]?.state?.phase, "waiting_for_approval");
    }).pipe(Effect.scoped),
  );

  it.effect("leaves coordinator-handled child questions out of phone activity", () =>
    Effect.gen(function* () {
      const child = waitingChild({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("child-question"),
          kind: "user_input",
          createdAt: DateTime.makeUnsafe(NOW),
        },
      });
      const { relay, publications } = yield* makeTestRelay({
        readShell: (id) => Effect.succeed(id === child.id ? child : shell()),
      });
      yield* relay.publishThread(THREAD_ID);
      yield* relay.publishThread(CHILD_THREAD_ID);
      assert.equal(publications.length, 1);
      assert.equal(publications[0]?.state?.phase, "running");
    }),
  );

  it.effect("publishes the parent as needing approval while its subagent waits", () =>
    Effect.gen(function* () {
      const shells = yield* Ref.make(
        new Map<ThreadId, OrchestrationV2ThreadShell>([
          [THREAD_ID, shell({ status: "completed" })],
          [CHILD_THREAD_ID, waitingChild({ pendingRuntimeRequest: null })],
        ]),
      );
      const setShell = (next: OrchestrationV2ThreadShell) =>
        Ref.update(shells, (current) => new Map(current).set(next.id, next));
      const { relay, publications } = yield* makeTestRelay({
        readShell: (threadId) =>
          Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
      });
      yield* setShell(shell({ status: "running" }));
      yield* relay.publishThread(THREAD_ID);
      yield* setShell(shell({ status: "completed" }));
      yield* setShell(waitingChild());
      yield* relay.publishThread(CHILD_THREAD_ID);
      assert.equal(publications.length, 2);
      assert.isTrue(publications[1]?.url.includes(`/threads/${THREAD_ID}/`) ?? false);
      assert.equal(publications[1]?.state?.phase, "waiting_for_approval");
      assert.equal(publications[1]?.state?.threadId, THREAD_ID);

      yield* setShell(waitingChild({ pendingRuntimeRequest: null }));
      yield* relay.publishThread(CHILD_THREAD_ID);
      assert.equal(publications.length, 2);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 3);
      assert.equal(publications[2]?.state?.phase, "completed");

      // Phones key alerts by phase and time, so a second wait needs a new time.
      yield* setShell(
        waitingChild({
          updatedAt: DateTime.makeUnsafe("2026-09-04T12:05:00.000Z"),
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("child-request-2"),
            kind: "command",
            createdAt: DateTime.makeUnsafe("2026-09-04T12:05:00.000Z"),
          },
        }),
      );
      yield* relay.publishThread(CHILD_THREAD_ID);
      assert.equal(publications.length, 4);
      assert.equal(publications[3]?.state?.phase, "waiting_for_approval");
      assert.equal(publications[3]?.state?.updatedAt, "2026-09-04T12:05:00.000Z");
      assert.notEqual(publications[3]?.state?.updatedAt, publications[1]?.state?.updatedAt);

      // With two pending requests, answering one shows the next, possibly an
      // older one, with no clear between.
      yield* setShell(
        waitingChild({
          updatedAt: DateTime.makeUnsafe("2026-09-04T12:06:00.000Z"),
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("child-request-3"),
            kind: "command",
            createdAt: DateTime.makeUnsafe("2026-09-04T12:04:00.000Z"),
          },
        }),
      );
      yield* relay.publishThread(CHILD_THREAD_ID);
      assert.equal(publications.length, 5);
      assert.equal(publications[4]?.state?.phase, "waiting_for_approval");
      assert.equal(publications[4]?.state?.updatedAt, "2026-09-04T12:06:00.000Z");
    }),
  );

  it.effect.each([
    { parentUpdatedAt: NOW, alertTime: "2026-09-04T12:05:00.000Z" },
    { parentUpdatedAt: "2026-09-04T12:10:00.000Z", alertTime: "2026-09-04T12:10:00.001Z" },
  ])(
    "announces overlapping child approvals with parent updated at $parentUpdatedAt",
    ({ parentUpdatedAt, alertTime }) =>
      Effect.gen(function* () {
        const secondChildId = ThreadId.make("relay-second-child-thread");
        const shells = yield* Ref.make(
          new Map<ThreadId, OrchestrationV2ThreadShell>([
            [THREAD_ID, shell({ updatedAt: DateTime.makeUnsafe(parentUpdatedAt) })],
            [CHILD_THREAD_ID, waitingChild()],
            [secondChildId, waitingChild({ id: secondChildId, pendingRuntimeRequest: null })],
          ]),
        );
        const { relay, publications } = yield* makeTestRelay({
          readShell: (threadId) =>
            Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
          respond: (attempt) =>
            attempt === 2
              ? new Response("unavailable", { status: 503 })
              : Response.json({ ok: true, deliveries: [] }),
        });
        yield* relay.publishThread(CHILD_THREAD_ID);
        assert.equal(publications[0]?.state?.phase, "waiting_for_approval");

        yield* Ref.update(shells, (current) =>
          new Map(current).set(
            secondChildId,
            waitingChild({
              id: secondChildId,
              updatedAt: DateTime.makeUnsafe("2026-09-04T12:05:00.000Z"),
              pendingRuntimeRequest: {
                id: RuntimeRequestId.make("second-child-request"),
                kind: "command",
                createdAt: DateTime.makeUnsafe("2026-09-04T12:05:00.000Z"),
              },
            }),
          ),
        );
        yield* relay.publishThread(secondChildId);
        assert.equal(publications.length, 2);
        assert.equal(publications[1]?.state?.updatedAt, alertTime);
        assert.notEqual(publications[1]?.state?.updatedAt, publications[0]?.state?.updatedAt);

        yield* TestClock.adjust("1 second");
        yield* relay.drain;
        assert.equal(publications.length, 3);
        assert.deepStrictEqual(publications[2]?.state, publications[1]?.state);
        yield* relay.publishThread(secondChildId);
        assert.equal(publications.length, 3);
      }),
  );

  it.effect("gives a child's next wait a new alert time after the parent republishes", () =>
    Effect.gen(function* () {
      const shells = yield* Ref.make(
        new Map<ThreadId, OrchestrationV2ThreadShell>([
          [THREAD_ID, shell({ updatedAt: DateTime.makeUnsafe("2026-09-04T12:10:00.000Z") })],
          [CHILD_THREAD_ID, waitingChild({ pendingRuntimeRequest: null })],
        ]),
      );
      const setChild = (next: OrchestrationV2ThreadShell) =>
        Ref.update(shells, (current) => new Map(current).set(CHILD_THREAD_ID, next));
      const { relay, publications } = yield* makeTestRelay({
        readShell: (threadId) =>
          Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
      });
      yield* relay.publishThread(THREAD_ID);
      yield* setChild(waitingChild());
      yield* relay.publishThread(CHILD_THREAD_ID);
      yield* setChild(waitingChild({ pendingRuntimeRequest: null }));
      yield* relay.publishThread(CHILD_THREAD_ID);
      yield* setChild(
        waitingChild({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("child-request-2"),
            kind: "command",
            createdAt: DateTime.makeUnsafe(NOW),
          },
        }),
      );
      yield* relay.publishThread(CHILD_THREAD_ID);
      assert.deepStrictEqual(
        publications.map(({ state }) => state?.phase),
        ["running", "waiting_for_approval", "running", "waiting_for_approval"],
      );
      assert.notEqual(publications[3]?.state?.updatedAt, publications[1]?.state?.updatedAt);
    }),
  );

  it.effect("announces equal-timestamp child requests in request-change order", () =>
    Effect.gen(function* () {
      const secondChildId = ThreadId.make("relay-second-child-thread");
      const shells = yield* Ref.make(
        new Map<ThreadId, OrchestrationV2ThreadShell>([
          [THREAD_ID, shell()],
          [CHILD_THREAD_ID, waitingChild()],
          [secondChildId, waitingChild({ id: secondChildId, pendingRuntimeRequest: null })],
        ]),
      );
      const setRequest = (childId: ThreadId, requestId: string, updatedAt = NOW) =>
        Ref.update(shells, (current) =>
          new Map(current).set(
            childId,
            waitingChild({
              id: childId,
              updatedAt: DateTime.makeUnsafe(updatedAt),
              pendingRuntimeRequest: {
                id: RuntimeRequestId.make(requestId),
                kind: "command",
                createdAt: DateTime.makeUnsafe(updatedAt),
              },
            }),
          ),
        );
      const { relay, publications } = yield* makeTestRelay({
        readShell: (threadId) =>
          Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
      });
      yield* relay.publishThread(CHILD_THREAD_ID);
      yield* setRequest(secondChildId, "second-child-request");
      yield* relay.publishThread(secondChildId);
      assert.equal(publications.length, 2);

      yield* setRequest(CHILD_THREAD_ID, "first-child-replacement");
      yield* relay.publishThread(CHILD_THREAD_ID);
      assert.equal(publications.length, 3);

      yield* setRequest(secondChildId, "second-child-replacement");
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 4);
      assert.equal(new Set(publications.map(({ state }) => state?.updatedAt)).size, 4);

      yield* relay.publishThread(CHILD_THREAD_ID);
      yield* setRequest(CHILD_THREAD_ID, "older-request", "2026-09-04T11:59:00.000Z");
      yield* relay.publishThread(CHILD_THREAD_ID);
      assert.equal(publications.length, 4);
    }),
  );

  it.effect(
    "does not republish a parent waiting on its own request when a child's comes and goes",
    () =>
      Effect.gen(function* () {
        const parentWaiting = shell({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("parent-request"),
            kind: "command",
            createdAt: DateTime.makeUnsafe(NOW),
          },
        });
        const shells = yield* Ref.make(
          new Map<ThreadId, OrchestrationV2ThreadShell>([
            [THREAD_ID, parentWaiting],
            [CHILD_THREAD_ID, waitingChild({ pendingRuntimeRequest: null })],
          ]),
        );
        const { relay, publications } = yield* makeTestRelay({
          readShell: (threadId) =>
            Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
        });
        yield* relay.publishThread(THREAD_ID);
        assert.equal(publications[0]?.state?.phase, "waiting_for_approval");

        yield* Ref.update(shells, (current) =>
          new Map(current).set(CHILD_THREAD_ID, waitingChild()),
        );
        yield* relay.publishThread(CHILD_THREAD_ID);
        yield* Ref.update(shells, (current) =>
          new Map(current).set(CHILD_THREAD_ID, waitingChild({ pendingRuntimeRequest: null })),
        );
        yield* relay.publishThread(CHILD_THREAD_ID);
        assert.equal(publications.length, 1);
      }),
  );

  it.effect(
    "retries a parent publish for a new subagent request after earlier retries ran out",
    () =>
      Effect.gen(function* () {
        const shells = yield* Ref.make(
          new Map<ThreadId, OrchestrationV2ThreadShell>([
            [THREAD_ID, shell()],
            [CHILD_THREAD_ID, waitingChild({ pendingRuntimeRequest: null })],
          ]),
        );
        const { relay, publications } = yield* makeTestRelay({
          readShell: (threadId) =>
            Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
          respond: (attempt) =>
            attempt <= 7
              ? new Response("unavailable", { status: 503 })
              : Response.json({ ok: true, deliveries: [] }),
        });
        yield* relay.publishThread(THREAD_ID);
        for (const delay of [
          "1 second",
          "2 seconds",
          "4 seconds",
          "8 seconds",
          "16 seconds",
        ] as const) {
          yield* TestClock.adjust(delay);
          yield* relay.drain;
        }
        assert.equal(publications.length, 6);

        yield* Ref.update(shells, (current) =>
          new Map(current).set(CHILD_THREAD_ID, waitingChild()),
        );
        yield* relay.publishThread(CHILD_THREAD_ID);
        assert.equal(publications.length, 7);
        yield* TestClock.adjust("1 second");
        yield* relay.drain;
        assert.equal(publications.length, 8);
        assert.equal(publications[7]?.state?.phase, "waiting_for_approval");
      }),
  );

  it.effect("keeps a subagent request that started while publishing was off", () =>
    Effect.gen(function* () {
      const shells = yield* Ref.make(
        new Map<ThreadId, OrchestrationV2ThreadShell>([
          [THREAD_ID, shell()],
          [CHILD_THREAD_ID, waitingChild({ pendingRuntimeRequest: null })],
        ]),
      );
      const { relay, secrets, publications } = yield* makeTestRelay({
        readShell: (threadId) =>
          Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
      });
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications[0]?.state?.phase, "running");

      yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
      yield* Ref.update(shells, (current) => new Map(current).set(CHILD_THREAD_ID, waitingChild()));
      yield* relay.publishThread(CHILD_THREAD_ID);
      yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true"));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state?.phase, "waiting_for_approval");
    }),
  );

  it.effect(
    "keeps a subagent request that started while publishing was off after an empty startup",
    () =>
      Effect.gen(function* () {
        const shells = yield* Ref.make(
          new Map<ThreadId, OrchestrationV2ThreadShell>([
            [THREAD_ID, shell()],
            [CHILD_THREAD_ID, waitingChild({ pendingRuntimeRequest: null })],
          ]),
        );
        const { relay, secrets, publications, catchUp } = yield* makeTestRelay({
          readShell: (threadId) =>
            Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
        });
        yield* relay.start();
        yield* TestClock.adjust("1 second");
        assert.equal(catchUp.shellSnapshotReads, 1);
        assert.equal(publications.length, 0);

        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
        yield* Ref.update(shells, (current) =>
          new Map(current).set(CHILD_THREAD_ID, waitingChild()),
        );
        yield* relay.publishThread(CHILD_THREAD_ID);
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true"));
        yield* relay.publishThread(THREAD_ID);
        assert.equal(publications[0]?.state?.phase, "waiting_for_approval");
      }).pipe(Effect.scoped),
  );

  it.effect("drops a subagent request that cleared while publishing was off", () =>
    Effect.gen(function* () {
      const shells = yield* Ref.make(
        new Map<ThreadId, OrchestrationV2ThreadShell>([
          [THREAD_ID, shell()],
          [CHILD_THREAD_ID, waitingChild()],
        ]),
      );
      const { relay, secrets, publications } = yield* makeTestRelay({
        readShell: (threadId) =>
          Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
      });
      yield* relay.publishThread(CHILD_THREAD_ID);
      assert.equal(publications[0]?.state?.phase, "waiting_for_approval");

      yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
      yield* Ref.update(shells, (current) =>
        new Map(current).set(CHILD_THREAD_ID, waitingChild({ pendingRuntimeRequest: null })),
      );
      yield* relay.publishThread(CHILD_THREAD_ID);
      yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true"));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state?.phase, "running");
    }),
  );

  it.effect("coalesces queued updates and reruns a thread dirtied during publishing", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const rerunStarted = yield* Deferred.make<void>();
      const releaseRerun = yield* Deferred.make<void>();
      const processed: Array<{ threadId: ThreadId; revision: number }> = [];
      let revision = 1;
      const worker = yield* AgentAwarenessRelay.makeAgentAwarenessPublishWorker((threadId) =>
        Effect.gen(function* () {
          const currentRevision = revision;
          const index = processed.length;
          processed.push({ threadId, revision: currentRevision });
          if (index === 0) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          } else if (threadId === THREAD_ID) {
            yield* Deferred.succeed(rerunStarted, undefined);
            yield* Deferred.await(releaseRerun);
          }
        }),
      );
      yield* worker.enqueue(THREAD_ID);
      yield* Deferred.await(started);
      revision = 2;
      for (let i = 0; i < 100; i++) {
        yield* worker.enqueue(SECOND_THREAD_ID);
        yield* worker.enqueue(THREAD_ID);
      }
      const drained = yield* Deferred.make<void>();
      const draining = yield* worker.drain.pipe(
        Effect.andThen(Deferred.succeed(drained, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(rerunStarted);
      assert.isFalse(yield* Deferred.isDone(drained));
      yield* Deferred.succeed(releaseRerun, undefined);
      yield* Fiber.join(draining);
      assert.deepEqual(processed, [
        { threadId: THREAD_ID, revision: 1 },
        { threadId: SECOND_THREAD_ID, revision: 2 },
        { threadId: THREAD_ID, revision: 2 },
      ]);
    }),
  );

  it.effect("deduplicates state and republishes title changes", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(
        currentShell,
        shell({ updatedAt: DateTime.makeUnsafe("2026-09-04T13:00:00Z") }),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      yield* Ref.set(currentShell, shell({ title: "Renamed thread" }));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state?.threadTitle, "Renamed thread");
    }),
  );

  it.effect("republishes unchanged state with fresh credentials after relinking", () =>
    Effect.gen(function* () {
      const { relay, secrets, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* secrets.set(
        RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        new TextEncoder().encode("credential-2"),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[0]?.authorization, "Bearer credential-1");
      assert.equal(publications[1]?.authorization, "Bearer credential-2");
      yield* secrets.set(
        RELAY_URL_SECRET,
        new TextEncoder().encode("https://new-relay.example.test"),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 3);
      assert.isTrue(publications[2]?.url.startsWith("https://new-relay.example.test/") ?? false);
    }),
  );

  it.effect.each(["completed", "failed"] as const)(
    "publishes a tombstone when a %s thread is settled through a domain event",
    (status) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const pulls = yield* Queue.unbounded<void>();
        const { relay, currentShell, publications } = yield* makeTestRelay({
          domainEvents: Stream.fromEffectRepeat(
            Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
          ),
        });
        yield* relay.start();
        yield* Queue.take(pulls);
        yield* relay.publishThread(THREAD_ID);
        const terminal = shell({ status });
        yield* Ref.set(currentShell, terminal);
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.equal(publications[1]?.state?.phase, status);

        const now = yield* DateTime.now;
        const settled = {
          ...terminal,
          settledOverride: "settled" as const,
          settledAt: now,
          lastVisitedAt: null,
        };
        yield* Ref.set(currentShell, settled);
        yield* Queue.offer(events, {
          id: EventId.make("event:settled"),
          type: "thread.settled",
          threadId: THREAD_ID,
          occurredAt: now,
          payload: settled,
        });
        yield* Queue.take(pulls);
        yield* relay.drain;
        assert.equal(publications.length, 2);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.equal(publications.length, 3);
        assert.equal(publications[2]?.state, null);
      }).pipe(Effect.scoped),
  );

  it.effect("holds a completion through a continuation gap, then publishes it once", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell());
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running"],
      );

      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running", "completed"],
      );
    }),
  );

  it.effect("still publishes a completion when the thread settles during the hold", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      const completed = shell({ status: "completed" });
      yield* Ref.set(currentShell, completed);
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, {
        ...completed,
        settledOverride: "settled",
        settledAt: yield* DateTime.now,
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed"],
      );

      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed", null],
      );
    }),
  );

  it.effect("drops a held completion when a queued continuation hides the thread", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell({ status: "queued" }));
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.notInclude(
        publications.map((publication) => publication.state?.phase ?? null),
        "completed",
      );
    }),
  );

  it.effect("retries a failed completion even after the thread settles", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay({
        respond: (attempt) =>
          attempt === 2
            ? new Response("unavailable", { status: 503 })
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* relay.publishThread(THREAD_ID);
      const completed = shell({ status: "completed" });
      yield* Ref.set(currentShell, completed);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      yield* Ref.set(currentShell, {
        ...completed,
        settledOverride: "settled",
        settledAt: yield* DateTime.now,
        lastVisitedAt: null,
      });
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed", "completed"],
      );

      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.at(-1)?.state ?? null, null);
    }),
  );

  it.effect("keeps settled live work until its awaited monitor finishes", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      const held = shell({
        status: "completed",
        settledOverride: "settled",
        pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }],
      });
      yield* Ref.set(currentShell, held);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      assert.equal(publications[0]?.state?.phase, "running");

      yield* Ref.set(currentShell, { ...held, pendingBackgroundTasks: [] });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state, null);
    }),
  );
  it.effect("publishes a held completion when its background item ends, not on tool output", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const pulls = yield* Queue.unbounded<void>();
      const { relay, shellReads, publications } = yield* makeTestRelay({
        readShell: (threadId) => store.getThreadShell(threadId).pipe(Effect.orDie),
        domainEvents: Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
        ),
      });
      yield* relay.start();
      yield* Queue.take(pulls);
      const deliver = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
        yield* store.apply(event);
        yield* Queue.offer(events, event);
        yield* Queue.take(pulls);
        yield* relay.drain;
      });

      const now = yield* DateTime.now;
      const runId = RunId.make("run:held-item");
      const run = {
        id: runId,
        threadId: THREAD_ID,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        providerThreadId: null,
        userMessageId: MessageId.make("message:held-item"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const item = (
        id: string,
        fields: Pick<OrchestrationV2TurnItem, "status"> &
          (
            | { readonly type: "dynamic_tool"; readonly toolName: string; readonly input: unknown }
            | {
                readonly type: "assistant_message";
                readonly messageId: MessageId;
                readonly text: string;
                readonly streaming: boolean;
              }
          ),
      ): OrchestrationV2TurnItem => ({
        id: TurnItemId.make(id),
        threadId: THREAD_ID,
        runId,
        nodeId: NodeId.make("node:held-item"),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        ...fields,
      });
      const itemEvent = (id: string, payload: OrchestrationV2TurnItem) =>
        ({
          id: EventId.make(id),
          type: "turn-item.updated",
          threadId: THREAD_ID,
          runId,
          occurredAt: now,
          payload,
        }) satisfies OrchestrationV2DomainEvent;
      const background = { type: "dynamic_tool" as const, toolName: "watch", input: {} };

      yield* deliver({
        id: EventId.make("event:held-item:thread"),
        type: "thread.created",
        threadId: THREAD_ID,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Thread",
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* deliver({
        id: EventId.make("event:held-item:run"),
        type: "run.created",
        threadId: THREAD_ID,
        runId,
        occurredAt: now,
        payload: run,
      });
      yield* deliver(
        itemEvent("event:held-item:tool", item("item:tool", { ...background, status: "running" })),
      );
      yield* deliver({
        id: EventId.make("event:held-item:run-completed"),
        type: "run.updated",
        threadId: THREAD_ID,
        runId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running"],
      );

      const readsBeforeOutput = shellReads.length;
      yield* deliver(
        itemEvent(
          "event:held-item:reply",
          item("item:reply", {
            type: "assistant_message",
            messageId: MessageId.make("message:held-item:reply"),
            text: "Still watching",
            streaming: true,
            status: "running",
          }),
        ),
      );
      yield* deliver(
        itemEvent("event:held-item:tick", item("item:tool", { ...background, status: "running" })),
      );
      assert.equal(shellReads.length, readsBeforeOutput);

      yield* deliver(
        itemEvent("event:held-item:end", item("item:tool", { ...background, status: "completed" })),
      );
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running", "completed"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    ),
  );
});
