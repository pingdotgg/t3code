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
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
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
    /** Starts unlinked with publishing off when false. */
    readonly linked?: boolean;
    /** Serves shells from this source instead of `currentShell`. */
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
  // Catch-up publishes read the whole shell once each.
  const catchUp = { shellSnapshotReads: 0 };
  const threads = ThreadManagementService.ThreadManagementService.of({
    getThreadShell: (threadId) =>
      Effect.sync(() => shellReads.push(threadId)).pipe(
        Effect.andThen(options.readShell?.(threadId) ?? Ref.get(currentShell)),
      ),
    getShellSnapshot: () =>
      Effect.sync(() => {
        catchUp.shellSnapshotReads += 1;
        return { schemaVersion: 2, snapshotSequence: 1, threads: [], archivedThreads: [] };
      }),
    ensureLegacyTranscript: unused,
    dispatch: unused,
    getTimelinePage: () => Effect.die("Unused timeline read"),
    getMessageCount: () => Effect.die("unused message count"),
    getThreadRecords: () => Effect.die("unused record read"),
    getThreadProjection: unused,
    getCheckpointContext: unused,
    getThreadSnapshot: unused,
    getThreadSnapshotWindow: unused,
    getProjectThreadRecords: () => Effect.die("unused project record read"),
    getProjectThread: unused,
    listProjectThreads: unused,
    sendToThread: unused,
    waitForThread: unused,
    interruptThread: unused,
    getThreadEventSequence: unused,
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
      getShell: unused,
      listShells: unused,
      getById: () =>
        Effect.succeed(
          Option.some({
            id: PROJECT_ID,
            title: "Project",
            workspaceRoot: "/workspace",
            defaultModelSelection: null,
            scripts: [],
            createdAt: NOW,
            updatedAt: NOW,
            deletedAt: null,
          }),
        ),
    }),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provide(NodeCrypto.layer),
  );
  return { relay, secrets, secretReads, currentShell, shellReads, publications, catchUp };
});

