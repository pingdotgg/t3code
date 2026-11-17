import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2StoredEvent,
  ThreadWebhookEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";

const Endpoint = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/)),
  url: Schema.String.check(
    Schema.makeFilter((value) => {
      try {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.hash &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
        );
      } catch {
        return false;
      }
    }),
  ),
  token: Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^[\x21-\x7e]+$/))),
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  threadIds: Schema.optional(Schema.Array(ThreadId)),
});

const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(ThreadWebhookEvent));
const decodeConfiguration = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Endpoint)));

type Notification<E = ThreadWebhookEvent> = E extends ThreadWebhookEvent
  ? Omit<
      E,
      | "schemaVersion"
      | "deliveryId"
      | "eventId"
      | "sequence"
      | "occurredAt"
      | "projectId"
      | "threadId"
    >
  : never;

export class Configuration extends Context.Reference<ReadonlyArray<typeof Endpoint.Type>>(
  "t3/orchestration-v2/ThreadWebhooks/Configuration",
  { defaultValue: () => [] },
) {}

export class ThreadWebhookConfigError extends Schema.TaggedError<ThreadWebhookConfigError>()(
  "ThreadWebhookConfigError",
  { reason: Schema.Literals(["read", "permissions", "invalid"]) },
) {
  override get message(): string {
    return `Cannot load private thread-webhooks.json configuration (${this.reason}).`;
  }
}

export class ThreadWebhookStoreError extends Schema.TaggedError<ThreadWebhookStoreError>()(
  "ThreadWebhookStoreError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Thread webhook outbox operation failed.";
  }
}

