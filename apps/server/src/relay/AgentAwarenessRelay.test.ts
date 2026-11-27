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
import * as PubSub from "effect/PubSub";
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
import * as TeamService from "../team/TeamService.ts";

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
});

const makeTestRelay = Effect.fnUntraced(function* (
  options: {
    readonly respond?: (attempt: number) => Response;
    readonly failSecretRead?: (name: string) => boolean;
    readonly linked?: boolean;
    readonly readShell?: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null>;
    readonly domainEvents?: Stream.Stream<OrchestrationV2DomainEvent>;
    readonly catchUpThreads?: ReadonlyArray<OrchestrationV2ThreadShell>;
    readonly teamService?: TeamService.TeamService["Service"];
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
    listActiveShellIndex: () => Effect.succeed([]),
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
  const relayEffect = AgentAwarenessRelay.make.pipe(
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
  const relay = yield* options.teamService !== undefined
    ? Effect.provideService(relayEffect, TeamService.TeamService, options.teamService)
    : relayEffect;
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

describe("AgentAwarenessRelay team notification gating", () => {
  it.effect(
    "suppresses relay push for unfollowed team colleague threads and publishes when allowed",
    () =>
      Effect.gen(function* () {
        let allowPublish = false;
        const teamService = {
          shouldPublishRelayNotificationForThread: () => Effect.sync(() => allowPublish),
        } as unknown as TeamService.TeamService["Service"];

        const { relay, publications } = yield* makeTestRelay({
          readShell: () => Effect.succeed(shell({ status: "running" })),
          teamService,
        });

        // Unfollowed colleague thread is suppressed without emitting any relay publication.
        yield* relay.publishThread(THREAD_ID);
        yield* relay.drain;
        assert.equal(publications.length, 0);

        // Once the host owner follows the thread (or owns it / authored the turn), relay publishes.
        allowPublish = true;
        yield* relay.publishThread(THREAD_ID);
        yield* relay.drain;
        assert.equal(publications.length, 1);
        assert.include(publications[0]?.state, {
          threadId: THREAD_ID,
          phase: "running",
        });

        // Unfollowing while live clears the previously published card via tombstone after grace window.
        allowPublish = false;
        yield* relay.publishThread(THREAD_ID);
        yield* relay.drain;
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.equal(publications.length, 2);
        assert.isNull(publications[1]?.state);
      }),
  );

  it.effect(
    "does not reconstruct and publish a held completion when team eligibility is revoked before settlement",
    () =>
      Effect.gen(function* () {
        let allowPublish = true;
        const teamService = {
          shouldPublishRelayNotificationForThread: () => Effect.sync(() => allowPublish),
        } as unknown as TeamService.TeamService["Service"];

        const { relay, currentShell, publications } = yield* makeTestRelay({
          teamService,
        });

        // 1. Thread runs while eligible -> publishes "running".
        yield* relay.publishThread(THREAD_ID);
        yield* relay.drain;
        assert.deepEqual(
          publications.map((publication) => publication.state?.phase ?? null),
          ["running"],
        );

        // 2. Thread completes while eligible -> enters 5s completion hold.
        const completed = shell({ status: "completed" });
        yield* Ref.set(currentShell, completed);
        yield* relay.publishThread(THREAD_ID);
        yield* relay.drain;
        assert.equal(publications.length, 1);

        // 3. Before hold expires, recipient unfollows AND thread settles.
        allowPublish = false;
        yield* Ref.set(currentShell, {
          ...completed,
          settledOverride: "settled",
          settledAt: yield* DateTime.now,
          lastVisitedAt: null,
        });
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;

        // Must emit only tombstone (null), NEVER a reconstructed "completed" alert.
        assert.deepEqual(
          publications.map((publication) => publication.state?.phase ?? null),
          ["running", null],
        );
      }),
  );

  it.effect(
    "republishes and tombstones automatically when team follow/attribution triggers fire",
    () =>
      Effect.gen(function* () {
        let allowPublish = false;
        const triggers = yield* PubSub.unbounded<TeamService.TeamNotificationTriggerEvent>();
        const teamService = {
          shouldPublishRelayNotificationForThread: () => Effect.sync(() => allowPublish),
          subscribeNotificationEvents: () => Stream.fromPubSub(triggers),
        } as unknown as TeamService.TeamService["Service"];

        const { relay, publications } = yield* makeTestRelay({
          readShell: () => Effect.succeed(shell({ status: "running" })),
          teamService,
        });

        yield* relay.start();
        yield* Effect.yieldNow;
        assert.equal(publications.length, 0);

        // Following triggers live relay publish without needing a domain event.
        allowPublish = true;
        yield* PubSub.publish(triggers, { type: "thread", threadId: THREAD_ID });
        yield* Effect.yieldNow;
        yield* relay.drain;
        assert.equal(publications.length, 1);
        assert.equal(publications[0]?.state?.phase, "running");

        // Unfollowing triggers tombstone after the 5s confirmation window.
        allowPublish = false;
        yield* PubSub.publish(triggers, { type: "thread", threadId: THREAD_ID });
        yield* Effect.yieldNow;
        yield* relay.drain;
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.equal(publications.length, 2);
        assert.isNull(publications[1]?.state);

        // Relay binding change revisits live published threads even when omitted from catchUpThreads.
        allowPublish = true;
        yield* relay.publishThread(THREAD_ID);
        yield* relay.drain;
        assert.equal(publications.length, 3);
        assert.equal(publications[2]?.state?.phase, "running");

        allowPublish = false;
        yield* PubSub.publish(triggers, { type: "relayBinding" });
        yield* TestClock.adjust("1 second");
        yield* relay.drain;
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.equal(publications.length, 4);
        assert.isNull(publications[3]?.state);
      }),
  );

  it.effect(
    "publishes prefixed mobile push notification on queuedMessage trigger only for eligible recipients and deduplicates per queuedRunId",
    () =>
      Effect.gen(function* () {
        let allowQueued = false;
        const triggers = yield* PubSub.unbounded<TeamService.TeamNotificationTriggerEvent>();
        const teamService = {
          shouldPublishRelayNotificationForThread: () => Effect.succeed(true),
          shouldPublishRelayQueuedMessageNotification: () => Effect.sync(() => allowQueued),
          formatUpstreamCompatThreadTitle: (_threadId: ThreadId, title: string) =>
            Effect.succeed(`alice: ${title}`),
          subscribeNotificationEvents: () => Stream.fromPubSub(triggers),
        } as unknown as TeamService.TeamService["Service"];

        const { relay, publications } = yield* makeTestRelay({
          readShell: () => Effect.succeed(shell({ status: "running", title: "Release prep" })),
          teamService,
        });

        yield* relay.start();
        yield* Effect.yieldNow;

        // Disallowed recipient (e.g. sender or unrelated colleague) produces 0 push publications.
        yield* PubSub.publish(triggers, {
          type: "queuedMessage",
          threadId: THREAD_ID,
          queuedRunId: "run-queued-denied",
          senderMemberId: null,
          senderPseudo: "bob",
          recipientMemberIds: [],
          messagePreview: "Hold deploy",
          createdAt: "2026-04-06T12:01:00.000Z",
        });
        yield* Effect.yieldNow;
        yield* relay.drain;
        assert.equal(publications.length, 0);

        // Eligible recipient (thread creator / active turn author) receives prefixed push notification once.
        allowQueued = true;
        const allowedTrigger: TeamService.TeamNotificationTriggerEvent = {
          type: "queuedMessage",
          threadId: THREAD_ID,
          queuedRunId: "run-queued-1",
          senderMemberId: null,
          senderPseudo: "bob",
          recipientMemberIds: [],
          messagePreview: "Wait for green CI",
          createdAt: "2026-04-06T12:02:00.000Z",
        };
        yield* PubSub.publish(triggers, allowedTrigger);
        yield* PubSub.publish(triggers, allowedTrigger);
        yield* Effect.yieldNow;
        yield* relay.drain;

        assert.equal(publications.length, 1);
        const notifThread1 = ThreadId.make(`${THREAD_ID}:queued:run-queued-1`);
        assert.include(publications[0]?.state, {
          threadId: notifThread1,
          threadTitle: "bob queued a message · alice: Release prep",
          phase: "waiting_for_input",
          headline: "bob queued a message",
          detail: "Wait for green CI",
          deepLink: `/threads/${encodeURIComponent("relay-environment")}/${encodeURIComponent(THREAD_ID)}`,
        });

        // A second distinct queued message publishes its own synthetic notification row so
        // delayed APNs/FCM consumers can deliver both alerts without staleness suppression.
        yield* PubSub.publish(triggers, {
          type: "queuedMessage",
          threadId: THREAD_ID,
          queuedRunId: "run-queued-2",
          senderMemberId: null,
          senderPseudo: "charlie",
          recipientMemberIds: [],
          messagePreview: "Also check migrations",
          createdAt: "2026-04-06T12:03:00.000Z",
        });
        yield* Effect.yieldNow;
        yield* relay.drain;

        assert.equal(publications.length, 2);
        const notifThread2 = ThreadId.make(`${THREAD_ID}:queued:run-queued-2`);
        assert.include(publications[1]?.state, {
          threadId: notifThread2,
          threadTitle: "charlie queued a message · alice: Release prep",
          phase: "waiting_for_input",
          headline: "charlie queued a message",
          detail: "Also check migrations",
          deepLink: `/threads/${encodeURIComponent("relay-environment")}/${encodeURIComponent(THREAD_ID)}`,
        });

        // Concurrent normal thread publish updates only the real thread row and leaves
        // queued-message notification rows intact for delayed APNs/FCM consumers.
        yield* relay.publishThread(THREAD_ID);
        assert.equal(publications.length, 3);
        assert.equal(publications[2]?.state?.threadId, THREAD_ID);
        assert.equal(publications[2]?.state?.phase, "running");
        assert.equal(publications[2]?.state?.threadTitle, "alice: Release prep");

        // Delayed consumer verification: reconstruct current relay row store after all publishes
        // and confirm both queued-message jobs still match the live relay DB (never stale).
        const extractPublishedThreadId = (url: string) =>
          decodeURIComponent(url.split("/threads/")[1]?.split("/")[0] ?? "");
        const relayRows = new Map<string, (typeof publications)[number]["state"]>();
        for (const pub of publications) {
          const urlThreadId = extractPublishedThreadId(pub.url);
          if (pub.state === null) relayRows.delete(urlThreadId);
          else relayRows.set(urlThreadId, pub.state);
        }
        for (const jobState of [publications[0]!.state!, publications[1]!.state!]) {
          const liveRow = relayRows.get(jobState.threadId);
          assert.isDefined(liveRow);
          assert.equal(liveRow?.phase, jobState.phase);
          assert.equal(liveRow?.updatedAt, jobState.updatedAt);
        }

        // Delayed consumer verification beyond 60s (e.g. 2 minutes later): rows are still live
        // in the relay store because the TTL spans the 5-minute async delivery window.
        yield* TestClock.adjust("2 minutes");
        yield* Effect.yieldNow;
        yield* relay.drain;
        assert.equal(publications.length, 3);

        // After the full 5-minute TTL window, both synthetic notification rows are tombstoned
        // cleanly without disturbing the real running thread row.
        yield* TestClock.adjust("3 minutes");
        yield* Effect.yieldNow;
        yield* relay.drain;
        const tombstones = publications.slice(3);
        assert.equal(tombstones.length, 2);
        assert.isNull(tombstones[0]?.state);
        assert.isNull(tombstones[1]?.state);
        assert.deepEqual(
          tombstones.map((entry) => extractPublishedThreadId(entry.url)).toSorted(),
          [notifThread1, notifThread2].toSorted(),
        );
      }),
  );

  it.effect(
    "caps concurrent synthetic rows during approval waits, flushes on revocation, and skips completed/idle threads",
    () =>
      Effect.gen(function* () {
        let allowThread = true;
        let allowQueued = true;
        const triggers = yield* PubSub.unbounded<TeamService.TeamNotificationTriggerEvent>();
        const teamService = {
          shouldPublishRelayNotificationForThread: () => Effect.sync(() => allowThread),
          shouldPublishRelayQueuedMessageNotification: () => Effect.sync(() => allowQueued),
          formatUpstreamCompatThreadTitle: (_threadId: ThreadId, title: string) =>
            Effect.succeed(`alice: ${title}`),
          subscribeNotificationEvents: () => Stream.fromPubSub(triggers),
        } as unknown as TeamService.TeamService["Service"];

        let currentShell = shell({
          status: "waiting",
          title: "Deploy prod",
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("req-approval-1"),
            kind: "command",
            createdAt: DateTime.makeUnsafe(NOW),
          },
        });
        const { relay, publications } = yield* makeTestRelay({
          readShell: () => Effect.sync(() => currentShell),
          teamService,
        });

        const extractPublishedThreadId = (url: string) =>
          decodeURIComponent(url.split("/threads/")[1]?.split("/")[0] ?? "");

        yield* relay.start();
        yield* Effect.yieldNow;
        yield* relay.publishThread(THREAD_ID);
        assert.equal(publications.length, 1);
        assert.equal(publications[0]?.state?.threadId, THREAD_ID);
        assert.equal(publications[0]?.state?.phase, "waiting_for_approval");

        // Queue 5 messages while the thread is awaiting approval: at most 2 synthetic rows stay
        // live simultaneously (never filling the relay's 5-row aggregate or evicting the approval row).
        for (let i = 1; i <= 5; i += 1) {
          yield* PubSub.publish(triggers, {
            type: "queuedMessage",
            threadId: THREAD_ID,
            queuedRunId: `run-queued-approval-${i}`,
            senderMemberId: null,
            senderPseudo: "bob",
            recipientMemberIds: [],
            messagePreview: `Wait #${i}`,
            createdAt: `2026-04-06T12:0${i}:00.000Z`,
          });
        }
        yield* relay.publishThread(THREAD_ID);
        yield* Effect.yieldNow;
        yield* relay.drain;

        // Reconstruct live relay rows at every step and confirm total live rows never exceeded 3
        // (1 approval + at most 2 queued notifications) and the approval row was never evicted.
        const liveRows = new Map<string, (typeof publications)[number]["state"]>();
        let maxLiveRows = 0;
        for (const pub of publications) {
          const id = extractPublishedThreadId(pub.url);
          if (pub.state === null) liveRows.delete(id);
          else liveRows.set(id, pub.state);
          maxLiveRows = Math.max(maxLiveRows, liveRows.size);
        }
        assert.isAtMost(maxLiveRows, 3);
        assert.equal(liveRows.get(THREAD_ID)?.phase, "waiting_for_approval");
        assert.isTrue(liveRows.has(`${THREAD_ID}:queued:run-queued-approval-4`));
        assert.isTrue(liveRows.has(`${THREAD_ID}:queued:run-queued-approval-5`));

        // When latestRunId advances to the queued run (so shouldPublishRelayNotificationForThread
        // becomes false for an active turn author who doesn't own/follow the thread), the synthetic
        // queued-message notifications MUST NOT self-tombstone.
        const countBeforeRunAdvance = publications.length;
        allowThread = false;
        yield* relay.publishThread(THREAD_ID);
        yield* relay.drain;
        const advanceTombstones = publications
          .slice(countBeforeRunAdvance)
          .filter((entry) => entry.state === null)
          .map((entry) => extractPublishedThreadId(entry.url));
        assert.deepEqual(advanceTombstones, []);

        // Revoking access to the thread (shouldPublishRelayQueuedMessageNotification -> false)
        // immediately tombstones its remaining synthetic rows without waiting for the 5-minute TTL.
        const countBeforeRevoke = publications.length;
        allowQueued = false;
        yield* relay.publishThread(THREAD_ID);
        yield* relay.drain;
        const revokeTombstones = publications
          .slice(countBeforeRevoke)
          .filter((entry) => entry.state === null)
          .map((entry) => extractPublishedThreadId(entry.url))
          .toSorted();
        assert.deepEqual(revokeTombstones, [
          `${THREAD_ID}:queued:run-queued-approval-4`,
          `${THREAD_ID}:queued:run-queued-approval-5`,
        ]);

        // Once the thread completes, late queued-message triggers are skipped so idle/completed
        // cards are never resurrected.
        allowThread = true;
        allowQueued = true;
        currentShell = shell({ status: "completed", title: "Deploy prod" });
        const countBeforeCompleted = publications.length;
        yield* PubSub.publish(triggers, {
          type: "queuedMessage",
          threadId: THREAD_ID,
          queuedRunId: "run-queued-after-complete",
          senderMemberId: null,
          senderPseudo: "charlie",
          recipientMemberIds: [],
          messagePreview: "Too late",
          createdAt: "2026-04-06T12:10:00.000Z",
        });
        yield* Effect.yieldNow;
        yield* relay.drain;
        assert.equal(publications.length, countBeforeCompleted);
      }),
  );

  it.effect(
    "flushes all synthetic queued rows when publishing is disabled, retries transient tombstone failures, and preserves cleanup across credential rotation",
    () =>
      Effect.gen(function* () {
        const triggers = yield* PubSub.unbounded<TeamService.TeamNotificationTriggerEvent>();
        const teamService = {
          shouldPublishRelayNotificationForThread: () => Effect.succeed(true),
          shouldPublishRelayQueuedMessageNotification: () => Effect.succeed(true),
          formatUpstreamCompatThreadTitle: (_threadId: ThreadId, title: string) =>
            Effect.succeed(`alice: ${title}`),
          subscribeNotificationEvents: () => Stream.fromPubSub(triggers),
        } as unknown as TeamService.TeamService["Service"];

        let failNextTombstone = true;
        const { relay, publications, secrets } = yield* makeTestRelay({
          readShell: () => Effect.succeed(shell({ status: "running", title: "Release" })),
          teamService,
          respond: (attempt) => {
            // Fail the first tombstone (attempt #3) once to prove non-blocking retry recovery.
            if (attempt === 3 && failNextTombstone) {
              failNextTombstone = false;
              return new Response("upstream timeout", { status: 503 });
            }
            return Response.json({ ok: true, deliveries: [] });
          },
        });
        const extractPublishedThreadId = (url: string) =>
          decodeURIComponent(url.split("/threads/")[1]?.split("/")[0] ?? "");

        yield* relay.start();
        yield* Effect.yieldNow;

        yield* PubSub.publish(triggers, {
          type: "queuedMessage",
          threadId: THREAD_ID,
          queuedRunId: "run-disable-1",
          senderMemberId: null,
          senderPseudo: "bob",
          recipientMemberIds: [],
          messagePreview: "First",
          createdAt: "2026-04-06T12:01:00.000Z",
        });
        yield* PubSub.publish(triggers, {
          type: "queuedMessage",
          threadId: THREAD_ID,
          queuedRunId: "run-disable-2",
          senderMemberId: null,
          senderPseudo: "charlie",
          recipientMemberIds: [],
          messagePreview: "Second",
          createdAt: "2026-04-06T12:02:00.000Z",
        });
        yield* Effect.yieldNow;
        yield* relay.drain;
        assert.equal(publications.length, 2);

        // Rotate credential on the same relay AND disable publishing: BOTH rows must still be
        // tombstoned (the first fails transiently with 503 and retries 1s later; the second
        // succeeds immediately with the rotated credential).
        yield* secrets.set(
          RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
          new TextEncoder().encode("credential-rotated"),
        );
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
        yield* relay.publishThread(THREAD_ID);
        yield* relay.drain;
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        yield* relay.drain;

        const successfulTombstones = publications
          .slice(2)
          .filter((entry) => entry.state === null)
          .map((entry) => ({
            id: extractPublishedThreadId(entry.url),
            auth: entry.authorization,
          }));
        // Attempt #3 failed (row 1), attempt #4 succeeded (row 2), retry attempt #5 succeeded (row 1).
        assert.equal(successfulTombstones.length, 3);
        assert.isTrue(
          successfulTombstones.every((entry) => entry.auth === "Bearer credential-rotated"),
        );
        assert.deepEqual([...new Set(successfulTombstones.map((entry) => entry.id))].toSorted(), [
          `${THREAD_ID}:queued:run-disable-1`,
          `${THREAD_ID}:queued:run-disable-2`,
        ]);
      }),
  );

  it.effect(
    "reconciles synthetic row capacity as real approval rows arrive, aborts on eviction failure, and preserves backoff during outages",
    () =>
      Effect.gen(function* () {
        const triggers = yield* PubSub.unbounded<TeamService.TeamNotificationTriggerEvent>();
        const teamService = {
          shouldPublishRelayNotificationForThread: () => Effect.succeed(true),
          shouldPublishRelayQueuedMessageNotification: () => Effect.succeed(true),
          formatUpstreamCompatThreadTitle: (_threadId: ThreadId, title: string) =>
            Effect.succeed(`alice: ${title}`),
          subscribeNotificationEvents: () => Stream.fromPubSub(triggers),
        } as unknown as TeamService.TeamService["Service"];

        const threadIds = [1, 2, 3, 4, 5].map((n) => ThreadId.make(`approval-thread-${n}`));
        const shellsById = new Map<ThreadId, OrchestrationV2ThreadShell>(
          threadIds.map((id, idx) => [
            id,
            shell({
              id,
              status: "waiting",
              title: `Approval ${idx + 1}`,
              pendingRuntimeRequest: {
                id: RuntimeRequestId.make(`req-cap-${idx + 1}`),
                kind: "command",
                createdAt: DateTime.makeUnsafe(NOW),
              },
            }),
          ]),
        );

        let failEviction = false;
        const { relay, publications, secrets } = yield* makeTestRelay({
          readShell: (id) => Effect.succeed(shellsById.get(id) ?? null),
          teamService,
          respond: () =>
            failEviction
              ? new Response("relay outage", { status: 503 })
              : Response.json({ ok: true, deliveries: [] }),
        });
        const extractPublishedThreadId = (url: string) =>
          decodeURIComponent(url.split("/threads/")[1]?.split("/")[0] ?? "");

        yield* relay.start();
        yield* Effect.yieldNow;

        // Publish 3 real approval rows + 2 synthetic queued rows (= 5 total priority-0 rows).
        for (const id of threadIds.slice(0, 3)) {
          yield* relay.publishThread(id);
        }
        yield* PubSub.publish(triggers, {
          type: "queuedMessage",
          threadId: threadIds[0]!,
          queuedRunId: "run-cap-1",
          senderMemberId: null,
          senderPseudo: "bob",
          recipientMemberIds: [],
          messagePreview: "Queued 1",
          createdAt: "2026-04-06T12:01:00.000Z",
        });
        yield* PubSub.publish(triggers, {
          type: "queuedMessage",
          threadId: threadIds[0]!,
          queuedRunId: "run-cap-2",
          senderMemberId: null,
          senderPseudo: "charlie",
          recipientMemberIds: [],
          messagePreview: "Queued 2",
          createdAt: "2026-04-06T12:02:00.000Z",
        });
        yield* Effect.yieldNow;
        yield* relay.drain;

        // Failed cap eviction aborts publishing the 3rd synthetic row instead of exceeding the cap.
        failEviction = true;
        const beforeFailedEvict = publications.length;
        yield* PubSub.publish(triggers, {
          type: "queuedMessage",
          threadId: threadIds[0]!,
          queuedRunId: "run-cap-3-aborted",
          senderMemberId: null,
          senderPseudo: "dana",
          recipientMemberIds: [],
          messagePreview: "Should abort",
          createdAt: "2026-04-06T12:03:00.000Z",
        });
        yield* Effect.yieldNow;
        yield* relay.drain;
        // Only the failed eviction tombstone attempt was sent; run-cap-3-aborted was NOT published.
        assert.equal(publications.length, beforeFailedEvict + 1);
        assert.isNull(publications.at(-1)?.state);
        assert.equal(
          extractPublishedThreadId(publications.at(-1)!.url),
          `${threadIds[0]!}:queued:run-cap-1`,
        );

        // Subsequent queued-message traffic while run-cap-1 is already flushing in backoff MUST NOT
        // cancel its backoff timer or issue another tombstone attempt during the outage.
        yield* PubSub.publish(triggers, {
          type: "queuedMessage",
          threadId: threadIds[0]!,
          queuedRunId: "run-cap-4-while-flushing",
          senderMemberId: null,
          senderPseudo: "eve",
          recipientMemberIds: [],
          messagePreview: "Should also abort without spinning",
          createdAt: "2026-04-06T12:03:30.000Z",
        });
        yield* Effect.yieldNow;
        yield* relay.drain;
        assert.equal(publications.length, beforeFailedEvict + 1);

        // Repeated flush attempts (via both publishThread and requestCatchUp) while disabled during
        // an outage must NOT cancel backoff or wipe livePhaseRelayIdentity.
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
        yield* relay.publishThread(threadIds[0]!);
        yield* relay.requestCatchUp();
        yield* Effect.yieldNow;
        yield* relay.drain;
        const afterFirstDisableFlush = publications.length;
        // Row 2 was flushed once (failed 503); calling requestCatchUp again immediately must NOT re-attempt either row.
        yield* relay.requestCatchUp();
        yield* Effect.yieldNow;
        yield* relay.drain;
        assert.equal(publications.length, afterFirstDisableFlush);

        // Recover relay and re-enable publishing: backoff retry clears both rows cleanly.
        failEviction = false;
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true"));
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        yield* relay.drain;

        // Re-publish 2 synthetic rows alongside 3 approvals, then rotate credentials on the same
        // relay and publish a 4th & 5th real approval: synthetic rows shrink to 1, then 0!
        yield* PubSub.publish(triggers, {
          type: "queuedMessage",
          threadId: threadIds[0]!,
          queuedRunId: "run-shrink-1",
          senderMemberId: null,
          senderPseudo: "bob",
          recipientMemberIds: [],
          messagePreview: "Shrink 1",
          createdAt: "2026-04-06T12:04:00.000Z",
        });
        yield* PubSub.publish(triggers, {
          type: "queuedMessage",
          threadId: threadIds[0]!,
          queuedRunId: "run-shrink-2",
          senderMemberId: null,
          senderPseudo: "charlie",
          recipientMemberIds: [],
          messagePreview: "Shrink 2",
          createdAt: "2026-04-06T12:05:00.000Z",
        });
        yield* Effect.yieldNow;
        yield* relay.drain;

        // Same-relay credential rotation preserves live attention phase accounting.
        yield* secrets.set(
          RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
          new TextEncoder().encode("credential-same-relay"),
        );
        const beforeFourthApproval = publications.length;
        yield* relay.publishThread(threadIds[3]!);
        yield* relay.drain;
        const fourthTombstones = publications
          .slice(beforeFourthApproval)
          .filter((entry) => entry.state === null)
          .map((entry) => extractPublishedThreadId(entry.url));
        assert.deepEqual(fourthTombstones, [`${threadIds[0]!}:queued:run-shrink-1`]);

        const beforeFifthApproval = publications.length;
        yield* relay.publishThread(threadIds[4]!);
        yield* relay.drain;
        const fifthTombstones = publications
          .slice(beforeFifthApproval)
          .filter((entry) => entry.state === null)
          .map((entry) => extractPublishedThreadId(entry.url));
        assert.deepEqual(fifthTombstones, [`${threadIds[0]!}:queued:run-shrink-2`]);
      }),
  );
});
