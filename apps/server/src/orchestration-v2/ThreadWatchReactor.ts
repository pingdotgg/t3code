import {
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type SecretRef,
  type SecretRequestError,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  makeAgentAwarenessPublishWorker,
  shouldPublishAgentAwarenessEvent,
} from "../relay/AgentAwarenessRelay.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { forkParked } from "../serverActivation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  observeThreadWatch,
  standardWebhookKey,
  standardWebhookSignature,
  threadWatchEventBody,
  threadWatchEventId,
  threadWatchId,
  type ThreadWatchState,
  UNSEEN,
} from "./threadWatch.ts";

export class ThreadWatchInvalidError extends Schema.TaggedError<ThreadWatchInvalidError>()(
  "ThreadWatchInvalidError",
  { reason: Schema.Literals(["url", "secret", "secret_source", "subagent", "ended"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "url":
        return "delivery.url must be an https URL without credentials or a fragment. Plain http is accepted only for localhost.";
      case "secret":
        return "The signing secret must be a Standard Webhooks secret: whsec_ followed by base64 of 24 to 64 random bytes.";
      case "secret_source":
        return "Pass exactly one of delivery.secret or delivery.secretRef.";
      case "subagent":
        return "This thread is a subagent. Watch its parent thread instead.";
      case "ended":
        return "This thread is settled, archived or deleted, so there is nothing to watch. Unsettle or unarchive it first.";
    }
  }
}

export class ThreadWatchStoreError extends Schema.TaggedError<ThreadWatchStoreError>()(
  "ThreadWatchStoreError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not update thread watches.";
  }
}

class ThreadWatchDeliveryError extends Schema.TaggedError<ThreadWatchDeliveryError>()(
  "ThreadWatchDeliveryError",
  { status: Schema.NullOr(Schema.Number) },
) {}

interface ThreadWatchDelivery {
  readonly url: string;
  readonly secret?: string | undefined;
  readonly secretRef?: SecretRef | undefined;
}

export class ThreadWatchReactor extends Context.Service<
  ThreadWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly checkThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly watch: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly delivery: ThreadWatchDelivery;
    }) => Effect.Effect<
      { readonly wasWatching: boolean },
      ThreadWatchInvalidError | ThreadWatchStoreError | SecretRequestError
    >;
    readonly unwatch: (input: {
      readonly threadId: ThreadId;
      readonly url: string;
    }) => Effect.Effect<{ readonly wasWatching: boolean }, ThreadWatchStoreError>;
    /** Watches the thread `launch` creates before it exists, so its first run cannot be missed. */
    readonly watchLaunch: <A, E, R>(input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly delivery: ThreadWatchDelivery;
      readonly launch: Effect.Effect<A, E, R>;
    }) => Effect.Effect<
      A,
      E | ThreadWatchInvalidError | ThreadWatchStoreError | SecretRequestError,
      R
    >;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadWatchReactor") {}

interface Watch {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly url: string;
  readonly key: Uint8Array;
}

function threadWatchUrl(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.username !== "" || url.password !== "" || url.hash !== "") return null;
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.href : null;
}

