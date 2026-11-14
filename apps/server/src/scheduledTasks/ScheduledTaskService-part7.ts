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
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import { PROMPT_TOO_LONG, ScheduledTaskService, WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT, WEBHOOK_MAX_QUEUED_PER_TASK, WEBHOOK_RATE_LIMIT_PER_MINUTE, decodeTaskId, encodeMissingFieldsJson, isScheduledTaskError, iso, localNow, taskError } from "./ScheduledTaskService.ts";
import type { WebhookTriggerRequest } from "./ScheduledTaskService.ts";

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
import { describeFailedWebhookFilter, findFailedWebhookFilter } from "./webhookFilter.ts";
import { constantTimeEquals, verifyWebhookSignature } from "./webhookVerification.ts";
import { decodeRow } from "./ScheduledTaskServiceParts.ts";
import type { WebhookDeliveryOutcome } from "./ScheduledTaskServiceParts8.ts";

import type { makeScheduledTaskStage4 } from "./ScheduledTaskService-part6.ts";

type State = Effect.Success<ReturnType<typeof makeScheduledTaskStage4>>;

export const makeScheduledTaskFlows = Effect.fn("makeScheduledTaskFlows")(function* (state: State) {
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
    } = state;
    const triggerWebhook: ScheduledTaskService["Service"]["triggerWebhook"] = (request) =>
      triggerWebhookUnobserved(request).pipe(
        // Accepted deliveries may have queued a coalescing window.
        Effect.ensuring(pendingWebhooks.invalidate),
        Effect.tapError(() => observeDelivery(request, "error", undefined, undefined)),
        Metrics.withMetrics({ timer: Metrics.webhookDeliveryDuration }),
        Effect.withSpan("ScheduledTaskService.triggerWebhook", {
          attributes: {
            "scheduled_task.webhook.method": request.method,
            "scheduled_task.webhook.body_bytes": request.body.byteLength,
            "scheduled_task.webhook.source":
              request.relayDeliveryId === undefined ? "direct" : "relay",
          },
        }),
      );

    // triggerWebhook owns the operation span and its task-id annotation.
    const triggerWebhookUnobserved = Effect.fnUntraced(function* (request: WebhookTriggerRequest) {
      // Refused before any lookup or log, so a blocked hook neither runs nor records a delivery.
      if (webhookPolicyBlock !== undefined) {
        return yield* observeDelivery(request, "blocked_by_policy", undefined, undefined).pipe(
          Effect.as({ _tag: "blocked_by_policy" as const }),
        );
      }
      const taskId = decodeTaskId(request.hookId);
      const notFound = observeDelivery(request, "not_found", undefined, undefined).pipe(
        Effect.as({ _tag: "not_found" as const }),
      );
      if (Option.isNone(taskId)) return yield* notFound;
      const rows = yield* getRows(taskId.value).pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: taskId.value, cause }),
        ),
      );
      const row = rows[0];
      // A wrong token is indistinguishable from an unknown hook, so the URL
      // does not reveal which hooks exist.
      if (
        row === undefined ||
        row.webhook_token === null ||
        !constantTimeEquals(request.token, row.webhook_token)
      ) {
        return yield* notFound;
      }
      const task = yield* decodeRow(row);
      yield* Effect.annotateCurrentSpan({ "scheduled_task.id": task.id });
      const schedule = task.schedule;
      if (schedule.type !== "webhook") return yield* notFound;

      const now = yield* localNow;
      // Anyone can reach the tunnel directly and set the relay's header, so
      // a receive time is never later than now: a future one would pin the
      // delivery in the log and slip past the task's max age.
      const receivedAt =
        request.receivedAt === undefined
          ? now
          : DateTime.min(
              Option.getOrElse(DateTime.make(request.receivedAt), () => now),
              now,
            );
      const observe = (outcome: WebhookDeliveryOutcome) =>
        observeDelivery(request, outcome, receivedAt, now);
      const deliveryId = ScheduledTaskWebhookDeliveryId.make(
        request.relayDeliveryId === undefined
          ? `delivery:${yield* random
              .uuidV4()
              .pipe(
                Effect.mapError((cause) => taskError("Could not generate delivery id.", { cause })),
              )}`
          : `delivery:relay:${request.relayDeliveryId}`,
      );
      // Claimed in its own table, kept longer than the relay holds a request,
      // because the delivery log is trimmed. A rate-limited delivery stays
      // held on the relay, so it must give up its claim or the next pass
      // would treat it as already delivered.
      let claimAcquired = false;
      const releaseClaim = <A>(result: A) =>
        !claimAcquired || request.relayDeliveryId === undefined
          ? Effect.succeed(result)
          : sql`
                DELETE FROM scheduled_task_webhook_relay_deliveries
                WHERE relay_delivery_id = ${request.relayDeliveryId}
              `.pipe(Effect.ignore, Effect.as(result));
      // From the claim until the run is forked nothing may interrupt: a
      // request dropped in between (the relay hangs up after its timeout)
      // would leave a claimed delivery that never runs, or a queue slot that
      // is never released.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          if (request.relayDeliveryId !== undefined) {
            const claimed = yield* sql<{ relay_delivery_id: string }>`
                INSERT INTO scheduled_task_webhook_relay_deliveries
                  (relay_delivery_id, task_id, seen_at)
                VALUES (${request.relayDeliveryId}, ${task.id}, ${iso(now)})
                ON CONFLICT (relay_delivery_id) DO NOTHING
                RETURNING relay_delivery_id
              `.pipe(
              Effect.mapError((cause) =>
                taskError("Could not record webhook delivery.", { taskId: task.id, cause }),
              ),
            );
            if (claimed.length === 0) {
              yield* observe("duplicate");
              return { _tag: "accepted" as const, deliveryId, outcome: "duplicate" as const };
            }
            claimAcquired = true;
            yield* sql`
                DELETE FROM scheduled_task_webhook_relay_deliveries
                WHERE seen_at < ${iso(DateTime.subtract(now, { hours: 48 }))}
              `.pipe(Effect.ignore);
          }
          const log = (
            outcome: ScheduledTaskWebhookDeliveryOutcome,
            details: {
              readonly signatureVerified?: boolean;
              readonly missing?: ReadonlyArray<string>;
              readonly renderedPrompt?: string;
              readonly error?: string;
            } = {},
          ) =>
            recordDelivery({
              id: deliveryId,
              taskId: task.id,
              receivedAt: iso(receivedAt),
              request,
              outcome,
              signatureVerified: details.signatureVerified ?? false,
              missing: details.missing ?? [],
              renderedPrompt: details.renderedPrompt ?? null,
              ...(details.error === undefined ? {} : { error: details.error }),
            });

          // Reject floods before signature work or rejection-log writes; valid
          // deliveries give this reservation back once validation succeeds.
          const rejectionReservation = { at: DateTime.toEpochMillis(now) };
          const rejectionSlot = yield* takeRateSlot(
            task.id,
            DateTime.toEpochMillis(now),
            webhookRejectedRateWindows,
            rejectionReservation,
          );
          if (rejectionSlot !== "allowed") {
            if (rejectionSlot === "first_rejected") yield* log("rate_limited");
            yield* observe("rate_limited");
            return yield* releaseClaim({ _tag: "rate_limited", outcome: "rate_limited" } as const);
          }
          if (!task.enabled) {
            yield* log("disabled");
            yield* observe("disabled");
            return { _tag: "disabled" as const };
          }
          const signature = schedule.signature;
          if (signature !== null) {
            const verified =
              row.webhook_secret !== null &&
              verifyWebhookSignature({
                signature,
                secret: row.webhook_secret,
                headers: request.headers,
                body: request.body,
              });
            if (!verified) {
              yield* log("rejected_signature");
              yield* observe("rejected_signature");
              return { _tag: "rejected_signature" as const };
            }
          }
          const maxAgeMinutes = schedule.maxDeliveryAgeMinutes ?? null;
          if (
            maxAgeMinutes !== null &&
            DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt) >
              maxAgeMinutes * 60_000
          ) {
            yield* log("expired", { signatureVerified: signature !== null });
            yield* observe("expired");
            return { _tag: "expired" as const };
          }

          const refundRejectionSlot = Ref.update(webhookRejectedRateWindows, (windows) => {
            const current = windows.get(task.id);
            if (current === undefined) return windows;
            return new Map(windows).set(task.id, {
              ...current,
              accepted: current.accepted.filter((entry) => entry !== rejectionReservation),
            });
          });

          const failedFilter = findFailedWebhookFilter(schedule.filters ?? [], request);
          if (failedFilter !== null) {
            if (yield* takeFilteredLogSlot(task.id, DateTime.toEpochMillis(now))) {
              yield* log("filtered", {
                signatureVerified: signature !== null,
                error: describeFailedWebhookFilter(failedFilter),
              });
            }
            yield* refundRejectionSlot;
            yield* observe("filtered");
            return yield* releaseClaim({
              _tag: "accepted" as const,
              deliveryId,
              outcome: "filtered" as const,
            });
          }

          const runWindow = (yield* Ref.get(webhookRateWindows)).get(task.id);
          if (
            schedule.dedupe === undefined &&
            (runWindow?.accepted.filter((entry) => DateTime.toEpochMillis(now) - entry.at < 60_000)
              .length ?? 0) >= WEBHOOK_RATE_LIMIT_PER_MINUTE
          ) {
            if ((yield* takeRateSlot(task.id, DateTime.toEpochMillis(now))) === "first_rejected")
              yield* log("rate_limited");
            yield* observe("rate_limited");
            return yield* releaseClaim({ _tag: "rate_limited", outcome: "rate_limited" } as const);
          }
          const reserve = takeRateSlot(task.id, DateTime.toEpochMillis(now)).pipe(
            Effect.flatMap((slot) => (slot === "allowed" ? Effect.void : Effect.fail(slot))),
          );
          const queueKey = `${task.id}\u0000${task.createdAt}`;
          const checkCapacity = Effect.gen(function* () {
            const [row] = yield* sql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM scheduled_task_webhook_pending
              WHERE task_id = ${task.id} AND state IN ('pending', 'dispatching', 'running')`;
            if (
              (row?.count ?? 0) + ((yield* Ref.get(webhookQueued)).get(queueKey) ?? 0) >=
              WEBHOOK_MAX_QUEUED_PER_TASK
            )
              return yield* Effect.fail("queue_full" as const);
          }).pipe(
            Effect.mapError((cause) => (cause === "queue_full" ? cause : dedupeError(cause))),
          );
          const admit = <A, E>(effect: Effect.Effect<A, E>) =>
            sql.withTransaction(effect).pipe(
              Effect.catch((cause) =>
                cause === "first_rejected" || cause === "rejected" || cause === "queue_full"
                  ? Effect.succeed({
                      outcome:
                        cause === "queue_full"
                          ? ("queue_full" as const)
                          : ("rate_limited" as const),
                      log: cause === "first_rejected",
                    })
                  : Effect.fail(isScheduledTaskError(cause) ? cause : dedupeError(cause)),
              ),
            );
          const deduped =
            schedule.dedupe === undefined
              ? "run"
              : yield* admit(
                  Effect.gen(function* () {
                    const outcome = yield* acceptWebhookDedupe(
                      task,
                      request,
                      deliveryId,
                      DateTime.toEpochMillis(now),
                      reserve,
                      takeDedupeLogSlot(task.id, DateTime.toEpochMillis(now)),
                      checkCapacity,
                      (ownerId) => replaceDeliveryRequest(ownerId, request),
                    ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
                    if (
                      outcome === "pending" ||
                      outcome === "coalesced" ||
                      (outcome === "duplicate" &&
                        (yield* takeDedupeLogSlot(task.id, DateTime.toEpochMillis(now))))
                    )
                      yield* log(outcome === "pending" ? "accepted" : outcome, {
                        signatureVerified: signature !== null,
                      });
                    return outcome;
                  }),
                );
          if (typeof deduped !== "string") {
            yield* refundRejectionSlot;
            if (deduped.log) yield* log("rate_limited");
            yield* observe(deduped.outcome);
            return yield* releaseClaim({ _tag: "rate_limited", outcome: deduped.outcome } as const);
          }
          if (deduped !== "run") {
            if (deduped !== "coalesced" && deduped !== "coalesced_unlogged")
              yield* refundRejectionSlot;
            const outcome =
              deduped === "pending"
                ? "accepted"
                : deduped === "coalesced_unlogged"
                  ? "coalesced"
                  : deduped;
            yield* observe(outcome);
            if (deduped === "duplicate")
              return yield* releaseClaim({ _tag: "accepted", deliveryId, outcome } as const);
            claimAcquired = false;
            return { _tag: "accepted", deliveryId, outcome } as const;
          }
          const frameId = yield* random.randomBytes(6).pipe(
            Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
            Effect.mapError((cause) => taskError("Could not generate frame id.", { cause })),
          );
          const rendered = renderWebhookPrompt(task.prompt, request, frameId);
          // Providers trim the prompt before checking, so whitespace around
          // it is free.
          if (rendered.prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
            yield* log("dispatch_failed", {
              signatureVerified: signature !== null,
              missing: rendered.missing,
              renderedPrompt: rendered.prompt,
              error: PROMPT_TOO_LONG,
            });
            yield* releaseReplay(deliveryId);
            yield* observe("prompt_too_long");
            return yield* releaseClaim({
              _tag: "accepted" as const,
              deliveryId,
              outcome: "prompt_too_long" as const,
            });
          }
          // Bound the deliveries one task holds, so steady traffic to a stuck
          // task cannot pile up parked fibers.
          yield* refundRejectionSlot;
          let queueReserved = false;
          const release = Effect.suspend(() => {
            if (!queueReserved) return Effect.void;
            queueReserved = false;
            return Ref.update(webhookQueued, (counts) => {
              const next = new Map(counts);
              const count = (next.get(queueKey) ?? 1) - 1;
              if (count <= 0) next.delete(queueKey);
              else next.set(queueKey, count);
              return next;
            });
          });
          // Serialize immediate reservations with persisted window admission.
          const reserveImmediate = Effect.gen(function* () {
            yield* checkCapacity;
            yield* reserve;
            yield* Ref.update(webhookQueued, (counts) =>
              new Map(counts).set(queueKey, (counts.get(queueKey) ?? 0) + 1),
            );
            queueReserved = true;
          });
          const admitted = yield* admit(
            Effect.gen(function* () {
              const outcome = yield* acceptImmediateWebhookDedupe(
                task,
                request,
                deliveryId,
                DateTime.toEpochMillis(now),
                reserveImmediate,
              ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
              if (outcome === "duplicate") {
                if (yield* takeDedupeLogSlot(task.id, DateTime.toEpochMillis(now)))
                  yield* log("duplicate", { signatureVerified: signature !== null });
              } else
                yield* log("accepted", {
                  signatureVerified: signature !== null,
                  missing: rendered.missing,
                  renderedPrompt: rendered.prompt,
                });
              return outcome;
            }),
          ).pipe(Effect.onError(() => release));
          if (typeof admitted !== "string") {
            yield* release;
            if (admitted.log) yield* log("rate_limited");
            yield* observe(admitted.outcome);
            return yield* releaseClaim({
              _tag: "rate_limited",
              outcome: admitted.outcome,
            } as const);
          }
          if (admitted === "duplicate") {
            yield* release;
            yield* observe("duplicate");
            return yield* releaseClaim({
              _tag: "accepted",
              deliveryId,
              outcome: "duplicate",
            } as const);
          }
          yield* observe("accepted");
          const permit = yield* webhookPermit(task.id);
          yield* runWebhookDelivery(task, deliveryId, rendered.prompt).pipe(
            permit.withPermits(1),
            Effect.ensuring(release),
            Effect.forkIn(serviceScope),
          );
          // Dispatch owns the accepted delivery now; retries must keep its claim.
          claimAcquired = false;
          return { _tag: "accepted" as const, deliveryId, outcome: "accepted" as const };
        }).pipe(
          Effect.onError(() =>
            Effect.all([
              releaseClaim(undefined),
              (request.relayDeliveryId === undefined || claimAcquired
                ? releaseReplay(deliveryId)
                : Effect.void
              ).pipe(Effect.ignore),
            ]),
          ),
        ),
      );
    });

    const dispatchPending = Effect.fn("ScheduledTaskService.dispatchPendingWebhooks")(function* () {
      const now = DateTime.toEpochMillis(yield* localNow);
      if (yield* pendingWebhooks.isIdle(now)) return;
      const readVersion = yield* pendingWebhooks.version;
      yield* sql`UPDATE scheduled_task_webhook_pending SET state = 'dispatching' WHERE state = 'pending' AND due_at <= ${now}`;
      const tasks = yield* sql<{ task_id: ScheduledTaskId }>`
        SELECT DISTINCT task_id FROM scheduled_task_webhook_pending WHERE state IN ('dispatching', 'running', 'completed', 'failed')
      `.pipe(NodeSqliteClient.readOnly);
      // Workers can leave rows behind to retry, so keep polling while any are claimed.
      if (tasks.length === 0) {
        const [next] = yield* sql<{ due_at: number | null }>`
          SELECT MIN(due_at) AS due_at FROM scheduled_task_webhook_pending WHERE state = 'pending'
        `.pipe(NodeSqliteClient.readOnly);
        yield* pendingWebhooks.record(readVersion, next?.due_at ?? Infinity, now);
      }
      yield* Effect.forEach(
        tasks,
        ({ task_id: taskId }) => {
          // One worker per task waits on its permit, then drains persisted rows in order.
          // Other tasks remain independent and ticks never reload an active task's payloads.
          const dispatch = Effect.gen(function* () {
            while (true) {
              const [entry] = yield* sql<{
                delivery_id: string;
                task_json: string;
                request_json: string;
                state: string;
              }>`
              SELECT delivery_id, task_json, request_json, state FROM scheduled_task_webhook_pending
              WHERE task_id = ${taskId} AND state IN ('dispatching', 'running', 'completed', 'failed') ORDER BY due_at, rowid LIMIT 1
            `.pipe(NodeSqliteClient.readOnly);
              if (entry === undefined) return;
              const remove = sql`DELETE FROM scheduled_task_webhook_pending WHERE delivery_id = ${entry.delivery_id}`;
              if (entry.state === "completed" || entry.state === "failed") {
                if (entry.state === "failed") {
                  yield* markDeliveryFailed(entry.delivery_id, "The run failed to start.");
                  yield* releaseFailedDelivery(entry.delivery_id);
                }
                yield* remove;
                continue;
              }
              const prepared = yield* Effect.gen(function* () {
                // A running row was already sent, so recovery keeps the prompt it was sent with.
                const current = entry.state === "dispatching" ? yield* findTask(taskId) : null;
                const snapshot = yield* decodePendingTask(entry.task_json);
                // The snapshot keeps the identity runTask checks; the prompt is the one saved now.
                const task =
                  current?.createdAt === snapshot.createdAt && current.prompt !== snapshot.prompt
                    ? { ...snapshot, prompt: current.prompt }
                    : snapshot;
                const request = yield* decodePendingRequest(entry.request_json);
                const frameId = Buffer.from(yield* random.randomBytes(6)).toString("hex");
                return {
                  task,
                  taskJson: task === snapshot ? null : yield* encodePendingTask(task),
                  rendered: renderWebhookPrompt(task.prompt, request, frameId),
                };
              }).pipe(Effect.exit);
              if (Exit.isFailure(prepared)) {
                if (Cause.hasInterruptsOnly(prepared.cause))
                  return yield* Effect.failCause(prepared.cause);
                yield* markDeliveryFailed(
                  entry.delivery_id,
                  "The pending webhook payload could not be prepared.",
                );
                yield* releaseFailedDelivery(entry.delivery_id);
                yield* remove;
                continue;
              }
              const { task, taskJson, rendered } = prepared.value;
              if (rendered.prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
                yield* markDeliveryFailed(entry.delivery_id, PROMPT_TOO_LONG);
                yield* releaseFailedDelivery(entry.delivery_id);
              } else {
                if (taskJson !== null)
                  yield* sql`UPDATE scheduled_task_webhook_pending SET task_json = ${taskJson} WHERE delivery_id = ${entry.delivery_id}`;
                yield* sql`UPDATE scheduled_task_webhook_deliveries SET outcome = 'accepted', error = NULL, rendered_prompt = ${rendered.prompt.slice(0, WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT)}, missing_fields_json = ${encodeMissingFieldsJson(rendered.missing)} WHERE delivery_id = ${entry.delivery_id}`;
                if (!(yield* runWebhookDelivery(task, entry.delivery_id, rendered.prompt))) return;
              }
              yield* remove;
            }
          });
          // The worker owns its reservation, so an interrupt anywhere still releases it.
          return Effect.acquireUseRelease(
            Ref.modify(pendingInFlight, (active) =>
              active.has(taskId)
                ? ([false, active] as const)
                : ([true, new Set(active).add(taskId)] as const),
            ),
            (reserved) =>
              reserved
                ? webhookPermit(taskId).pipe(
                    Effect.flatMap((permit) => dispatch.pipe(permit.withPermits(1))),
                    Effect.catch((cause) =>
                      Effect.logWarning("Pending webhook dispatch failed", { cause }),
                    ),
                    Effect.withSpan("ScheduledTaskService.dispatchPendingWebhook", {
                      root: true,
                    }),
                  )
                : Effect.void,
            (reserved) =>
              reserved
                ? Ref.update(pendingInFlight, (active) => {
                    const next = new Set(active);
                    next.delete(taskId);
                    return next;
                  })
                : Effect.void,
          ).pipe(Effect.forkIn(serviceScope));
        },
        { discard: true },
      );
    });
    yield* scheduler.register("webhook-coalescing", dispatchPending());

    return {
      list,
      subscribeList,
      upsert,
      setEnabled,
      delete: deleteTask,
      deleteForThread,
      moveThreadTasks,
      runNow,
      rotateWebhookToken,
      listWebhookDeliveries,
      getWebhookDelivery,
      triggerWebhook,
    };
});
