import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProjectId,
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  ScheduledTaskWebhookDeliveryId,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskDeleteResult,
  type ScheduledTaskGetWebhookDeliveryInput,
  type ScheduledTaskGetWebhookDeliveryResult,
  type ScheduledTaskListWebhookDeliveriesInput,
  type ScheduledTaskListWebhookDeliveriesResult,
  type ScheduledTaskRotateWebhookTokenInput,
  type ScheduledTaskWebhookDeliveryOutcome,
  type ScheduledTaskWebhookFilter,
  type ScheduledTaskListResult,
  type ScheduledTaskMutationResult,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskRunNowResult,
  type ScheduledTaskSetEnabledInput,
  type ScheduledTaskUpsertInput,
  managedPolicyDeniedMessage,
  managedRuntimeModeDenial,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { ScheduledTaskService, WEBHOOK_DEDUPE_DELIVERY_RETENTION, WEBHOOK_DEDUPE_LOG_PER_MINUTE, WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT, WEBHOOK_DELIVERY_RETENTION, WEBHOOK_FILTERED_DELIVERY_RETENTION, WEBHOOK_FILTERED_LOG_PER_MINUTE, WEBHOOK_RATE_LIMIT_PER_MINUTE, encodeHeadersJson, encodeMissingFieldsJson, taskError } from "./ScheduledTaskService.ts";
import type { RateWindow, WebhookDeliverySkipped, WebhookTriggerRequest } from "./ScheduledTaskService.ts";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as Metrics from "../observability/Metrics.ts";
import {
  redactHeaders,
  redactQuery,
  renderWebhookPrompt,
  type WebhookRequest,
} from "./webhookTemplate.ts";
import {
  acceptWebhookDedupe,
  acceptImmediateWebhookDedupe,
  releaseWebhookReplay,
  decodePendingTask,
  encodePendingTask,
  decodePendingRequest,
  dedupeError,
} from "./webhookDedupe.ts";
import type { WebhookDeliveryOutcome } from "./ScheduledTaskServiceParts8.ts";

import type { makeScheduledTaskStage3 } from "./ScheduledTaskService-part5.ts";

type State = Effect.Success<ReturnType<typeof makeScheduledTaskStage3>>;