// A `request_secret` wait shows as pending input, but its only event is a turn
// item the mobile alert filter skips.
const wakesWatchers = (event: OrchestrationV2DomainEvent) =>
  shouldPublishAgentAwarenessEvent(event) ||
  (event.type === "turn-item.updated" && event.payload.type === "secret_request");

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const secretRequests = yield* SecretRequests.SecretRequests;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const deliveries = yield* FiberSet.make<void, never>();
  // Registration changes take turns, so a late removal cannot delete a newer watch's row.
  const registrations = yield* Semaphore.make(1);
  const watchesByThread = new Map<ThreadId, Map<string, Watch>>();
  const told = new Map<string, ThreadWatchState>();

  const add = (watch: Watch) => {
    const watches = watchesByThread.get(watch.threadId) ?? new Map<string, Watch>();
    watches.set(watch.url, watch);
    watchesByThread.set(watch.threadId, watches);
  };
  const isCurrent = (watch: Watch) => watchesByThread.get(watch.threadId)?.get(watch.url) === watch;
  const forget = (watch: Watch) => {
    if (!isCurrent(watch)) return;
    watchesByThread.get(watch.threadId)?.delete(watch.url);
    if (watchesByThread.get(watch.threadId)?.size === 0) watchesByThread.delete(watch.threadId);
    told.delete(watch.id);
  };

  const stored = yield* sql<{
    readonly thread_id: string;
    readonly url: string;
    readonly secret: string;
  }>`SELECT thread_id, url, secret FROM thread_watches`.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("thread watches could not be loaded", { cause }).pipe(Effect.as([])),
    ),
  );
  for (const row of stored) {
    const key = standardWebhookKey(row.secret);
    const threadId = ThreadId.make(row.thread_id);
    if (key !== null) add({ id: threadWatchId(threadId, row.url), threadId, url: row.url, key });
  }

  const end = (watch: Watch) =>
    Effect.suspend(() =>
      isCurrent(watch)
        ? sql`DELETE FROM thread_watches WHERE thread_id = ${watch.threadId} AND url = ${watch.url}`.pipe(
            Effect.andThen(Effect.sync(() => forget(watch))),
          )
        : Effect.void,
    ).pipe(
      registrations.withPermits(1),
      Effect.catchCause((cause) =>
        Effect.logWarning("thread watch could not be removed", { watchId: watch.id, cause }),
      ),
    );

  const post = Effect.fn("ThreadWatchReactor.post")(function* (
    watch: Watch,
    eventId: string,
    body: string,
  ) {
    const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    // Redirects stay manual so a receiver cannot bounce the signed body to
    // another host. Tracing stays off because request spans record the URL.
    const response = yield* HttpClient.withScope(httpClient)
      .post(watch.url, {
        body: HttpBody.text(body, "application/json"),
        headers: {
          "webhook-id": eventId,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": standardWebhookSignature({
            key: watch.key,
            id: eventId,
            timestamp,
            body,
          }),
          "x-mcp-subscription-id": watch.id,
        },
      })
      .pipe(
        Effect.map(({ status }) => status),
        Effect.scoped,
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.withTracerEnabled(false),
        Effect.timeoutOption("10 seconds"),
        Effect.option,
      );
    const status = Option.getOrNull(Option.flatten(response));
    if (status === null || status < 200 || (status >= 300 && status !== 410))
      return yield* new ThreadWatchDeliveryError({ status });
    return status;
  });

  const deliver = (watch: Watch, eventId: string, body: string) =>
    Effect.suspend(() => (isCurrent(watch) ? post(watch, eventId, body) : Effect.succeed(0))).pipe(
      Effect.retry({ schedule: Schedule.exponential("2 seconds"), times: 3 }),
      // MCP Events: 410 means the receiver dropped the subscription.
      Effect.flatMap((status) => (status === 410 ? end(watch) : Effect.void)),
      Effect.catchTags({
        ThreadWatchDeliveryError: (error) =>
          Effect.logWarning("thread watch delivery failed", {
            watchId: watch.id,
            status: error.status,
          }),
      }),
    );

  // Untraced: it runs for every qualifying event on every thread.
  const check = Effect.fnUntraced(
    function* (threadId: ThreadId) {
      const watches = watchesByThread.get(threadId);
      if (watches === undefined) return;
      const shell = yield* threads.getThreadShell(threadId);
      const environmentId = yield* environment.getEnvironmentId;
      const now = yield* DateTime.now;
      for (const watch of watches.values()) {
        const prior = told.get(watch.id);
        const { state, kinds } = observeThreadWatch(shell, prior ?? UNSEEN);
        told.set(watch.id, state);
        // A first look only sets the baseline, unless the thread already ended.
        const send = prior === undefined ? kinds.filter((kind) => kind === "ended") : kinds;
        if (send.length === 0) continue;
        yield* FiberSet.run(
          deliveries,
          Effect.forEach(
            send,
            (kind) => {
              const eventId = threadWatchEventId(watch.id, kind, state, now);
              const body = threadWatchEventBody({
                eventId,
                environmentId,
                threadId,
                shell,
                kind,
                occurredAt: now,
              });
              return deliver(watch, eventId, body);
            },
            { discard: true },
          ).pipe(Effect.andThen(state.ended ? end(watch) : Effect.void)),
        );
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread watch check failed", { threadId, cause }),
        ),
      ),
  );
  const worker = yield* makeAgentAwarenessPublishWorker(check);

  const watch: ThreadWatchReactor["Service"]["watch"] = Effect.fn("ThreadWatchReactor.watch")(
    function* ({ threadId, projectId, delivery }) {
      const url = threadWatchUrl(delivery.url);
      if (url === null) return yield* new ThreadWatchInvalidError({ reason: "url" });
      if ((delivery.secret === undefined) === (delivery.secretRef === undefined))
        return yield* new ThreadWatchInvalidError({ reason: "secret_source" });
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError((cause) => new ThreadWatchStoreError({ cause })));
      if (shell?.lineage.relationshipToParent === "subagent")
        return yield* new ThreadWatchInvalidError({ reason: "subagent" });
      const baseline = shell === null ? UNSEEN : observeThreadWatch(shell, UNSEEN).state;
      if (baseline.ended) return yield* new ThreadWatchInvalidError({ reason: "ended" });
      const secret =
        delivery.secretRef === undefined
          ? (delivery.secret ?? "")
          : yield* secretRequests.consume({ ref: delivery.secretRef, projectId });
      const key = standardWebhookKey(secret);
      if (key === null) return yield* new ThreadWatchInvalidError({ reason: "secret" });
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const id = threadWatchId(threadId, url);
      return yield* sql`
        INSERT INTO thread_watches (thread_id, url, secret, created_at)
        VALUES (${threadId}, ${url}, ${secret}, ${createdAt})
        ON CONFLICT(thread_id, url) DO UPDATE SET secret = excluded.secret
      `.pipe(
        Effect.mapError((cause) => new ThreadWatchStoreError({ cause })),
        Effect.map(() => {
          const wasWatching = watchesByThread.get(threadId)?.has(url) ?? false;
          if (!told.has(id)) told.set(id, baseline);
          add({ id, threadId, url, key });
          return { wasWatching };
        }),
        registrations.withPermits(1),
        // The thread may have changed since its baseline was read.
        Effect.tap(() => (shell === null ? Effect.void : worker.enqueue(threadId))),
      );
    },
  );

  const unwatch: ThreadWatchReactor["Service"]["unwatch"] = Effect.fn("ThreadWatchReactor.unwatch")(
    function* ({ threadId, url }) {
      const target = threadWatchUrl(url) ?? url;
      return yield* sql`DELETE FROM thread_watches WHERE thread_id = ${threadId} AND url = ${target}`.pipe(
        Effect.mapError((cause) => new ThreadWatchStoreError({ cause })),
        Effect.map(() => {
          const watch = watchesByThread.get(threadId)?.get(target);
          if (watch !== undefined) forget(watch);
          return { wasWatching: watch !== undefined };
        }),
        registrations.withPermits(1),
      );
    },
  );

  const watchLaunch: ThreadWatchReactor["Service"]["watchLaunch"] = ({ launch, ...input }) =>
    Effect.uninterruptibleMask((restore) =>
      watch(input).pipe(
        Effect.andThen(
          restore(launch).pipe(
            // A failed launch may still have created the thread; the check ends
            // the watch only if it did not.
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : worker.enqueue(input.threadId),
            ),
          ),
        ),
      ),
    ).pipe(Effect.withSpan("ThreadWatchReactor.watchLaunch"));

  const start: ThreadWatchReactor["Service"]["start"] = Effect.fn("ThreadWatchReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) =>
          wakesWatchers(event) ? worker.enqueue(event.threadId) : Effect.void,
        ),
      );
      yield* Effect.forEach([...watchesByThread.keys()], worker.enqueue, { discard: true });
    },
  );

  return ThreadWatchReactor.of({
    start,
    checkThread: (threadId) => worker.enqueue(threadId).pipe(Effect.asVoid),
    watch,
    unwatch,
    watchLaunch,
    drain: worker.drain.pipe(Effect.andThen(FiberSet.awaitEmpty(deliveries))),
  });
});

export const layer = Layer.effect(ThreadWatchReactor, make);
