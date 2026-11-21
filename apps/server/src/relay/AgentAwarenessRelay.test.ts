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

import * as EnvironmentKeys from "../cloud/environmentKeys.ts";
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
    const muteEnded = ThreadId.make("mute-ended");
    const ids = AgentAwarenessRelay.resolveAgentAwarenessRelayActiveThreadIds({
      environmentId: EnvironmentId.make("relay-env"),
      startedAt,
      now: startedAt,
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
        shell({ id: ThreadId.make("muted"), mutedAt: DateTime.makeUnsafe(NOW) }),
        shell({
          id: ThreadId.make("muted-for-now"),
          mutedAt: DateTime.makeUnsafe("2026-09-04T11:00:00.000Z"),
          mutedUntil: DateTime.makeUnsafe("2026-09-04T13:00:00.000Z"),
        }),
        shell({
          id: muteEnded,
          mutedAt: DateTime.makeUnsafe("2026-09-04T11:00:00.000Z"),
          mutedUntil: DateTime.makeUnsafe("2026-09-04T11:30:00.000Z"),
        }),
      ],
    });
    assert.deepStrictEqual(ids, [THREAD_ID, newCompleted, newFailed, muteEnded]);
  });

  it("reads mutes at the catch-up, not at startup", () => {
    const startedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(NOW));
    const later = startedAt + 60 * 60 * 1000;
    const threads = [
      shell({
        mutedAt: DateTime.makeUnsafe("2026-09-04T11:00:00.000Z"),
        mutedUntil: DateTime.makeUnsafe("2026-09-04T12:30:00.000Z"),
      }),
    ];
    const resolve = (now: number) =>
      AgentAwarenessRelay.resolveAgentAwarenessRelayActiveThreadIds({
        environmentId: EnvironmentId.make("relay-env"),
        startedAt,
        now,
        projects: [{ id: PROJECT_ID, title: "Project" }],
        threads,
      });
    assert.deepStrictEqual(resolve(startedAt), []);
    assert.deepStrictEqual(resolve(later), [THREAD_ID]);
    assert.deepStrictEqual(
      AgentAwarenessRelay.resolveAgentAwarenessRelayMuteEnds({ now: startedAt, threads }),
      [
        [
          THREAD_ID,
          {
            endMs: Date.parse("2026-09-04T12:30:00.000Z"),
            mutedAtMs: Date.parse("2026-09-04T11:00:00.000Z"),
          },
        ],
      ],
    );
    assert.deepStrictEqual(
      AgentAwarenessRelay.resolveAgentAwarenessRelayMuteEnds({ now: later, threads }),
      [],
    );
  });
});

