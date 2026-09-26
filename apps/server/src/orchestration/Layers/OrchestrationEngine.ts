import type {
  DispatchReportVerdict,
  DispatchResult,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
  WorkflowRunId,
} from "@t3tools/contracts";
import { OrchestrationCommand } from "@t3tools/contracts";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  PubSub,
  Queue,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { runStartupPhase } from "../../startupTiming.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { WorktreeCleanupJobRepository } from "../../persistence/Services/WorktreeCleanupJobs.ts";
import { WorktreeCleanupJobRepositoryLive } from "../../persistence/Layers/WorktreeCleanupJobs.ts";
import { CheckoutCoordinator, CheckoutCoordinatorLive } from "../../git/CheckoutCoordinator.ts";
import { WorkspaceOwnershipRepository } from "../../persistence/Services/WorkspaceOwnership.ts";
import { WorkspaceOwnershipRepositoryLive } from "../../persistence/Layers/WorkspaceOwnership.ts";
import { ThreadUrlBuilder } from "../../threadUrl.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandWorktreeCleanupPendingError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { childReportDedupeKey } from "../dispatchAuthority.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import {
  admitWorkspaceCommand,
  canonicalizeCommandWorktree,
  cleanupWorktreePath,
  isWorktreeCleanupPending,
  type WorkspaceAdmissionDeps,
} from "../workspaceAdmission.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import type { ProjectionReceipt } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<DispatchResult, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread" | "workflow";
  readonly aggregateId: ProjectId | ThreadId | WorkflowRunId;
} {
  switch (command.type) {
    case "project.create":
    case "chat-archive.import":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    case "workflow.run.request":
    case "workflow.node.worker.start":
    case "workflow.worker-result.record":
    case "workflow.run.finalize":
      return {
        aggregateKind: "workflow",
        aggregateId: command.runId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const worktreeCleanupJobs = yield* WorktreeCleanupJobRepository;
  const threadUrls = yield* Effect.serviceOption(ThreadUrlBuilder);
  const coordinator = yield* CheckoutCoordinator;
  const workspaceOwnership = yield* WorkspaceOwnershipRepository;

  let readModel = createEmptyReadModel(new Date().toISOString());

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
  const initialized = yield* Deferred.make<void, OrchestrationDispatchError>();
  const worktreeLock = yield* Semaphore.make(1);

  const withWorktreeLock: OrchestrationEngineShape["withWorktreeLock"] = (effect) =>
    worktreeLock.withPermits(1)(effect);

  const dispatchResult = (
    command: OrchestrationCommand,
    sequence: number,
    reportVerdict?: DispatchReportVerdict,
  ): DispatchResult => ({
    sequence,
    ...((command.type === "thread.create" ||
      (command.type === "thread.turn.start" && command.bootstrap?.createThread !== undefined)) &&
    Option.isSome(threadUrls)
      ? { threadUrl: threadUrls.value.forThread(command.threadId) }
      : {}),
    ...(reportVerdict !== undefined ? { reportVerdict } : {}),
  });

  // Recovers the fencing outcome of a child report from durable receipt
  // activities, so retried deliveries replay the recorded verdict instead
  // of re-mutating. Returns undefined when the command produced no report
  // receipt (e.g. pre-fence history or a different command type).
  const reportVerdictFromReceiptPayload = (payload: unknown): DispatchReportVerdict | undefined => {
    const verdict = (payload as { readonly dispatchVerdict?: unknown } | null | undefined)
      ?.dispatchVerdict;
    return verdict === "accepted" || verdict === "already-recorded" || verdict === "stale"
      ? verdict
      : undefined;
  };

  const reportVerdictFromActivity = (activity: {
    readonly id?: unknown;
    readonly kind?: unknown;
    readonly payload?: unknown;
  }): DispatchReportVerdict | undefined =>
    activity.kind === "delegation.reported"
      ? reportVerdictFromReceiptPayload(activity.payload)
      : undefined;

  const reportVerdictForCommand = (
    commandId: string,
    events: ReadonlyArray<{ readonly type: string; readonly payload?: unknown }>,
  ): DispatchReportVerdict | undefined => {
    for (const event of events) {
      if (event.type !== "thread.activity-appended") {
        continue;
      }
      const activity = (event.payload as { readonly activity?: unknown } | undefined)?.activity as
        | { readonly id?: unknown; readonly kind?: unknown; readonly payload?: unknown }
        | undefined;
      if (activity?.id !== commandId) {
        continue;
      }
      const verdict = activity ? reportVerdictFromActivity(activity) : undefined;
      if (verdict !== undefined) {
        return verdict;
      }
    }
    return undefined;
  };

  const reportVerdictFromActivities = (
    commandId: string,
    activities: ReadonlyArray<{
      readonly id?: unknown;
      readonly kind?: unknown;
      readonly payload?: unknown;
    }>,
  ): DispatchReportVerdict | undefined => {
    const activity = activities.find((entry) => entry.id === commandId);
    return activity ? reportVerdictFromActivity(activity) : undefined;
  };

  // Durable fallback when the receipt activity has aged out of the capped
  // read model: the event log retains every `thread.activity-appended` row
  // indexed by command ID, so a valid retry still recovers its verdict.
  const reportVerdictFromDurableEvents = (
    commandId: string,
  ): Effect.Effect<DispatchReportVerdict | undefined> =>
    sql<{ readonly payload_json: string }>`
      SELECT payload_json
      FROM orchestration_events
      WHERE command_id = ${commandId} AND event_type = 'thread.activity-appended'
      LIMIT 5
    `.pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationEngine.reportVerdict:query")),
      Effect.map((rows) => {
        for (const row of rows) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.payload_json) as unknown;
          } catch {
            continue;
          }
          const verdict = reportVerdictFromActivity(
            (parsed as { readonly activity?: unknown }).activity as {
              readonly id?: unknown;
              readonly kind?: unknown;
              readonly payload?: unknown;
            },
          );
          if (verdict !== undefined) {
            return verdict;
          }
        }
        return undefined;
      }),
      Effect.catch((error) =>
        Effect.logWarning("orchestration report verdict durable lookup failed", {
          commandId,
          error,
        }).pipe(Effect.as(undefined)),
      ),
    );

  const reportIdentityForCommand = (
    command: Extract<OrchestrationCommand, { type: "thread.child.report" }>,
    model: OrchestrationReadModel,
  ) => {
    const delegation = model.threads.find((thread) => thread.id === command.threadId)?.nudging
      ?.delegation;
    const assignmentId = command.assignmentId ?? delegation?.assignmentId;
    if (!assignmentId) return null;
    return {
      reportKey: childReportDedupeKey({
        childThreadId: command.threadId,
        dispatchId: command.dispatchId,
        originTurnId: command.originTurnId,
        assignmentId,
        reportId: command.reportId,
      }),
      assignmentId,
    };
  };

  const findRecordedReportOutcome = (reportKey: string) =>
    sql<{ readonly outcome: string }>`
      SELECT outcome
      FROM delegation_report_receipts
      WHERE report_key = ${reportKey}
    `.pipe(
      Effect.map((rows) => {
        const outcome = rows[0]?.outcome;
        return outcome === "accepted" || outcome === "stale" ? outcome : undefined;
      }),
      Effect.mapError(toPersistenceSqlError("OrchestrationEngine.reportReceipt:query")),
    );

  // Live read-model accessors for workspace admission. The closures read the
  // current model at call time, preserving dispatch-time visibility.
  const admissionDeps: WorkspaceAdmissionDeps = {
    findThread: (threadId) => readModel.threads.find((entry) => entry.id === threadId),
    findProject: (projectId) => readModel.projects.find((entry) => entry.id === projectId),
    claimOwnership: (input) => workspaceOwnership.claim(input),
    hasCleanupReservationByPath: (canonicalPath) =>
      worktreeCleanupJobs.hasReservationByPath(canonicalPath),
  };

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = readModel.snapshotSequence;
    const processingStartedAtMs = Date.now();
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      let nextReadModel = readModel;
      for (const persistedEvent of persistedEvents) {
        nextReadModel = yield* projectEvent(nextReadModel, persistedEvent);
      }
      readModel = nextReadModel;

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });
    // Canonical path admitted by this dispatch attempt (the Git top-level
    // ownership key). Recorded for failure compensation below: recomputing it
    // from the command input would miss the claimed row when a handoff
    // targets a subdirectory of the worktree.
    let admittedCanonicalPath: string | undefined;

    const process = Effect.exit(
      Effect.gen(function* () {
        const command = yield* canonicalizeCommandWorktree(envelope.command);
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.status === "accepted") {
            // Durable verdict replay: a retried report returns its recorded
            // outcome without re-mutating. The in-memory read model caps
            // activities (projector retains 500), so fall back to the durable
            // event log by command ID when the receipt activity has aged out.
            const completedCommand = envelope.command;
            const replayedVerdict =
              completedCommand.type === "thread.child.report"
                ? (reportVerdictFromActivities(
                    completedCommand.commandId,
                    readModel.threads.find((thread) => thread.id === completedCommand.threadId)
                      ?.activities ?? [],
                  ) ?? (yield* reportVerdictFromDurableEvents(completedCommand.commandId)))
                : undefined;
            return dispatchResult(command, existingReceipt.value.resultSequence, replayedVerdict);
          }

          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        const previousWorkspaceBinding =
          command.type === "thread.workspace.handoff"
            ? readModel.threads.find((thread) => thread.id === command.threadId)?.workspaceBinding
            : undefined;
        const admittedCommand = yield* admitWorkspaceCommand(admissionDeps, command);
        admittedCanonicalPath =
          "workspaceBinding" in admittedCommand
            ? admittedCommand.workspaceBinding?.canonicalPath
            : undefined;
        const worktreePath = cleanupWorktreePath(admittedCommand, readModel.threads);
        if (
          worktreePath !== null &&
          (yield* isWorktreeCleanupPending(admissionDeps, worktreePath))
        ) {
          return yield* new OrchestrationCommandWorktreeCleanupPendingError({
            commandType: command.type,
            worktreePath,
          });
        }

        if (command.type === "thread.queued-turn.dispatch") {
          const queued = readModel.threads
            .find((thread) => thread.id === command.threadId)
            ?.queuedTurns?.find((turn) => turn.id === command.queuedTurnId);
          if (queued?.origin?.kind === "child-nudge") {
            const pending = yield* sql<{ readonly pending: number }>`
              SELECT pending_approval_count + pending_user_input_count AS pending
              FROM projection_threads WHERE thread_id = ${command.threadId}
            `;
            if (pending[0]?.pending) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Child follow-up is awaiting approval or input.",
              });
            }
          }
        }

        const reportIdentity =
          command.type === "thread.child.report"
            ? reportIdentityForCommand(command, readModel)
            : null;
        const recordedReportOutcome =
          reportIdentity === null
            ? undefined
            : yield* findRecordedReportOutcome(reportIdentity.reportKey);
        const eventBase = yield* decideOrchestrationCommand({
          command: admittedCommand,
          readModel,
          ...(recordedReportOutcome !== undefined ? { recordedReportOutcome } : {}),
        });
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        // State-dependent no-ops are accepted once so retries cannot apply
        // them to a later state.
        if (
          eventBases.length === 0 &&
          (admittedCommand.type === "thread.delegation.settle" ||
            admittedCommand.type === "thread.child.wait.prune" ||
            (admittedCommand.type === "thread.meta.update" &&
              (admittedCommand.expectedUpdatedAt !== undefined ||
                admittedCommand.expectedWorkspaceCwd !== undefined)))
        ) {
          yield* commandReceiptRepository.upsert({
            commandId: command.commandId,
            aggregateKind: aggregateRef.aggregateKind,
            aggregateId: aggregateRef.aggregateId,
            acceptedAt: new Date().toISOString(),
            resultSequence: readModel.snapshotSequence,
            status: "accepted",
            error: null,
          });
          return dispatchResult(command, readModel.snapshotSequence);
        }
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              const projectionReceipts: ProjectionReceipt[] = [];
              let nextReadModel = readModel;
              const skippedEventIds = new Set<string>();

              for (const nextEvent of eventBases) {
                if (
                  nextEvent.causationEventId !== null &&
                  skippedEventIds.has(nextEvent.causationEventId)
                ) {
                  skippedEventIds.add(nextEvent.eventId);
                  continue;
                }
                if (nextEvent.type === "thread.child-lifecycle-notified") {
                  const claimed = yield* sql<{ readonly dedupe_key: string }>`
                    INSERT INTO child_lifecycle_notification_dedup (
                      dedupe_key,
                      event_id,
                      created_at
                    )
                    VALUES (
                      ${nextEvent.payload.dedupeKey},
                      ${nextEvent.eventId},
                      ${nextEvent.occurredAt}
                    )
                    ON CONFLICT(dedupe_key) DO NOTHING
                    RETURNING dedupe_key
                  `;
                  if (claimed.length === 0) {
                    skippedEventIds.add(nextEvent.eventId);
                    continue;
                  }
                }
                const savedEvent = yield* eventStore.append(nextEvent);
                nextReadModel = yield* projectEvent(nextReadModel, savedEvent);
                projectionReceipts.push(yield* projectionPipeline.projectEvent(savedEvent));
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              if (command.type === "thread.child.report" && reportIdentity !== null) {
                const outcome = reportVerdictForCommand(command.commandId, committedEvents);
                if (outcome === "accepted" || outcome === "stale") {
                  yield* sql`
                    INSERT INTO delegation_report_receipts (
                      report_key,
                      command_id,
                      child_thread_id,
                      assignment_id,
                      dispatch_id,
                      origin_turn_id,
                      report_id,
                      outcome,
                      created_at
                    )
                    VALUES (
                      ${reportIdentity.reportKey},
                      ${command.commandId},
                      ${command.threadId},
                      ${reportIdentity.assignmentId},
                      ${command.dispatchId ?? null},
                      ${command.originTurnId ?? null},
                      ${command.reportId},
                      ${outcome},
                      ${command.createdAt}
                    )
                    ON CONFLICT(report_key) DO NOTHING
                  `;
                }
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                lastSequence: lastSavedEvent.sequence,
                nextReadModel,
                projectionReceipts,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        readModel = committedCommand.nextReadModel;
        if (
          admittedCommand.type === "thread.workspace.handoff" &&
          previousWorkspaceBinding !== undefined &&
          admittedCommand.workspaceBinding !== undefined &&
          previousWorkspaceBinding.canonicalPath !== admittedCommand.workspaceBinding.canonicalPath
        ) {
          yield* workspaceOwnership
            .release(admittedCommand.threadId, previousWorkspaceBinding.canonicalPath)
            .pipe(
              Effect.catch((error) =>
                Effect.logError("workspace handoff committed but old ownership remains held", {
                  threadId: admittedCommand.threadId,
                  canonicalPath: previousWorkspaceBinding.canonicalPath,
                  error,
                }),
              ),
            );
        }
        yield* Effect.forEach(committedCommand.projectionReceipts, (receipt) => receipt.reconcile, {
          concurrency: 1,
          discard: true,
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("projection post-commit reconciliation remains pending", {
              commandId: envelope.command.commandId,
              error,
            }),
          ),
          Effect.ignore,
        );
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, Date.now() - envelope.startedAtMs)),
            );
          }
        }
        return dispatchResult(
          admittedCommand,
          committedCommand.lastSequence,
          command.type === "thread.child.report"
            ? reportVerdictForCommand(command.commandId, committedCommand.committedEvents)
            : undefined,
        );
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, Date.now() - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (!isOrchestrationCommandPreviouslyRejectedError(error)) {
            const releaseFailedAdmission = Effect.gen(function* () {
              const failedThreadId = (() => {
                switch (envelope.command.type) {
                  case "thread.create":
                    return envelope.command.threadId;
                  case "thread.turn.start":
                    return envelope.command.bootstrap?.createThread === undefined
                      ? undefined
                      : envelope.command.threadId;
                  default:
                    return undefined;
                }
              })();
              if (
                failedThreadId !== undefined &&
                !readModel.threads.some((thread) => thread.id === failedThreadId)
              ) {
                yield* workspaceOwnership.release(failedThreadId);
              }

              const transferCommand =
                envelope.command.type === "thread.workspace.handoff" ||
                envelope.command.type === "thread.meta.update"
                  ? envelope.command
                  : undefined;
              if (transferCommand !== undefined && admittedCanonicalPath !== undefined) {
                const currentThread = readModel.threads.find(
                  (thread) => thread.id === transferCommand.threadId,
                );
                if (admittedCanonicalPath !== currentThread?.workspaceBinding?.canonicalPath) {
                  yield* workspaceOwnership.release(
                    transferCommand.threadId,
                    admittedCanonicalPath,
                  );
                }
              }
            }).pipe(
              Effect.catch((cleanupError) =>
                Effect.logWarning("failed to compensate workspace admission", {
                  commandId: envelope.command.commandId,
                  cleanupError,
                }),
              ),
            );
            yield* releaseFailedAdmission;
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: readModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (isOrchestrationCommandInvariantError(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: new Date().toISOString(),
                  resultSequence: readModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
    const command = envelope.command;
    const cleanupPath = cleanupWorktreePath(command, readModel.threads);
    const requiresWorktreeLock =
      cleanupPath !== null ||
      command.type === "thread.archive" ||
      command.type === "thread.unarchive" ||
      command.type === "thread.delete";
    const worktreeProcess = requiresWorktreeLock ? withWorktreeLock(process) : process;
    if (command.type !== "thread.turn.start" && command.type !== "thread.queued-turn.dispatch") {
      return worktreeProcess;
    }
    const thread = readModel.threads.find((entry) => entry.id === command.threadId);
    const bootstrap = command.type === "thread.turn.start" ? command.bootstrap : undefined;
    const projectId = thread?.projectId ?? bootstrap?.createThread?.projectId;
    const project = readModel.projects.find((entry) => entry.id === projectId);
    const cwd =
      thread?.worktreePath ?? bootstrap?.createThread?.worktreePath ?? project?.workspaceRoot;
    // This is the command worker itself, not dispatch(). Release after the
    // committed pending state is visible, before the provider starts its turn.
    return cwd ? coordinator.withCheckout(cwd, worktreeProcess) : worktreeProcess;
  };

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const initializationExit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* runStartupPhase("projections.replay", projectionPipeline.bootstrap);
          readModel = yield* runStartupPhase(
            "projections.snapshot",
            projectionSnapshotQuery.getSnapshot(),
          );
          yield* Effect.forkScoped(worker);
          yield* Effect.logDebug("orchestration engine started").pipe(
            Effect.annotateLogs({ sequence: readModel.snapshotSequence }),
          );
        }),
      );
      if (Exit.isFailure(initializationExit)) {
        yield* Deferred.failCause(initialized, initializationExit.cause).pipe(Effect.orDie);
        return;
      }
      yield* Deferred.succeed(initialized, undefined).pipe(Effect.orDie);
    }),
  );

  const getReadModel: OrchestrationEngineShape["getReadModel"] = () =>
    Deferred.await(initialized).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error("Orchestration engine initialization failed"),
      ),
      Effect.orDie,
      Effect.map(() => readModel),
    );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      yield* Deferred.await(initialized);
      const result = yield* Deferred.make<DispatchResult, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, { command, result, startedAtMs: Date.now() });
      return yield* Deferred.await(result);
    });

  return {
    getReadModel,
    readEvents,
    dispatch,
    withWorktreeLock,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    // Scoped subscribe registers the subscription synchronously during the yield,
    // giving consumers an explicit attach-before-snapshot handshake.
    acquireDomainEventSubscription: PubSub.subscribe(eventPubSub),
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
).pipe(
  Layer.provideMerge(WorktreeCleanupJobRepositoryLive),
  Layer.provideMerge(CheckoutCoordinatorLive),
  Layer.provideMerge(WorkspaceOwnershipRepositoryLive),
);