export class ThreadWebhooks extends Context.Service<
  ThreadWebhooks,
  {
    /** Called before projection writes, on the event transaction's connection. */
    readonly capture: (
      events: ReadonlyArray<OrchestrationV2StoredEvent>,
    ) => Effect.Effect<void, ThreadWebhookStoreError>;
    readonly wake: Effect.Effect<void>;
    /** Drain due deliveries and return the next active retry time. Successful rows are deleted. */
    readonly deliverPending: Effect.Effect<number | undefined, ThreadWebhookStoreError>;
    readonly awaitAvailable: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadWebhooks") {}

type DeliveryRow = {
  readonly delivery_id: string;
  readonly endpoint_id: string;
  readonly destination_url: string;
  readonly payload_json: string;
  readonly attempt_count: number;
  readonly next_attempt_at: number;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The 0.1.9 backport owns this schema independently of upstream migration IDs.
  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`CREATE TABLE IF NOT EXISTS pulsar_thread_webhook_outbox (
        delivery_id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        destination_url TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL
      )`;
        yield* sql`CREATE INDEX IF NOT EXISTS pulsar_thread_webhook_outbox_due_idx
        ON pulsar_thread_webhook_outbox(next_attempt_at)`;
      }),
    )
    .pipe(Effect.orDie);
  const endpoints = yield* Configuration;
  const http = yield* HttpClient.HttpClient;
  const available = yield* Queue.dropping<void>(1);
  const lane = yield* Semaphore.make(1);
  const endpointFor = (row: DeliveryRow) =>
    endpoints.find(
      (endpoint) => endpoint.id === row.endpoint_id && endpoint.url === row.destination_url,
    );

  // Capture runs before every projection update, including streamed provider items. The write owns the span.
  const capture = Effect.fnUntraced(
    function* (events: ReadonlyArray<OrchestrationV2StoredEvent>) {
      if (endpoints.length === 0) return;
      for (const stored of events) {
        const event = stored.event;
        let notification: Notification;
        if (
          (event.type === "run.updated" || event.type === "run.created") &&
          (event.payload.status === "completed" ||
            event.payload.status === "failed" ||
            event.payload.status === "interrupted" ||
            event.payload.status === "cancelled" ||
            event.payload.status === "rolled_back")
        ) {
          const [previous] = yield* sql<{ status: string }>`
          SELECT status FROM orchestration_v2_projection_runs WHERE run_id = ${event.payload.id}
        `;
          if (previous?.status === event.payload.status) continue;
          notification = {
            type: "thread.run.terminal",
            status: event.payload.status,
            runId: event.payload.id,
          };
        } else if (
          event.type === "runtime-request.updated" &&
          event.payload.status === "pending" &&
          (event.payload.kind === "user_input" ||
            event.payload.kind === "command" ||
            event.payload.kind === "file-read" ||
            event.payload.kind === "file-change" ||
            event.payload.kind === "permission" ||
            event.payload.kind === "mcp-elicitation")
        ) {
          const [previous] = yield* sql<{ status: string }>`
          SELECT status FROM orchestration_v2_projection_runtime_requests
          WHERE runtime_request_id = ${event.payload.id}
        `;
          if (previous?.status === "pending") continue;
          const [node] = yield* sql<{ run_id: string | null }>`
          SELECT run_id FROM orchestration_v2_projection_nodes WHERE node_id = ${event.payload.nodeId}
        `;
          notification = {
            type:
              event.payload.kind === "user_input"
                ? "thread.user-input.requested"
                : "thread.approval.requested",
            status: "pending",
            requestId: event.payload.id,
            runId: node?.run_id ? RunId.make(node.run_id) : null,
          };
        } else if (
          event.type === "turn-item.updated" &&
          event.payload.type === "error" &&
          (event.payload.status === "running" || event.payload.status === "failed")
        ) {
          const [previous] = yield* sql<{ status: string; failure_class: string | null }>`
            SELECT status, json_extract(payload_json, '$.failure.class') AS failure_class
            FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${event.payload.id}
          `;
          if (
            previous?.status === event.payload.status &&
            previous.failure_class === event.payload.failure.class
          )
            continue;
          notification = {
            type: "thread.provider-error",
            status: event.payload.status,
            turnItemId: event.payload.id,
            failureClass: event.payload.failure.class,
            runId: event.payload.runId,
          };
        } else if (
          event.type === "provider-thread.updated" &&
          (event.payload.goal?.status === "usage_limited" ||
            event.payload.goal?.status === "budget_limited")
        ) {
          const [previous] = yield* sql<{ status: string | null }>`
            SELECT json_extract(payload_json, '$.goal.status') AS status
            FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${event.payload.id}
          `;
          if (previous?.status === event.payload.goal.status) continue;
          notification = {
            type: "thread.goal.blocked",
            status: event.payload.goal.status,
            providerThreadId: event.payload.id,
            runId: null,
          };
        } else continue;
        const [thread] = yield* sql<{ project_id: string }>`
        SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id = ${event.threadId}
      `;
        if (thread === undefined) continue;
        for (const endpoint of endpoints) {
          if (
            (endpoint.projectIds !== undefined &&
              !endpoint.projectIds.includes(ProjectId.make(thread.project_id))) ||
            (endpoint.threadIds !== undefined && !endpoint.threadIds.includes(event.threadId))
          )
            continue;
          const deliveryId = `${endpoint.id}:${event.id}`;
          const payload: ThreadWebhookEvent = {
            schemaVersion: 1,
            deliveryId,
            eventId: event.id,
            sequence: stored.sequence,
            occurredAt: DateTime.formatIso(event.occurredAt),
            projectId: ProjectId.make(thread.project_id),
            threadId: event.threadId,
            ...notification,
          };
          const payloadJson = yield* encodeEvent(payload);
          yield* sql`
          INSERT OR IGNORE INTO pulsar_thread_webhook_outbox
            (delivery_id, endpoint_id, destination_url, payload_json, next_attempt_at)
          VALUES (${deliveryId}, ${endpoint.id}, ${endpoint.url}, ${payloadJson},
            ${DateTime.toEpochMillis(yield* DateTime.now)})
        `;
        }
      }
    },
    Effect.mapError((cause) => new ThreadWebhookStoreError({ cause })),
  );

  const deliverPending = Effect.gen(function* () {
    if (endpoints.length === 0) return undefined;
    const active = sql.or(
      endpoints.map(
        (endpoint) => sql`(endpoint_id = ${endpoint.id} AND destination_url = ${endpoint.url})`,
      ),
    );
    // Bound each drain so a backlog does not fill memory. The retry timer resumes remaining rows.
    const rows = yield* sql<DeliveryRow>`SELECT * FROM pulsar_thread_webhook_outbox WHERE ${active}
      AND next_attempt_at <= ${DateTime.toEpochMillis(yield* DateTime.now)}
      ORDER BY next_attempt_at, delivery_id LIMIT 100`;
    let next: number | undefined;
    for (const row of rows) {
      const endpoint = endpointFor(row);
      // Removed destinations keep their rows dormant. Re-adding the same id and URL resumes them.
      if (endpoint === undefined) continue;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      if (row.next_attempt_at > now) {
        next = Math.min(next ?? Infinity, row.next_attempt_at);
        continue;
      }
      const responseStatus = yield* HttpClientRequest.post(endpoint.url).pipe(
        HttpClientRequest.bearerToken(Redacted.value(endpoint.token)),
        HttpClientRequest.setHeader("Idempotency-Key", row.delivery_id),
        HttpClientRequest.setHeader("Content-Type", "application/json"),
        HttpClientRequest.bodyText(row.payload_json, "application/json"),
        http.execute,
        Effect.flatMap((response) => {
          const web = HttpClientResponse.toWeb(response);
          const body = Option.isSome(web) ? web.value.body : null;
          const cancel =
            body !== null
              ? Effect.promise(() => body.cancel().catch(() => undefined))
              : Effect.void;
          return cancel.pipe(Effect.as(response.status));
        }),
        Effect.timeout("10 seconds"),
        Effect.orElseSucceed(() => 0),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.scoped,
      );
      if (responseStatus === 200) {
        yield* sql`DELETE FROM pulsar_thread_webhook_outbox WHERE delivery_id = ${row.delivery_id}`;
      } else {
        const retryAt =
          DateTime.toEpochMillis(yield* DateTime.now) +
          Math.min(300_000, 1000 * 2 ** Math.min(row.attempt_count, 9));
        yield* sql`UPDATE pulsar_thread_webhook_outbox SET attempt_count = attempt_count + 1,
          next_attempt_at = ${retryAt} WHERE delivery_id = ${row.delivery_id}`;
        yield* Effect.logWarning("Thread webhook delivery failed; retry scheduled.").pipe(
          Effect.annotateLogs({
            endpointId: endpoint.id,
            deliveryId: row.delivery_id,
            attempt: row.attempt_count + 1,
            status: responseStatus,
            retryAt,
          }),
        );
        next = Math.min(next ?? Infinity, retryAt);
      }
    }
    const [remaining] = yield* sql<{ next: number | null }>`
      SELECT MIN(next_attempt_at) AS next FROM pulsar_thread_webhook_outbox WHERE ${active}
    `;
    return remaining?.next ?? next;
  }).pipe(
    lane.withPermits(1),
    Effect.mapError((cause) => new ThreadWebhookStoreError({ cause })),
  );

  return ThreadWebhooks.of({
    capture,
    deliverPending,
    wake: Queue.offer(available, undefined).pipe(Effect.asVoid),
    awaitAvailable: Queue.take(available),
  });
});

