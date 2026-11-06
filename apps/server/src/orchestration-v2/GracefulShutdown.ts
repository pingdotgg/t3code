import {
  CommandId,
  DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  GracefulShutdownError,
  type GracefulShutdownId,
  type GracefulShutdownInput,
  type GracefulShutdownResult,
  type GracefulShutdownScope,
  type GracefulShutdownStatus,
  MessageId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import { isActiveRun } from "./CommandPolicy.ts";
import * as GracefulShutdownGate from "./GracefulShutdownGate.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const isGracefulShutdownError = Schema.is(GracefulShutdownError);

const SAVE_WORK_PROMPT =
  "This environment is preparing to shut down for an update or maintenance. Save your work now: commit and push any changes that should survive the restart if appropriate, leave the working tree recoverable, and briefly note anything still unfinished. Do not start new long-running work.";

const LIVE_SESSION_STATUSES = new Set(["starting", "ready", "running", "waiting"]);

export class GracefulShutdown extends Context.Service<
  GracefulShutdown,
  {
    readonly status: Effect.Effect<GracefulShutdownStatus>;
    /**
     * Enter drain mode, optionally prompt in-scope agents to save work, wait until
     * quiesced or timed out, then return control to the caller. Drain stays active
     * until `complete` or process exit so new turns keep queueing.
     */
    readonly beginAndAwait: (
      input: GracefulShutdownInput,
    ) => Effect.Effect<GracefulShutdownResult, GracefulShutdownError>;
    /** Clear drain mode and allow queued turns to start again. */
    readonly complete: (
      shutdownId?: GracefulShutdownId,
    ) => Effect.Effect<void, GracefulShutdownError>;
  }
>()("t3/orchestration-v2/GracefulShutdown") {}

function shellHasActiveRun(shell: OrchestrationV2ThreadShell): boolean {
  return shell.activeRunId !== null && shell.activityRunStatus != null;
}

function shellInScope(shell: OrchestrationV2ThreadShell, scope: GracefulShutdownScope): boolean {
  if (shell.archivedAt !== null || shell.deletedAt !== null) return false;
  switch (scope.type) {
    case "environment":
      return true;
    case "provider":
      return shell.providerInstanceId === scope.providerInstanceId;
    case "session":
      return false;
  }
}

const make = Effect.fn("GracefulShutdown.make")(function* () {
  const gate = yield* GracefulShutdownGate.GracefulShutdownGate;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const shutdownSequence = yield* Ref.make(0);

  const listShutdownShells = Effect.fn("GracefulShutdown.listShutdownShells")(function* () {
    const snapshot = yield* threads.getShellSnapshot({ location: "active" });
    return snapshot.threads.filter(
      (shell) => shell.archivedAt === null && shell.deletedAt === null,
    );
  });

  const clearIfShutdown = Effect.fn("GracefulShutdown.clearIfShutdown")(function* (
    shutdownId: GracefulShutdownId,
  ) {
    const state = yield* gate.getState;
    if (state.shutdownId === shutdownId) {
      yield* gate.clear;
    }
  });

  const countActiveInScope = Effect.fn("GracefulShutdown.countActiveInScope")(function* (
    scope: GracefulShutdownScope,
  ) {
    if (scope.type === "session") {
      const shells = yield* listShutdownShells();
      let count = 0;
      for (const shell of shells) {
        const records = yield* threads.getThreadRecords(shell.id, [
          "runs",
          "providerSessions",
          "providerThreads",
        ]);
        const session = records.providerSessions.find(
          (candidate) => candidate.id === scope.providerSessionId,
        );
        if (session === undefined || !LIVE_SESSION_STATUSES.has(session.status)) continue;
        const hasActive = records.runs.some(
          (run) =>
            isActiveRun(run) &&
            records.providerThreads.some(
              (providerThread) =>
                providerThread.id === run.providerThreadId &&
                providerThread.providerSessionId === scope.providerSessionId,
            ),
        );
        if (hasActive) count += 1;
      }
      return count;
    }

    const shells = yield* listShutdownShells();
    return shells.filter((shell) => shellInScope(shell, scope) && shellHasActiveRun(shell)).length;
  });

  const countPendingSaveWork = Effect.fn("GracefulShutdown.countPendingSaveWork")(function* (
    messageIds: ReadonlySet<MessageId>,
  ) {
    if (messageIds.size === 0) return 0;
    const shells = yield* listShutdownShells();
    let count = 0;
    for (const shell of shells) {
      const records = yield* threads.getThreadRecords(shell.id, ["runs"]);
      if (
        records.runs.some(
          (run) =>
            messageIds.has(run.userMessageId) && (run.status === "queued" || isActiveRun(run)),
        )
      ) {
        count += 1;
      }
    }
    return count;
  });

  const status = Effect.gen(function* () {
    const state = yield* gate.getState;
    const activeRunCount =
      state.scope === null
        ? 0
        : yield* countActiveInScope(state.scope).pipe(Effect.orElseSucceed(() => 0));
    return yield* gate.toStatus(activeRunCount);
  });

  const promptSaveWork = Effect.fn("GracefulShutdown.promptSaveWork")(function* (input: {
    readonly shutdownId: GracefulShutdownId;
    readonly scope: GracefulShutdownScope;
  }) {
    const messageIds = new Set<MessageId>();
    const threadIds = new Set<ThreadId>();
    const shells = yield* listShutdownShells();

    for (const shell of shells) {
      const records = yield* threads.getThreadRecords(shell.id, [
        "runs",
        "providerSessions",
        "providerThreads",
      ]);
      const liveSessions = records.providerSessions.filter((session) =>
        LIVE_SESSION_STATUSES.has(session.status),
      );
      const activeRun = records.runs.find(isActiveRun);

      const inScope = (() => {
        switch (input.scope.type) {
          case "environment":
            return activeRun !== undefined || liveSessions.length > 0;
          case "provider": {
            const providerId = input.scope.providerInstanceId;
            return (
              (activeRun !== undefined && activeRun.providerInstanceId === providerId) ||
              liveSessions.some((session) => session.providerInstanceId === providerId)
            );
          }
          case "session": {
            const sessionId = input.scope.providerSessionId;
            return liveSessions.some((session) => session.id === sessionId);
          }
        }
      })();
      if (!inScope) continue;

      const messageId = MessageId.make(
        `message:graceful-shutdown-save:${input.shutdownId}:${shell.id}`,
      );
      const commandId = CommandId.make(
        `command:graceful-shutdown-save:${input.shutdownId}:${shell.id}`,
      );

      const accepted = yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId,
          threadId: shell.id,
          messageId,
          text: SAVE_WORK_PROMPT,
          notification: {
            source: { kind: "system" },
            outcome: "updated",
            summary: "T3 Code asked this agent to save work before shutdown",
            detail: SAVE_WORK_PROMPT,
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("graceful-shutdown.save-work-failed", {
              threadId: shell.id,
              error: String(error),
            }).pipe(Effect.as(false)),
          ),
        );
      if (!accepted) continue;
      messageIds.add(messageId);
      threadIds.add(shell.id);
    }

    return { messageIds, threadIds };
  });

  const mapShutdownError = (reason: string) => (cause: unknown) =>
    new GracefulShutdownError({ reason, cause });

  const beginAndAwait = Effect.fn("GracefulShutdown.beginAndAwait")(
    function* (input: GracefulShutdownInput) {
      const existing = yield* gate.getState;
      if (GracefulShutdownGate.isDrainActive(existing)) {
        return yield* new GracefulShutdownError({
          reason: "A graceful shutdown is already in progress.",
        });
      }

      const sequence = yield* Ref.getAndUpdate(shutdownSequence, (value) => value + 1);
      const started = yield* DateTime.now;
      const shutdownId =
        `shutdown:${DateTime.toEpochMillis(started)}:${sequence}` as GracefulShutdownId;
      const timeoutMs = input.timeoutMs ?? DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS;
      const deadline = DateTime.add(started, { milliseconds: timeoutMs });
      const serverSettings = yield* settings.getSettings.pipe(
        Effect.mapError(
          mapShutdownError("Could not read environment settings for graceful shutdown."),
        ),
      );
      const shouldPrompt = input.promptSaveWork ?? serverSettings.promptSaveWorkOnGracefulShutdown;

      let saveWorkMessageIds = new Set<MessageId>();
      let saveWorkThreadIds = new Set<ThreadId>();

      if (shouldPrompt) {
        // Register privileged message ids before dispatch so the queue gate admits them.
        const plannedShells = yield* listShutdownShells().pipe(
          Effect.mapError(
            mapShutdownError("Could not list threads for graceful shutdown save prompts."),
          ),
        );
        for (const shell of plannedShells) {
          saveWorkMessageIds.add(
            MessageId.make(`message:graceful-shutdown-save:${shutdownId}:${shell.id}`),
          );
        }
      }

      yield* gate.setState({
        phase: "draining",
        shutdownId,
        scope: input.scope,
        reason: input.reason ?? null,
        startedAt: DateTime.formatIso(started),
        deadlineAt: DateTime.formatIso(deadline),
        saveWorkPrompted: shouldPrompt,
        saveWorkMessageIds,
        saveWorkThreadIds,
      });

      const drainBody = Effect.gen(function* () {
        if (shouldPrompt) {
          const prompted = yield* promptSaveWork({ shutdownId, scope: input.scope }).pipe(
            Effect.mapError(
              mapShutdownError("Could not prompt agents to save work before shutdown."),
            ),
          );
          saveWorkMessageIds = prompted.messageIds;
          saveWorkThreadIds = prompted.threadIds;
          const current = yield* gate.getState;
          if (current.shutdownId === shutdownId) {
            yield* gate.setState({
              phase: "draining",
              shutdownId,
              scope: input.scope,
              reason: input.reason ?? null,
              startedAt: DateTime.formatIso(started),
              deadlineAt: DateTime.formatIso(deadline),
              saveWorkPrompted: true,
              saveWorkMessageIds,
              saveWorkThreadIds,
            });
          }
        }

        const waitQuiesced = Effect.gen(function* () {
          while (true) {
            const active = yield* countActiveInScope(input.scope).pipe(
              Effect.mapError(
                mapShutdownError("Could not inspect in-scope runs during graceful shutdown."),
              ),
            );
            const pendingSave = yield* countPendingSaveWork(saveWorkMessageIds).pipe(
              Effect.mapError(
                mapShutdownError("Could not inspect save-work turns during graceful shutdown."),
              ),
            );
            if (active === 0 && pendingSave === 0) return "quiesced" as const;
            yield* Effect.sleep(Duration.millis(250));
          }
        });

        const outcome = yield* Effect.race(
          waitQuiesced,
          Effect.sleep(Duration.millis(timeoutMs)).pipe(Effect.as("timed_out" as const)),
        );

        const finished = yield* DateTime.now;
        const activeRunCount = yield* countActiveInScope(input.scope).pipe(
          Effect.orElseSucceed(() => 0),
        );
        const phase = outcome === "quiesced" ? ("quiesced" as const) : ("timed_out" as const);
        const state = yield* gate.getState;
        if (state.shutdownId === shutdownId) {
          yield* gate.setState({
            ...state,
            phase,
          });
        }

        return {
          shutdownId,
          phase,
          scope: input.scope,
          timedOut: outcome === "timed_out",
          activeRunCount,
          saveWorkPrompted: shouldPrompt,
          saveWorkTurnCount: saveWorkMessageIds.size,
          elapsedMs: Math.max(
            0,
            DateTime.toEpochMillis(finished) - DateTime.toEpochMillis(started),
          ),
        } satisfies GracefulShutdownResult;
      });

      return yield* drainBody.pipe(
        Effect.onInterrupt(() => clearIfShutdown(shutdownId)),
        Effect.onError(() => clearIfShutdown(shutdownId)),
      );
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isGracefulShutdownError(cause)
            ? cause
            : new GracefulShutdownError({
                reason: "Graceful shutdown failed.",
                cause,
              }),
        ),
      ),
  );

  const complete = Effect.fn("GracefulShutdown.complete")(
    function* (shutdownId?: GracefulShutdownId) {
      const state = yield* gate.getState;
      if (!GracefulShutdownGate.isDrainActive(state)) return;
      if (shutdownId !== undefined && state.shutdownId !== shutdownId) {
        return yield* new GracefulShutdownError({
          reason: "That graceful shutdown is no longer active.",
        });
      }
      // Drain only blocks startNextQueuedRun; it never sets queueHeld. Kick the
      // queue without queue.resume so pre-existing manual holds stay held.
      yield* gate.clear;
      yield* orchestrator.resumeQueuedRuns.pipe(
        Effect.mapError(
          (cause) =>
            new GracefulShutdownError({
              reason: "Could not resume queued turns after graceful shutdown.",
              cause,
            }),
        ),
      );
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isGracefulShutdownError(cause)
            ? cause
            : new GracefulShutdownError({
                reason: "Could not complete graceful shutdown.",
                cause,
              }),
        ),
      ),
  );

  return GracefulShutdown.of({ status, beginAndAwait, complete });
});

export const layer = Layer.effect(GracefulShutdown, make());