describe("AgentAwarenessRelay", () => {
  it("ignores transcript and tool updates but retains activity and metadata changes", () => {
    for (const type of [
      "message.updated",
      "turn-item.updated",
      "provider-turn.updated",
      "thread.visited",
      "thread.pinned",
    ] as const) {
      assert.isFalse(AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({ type }));
    }
    for (const type of [
      "run.created",
      "run.updated",
      "runtime-request.updated",
      // Pending background work changes can release a held completion.
      "subagent.updated",
      "provider-thread.updated",
      "thread.metadata-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
      "thread.archived",
      "thread.unarchived",
      "thread.deleted",
    ] as const) {
      assert.isTrue(AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({ type }));
    }
  });

  it("does not publish imported thread creation as new agent activity", () => {
    assert.isFalse(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        type: "thread.created",
        payload: { historyOrigin: "v1_import" },
      }),
    );
    assert.isTrue(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({ type: "thread.created", payload: {} }),
    );
  });

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

  it.effect("stops before shell reads when disabled and republishes after re-enabling", () =>
    Effect.gen(function* () {
      const { relay, secrets, secretReads, shellReads, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
      const previousReads = secretReads.length;
      yield* relay.publishThread(THREAD_ID);
      assert.deepEqual(secretReads.slice(previousReads), [PUBLISH_AGENT_ACTIVITY_SECRET]);
      assert.equal(shellReads.length, 1);
      assert.equal(publications.length, 1);
      yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true"));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
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

  it.effect("retries a failed final state without another thread event", () =>
    Effect.gen(function* () {
      const { relay, currentShell, shellReads, publications } = yield* makeTestRelay({
        respond: (attempt) =>
          attempt === 2
            ? new Response("relay unavailable", { status: 503 })
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(
        currentShell,
        shell({
          status: "completed",
          latestRunCompletedAt: DateTime.add(yield* DateTime.now, { seconds: 1 }),
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 3);
      assert.equal(publications[2]?.state?.phase, "completed");
      yield* TestClock.adjust("1 minute");
      yield* relay.drain;
      assert.equal(shellReads.length, 3);
    }),
  );

  it.effect("retries the latest shell and credentials with first-completion confirmation", () =>
    Effect.gen(function* () {
      const { relay, secrets, currentShell, publications } = yield* makeTestRelay({
        respond: (attempt) =>
          attempt === 1
            ? new Response("relay unavailable", { status: 503 })
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(
        currentShell,
        shell({
          status: "completed",
          title: "Final title",
          latestRunCompletedAt: DateTime.add(yield* DateTime.now, { seconds: 1 }),
        }),
      );
      yield* secrets.set(
        RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        new TextEncoder().encode("credential-2"),
      );
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.authorization, "Bearer credential-2");
      assert.equal(publications[1]?.state?.phase, "completed");
      assert.equal(publications[1]?.state?.threadTitle, "Final title");
    }),
  );

  it.effect("cancels a stale retry when a newer update publishes successfully", () =>
    Effect.gen(function* () {
      const { relay, currentShell, shellReads, publications } = yield* makeTestRelay({
        respond: (attempt) =>
          attempt === 1
            ? new Response("relay unavailable", { status: 503 })
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell({ title: "New title" }));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state?.threadTitle, "New title");
      yield* TestClock.adjust("1 minute");
      yield* relay.drain;
      assert.equal(shellReads.length, 2);
    }),
  );

  it.effect.each(["disable", "unlink"] as const)(
    "stops retries before shell reads after %s",
    (change) =>
      Effect.gen(function* () {
        const { relay, secrets, shellReads, publications } = yield* makeTestRelay({
          respond: () => new Response("relay unavailable", { status: 503 }),
        });
        yield* relay.publishThread(THREAD_ID);
        if (change === "disable") {
          yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
        } else {
          yield* secrets.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET);
        }
        yield* TestClock.adjust("1 second");
        yield* relay.drain;
        yield* TestClock.adjust("1 minute");
        yield* relay.drain;
        assert.equal(publications.length, 1);
        assert.equal(shellReads.length, 1);
      }),
  );

  it.effect("recovers from a transient configuration read failure", () =>
    Effect.gen(function* () {
      let failRead = false;
      const { relay, shellReads, publications } = yield* makeTestRelay({
        failSecretRead: (name) => failRead && name === PUBLISH_AGENT_ACTIVITY_SECRET,
      });
      failRead = true;
      yield* relay.publishThread(THREAD_ID);
      assert.equal(shellReads.length, 0);
      failRead = false;
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      assert.equal(publications[0]?.state?.phase, "running");
    }),
  );

  it.effect("bounds retry attempts and resets the budget for a newer update", () =>
    Effect.gen(function* () {
      const { relay, currentShell, shellReads, publications } = yield* makeTestRelay({
        respond: () => new Response("relay unavailable", { status: 503 }),
      });
      yield* relay.publishThread(THREAD_ID);
      let attempts = 1;
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
        yield* TestClock.adjust(delay - 1);
        yield* relay.drain;
        assert.equal(publications.length, attempts);
        yield* TestClock.adjust(1);
        yield* relay.drain;
        attempts += 1;
        assert.equal(publications.length, attempts);
      }
      yield* TestClock.adjust("1 minute");
      yield* relay.drain;
      assert.equal(publications.length, 6);
      assert.equal(shellReads.length, 6);
      yield* Ref.set(currentShell, shell({ title: "New update" }));
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 8);
      assert.equal(publications[7]?.state?.threadTitle, "New update");
    }),
  );

  it.effect("retries a confirmed completion without restarting its confirmation window", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay({
        respond: (attempt) =>
          attempt <= 2
            ? new Response("relay unavailable", { status: 503 })
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* Ref.set(
        currentShell,
        shell({
          status: "completed",
          latestRunCompletedAt: DateTime.add(yield* DateTime.now, { seconds: 1 }),
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      yield* TestClock.adjust("2 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 3);
      assert.isTrue(publications.every((publication) => publication.state?.phase === "completed"));
      yield* TestClock.adjust("1 minute");
      yield* relay.drain;
      assert.equal(publications.length, 3);
    }),
  );

  it.effect("does not reset an exhausted retry budget for old confirmation timers", () =>
    Effect.gen(function* () {
      let unavailable = false;
      const { relay, currentShell, shellReads, publications } = yield* makeTestRelay({
        respond: () =>
          unavailable
            ? new Response("relay unavailable", { status: 503 })
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* relay.publishThread(THREAD_ID);
      // Leave six obsolete confirmations at 5,000 through 5,005 milliseconds.
      for (let i = 0; i < 6; i++) {
        yield* Ref.set(currentShell, null);
        yield* relay.publishThread(THREAD_ID);
        yield* Ref.set(currentShell, shell());
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust(1);
      }
      unavailable = true;
      yield* Ref.set(currentShell, shell({ status: "failed" }));
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust(1_000);
      yield* relay.drain;
      yield* TestClock.adjust(2_000);
      yield* relay.drain;
      yield* TestClock.adjust(1_994);
      yield* relay.drain;
      for (let i = 0; i < 5; i++) {
        yield* TestClock.adjust(1);
        yield* relay.drain;
      }
      const attempts = publications.length;
      const reads = shellReads.length;
      yield* TestClock.adjust("1 minute");
      yield* relay.drain;
      assert.equal(publications.length, attempts);
      assert.equal(shellReads.length, reads);
    }),
  );

  it.effect("confirms tombstones and cancels stale confirmations when activity recovers", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, null);
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      yield* Ref.set(currentShell, shell());
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      yield* Ref.set(currentShell, null);
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state, null);
    }),
  );

  it.effect("confirms a first completed state and respects disabling during confirmation", () =>
    Effect.gen(function* () {
      const { relay, secrets, currentShell, publications } = yield* makeTestRelay();
      yield* Ref.set(
        currentShell,
        shell({
          status: "completed",
          latestRunCompletedAt: DateTime.add(yield* DateTime.now, { seconds: 1 }),
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 0);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications[0]?.state?.phase, "completed");
      yield* Ref.set(currentShell, null);
      yield* relay.publishThread(THREAD_ID);
      yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 1);
    }),
  );
  it.effect("publishes a held completion when its background item ends, not on tool output", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      // The relay pulls the next event only after it has handled the previous one.
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

      // Streaming output never reaches the shell read.
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
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running", "completed"],
      );
    }).pipe(Effect.scoped, Effect.provide(ProjectionStore.layerMemory)),
  );
});

describe("startup catch-up", { concurrent: false }, () => {
  const link = (secrets: ServerSecretStore.ServerSecretStore["Service"]) =>
    Effect.all(
      [
        secrets.set(RELAY_URL_SECRET, new TextEncoder().encode("https://relay.example.test")),
        secrets.set(RELAY_ISSUER_SECRET, new TextEncoder().encode("https://relay.example.test")),
        secrets.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("credential-1")),
      ],
      { discard: true },
    );
  const enablePublishing = (secrets: ServerSecretStore.ServerSecretStore["Service"]) =>
    secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true"));
  const linkChecks = (secretReads: ReadonlyArray<string>) =>
    secretReads.filter((name) => name === RELAY_URL_SECRET).length;

  it.effect("checks an unlinked environment once a minute and still catches up once linked", () =>
    Effect.gen(function* () {
      const { relay, secrets, secretReads, catchUp } = yield* makeTestRelay({ linked: false });
      yield* enablePublishing(secrets);
      yield* relay.start();

      // Get past the backoff ramp, then count checks in a steady window.
      yield* TestClock.adjust("10 minutes");
      const checksBeforeWindow = linkChecks(secretReads);
      yield* TestClock.adjust("10 minutes");
      assert.equal(linkChecks(secretReads) - checksBeforeWindow, 10);
      assert.equal(catchUp.shellSnapshotReads, 0);

      yield* link(secrets);
      yield* TestClock.adjust("1 minute");
      assert.equal(catchUp.shellSnapshotReads, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("publishes at once when this process links while the check is backed off", () =>
    Effect.gen(function* () {
      const { relay, secrets, catchUp } = yield* makeTestRelay({ linked: false });
      yield* enablePublishing(secrets);
      yield* relay.start();

      // Backed off to 60 s: the next check is still seconds away.
      yield* TestClock.adjust("10 minutes");
      yield* link(secrets);
      yield* TestClock.adjust("1 second");
      assert.equal(catchUp.shellSnapshotReads, 0);

      yield* relay.requestCatchUp();
      yield* TestClock.adjust("1 second");
      assert.equal(catchUp.shellSnapshotReads, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("catches up within 5 s when another process enables publishing on a link", () =>
    Effect.gen(function* () {
      const { relay, secrets, catchUp } = yield* makeTestRelay({ linked: false });
      yield* link(secrets);
      yield* relay.start();

      yield* TestClock.adjust("10 minutes");
      assert.equal(catchUp.shellSnapshotReads, 0);

      // `t3 connect publish` writes the opt-in without waking this process.
      yield* enablePublishing(secrets);
      yield* TestClock.adjust("5 seconds");
      assert.equal(catchUp.shellSnapshotReads, 1);
    }).pipe(Effect.scoped),
  );
});
