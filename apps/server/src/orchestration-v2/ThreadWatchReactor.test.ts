// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  SecretRef,
  SecretRequestError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadWatchReactor from "./ThreadWatchReactor.ts";

const THREAD_ID = ThreadId.make("watched-thread");
const PROJECT_ID = ProjectId.make("watched-project");
const ENVIRONMENT_ID = EnvironmentId.make("watch-environment");
const RUN_1 = RunId.make("run-1");
const RUN_2 = RunId.make("run-2");
const URL = "https://receiver.example.test/hook";
const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const at = (iso: string) => DateTime.makeUnsafe(iso);

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "[bot] GM ticket desk",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "agent",
    creationSource: "mcp",
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
    activityRunStatus: "running",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: RUN_1,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at("2026-10-20T12:00:00.000Z"),
    updatedAt: at("2026-10-20T12:00:00.000Z"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const completed = (runId = RUN_1, completedAt = "2026-10-20T12:05:00.000Z") =>
  shell({
    status: "completed",
    activityRunStatus: null,
    latestRunId: runId,
    latestRunCompletedAt: at(completedAt),
  });

interface Received {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

const makeHarness = Effect.fnUntraced(function* (
  options: {
    readonly respond?: (attempt: number, request: Received) => Response | Promise<Response>;
    readonly secretRefValue?: string;
    readonly whileConsuming?: (
      current: Ref.Ref<OrchestrationV2ThreadShell | null>,
    ) => Effect.Effect<void>;
    readonly domainEvents?: Stream.Stream<OrchestrationV2DomainEvent>;
    readonly initial?: OrchestrationV2ThreadShell | null;
  } = {},
) {
  const current = yield* Ref.make<OrchestrationV2ThreadShell | null>(
    options.initial === undefined ? shell() : options.initial,
  );
  const received: Array<Received> = [];
  const consumed: Array<{ readonly ref: string; readonly projectId: string }> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const body = init?.body;
      const request = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body),
      };
      received.push(request);
      return Promise.resolve(
        options.respond?.(received.length, request) ?? new Response(null, { status: 204 }),
      );
    },
    { preconnect: () => {} },
  );
  const reactor = yield* ThreadWatchReactor.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          // One shell stands in for every thread, under the id asked for.
          getThreadShell: (threadId) =>
            Ref.get(current).pipe(
              Effect.map((value) => (value === null ? null : { ...value, id: threadId })),
            ),
          streamDomainEvents: options.domainEvents ?? Stream.empty,
        }),
        Layer.mock(SecretRequests.SecretRequests)({
          consume: ({ ref, projectId }) =>
            Effect.suspend(() => {
              consumed.push({ ref, projectId });
              const value = options.secretRefValue;
              return (options.whileConsuming?.(current) ?? Effect.void).pipe(
                Effect.andThen(
                  value === undefined
                    ? Effect.fail(new SecretRequestError({ reason: "ref_expired" }))
                    : Effect.succeed(value),
                ),
              );
            }),
        }),
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
          getDescriptor: Effect.die("unused"),
        }),
        FetchHttpClient.layer,
        Layer.succeed(FetchHttpClient.Fetch, fetch),
      ),
    ),
  );
  const watch = (
    delivery: Parameters<typeof reactor.watch>[0]["delivery"] = { url: URL, secret: SECRET },
    threadId = THREAD_ID,
  ) => reactor.watch({ threadId, projectId: PROJECT_ID, delivery });
  const settle = (next: OrchestrationV2ThreadShell | null, threadId = THREAD_ID) =>
    Ref.set(current, next).pipe(
      Effect.andThen(reactor.checkThread(threadId)),
      Effect.andThen(reactor.drain),
    );
  return { current, received, consumed, reactor, watch, settle };
});

/** Whether the default endpoint still watches; ends the watch to find out. */
const stillWatching = (reactor: ThreadWatchReactor.ThreadWatchReactor["Service"]) =>
  reactor
    .unwatch({ threadId: THREAD_ID, url: URL })
    .pipe(Effect.map(({ wasWatching }) => wasWatching));