export const makeScheduledTaskStage4 = Effect.fn("makeScheduledTaskStage4")(function* (state: State) {
    const {
      sql,
      random,
      threadLaunch,
      threadManagement,
      managedFolders,
      secretRequests,
      scheduler,
      readWebhookOrigin,
      managedPolicy,
      webhookPolicyOrganization,
      webhookPolicyBlock,
      withPolicy,
      webhookPermits,
      webhookQueued,
      webhookRateWindows,
      webhookRejectedRateWindows,
      webhookDedupeLogWindows,
      pendingInFlight,
      webhookFilteredLogWindows,
      activeRuns,
      changesPubSub,
      dueTasks,
      pendingWebhooks,
      notifyChanged,
      selectAllRows,
      listRows,
      getRows,
      findTask,
      findWebhookCredentials,
      newWebhookToken,
      loadTask,
      saveTask,
      deleteRow,
      markRunning,
      markCompleted,
      releaseStuckRun,
      runTask,
      rescheduleMissedRun,
      runDueTasks,
      list,
      subscribeList,
      upsert,
      setEnabled,
      forgetWebhookTask,
      deleteTask,
      deleteForThread,
      moveThreadTasks,
      runNow,
      rotateWebhookToken,
      deliveryHeaders,
      decodeDeliverySummary,
      listWebhookDeliveries,
      getWebhookDelivery,
      deliveryRequestBody,
      replaceDeliveryRequest,
      deliveryBucket,
    } = state;
    const pruneDeliveries = (
      taskId: string,
      retentionBucket: ReturnType<typeof deliveryBucket>,
    ) => {
      const rowBucket = sql.literal(`CASE WHEN outcome = 'filtered' THEN 'filtered'
        WHEN outcome IN ('duplicate', 'coalesced', 'rate_limited') OR error = 'The filled-in prompt is too long.' THEN 'dedupe'
        ELSE 'main' END`);
      return sql`
        DELETE FROM scheduled_task_webhook_deliveries
        WHERE task_id = ${taskId} AND ${rowBucket} = ${retentionBucket}
          AND delivery_id NOT IN (
            SELECT delivery_id FROM scheduled_task_webhook_deliveries
            WHERE task_id = ${taskId} AND ${rowBucket} = ${retentionBucket}
            ORDER BY received_at DESC, rowid DESC
            LIMIT ${retentionBucket === "main" ? WEBHOOK_DELIVERY_RETENTION : retentionBucket === "filtered" ? WEBHOOK_FILTERED_DELIVERY_RETENTION : WEBHOOK_DEDUPE_DELIVERY_RETENTION}
          )
      `;
    };

    const recordDelivery = (input: {
      readonly id: string;
      readonly taskId: ScheduledTaskId;
      readonly receivedAt: string;
      readonly request: WebhookTriggerRequest;
      readonly outcome: ScheduledTaskWebhookDeliveryOutcome;
      readonly signatureVerified: boolean;
      readonly missing: ReadonlyArray<string>;
      readonly renderedPrompt: string | null;
      readonly error?: string;
    }) => {
      const { truncated, body: loggedBody } = deliveryRequestBody(input.request);
      return sql
        .withTransaction(
          Effect.gen(function* () {
            // Require the task to exist so deletes cannot leave deliveries for a recreated task.
            yield* sql`
              INSERT INTO scheduled_task_webhook_deliveries (
                delivery_id, task_id, received_at, method, query, headers_json, body,
                body_bytes, body_truncated, outcome, signature_verified,
                missing_fields_json, rendered_prompt, error
              )
              SELECT
                ${input.id}, ${input.taskId}, ${input.receivedAt}, ${input.request.method},
                ${redactQuery(input.request.query)},
                ${encodeHeadersJson(redactHeaders(input.request.headers))},
                ${loggedBody},
                ${input.request.body.byteLength}, ${truncated ? 1 : 0}, ${input.outcome},
                ${input.signatureVerified ? 1 : 0}, ${encodeMissingFieldsJson(input.missing)},
                ${input.renderedPrompt?.slice(0, WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT) ?? null},
                ${input.error ?? null}
              WHERE EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${input.taskId})
              -- A held request retried after a rate limit reuses its relay
              -- delivery id; the newer attempt replaces the logged one.
              ON CONFLICT (delivery_id) DO UPDATE SET
                outcome = excluded.outcome,
                signature_verified = excluded.signature_verified,
                missing_fields_json = excluded.missing_fields_json,
                rendered_prompt = excluded.rendered_prompt,
                error = excluded.error
            `;
            yield* pruneDeliveries(input.taskId, deliveryBucket(input.outcome, input.error));
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not record webhook delivery.", { taskId: input.taskId, cause }),
          ),
        );
    };

    const markDeliveryFailed = (deliveryId: string, message: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const [updated] = yield* sql<{ task_id: string }>`
              UPDATE scheduled_task_webhook_deliveries
              SET outcome = 'dispatch_failed', error = ${message}
              WHERE delivery_id = ${deliveryId}
              RETURNING task_id
            `;
            // An oversized prompt moves the row into the suppression bucket.
            if (updated !== undefined)
              yield* pruneDeliveries(updated.task_id, deliveryBucket("dispatch_failed", message));
          }),
        )
        .pipe(Effect.ignore);

    /** Sliding one-minute window for deliveries that can start work. */
    const takeRateSlot = (
      id: ScheduledTaskId,
      nowMs: number,
      rateWindows = webhookRateWindows,
      reservation = { at: nowMs },
    ) =>
      Ref.modify(
        rateWindows,
        (
          windows,
        ): readonly [
          "allowed" | "first_rejected" | "rejected",
          ReadonlyMap<ScheduledTaskId, RateWindow>,
        ] => {
          const current = windows.get(id);
          const recent = (current?.accepted ?? []).filter((entry) => nowMs - entry.at < 60_000);
          if (recent.length >= WEBHOOK_RATE_LIMIT_PER_MINUTE) {
            const first = current?.rejectedLogged !== true;
            return [
              first ? "first_rejected" : "rejected",
              new Map(windows).set(id, { accepted: recent, rejectedLogged: true }),
            ];
          }
          return [
            "allowed",
            new Map(windows).set(id, { accepted: [...recent, reservation], rejectedLogged: false }),
          ];
        },
      );

    const takeDedupeLogSlot = (id: ScheduledTaskId, nowMs: number) =>
      Ref.modify(webhookDedupeLogWindows, (windows) => {
        const recent = (windows.get(id) ?? []).filter((at) => nowMs - at < 60_000);
        return recent.length >= WEBHOOK_DEDUPE_LOG_PER_MINUTE
          ? ([false, windows] as const)
          : ([true, new Map(windows).set(id, [...recent, nowMs])] as const);
      });
    const releaseReplay = (deliveryId: string) =>
      releaseWebhookReplay(deliveryId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(dedupeError),
      );
    /** Sliding one-minute window of filtered requests written to the delivery log. */
    const takeFilteredLogSlot = (id: ScheduledTaskId, nowMs: number) =>
      Ref.modify(
        webhookFilteredLogWindows,
        (windows): readonly [boolean, ReadonlyMap<ScheduledTaskId, ReadonlyArray<number>>] => {
          const recent = (windows.get(id) ?? []).filter((at) => nowMs - at < 60_000);
          return recent.length >= WEBHOOK_FILTERED_LOG_PER_MINUTE
            ? [false, windows]
            : [true, new Map(windows).set(id, [...recent, nowMs])];
        },
      );

    const webhookPermit = Effect.fn("ScheduledTaskService.webhookPermit")(function* (
      id: ScheduledTaskId,
    ) {
      const existing = (yield* Ref.get(webhookPermits)).get(id);
      if (existing !== undefined) return existing;
      const created = yield* Semaphore.make(1);
      return yield* Ref.modify(webhookPermits, (permits) => {
        const raced = permits.get(id);
        return raced === undefined
          ? [created, new Map(permits).set(id, created)]
          : [raced, permits];
      });
    });

    const serviceScope = yield* Effect.scope;

    const releaseFailedDelivery = Effect.fn("ScheduledTaskService.releaseFailedDelivery")(
      function* (deliveryId: string) {
        yield* releaseReplay(deliveryId);
        yield* sql`DELETE FROM scheduled_task_webhook_relay_deliveries WHERE relay_delivery_id IN (
          SELECT substr(value, ${"delivery:relay:".length + 1}) FROM scheduled_task_webhook_pending, json_each(delivery_ids_json)
          WHERE delivery_id = ${deliveryId} AND value LIKE 'delivery:relay:%'
        )`.pipe(Effect.mapError(dedupeError));
        if (deliveryId.startsWith("delivery:relay:"))
          yield* sql`DELETE FROM scheduled_task_webhook_relay_deliveries WHERE relay_delivery_id = ${deliveryId.slice("delivery:relay:".length)}`.pipe(
            Effect.mapError(dedupeError),
          );
      },
      (effect) => sql.withTransaction(effect).pipe(Effect.mapError(dedupeError)),
    );

    const runWebhookDelivery = Effect.fn("ScheduledTaskService.runWebhookDelivery")(function* (
      task: ScheduledTask,
      deliveryId: string,
      prompt: string,
    ) {
      const runOutcome = (outcome: "started" | "skipped" | "failed") =>
        Effect.all([
          Effect.annotateCurrentSpan({ "scheduled_task.webhook.run_outcome": outcome }),
          Metrics.increment(Metrics.webhookRunsTotal, { outcome }),
        ]);
      const dispatched = yield* Ref.make(false);
      return yield* runTask(task, "webhook", { deliveryId, prompt, dispatched }).pipe(
        Effect.flatMap(({ dispatchFailed }) =>
          dispatchFailed
            ? runOutcome("failed").pipe(
                Effect.andThen(markDeliveryFailed(deliveryId, "The run failed to start.")),
                Effect.andThen(releaseFailedDelivery(deliveryId)),
              )
            : runOutcome("started"),
        ),
        Effect.catchTags({
          WebhookDeliverySkipped: (skipped) =>
            runOutcome("skipped").pipe(
              Effect.andThen(markDeliveryFailed(deliveryId, skipped.reason)),
              Effect.andThen(releaseFailedDelivery(deliveryId)),
            ),
        }),
        Effect.as(true),
        // Dispatch success owns the replay key even if later bookkeeping fails.
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const started = yield* Ref.get(dispatched);
            yield* Effect.logWarning("Webhook dispatch failed", { taskId: task.id, cause });
            yield* runOutcome(started ? "started" : "failed");
            yield* markDeliveryFailed(
              deliveryId,
              started
                ? "The run started, but completion could not be recorded."
                : "The run failed to start.",
            );
            if (!started) {
              yield* sql
                .withTransaction(
                  Effect.gen(function* () {
                    const counted =
                      yield* sql`UPDATE scheduled_task_webhook_pending SET state = 'failed'
                WHERE delivery_id = ${deliveryId} AND state = 'running' RETURNING delivery_id`;
                    if (counted.length > 0)
                      yield* sql`UPDATE scheduled_tasks SET run_count = run_count + 1
                WHERE task_id = ${task.id} AND created_at = ${task.createdAt}`;
                  }),
                )
                .pipe(Effect.mapError(dedupeError));
              yield* releaseFailedDelivery(deliveryId);
            }
            // Pending windows retry the same command id to finish bookkeeping.
            return !started;
          }),
        ),
      );
    });

    // Delivery attributes belong to the enclosing triggerWebhook span.
    const observeDelivery = Effect.fnUntraced(function* (
      request: WebhookTriggerRequest,
      outcome: WebhookDeliveryOutcome,
      receivedAt: DateTime.DateTime | undefined,
      now: DateTime.DateTime | undefined,
    ) {
      const source = request.relayDeliveryId === undefined ? "direct" : "relay";
      yield* Effect.annotateCurrentSpan({
        "scheduled_task.webhook.outcome": outcome,
        "scheduled_task.webhook.source": source,
      });
      yield* Metrics.increment(Metrics.webhookDeliveriesTotal, { outcome, source });
      if (request.receivedAt !== undefined && receivedAt !== undefined && now !== undefined) {
        const heldMs = Math.max(
          0,
          DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt),
        );
        yield* Effect.annotateCurrentSpan({ "scheduled_task.webhook.held_ms": heldMs });
        yield* Metric.update(Metrics.webhookHeldDelay, Duration.millis(heldMs));
      }
    });

    return {
      ...state,
      pruneDeliveries,
      recordDelivery,
      markDeliveryFailed,
      takeRateSlot,
      takeDedupeLogSlot,
      releaseReplay,
      takeFilteredLogSlot,
      webhookPermit,
      serviceScope,
      releaseFailedDelivery,
      runWebhookDelivery,
      observeDelivery,
    };
});
