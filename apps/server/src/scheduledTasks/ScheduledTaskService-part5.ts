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
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { LEGACY_DELIVERY_OUTCOMES, PROMPT_TOO_LONG, ScheduledTaskService, WEBHOOK_DELIVERY_LOG_BODY_LIMIT, decodeHeadersJson, decodeMissingFieldsJson, encodeHeadersJson, isScheduledTaskError, iso, localNow, requireFutureOnce, taskError, webhookFilters } from "./ScheduledTaskService.ts";
import type { WebhookTriggerRequest } from "./ScheduledTaskService.ts";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";
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
import { nextRunAt } from "./ScheduledTaskServiceParts3.ts";
import type { WebhookDeliveryRow } from "./ScheduledTaskServiceParts6.ts";

import type { makeScheduledTaskStage2 } from "./ScheduledTaskService-part4.ts";

type State = Effect.Success<ReturnType<typeof makeScheduledTaskStage2>>;

export const makeScheduledTaskStage3 = Effect.fn("makeScheduledTaskStage3")(function* (state: State) {
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
    } = state;
    const list: ScheduledTaskService["Service"]["list"] = () =>
      listRows().pipe(
        Effect.map((tasks) => ({ tasks })),
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );

    const subscribeList: ScheduledTaskService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading to buffer concurrent changes.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    const upsert: ScheduledTaskService["Service"]["upsert"] = Effect.fn(
      "ScheduledTaskService.upsert",
    )(function* (input) {
      // A webhook task the policy blocks can still be edited while it is off.
      if (input.enabled && input.schedule.type === "webhook" && webhookPolicyBlock !== undefined) {
        return yield* taskError(
          webhookPolicyBlock,
          input.id === undefined ? {} : { taskId: input.id },
        );
      }
      // Refused on save rather than at run time; a disabled task can still be saved, so one
      // stored above the ceiling can be turned off before its mode is lowered. A task bound to a
      // thread runs in that thread's mode, which the orchestrator checks instead.
      const modeDenial =
        input.enabled && input.threadId == null
          ? managedRuntimeModeDenial(managedPolicy.summary, input.runtimeMode)
          : undefined;
      if (modeDenial !== undefined) {
        return yield* taskError(modeDenial, input.id === undefined ? {} : { taskId: input.id });
      }
      const now = yield* localNow;
      const uuid =
        input.commandId === undefined
          ? yield* random
              .uuidV4()
              .pipe(
                Effect.mapError((cause) =>
                  taskError("Could not generate schedule task id.", { cause }),
                ),
              )
          : null;
      const id =
        input.id ??
        ScheduledTaskId.make(
          input.commandId ? `scheduled-task:${input.commandId}` : `scheduled-task:${uuid}`,
        );
      // Look up by the *resolved* id so idempotent creates (commandId replays)
      // keep their run history, and so real load failures propagate instead
      // of silently resetting an existing row.
      const existingTask = yield* findTask(id);
      // Keep the existing next_run_at when the schedule itself is untouched:
      // editing a title or prompt must not postpone (or resurrect) a due
      // run — only schedule/enabled changes restart the clock.
      const schedule: ScheduledTask["schedule"] =
        input.schedule.type === "webhook"
          ? {
              type: "webhook",
              signature:
                input.schedule.signature == null
                  ? null
                  : {
                      header: input.schedule.signature.header.toLowerCase(),
                      encoding: input.schedule.signature.encoding,
                      prefix: input.schedule.signature.prefix,
                    },
              maxDeliveryAgeMinutes: input.schedule.maxDeliveryAgeMinutes ?? null,
              ...(input.schedule.dedupe === undefined
                ? existingTask?.schedule.type === "webhook" &&
                  existingTask.schedule.dedupe !== undefined
                  ? { dedupe: existingTask.schedule.dedupe }
                  : {}
                : { dedupe: input.schedule.dedupe }),
              ...webhookFilters(
                // Omitted keeps the stored filters, so a client that predates
                // them can re-save a task without clearing them.
                input.schedule.filters ??
                  (existingTask?.schedule.type === "webhook"
                    ? existingTask.schedule.filters
                    : undefined),
              ),
            }
          : input.schedule.type === "once"
            ? { type: "once", runAt: iso(DateTime.makeUnsafe(input.schedule.runAt)) }
            : input.schedule;
      const webhook =
        input.schedule.type === "webhook"
          ? yield* Effect.gen(function* () {
              const existing = existingTask === null ? null : yield* findWebhookCredentials(id);
              const token = existing?.token ?? (yield* newWebhookToken);
              const signature = input.schedule.type === "webhook" ? input.schedule.signature : null;
              // A secretRef is a value the user entered for an agent; this
              // save consumes it, so it cannot be used again. A replay of a
              // save that already used it keeps the secret that save stored.
              const replay = input.commandId !== undefined && existing?.secret != null;
              const fromRef =
                signature?.secretRef === undefined
                  ? undefined
                  : yield* secretRequests
                      .consume({ ref: signature.secretRef, projectId: input.projectId })
                      .pipe(
                        Effect.catch((error) =>
                          replay
                            ? Effect.void
                            : Effect.fail(taskError(error.message, { taskId: id })),
                        ),
                      );
              // A ref, when given, is the only source: a plain secret sent
              // alongside it must not replace what a replayed save stored.
              const provided = signature?.secretRef === undefined ? signature?.secret : fromRef;
              const secret = signature == null ? null : (provided ?? existing?.secret ?? null);
              const secretChanged =
                signature == null || provided !== undefined || existing === null;
              if (signature != null && secret === null) {
                return yield* taskError("A webhook signature check needs a signing secret.", {
                  taskId: id,
                });
              }
              return { token, secret, secretChanged };
            })
          : { token: null, secret: null, secretChanged: true };
      const workspaceStrategy: ScheduledTask["workspaceStrategy"] =
        input.workspaceStrategy.type === "worktree" &&
        (yield* managedFolders.isScratchProject(input.projectId))
          ? { type: "root" }
          : input.workspaceStrategy;
      const scheduleUnchanged =
        existingTask !== null &&
        existingTask.enabled === input.enabled &&
        isSameSchedule(existingTask.schedule, schedule);
      if (!scheduleUnchanged)
        yield* requireFutureOnce({ enabled: input.enabled, schedule }, now, id);
      const task: ScheduledTask = {
        id,
        title: input.title,
        prompt: input.prompt,
        enabled: input.enabled,
        schedule,
        projectId: input.projectId,
        threadId: input.threadId ?? null,
        workspaceStrategy,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        createdBy: existingTask?.createdBy ?? input.createdBy ?? "user",
        creationSource: input.creationSource ?? "web",
        createdAt: existingTask?.createdAt ?? iso(now),
        updatedAt: iso(now),
        nextRunAt: scheduleUnchanged
          ? existingTask.nextRunAt
          : nextRunAt({ enabled: input.enabled, schedule }, now),
        lastRunAt: existingTask?.lastRunAt ?? null,
        lastRunStatus: existingTask?.lastRunStatus ?? "never",
        lastRunError: existingTask?.lastRunError ?? null,
        runCount: existingTask?.runCount ?? 0,
      };
      yield* saveTask(
        task,
        input.requireExisting === true,
        scheduleUnchanged ? existingTask.schedule : null,
        webhook,
      );
      yield* notifyChanged;
      return { task: (yield* findTask(id)) ?? task };
    });

    const setEnabled: ScheduledTaskService["Service"]["setEnabled"] = Effect.fn(
      "ScheduledTaskService.setEnabled",
    )(function* (input) {
      const existing = yield* loadTask(input.id);
      if (existing.enabled === input.enabled) return { task: existing };
      if (
        input.enabled &&
        existing.schedule.type === "webhook" &&
        webhookPolicyBlock !== undefined
      ) {
        return yield* taskError(webhookPolicyBlock, { taskId: input.id });
      }
      const modeDenial =
        input.enabled && existing.threadId === null
          ? managedRuntimeModeDenial(managedPolicy.summary, existing.runtimeMode)
          : undefined;
      if (modeDenial !== undefined) {
        return yield* taskError(modeDenial, { taskId: input.id });
      }
      const now = yield* localNow;
      yield* requireFutureOnce(
        { enabled: input.enabled, schedule: existing.schedule },
        now,
        input.id,
      );
      const next = nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now);
      // RETURNING so a task deleted between the load and this UPDATE is a
      // visible not-found error, not a false success.
      const updated = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET enabled = ${input.enabled ? 1 : 0},
              next_run_at = ${next},
              updated_at = ${iso(now)}
          WHERE task_id = ${input.id}
          RETURNING task_id
        `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not update schedule task.", { taskId: input.id, cause }),
        ),
      );
      if (updated.length === 0) {
        return yield* taskError("Schedule task not found.", { taskId: input.id });
      }
      yield* notifyChanged;
      return {
        task: { ...existing, enabled: input.enabled, nextRunAt: next, updatedAt: iso(now) },
      };
    });

    const forgetWebhookTask = (id: ScheduledTaskId) =>
      Effect.all(
        [
          Ref.update(webhookRateWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookRejectedRateWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookDedupeLogWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookFilteredLogWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookPermits, (permits) => {
            const next = new Map(permits);
            next.delete(id);
            return next;
          }),
        ],
        { discard: true },
      );

    const deleteTask: ScheduledTaskService["Service"]["delete"] = (input) =>
      deleteRow(input.id).pipe(
        Effect.andThen(forgetWebhookTask(input.id)),
        Effect.andThen(notifyChanged),
        Effect.as({ id: input.id }),
      );

    const deleteForThread = Effect.fn("ScheduledTaskService.deleteForThread")(function* (
      threadId: ThreadId,
    ) {
      // Check the current binding in the transaction: an automation may have
      // been unbound or moved since thread deletion queued this cleanup.
      const removed = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
            DELETE FROM scheduled_task_webhook_deliveries
            WHERE task_id IN (SELECT task_id FROM scheduled_tasks WHERE thread_id = ${threadId})
          `;
            return yield* sql<{ task_id: ScheduledTaskId }>`
            DELETE FROM scheduled_tasks WHERE thread_id = ${threadId} RETURNING task_id
          `;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not delete thread's schedule tasks.", { cause }),
          ),
        );
      yield* Effect.forEach(removed, ({ task_id }) => forgetWebhookTask(task_id), {
        discard: true,
      });
      if (removed.length > 0) yield* notifyChanged;
    });

    const moveThreadTasks: ScheduledTaskService["Service"]["moveThreadTasks"] = Effect.fn(
      "ScheduledTaskService.moveThreadTasks",
    )(function* (input) {
      if (input.threadIds.length === 0) return;
      const moved = yield* sql<{ task_id: ScheduledTaskId }>`
        UPDATE scheduled_tasks SET project_id = ${input.projectId}
        WHERE project_id != ${input.projectId} AND thread_id IN ${sql.in(input.threadIds)}
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not move the thread's schedule tasks.", { cause }),
        ),
      );
      if (moved.length > 0) yield* notifyChanged;
    });

    const runNow: ScheduledTaskService["Service"]["runNow"] = Effect.fn(
      "ScheduledTaskService.runNow",
    )(function* (input: ScheduledTaskRunNowInput) {
      const task = yield* loadTask(input.id);
      if (task.schedule.type === "webhook") {
        return yield* taskError("Webhook tasks run when their URL receives a request.", {
          taskId: input.id,
        });
      }
      return yield* runTask(task, "manual").pipe(
        Effect.mapError((cause) =>
          isScheduledTaskError(cause)
            ? cause
            : taskError("Could not run schedule task.", { taskId: input.id, cause }),
        ),
      );
    });

    const rotateWebhookToken: ScheduledTaskService["Service"]["rotateWebhookToken"] = Effect.fn(
      "ScheduledTaskService.rotateWebhookToken",
    )(function* (input) {
      const task = yield* loadTask(input.id);
      if (task.schedule.type !== "webhook") {
        return yield* taskError("Only webhook tasks have a URL token.", { taskId: input.id });
      }
      const token = yield* newWebhookToken;
      const now = yield* localNow;
      // Matching created_at keeps a rotation from landing on a task deleted
      // and recreated under the same id since it was loaded.
      const updated = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET webhook_token = ${token}, updated_at = ${iso(now)}
          WHERE task_id = ${input.id} AND created_at = ${task.createdAt}
          RETURNING task_id
        `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not rotate webhook token.", { taskId: input.id, cause }),
        ),
      );
      if (updated.length === 0) {
        return yield* taskError("Schedule task was deleted or replaced.", { taskId: input.id });
      }
      yield* notifyChanged;
      return { task: yield* loadTask(input.id) };
    });

    const deliveryHeaders = (row: WebhookDeliveryRow): Readonly<Record<string, string>> =>
      Option.getOrElse(decodeHeadersJson(row.headers_json), () => ({}));
    const decodeDeliverySummary = (row: WebhookDeliveryRow) => ({
      id: ScheduledTaskWebhookDeliveryId.make(row.delivery_id),
      taskId: ScheduledTaskId.make(row.task_id),
      receivedAt: row.received_at,
      method: row.method,
      contentType: deliveryHeaders(row)["content-type"] ?? null,
      bodyBytes: row.body_bytes,
      outcome: row.outcome as ScheduledTaskWebhookDeliveryOutcome,
      signatureVerified: row.signature_verified === 1,
      pendingWindow: row.outcome === "accepted" && row.pending_window === 1,
      missingFields: Option.getOrElse(decodeMissingFieldsJson(row.missing_fields_json), () => []),
      error: row.error,
    });

    const listWebhookDeliveries: ScheduledTaskService["Service"]["listWebhookDeliveries"] = (
      input,
    ) =>
      sql<WebhookDeliveryRow>`
        SELECT d.*, EXISTS (SELECT 1 FROM scheduled_task_webhook_pending p
          WHERE p.delivery_id = d.delivery_id AND p.state IN ('pending', 'dispatching')) AS pending_window
        FROM scheduled_task_webhook_deliveries d WHERE task_id = ${input.id}
        ORDER BY received_at DESC, rowid DESC
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => ({
          deliveries: rows
            .filter(
              (row) => input.acceptAnyOutcome === true || LEGACY_DELIVERY_OUTCOMES.has(row.outcome),
            )
            .map(decodeDeliverySummary),
        })),
        Effect.mapError((cause) =>
          taskError("Could not list webhook deliveries.", { taskId: input.id, cause }),
        ),
      );

    const getWebhookDelivery: ScheduledTaskService["Service"]["getWebhookDelivery"] = Effect.fn(
      "ScheduledTaskService.getWebhookDelivery",
    )(function* (input) {
      const rows = yield* sql<WebhookDeliveryRow>`
          SELECT d.*, EXISTS (SELECT 1 FROM scheduled_task_webhook_pending p
            WHERE p.delivery_id = d.delivery_id AND p.state IN ('pending', 'dispatching')) AS pending_window
          FROM scheduled_task_webhook_deliveries d WHERE task_id = ${input.id} AND delivery_id = ${input.deliveryId}
        `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) =>
          taskError("Could not load webhook delivery.", { taskId: input.id, cause }),
        ),
      );
      const row = rows[0];
      if (
        row === undefined ||
        (input.acceptAnyOutcome !== true && !LEGACY_DELIVERY_OUTCOMES.has(row.outcome))
      ) {
        return yield* taskError("Webhook delivery not found.", { taskId: input.id });
      }
      return {
        delivery: {
          ...decodeDeliverySummary(row),
          query: row.query,
          headers: deliveryHeaders(row),
          body: row.body,
          bodyTruncated: row.body_truncated === 1,
          renderedPrompt: row.rendered_prompt,
        },
      };
    });

    const deliveryRequestBody = (request: WebhookTriggerRequest) => {
      const truncated = request.body.byteLength > WEBHOOK_DELIVERY_LOG_BODY_LIMIT;
      return {
        truncated,
        // Streaming decode drops a character the byte limit split, instead of ending in U+FFFD.
        body: truncated
          ? new TextDecoder().decode(request.body.subarray(0, WEBHOOK_DELIVERY_LOG_BODY_LIMIT), {
              stream: true,
            })
          : request.bodyText,
      };
    };
    const replaceDeliveryRequest = (deliveryId: string, request: WebhookTriggerRequest) => {
      const logged = deliveryRequestBody(request);
      return sql`UPDATE scheduled_task_webhook_deliveries SET
        method = ${request.method}, query = ${redactQuery(request.query)},
        headers_json = ${encodeHeadersJson(redactHeaders(request.headers))}, body = ${logged.body},
        body_bytes = ${request.body.byteLength}, body_truncated = ${logged.truncated ? 1 : 0}
        WHERE delivery_id = ${deliveryId}`.pipe(Effect.asVoid, Effect.mapError(dedupeError));
    };

    // Each suppression bucket retains its own rows, never real run history.
    const deliveryBucket = (outcome: string, error: string | undefined) =>
      outcome === "filtered"
        ? "filtered"
        : outcome === "duplicate" ||
            outcome === "coalesced" ||
            outcome === "rate_limited" ||
            error === PROMPT_TOO_LONG
          ? "dedupe"
          : "main";
    return {
      ...state,
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
    };
});