/** Verifies as a Standard Webhooks receiver would, independently of the sender's code. */
function verified(request: Received | undefined) {
  assert.isDefined(request);
  const id = request!.headers.get("webhook-id") ?? "";
  const timestamp = request!.headers.get("webhook-timestamp") ?? "";
  const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
  const expected = NodeCrypto.createHmac("sha256", key)
    .update(`${id}.${timestamp}.${request!.body}`)
    .digest("base64");
  assert.strictEqual(request!.headers.get("webhook-signature"), `v1,${expected}`);
  assert.strictEqual(request!.headers.get("content-type"), "application/json");
  return JSON.parse(request!.body) as {
    readonly eventId: string;
    readonly name: string;
    readonly data: Record<string, unknown>;
    readonly cursor: null;
  };
}

describe("ThreadWatchReactor", () => {
  it.effect("sends one signed MCP Events request per change, from the watch on", () =>
    Effect.gen(function* () {
      const { received, watch, settle } = yield* makeHarness({ initial: completed() });
      assert.deepStrictEqual(yield* watch(), { wasWatching: false });
      yield* settle(completed());
      assert.strictEqual(received.length, 0, "what happened before the watch is not sent");

      yield* settle(shell({ latestRunId: RUN_2 }));
      yield* settle(completed(RUN_2, "2026-10-20T12:30:00.000Z"));
      yield* settle(completed(RUN_2, "2026-10-20T12:30:00.000Z"));
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0]?.url, URL);
      assert.match(received[0]?.headers.get("x-mcp-subscription-id") ?? "", /^tw_[0-9a-f]{32}$/);
      const body = verified(received[0]);
      assert.strictEqual(body.name, "thread.watch");
      assert.strictEqual(body.eventId, received[0]?.headers.get("webhook-id"));
      assert.strictEqual(body.cursor, null);
      assert.deepStrictEqual(body.data, {
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        title: "[bot] GM ticket desk",
        kind: "completed",
        runId: RUN_2,
      });
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("a launch is watched before its thread exists, and a launch that fails ends it", () =>
    Effect.gen(function* () {
      const delivery = { url: URL, secret: SECRET };
      const launched = yield* makeHarness({ initial: null });
      const launch = (harness: typeof launched, effect: Effect.Effect<void, string>) =>
        harness.reactor
          .watchLaunch({ threadId: THREAD_ID, projectId: PROJECT_ID, delivery, launch: effect })
          .pipe(Effect.exit);
      yield* launch(launched, Effect.void);
      yield* launched.reactor.drain;
      assert.strictEqual(launched.received.length, 0, "the thread is still being launched");
      yield* launched.settle(shell({ status: "failed", activityRunStatus: null }));
      assert.deepInclude(verified(launched.received[0]).data, { kind: "failed", runId: RUN_1 });

      for (const failure of [Effect.fail("no thread"), Effect.interrupt]) {
        const unborn = yield* makeHarness({ initial: null });
        yield* launch(unborn, failure);
        yield* unborn.reactor.drain;
        assert.deepInclude(verified(unborn.received[0]).data, { kind: "ended" });
        assert.isFalse(yield* stillWatching(unborn.reactor));
      }
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("after a restart, a watch picks up from the thread as it is then", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness();
      yield* first.watch();
      const restarted = yield* makeHarness({ initial: shell() });
      assert.deepStrictEqual(yield* restarted.watch(), { wasWatching: true });
      yield* restarted.reactor.start();
      yield* restarted.reactor.drain;
      yield* restarted.settle(completed());
      assert.deepInclude(verified(restarted.received[0]).data, { kind: "completed", runId: RUN_1 });
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("a change made while a watch is being registered is still sent", () =>
    Effect.gen(function* () {
      const { received, reactor, watch } = yield* makeHarness({
        secretRefValue: SECRET,
        whileConsuming: (current) => Ref.set(current, completed()),
      });
      yield* watch({
        url: URL,
        secretRef: SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef"),
      });
      yield* reactor.drain;
      assert.deepInclude(verified(received[0]).data, { kind: "completed", runId: RUN_1 });
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("follows thread events, including a request_secret wait", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const pulls = yield* Queue.unbounded<void>();
      const { current, received, reactor, watch } = yield* makeHarness({
        domainEvents: Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
        ),
      });
      yield* watch();
      yield* reactor.start();
      yield* Queue.take(pulls);
      const asked = at("2026-10-20T12:40:00.000Z");
      const itemId = TurnItemId.make("item:secret");
      yield* Ref.set(
        current,
        shell({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make(itemId),
            kind: "user_input",
            createdAt: asked,
            blocking: true,
          },
        }),
      );
      yield* Queue.offer(events, {
        id: EventId.make("event:secret"),
        type: "turn-item.updated",
        threadId: THREAD_ID,
        runId: RUN_1,
        occurredAt: asked,
        payload: {
          id: itemId,
          threadId: THREAD_ID,
          runId: RUN_1,
          nodeId: NodeId.make("node:secret"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "waiting",
          title: null,
          startedAt: asked,
          completedAt: null,
          updatedAt: asked,
          type: "secret_request",
          label: "Webhook secret",
          reason: "Sign deliveries",
          secretStatus: "pending",
        },
      });
      yield* Queue.take(pulls);
      yield* reactor.drain;
      assert.deepInclude(verified(received[0]).data, { kind: "question" });
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("settling sends what changed, then ended, and ends the watch", () =>
    Effect.gen(function* () {
      const { received, reactor, settle, watch } = yield* makeHarness();
      yield* watch();
      yield* settle({ ...completed(), settledOverride: "settled" });
      assert.deepStrictEqual(
        received.map((request) => verified(request).data["kind"]),
        ["completed", "ended"],
      );
      yield* settle(completed(RUN_2, "2026-10-20T12:30:00.000Z"));
      assert.strictEqual(received.length, 2);
      assert.isFalse(yield* stillWatching(reactor));

      // Watched again after unsettling, a thread can end with nothing else changed.
      const again = yield* makeHarness();
      const settled = shell({ settledOverride: "settled" });
      yield* again.watch();
      yield* again.settle(settled);
      yield* again.settle(shell());
      yield* again.watch();
      yield* TestClock.adjust("1 minute");
      yield* again.settle(settled);
      const [first, second] = again.received;
      assert.notStrictEqual(second?.headers.get("webhook-id"), first?.headers.get("webhook-id"));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("a 410 from the receiver ends the watch", () =>
    Effect.gen(function* () {
      const { received, reactor, settle, watch } = yield* makeHarness({
        respond: () => new Response(null, { status: 410 }),
      });
      yield* watch();
      yield* settle(completed());
      yield* settle(completed(RUN_2, "2026-10-20T12:30:00.000Z"));
      assert.strictEqual(received.length, 1);
      assert.isFalse(yield* stillWatching(reactor));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("retries with the same event id, and unwatching drops the retry", () =>
    Effect.gen(function* () {
      const firstTry = yield* Deferred.make<void>();
      const retried = yield* makeHarness({
        respond: (attempt) => {
          Deferred.doneUnsafe(firstTry, Effect.void);
          return new Response(null, { status: attempt === 1 ? 503 : 204 });
        },
      });
      yield* retried.watch();
      yield* Ref.set(retried.current, completed());
      yield* retried.reactor.checkThread(THREAD_ID);
      yield* Deferred.await(firstTry);
      const draining = yield* Effect.forkChild(retried.reactor.drain);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(draining);
      const [first, retry] = retried.received;
      assert.strictEqual(retried.received.length, 2);
      assert.strictEqual(retry?.headers.get("webhook-id"), first?.headers.get("webhook-id"));
      verified(retry);

      const firstAttempt = yield* Deferred.make<void>();
      const dropped = yield* makeHarness({
        respond: () => {
          Deferred.doneUnsafe(firstAttempt, Effect.void);
          return new Response(null, { status: 503 });
        },
      });
      yield* dropped.watch({ url: "https://other.example.test/hook", secret: SECRET });
      yield* Ref.set(dropped.current, completed());
      yield* dropped.reactor.checkThread(THREAD_ID);
      yield* Deferred.await(firstAttempt);
      yield* dropped.reactor.unwatch({
        threadId: THREAD_ID,
        url: "https://other.example.test/hook",
      });
      const settling = yield* Effect.forkChild(dropped.reactor.drain);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(settling);
      assert.strictEqual(dropped.received.length, 1);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("a late 410 for a replaced watch leaves the replacement in place", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      let answer: (response: Response) => void = () => {};
      const first = yield* makeHarness({
        respond: () => {
          // Made before signalling: the signal can resume the test at once.
          const response = new Promise<Response>((resolve) => (answer = resolve));
          Deferred.doneUnsafe(requested, Effect.void);
          return response;
        },
      });
      yield* first.watch();
      yield* Ref.set(first.current, completed());
      yield* first.reactor.checkThread(THREAD_ID);
      yield* Deferred.await(requested);
      yield* first.watch({ url: URL, secret: `whsec_${Buffer.alloc(32, 9).toString("base64")}` });
      answer(new Response(null, { status: 410 }));
      yield* first.reactor.drain;
      const restarted = yield* makeHarness();
      assert.isTrue(yield* stillWatching(restarted.reactor), "the replacement's row survives");
      assert.isTrue(yield* stillWatching(first.reactor));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("a receiver that never answers does not hold up another thread", () =>
    Effect.gen(function* () {
      const other = ThreadId.make("other-thread");
      const hanging = "https://hanging.example.test/hook";
      const otherDelivered = yield* Deferred.make<void>();
      const { current, received, reactor, watch } = yield* makeHarness({
        respond: (_attempt, request) => {
          if (request.url === hanging) return new Promise<Response>(() => {});
          Deferred.doneUnsafe(otherDelivered, Effect.void);
          return new Response(null, { status: 204 });
        },
      });
      yield* watch({ url: hanging, secret: SECRET });
      yield* watch({ url: URL, secret: SECRET }, other);
      yield* Ref.set(current, completed());
      yield* reactor.checkThread(THREAD_ID);
      yield* reactor.checkThread(other);
      yield* Deferred.await(otherDelivered);
      assert.deepStrictEqual(
        received.map((request) => request.url),
        [hanging, URL],
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("refuses deliveries it could never sign or should never send", () =>
    Effect.gen(function* () {
      const { current, watch } = yield* makeHarness();
      const refused = (delivery: Parameters<typeof watch>[0]) =>
        watch(delivery).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      assert.include(
        yield* refused({ url: "http://receiver.example.test/", secret: SECRET }),
        "https",
      );
      assert.include(
        yield* refused({ url: "https://u:p@receiver.example.test/", secret: SECRET }),
        "https",
      );
      assert.include(yield* refused({ url: URL, secret: "shared-secret" }), "whsec_");
      assert.include(yield* refused({ url: URL }), "exactly one");
      yield* Ref.set(
        current,
        shell({
          lineage: {
            rootThreadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        }),
      );
      assert.include(yield* refused({ url: URL, secret: SECRET }), "parent");
      yield* Ref.set(current, shell({ settledOverride: "settled" }));
      assert.include(yield* refused({ url: URL, secret: SECRET }), "Unsettle");
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("stores one watch per URL, takes secrets from a secretRef, and unwatches by URL", () =>
    Effect.gen(function* () {
      const { consumed, reactor, watch } = yield* makeHarness({ secretRefValue: SECRET });
      const ref = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");
      yield* watch({ url: "https://Receiver.Example.Test/hook", secretRef: ref });
      assert.deepStrictEqual(consumed, [{ ref, projectId: PROJECT_ID }]);
      assert.deepStrictEqual(yield* watch({ url: "http://localhost:8787/hook", secret: SECRET }), {
        wasWatching: false,
      });
      assert.deepStrictEqual(yield* watch(), { wasWatching: true }, "one watch per URL");
      const unwatch = (url: string) => reactor.unwatch({ threadId: THREAD_ID, url });
      assert.deepStrictEqual(yield* unwatch("https://RECEIVER.example.test/hook"), {
        wasWatching: true,
      });
      assert.deepStrictEqual(yield* unwatch(URL), { wasWatching: false });
      assert.deepStrictEqual(yield* unwatch("http://localhost:8787/hook"), { wasWatching: true });
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