const makeTestRelay = Effect.fnUntraced(function* (
  options: {
    readonly respond?: (attempt: number) => Response;
    readonly failSecretRead?: (name: string) => boolean;
    readonly linked?: boolean;
    readonly readShell?: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null>;
    readonly domainEvents?: Stream.Stream<OrchestrationV2DomainEvent>;
    readonly catchUpThreads?: ReadonlyArray<OrchestrationV2ThreadShell>;
    /** Runs after the catch-up reads its snapshot, before it sets mute end timers. */
    readonly listActiveShellIndex?: Effect.Effect<void>;
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
  const catchUp = { activitySnapshotReads: 0 };
  const threads = ThreadManagementService.ThreadManagementService.of({
    getThreadShell: unused,
    getShellSnapshot: unused,
    getAgentAwarenessSnapshot: (threadId) =>
      threadId === undefined
        ? Effect.sync(() => {
            catchUp.activitySnapshotReads += 1;
            return { snapshotSequence: 1, threads: options.catchUpThreads ?? [] };
          })
        : Effect.sync(() => shellReads.push(threadId)).pipe(
            Effect.andThen(options.readShell?.(threadId) ?? Ref.get(currentShell)),
            Effect.map((thread) => ({
              snapshotSequence: 1,
              threads: thread === null ? [] : [thread],
            })),
          ),
    listActiveSubagentThreadIds: unused,
    listAppOwnedChildThreadIds: unused,
    countThreads: unused,
    listActiveShellIndex: () => (options.listActiveShellIndex ?? Effect.void).pipe(Effect.as([])),
    listOlderSettledThreads: unused,
    readShellSnapshot: unused,
    getThreadTitles: unused,
    getThreadLinkMetadata: unused,
    ensureLegacyTranscript: unused,
    dispatch: unused,
    searchThread: () => Effect.die("unused"),
    searchThreadStream: () => Stream.empty,
    getThreadHistoryPage: () => Effect.die("unused"),
    getTimelinePage: () => Effect.die("Unused timeline read"),
    getMessageCount: () => Effect.die("unused message count"),
    getRunCount: () => Effect.die("unused run count"),
    getMessagesById: () => Effect.die("unused messages by id"),
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
    submitRunOutput: unused,
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
    cancelDelegatedTask: unused,
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
      try {
        return Promise.resolve(
          options.respond?.(publications.length) ?? Response.json({ ok: true, deliveries: [] }),
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },
    { preconnect: () => {} },
  );
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
  const relay = yield* AgentAwarenessRelay.make.pipe(
    Effect.provide(EnvironmentKeys.layer),
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
      workspaceScanDirectory: unused,
      snapshot: Effect.succeed({ projects: [project], updatedAt: NOW }),
      listPage: unused,
      getShell: unused,
      listShells: unused,
      getById: () => Effect.succeedSome(project),
    }),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provide(NodeCrypto.layer),
  );
  return { relay, secrets, secretReads, currentShell, shellReads, publications, catchUp };
});

describe("AgentAwarenessRelay", () => {
  it.effect("publishes the parent as needing approval while its subagent waits", () =>
    Effect.gen(function* () {
      const shells = yield* Ref.make(
        new Map<ThreadId, OrchestrationV2ThreadShell>([
          [THREAD_ID, shell({ status: "running" })],
          [CHILD_THREAD_ID, waitingChild({ pendingRuntimeRequest: null })],
        ]),
      );
      const setShell = (next: OrchestrationV2ThreadShell) =>
        Ref.update(shells, (current) => new Map(current).set(next.id, next));
      const { relay, publications } = yield* makeTestRelay({
        readShell: (threadId) =>
          Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
      });
      yield* relay.publishThread(THREAD_ID);
      yield* setShell(shell({ status: "completed" }));
      yield* setShell(waitingChild());
      yield* relay.publishThread(CHILD_THREAD_ID);
      assert.equal(publications.length, 2);
      assert.isTrue(publications[1]?.url.includes(`/threads/${THREAD_ID}/`) ?? false);
      assert.equal(publications[1]?.state?.phase, "waiting_for_approval");

      // A rename keeps the same request's alert time, so the phone doesn't re-alert.
      yield* setShell(
        shell({
          status: "completed",
          title: "Renamed thread",
          updatedAt: DateTime.makeUnsafe("2026-09-04T12:01:00.000Z"),
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 3);
      assert.equal(publications[2]?.state?.threadTitle, "Renamed thread");
      assert.equal(publications[2]?.state?.updatedAt, publications[1]?.state?.updatedAt);

      yield* setShell(waitingChild({ pendingRuntimeRequest: null }));
      yield* relay.publishThread(CHILD_THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 4);
      assert.equal(publications[3]?.state?.phase, "completed");
    }),
  );

  it.effect("publishes the parent as needing input when its subagent raises a secret card", () =>
    Effect.gen(function* () {
      const now = DateTime.makeUnsafe(NOW);
      const child = waitingChild({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("child-secret-card"),
          kind: "user_input",
          createdAt: now,
          blocking: true,
          userOnly: true,
        },
      });
      const parent = shell({ status: "completed" });
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const pulls = yield* Queue.unbounded<void>();
      const { relay, publications } = yield* makeTestRelay({
        readShell: (threadId) => Effect.succeed(threadId === child.id ? child : parent),
        domainEvents: Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
        ),
      });
      yield* relay.start();
      yield* Queue.take(pulls);
      const runId = RunId.make("run:child-secret-card");
      // Recording a secret card emits only this event for the child.
      yield* Queue.offer(events, {
        id: EventId.make("event:child-secret-card"),
        type: "turn-item.updated",
        threadId: CHILD_THREAD_ID,
        runId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("child-secret-card"),
          threadId: CHILD_THREAD_ID,
          runId,
          nodeId: NodeId.make("node:child-secret-card"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "waiting",
          title: "SMS code",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "secret_request",
          label: "SMS code",
          reason: "The agent needs the code.",
          secretStatus: "pending",
        },
      });
      yield* Queue.take(pulls);
      yield* relay.drain;
      assert.equal(publications.length, 1);
      assert.isTrue(publications[0]?.url.includes(`/threads/${THREAD_ID}/`) ?? false);
      assert.equal(publications[0]?.state?.phase, "waiting_for_input");
    }),
  );

  it.effect(
    "clears the parent's input wait when the user steers its subagent past a link card",
    () =>
      Effect.gen(function* () {
        const now = DateTime.makeUnsafe(NOW);
        let child = waitingChild({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("child-link-card"),
            kind: "user_input",
            createdAt: now,
            blocking: true,
            userOnly: true,
          },
        });
        const parent = shell({ status: "completed" });
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const pulls = yield* Queue.unbounded<void>();
        const { relay, publications } = yield* makeTestRelay({
          readShell: (threadId) => Effect.succeed(threadId === child.id ? child : parent),
          domainEvents: Stream.fromEffectRepeat(
            Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
          ),
        });
        yield* relay.start();
        yield* Queue.take(pulls);
        const runId = RunId.make("run:child-link-card");
        const item = {
          threadId: CHILD_THREAD_ID,
          runId,
          nodeId: NodeId.make("node:child-link-card"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          title: null,
          startedAt: now,
          updatedAt: now,
        } as const;
        yield* Queue.offer(events, {
          id: EventId.make("event:child-link-card"),
          type: "turn-item.updated",
          threadId: CHILD_THREAD_ID,
          runId,
          occurredAt: now,
          payload: {
            ...item,
            id: TurnItemId.make("child-link-card"),
            ordinal: 1,
            status: "waiting",
            completedAt: null,
            type: "link_request",
            url: "https://example.com/login",
            label: "Sign in",
            reason: "The agent needs you to sign in.",
            linkStatus: "pending",
          },
        });
        yield* Queue.take(pulls);
        yield* relay.drain;
        assert.equal(publications[0]?.state?.phase, "waiting_for_input");

        // Steering a running child records only these events for it; the
        // projection then stops counting the link card as pending.
        child = waitingChild({ pendingRuntimeRequest: null });
        yield* Queue.offer(events, {
          id: EventId.make("event:child-steer"),
          type: "turn-item.updated",
          threadId: CHILD_THREAD_ID,
          runId,
          occurredAt: now,
          payload: {
            ...item,
            id: TurnItemId.make("child-steer"),
            ordinal: 2,
            status: "completed",
            completedAt: now,
            createdBy: "user",
            creationSource: "web",
            type: "user_message",
            messageId: MessageId.make("message:child-steer"),
            inputIntent: "steer",
            text: "Skip the login.",
            attachments: [],
          },
        });
        yield* Queue.take(pulls);
        // The relay confirms a move into completed before publishing it.
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.equal(publications.length, 2);
        assert.equal(publications[1]?.state?.phase, "completed");
      }),
  );

  it.effect("republishes a completed parent for its waiting child after a relink", () =>
    Effect.gen(function* () {
      const parent = shell({ status: "completed" });
      const child = waitingChild();
      const { relay, secrets, publications } = yield* makeTestRelay({
        catchUpThreads: [parent, child],
        readShell: (id) => Effect.succeed(id === child.id ? child : parent),
      });
      yield* relay.start();
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      assert.equal(publications[0]?.state?.phase, "waiting_for_approval");

      yield* secrets.set(
        RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        new TextEncoder().encode("credential-2"),
      );
      yield* relay.requestCatchUp();
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state?.phase, "waiting_for_approval");
    }),
  );

  it.effect("keeps a child's alert time when the parent's own request comes and goes", () =>
    Effect.gen(function* () {
      const shells = yield* Ref.make(
        new Map<ThreadId, OrchestrationV2ThreadShell>([
          [THREAD_ID, shell()],
          [CHILD_THREAD_ID, waitingChild()],
        ]),
      );
      const setParent = (next: OrchestrationV2ThreadShell) =>
        Ref.update(shells, (current) => new Map(current).set(THREAD_ID, next));
      const { relay, publications } = yield* makeTestRelay({
        readShell: (threadId) =>
          Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
      });
      yield* relay.publishThread(CHILD_THREAD_ID);
      yield* setParent(
        shell({
          updatedAt: DateTime.makeUnsafe("2026-09-04T12:01:00.000Z"),
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("parent-request"),
            kind: "command",
            createdAt: DateTime.makeUnsafe("2026-09-04T12:01:00.000Z"),
          },
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      yield* setParent(shell({ updatedAt: DateTime.makeUnsafe("2026-09-04T12:02:00.000Z") }));
      yield* relay.publishThread(THREAD_ID);
      assert.deepStrictEqual(
        publications.map(({ state }) => state?.phase),
        ["waiting_for_approval", "waiting_for_approval", "waiting_for_approval"],
      );
      assert.equal(publications[2]?.state?.updatedAt, publications[0]?.state?.updatedAt);
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
      }),
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

  it.effect(
    "clears a completion that landed while snoozed, even when processed after the wake",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(NOW)));
        const { relay, currentShell, publications } = yield* makeTestRelay();
        const snooze = {
          snoozedAt: DateTime.makeUnsafe(NOW),
          snoozedUntil: DateTime.makeUnsafe("2026-09-04T13:00:00.000Z"),
        };
        yield* Ref.set(currentShell, shell(snooze));
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust("2 hours");
        yield* Ref.set(
          currentShell,
          shell({
            ...snooze,
            status: "completed",
            latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T12:30:00.000Z"),
          }),
        );
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.deepEqual(
          publications.map((publication) => publication.state?.phase ?? null),
          ["running", null],
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

  it.effect("publishes a cleared thread's tombstone once while it stays cleared", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
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
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed", null],
      );

      for (let i = 0; i < 3; i++) {
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
      }
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed", null],
      );
    }),
  );

  it.effect("does not alert an old completion after publishing its thread's tombstone", () =>
    Effect.gen(function* () {
      const oldCompleted = shell({
        status: "completed",
        latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T11:59:00.000Z"),
      });
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(NOW)));
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* Ref.set(currentShell, {
        ...oldCompleted,
        settledOverride: "settled",
        settledAt: DateTime.makeUnsafe(NOW),
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state),
        [null],
      );

      yield* Ref.set(currentShell, oldCompleted);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state),
        [null],
      );
    }),
  );

  it.effect("alerts a completion settled during its hold after an earlier tombstone", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(NOW)));
      const { relay, currentShell, publications } = yield* makeTestRelay();
      const settledAt = DateTime.makeUnsafe(NOW);
      yield* Ref.set(currentShell, {
        ...shell({ status: "completed" }),
        settledOverride: "settled",
        settledAt,
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;

      const completed = shell({
        status: "completed",
        latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T12:00:06.000Z"),
      });
      yield* Ref.set(currentShell, completed);
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, {
        ...completed,
        settledOverride: "settled",
        settledAt,
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        [null, "completed", null],
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

  it.effect("delivers a completion once the network returns after the retry budget runs out", () =>
    Effect.gen(function* () {
      let networkUp = true;
      const delivered: Array<string | null> = [];
      const { relay, currentShell, publications } = yield* makeTestRelay({
        respond: (attempt) => {
          if (!networkUp) throw new TypeError("fetch failed: getaddrinfo EAI_AGAIN");
          delivered.push(publications[attempt - 1]?.state?.phase ?? null);
          return Response.json({ ok: true, deliveries: [] });
        },
      });
      yield* relay.publishThread(THREAD_ID);
      networkUp = false;
      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
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
      assert.equal(publications.length, 7);
      assert.deepEqual(delivered, ["running"]);

      networkUp = true;
      yield* TestClock.adjust("10 minutes");
      yield* relay.drain;
      assert.deepEqual(delivered, ["running", "completed"]);
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

  it.effect("withdraws a muted thread and restores it when unmuted", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      yield* Ref.set(currentShell, shell({ mutedAt: yield* DateTime.now }));
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state, null);
      const mutedAt = yield* DateTime.now;
      yield* Ref.set(currentShell, shell({ mutedAt, mutedUntil: mutedAt }));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 3);
      assert.notEqual(publications[2]?.state, null);
    }),
  );

  it.effect("restores a thread when its timed mute ends without an event", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      const now = yield* DateTime.now;
      yield* Ref.set(
        currentShell,
        shell({ mutedAt: now, mutedUntil: DateTime.add(now, { minutes: 15 }) }),
      );
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.at(-1)?.state, null);
      yield* TestClock.adjust("15 minutes");
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.at(-1)?.state?.phase, "running");
    }),
  );

  it.effect("republishes a thread on its own when its timed mute ends", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      const now = yield* DateTime.now;
      yield* Ref.set(
        currentShell,
        shell({ mutedAt: now, mutedUntil: DateTime.add(now, { minutes: 15 }) }),
      );
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.at(-1)?.state, null);
      const quiet = publications.length;
      // A thread waiting on the user emits nothing more, so the end itself must publish.
      yield* TestClock.adjust("15 minutes");
      yield* relay.drain;
      assert.isAbove(publications.length, quiet);
      assert.equal(publications.at(-1)?.state?.phase, "running");
    }),
  );

  it.effect("alerts at the end of a mute that was already set when the server started", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const muted = shell({ mutedAt: now, mutedUntil: DateTime.add(now, { minutes: 15 }) });
      const { relay, currentShell, publications } = yield* makeTestRelay({
        catchUpThreads: [muted],
      });
      yield* Ref.set(currentShell, muted);
      yield* relay.start();
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 0);
      // Nothing else happens on the thread, so only the end timer can publish it.
      yield* TestClock.adjust("15 minutes");
      yield* relay.drain;
      assert.equal(publications.at(-1)?.state?.phase, "running");
    }),
  );

  it.effect("keeps a newer mute's end when a slower catch-up read an older one", () =>
    Effect.gen(function* () {
      const startedAt = yield* DateTime.now;
      const olderMute = shell({
        mutedAt: startedAt,
        mutedUntil: DateTime.add(startedAt, { hours: 1 }),
      });
      const childReads = yield* Deferred.make<void>();
      const { relay, currentShell, publications } = yield* makeTestRelay({
        catchUpThreads: [olderMute],
        listActiveShellIndex: Deferred.await(childReads),
      });
      yield* Ref.set(currentShell, olderMute);
      yield* relay.start();
      // While the catch-up waits on its child reads, the user mutes again for less time.
      yield* TestClock.adjust("1 second");
      const now = yield* DateTime.now;
      yield* Ref.set(
        currentShell,
        shell({ mutedAt: now, mutedUntil: DateTime.add(now, { minutes: 15 }) }),
      );
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.at(-1)?.state, null);
      yield* Deferred.succeed(childReads, undefined);
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      yield* TestClock.adjust("15 minutes");
      yield* relay.drain;
      assert.equal(publications.at(-1)?.state?.phase, "running");
    }),
  );

  it.effect("keeps a muted subagent's approval off its parent until the mute ends", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const shells = yield* Ref.make(
        new Map<ThreadId, OrchestrationV2ThreadShell>([
          [THREAD_ID, shell({ status: "running" })],
          [CHILD_THREAD_ID, waitingChild({ pendingRuntimeRequest: null })],
        ]),
      );
      const setShell = (next: OrchestrationV2ThreadShell) =>
        Ref.update(shells, (current) => new Map(current).set(next.id, next));
      const { relay, publications } = yield* makeTestRelay({
        readShell: (threadId) =>
          Ref.get(shells).pipe(Effect.map((current) => current.get(threadId) ?? null)),
      });
      yield* relay.publishThread(THREAD_ID);
      yield* setShell(shell({ status: "completed" }));
      yield* setShell(
        waitingChild({ mutedAt: now, mutedUntil: DateTime.add(now, { minutes: 15 }) }),
      );
      yield* relay.publishThread(CHILD_THREAD_ID);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.isFalse(publications.some((entry) => entry.state?.phase === "waiting_for_approval"));
      // The child emits nothing when its mute ends, so its end timer must republish the parent.
      yield* TestClock.adjust("15 minutes");
      yield* relay.drain;
      assert.isTrue(publications.at(-1)?.url.includes(`/threads/${THREAD_ID}/`) ?? false);
      assert.equal(publications.at(-1)?.state?.phase, "waiting_for_approval");
    }),
  );

  // Ending a mute stores its time as mutedUntil, so work that finished before it stays quiet.
  const makeMuteRelay = Effect.fnUntraced(function* (
    confirmWithdrawal = true,
    holdCompletion = false,
  ) {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const pulls = yield* Queue.unbounded<void>();
    const harness = yield* makeTestRelay({
      domainEvents: Stream.fromEffectRepeat(
        Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
      ),
    });
    yield* harness.relay.start();
    yield* Queue.take(pulls);
    const deliverMuteSet = Effect.fnUntraced(function* (
      mutedAt: DateTime.Utc,
      mutedUntil: DateTime.Utc | null,
      occurredAt: DateTime.Utc,
    ) {
      yield* Queue.offer(events, {
        id: EventId.make(`event:mute:${DateTime.toEpochMillis(occurredAt)}`),
        type: "thread.mute-set",
        threadId: THREAD_ID,
        occurredAt,
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
          createdAt: occurredAt,
          updatedAt: occurredAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
          mutedAt,
          mutedUntil,
        },
      });
      yield* Queue.take(pulls);
      yield* harness.relay.drain;
    });
    // Publish live work, then mute and let the withdrawal confirm.
    yield* harness.relay.publishThread(THREAD_ID);
    if (holdCompletion) {
      yield* Ref.set(
        harness.currentShell,
        shell({ status: "completed", latestRunCompletedAt: yield* DateTime.now }),
      );
      yield* harness.relay.publishThread(THREAD_ID);
    }
    const mutedAt = yield* DateTime.now;
    yield* Ref.set(harness.currentShell, shell({ mutedAt }));
    yield* deliverMuteSet(mutedAt, null, mutedAt);
    if (confirmWithdrawal) {
      yield* TestClock.adjust("5 seconds");
      yield* harness.relay.drain;
      assert.equal(harness.publications.length, 2);
      assert.equal(harness.publications[1]?.state, null);
    }
    // Unmuting keeps mutedAt and records the end, as the orchestrator does.
    const unmute = Effect.fnUntraced(function* (overrides: Parameters<typeof shell>[0]) {
      const unmutedAt = yield* DateTime.now;
      yield* Ref.set(harness.currentShell, shell({ ...overrides, mutedAt, mutedUntil: unmutedAt }));
      yield* deliverMuteSet(mutedAt, unmutedAt, unmutedAt);
    });
    return { ...harness, mutedAt, unmute };
  });

  it.effect("keeps work that finished while muted quiet after unmuting", () =>
    Effect.gen(function* () {
      const { relay, publications, unmute } = yield* makeMuteRelay();
      const finishedAt = yield* DateTime.now;
      yield* TestClock.adjust("1 second");
      yield* unmute({ status: "completed", latestRunCompletedAt: finishedAt });
      // Past the confirmation window a first terminal state would otherwise publish.
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 2);
    }),
  );

  it.effect(
    "keeps a run that finished while muted quiet when its held background work ends later",
    () =>
      Effect.gen(function* () {
        const { relay, currentShell, publications, mutedAt, unmute } = yield* makeMuteRelay();
        const finishedAt = yield* DateTime.now;
        yield* TestClock.adjust("1 second");
        const finished = { status: "completed", latestRunCompletedAt: finishedAt } as const;
        yield* unmute({
          ...finished,
          pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }],
        });
        assert.equal(publications.at(-1)?.state?.phase, "running");
        const unmutedAt = yield* DateTime.now;
        yield* Ref.set(currentShell, shell({ ...finished, mutedAt, mutedUntil: unmutedAt }));
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.isFalse(
          publications.some((publication) => publication.state?.phase === "completed"),
        );
      }),
  );

  it.effect("clears a stale live card when unmuted before withdrawal confirms", () =>
    Effect.gen(function* () {
      const { relay, publications, unmute } = yield* makeMuteRelay(false);
      const finishedAt = yield* DateTime.now;
      yield* TestClock.adjust("1 second");
      yield* unmute({ status: "completed", latestRunCompletedAt: finishedAt });
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.at(-1)?.state, null);
    }),
  );

  it.effect("does not restore a muted completion held across settlement", () =>
    Effect.gen(function* () {
      const { relay, publications, unmute } = yield* makeMuteRelay(false, true);
      const finishedAt = yield* DateTime.now;
      yield* TestClock.adjust("1 second");
      yield* unmute({
        status: "completed",
        settledOverride: "settled",
        latestRunCompletedAt: finishedAt,
      });
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.at(-1)?.state, null);
      assert.isFalse(publications.some((publication) => publication.state?.phase === "completed"));
    }),
  );

  it.effect("alerts for work that finished after the unmute even when read later", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications, mutedAt } = yield* makeMuteRelay();
      const unmutedAt = yield* DateTime.now;
      yield* TestClock.adjust("3 seconds");
      yield* Ref.set(
        currentShell,
        shell({
          status: "completed",
          latestRunCompletedAt: DateTime.add(unmutedAt, { seconds: 1 }),
          mutedAt,
          mutedUntil: unmutedAt,
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      // A first terminal state after a withdrawal waits out its confirmation.
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 3);
      assert.equal(publications[2]?.state?.phase, "completed");
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

it.effect("catches up after startup without polling after success", () =>
  Effect.gen(function* () {
    const { relay, secrets, secretReads, catchUp, publications } = yield* makeTestRelay({
      catchUpThreads: [shell()],
    });
    yield* relay.start();
    yield* TestClock.adjust("1 second");
    yield* relay.drain;
    assert.equal(catchUp.activitySnapshotReads, 1);
    assert.equal(publications.length, 1);
    assert.include(publications[0]?.state, {
      threadId: THREAD_ID,
      projectTitle: "Project",
      threadTitle: "Thread",
      phase: "running",
    });

    yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    assert.equal(catchUp.activitySnapshotReads, 1);

    yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true"));
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    assert.equal(catchUp.activitySnapshotReads, 2);

    const readsBeforeIdle = secretReads.length;
    yield* TestClock.adjust("10 minutes");
    assert.equal(catchUp.activitySnapshotReads, 2);
    assert.equal(secretReads.length, readsBeforeIdle);

    yield* secrets.set(
      RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
      new TextEncoder().encode("credential-2"),
    );
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    yield* relay.drain;
    assert.equal(catchUp.activitySnapshotReads, 3);
    assert.equal(publications.length, 2);
    assert.equal(publications[1]?.state?.threadId, THREAD_ID);
  }),
);