export const layer = Layer.effect(ThreadWebhooks, make).pipe(Layer.provide(FetchHttpClient.layer));

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const webhooks = yield* ThreadWebhooks;
    yield* forkParked(
      Effect.forever(
        Effect.gen(function* () {
          const next = yield* webhooks.deliverPending.pipe(
            Effect.catchTags({
              ThreadWebhookStoreError: () =>
                Effect.logError("Thread webhook delivery storage failed; retrying.").pipe(
                  Effect.andThen(DateTime.now),
                  Effect.map((now) => DateTime.toEpochMillis(now) + 1000),
                ),
            }),
          );
          if (next === undefined) yield* webhooks.awaitAvailable;
          else {
            const delay = Math.max(0, next - DateTime.toEpochMillis(yield* DateTime.now));
            yield* webhooks.awaitAvailable.pipe(
              Effect.timeoutOrElse({ duration: delay, orElse: () => Effect.void }),
            );
          }
        }),
      ),
    );
  }),
);

export const layerConfiguration = Layer.effect(
  Configuration,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const filename = path.join(stateDir, "thread-webhooks.json");
    const exists = yield* fs
      .exists(filename)
      .pipe(Effect.mapError(() => new ThreadWebhookConfigError({ reason: "read" })));
    if (!exists) return [];
    const stat = yield* fs
      .stat(filename)
      .pipe(Effect.mapError(() => new ThreadWebhookConfigError({ reason: "read" })));
    if ((yield* HostProcess.Platform) !== "win32" && (stat.mode & 0o077) !== 0) {
      return yield* new ThreadWebhookConfigError({ reason: "permissions" });
    }
    const contents = yield* fs
      .readFileString(filename)
      .pipe(Effect.mapError(() => new ThreadWebhookConfigError({ reason: "read" })));
    const endpoints = yield* decodeConfiguration(contents).pipe(
      Effect.mapError(() => new ThreadWebhookConfigError({ reason: "invalid" })),
    );
    if (new Set(endpoints.map((endpoint) => endpoint.id)).size !== endpoints.length) {
      return yield* new ThreadWebhookConfigError({ reason: "invalid" });
    }
    return endpoints;
  }),
);
