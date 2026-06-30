import type { BoardId, ThreadId, TicketId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { BoardRegistryShape } from "./Services/BoardRegistry.ts";
import type { WorkflowAgentSessionStoreShape } from "./Services/WorkflowAgentSessionStore.ts";
import type { WorkflowBoardSaveLocksShape } from "./Services/WorkflowBoardSaveLocks.ts";
import type { WorkflowBoardVersionStoreShape } from "./Services/WorkflowBoardVersionStore.ts";
import type { WorkflowEngineShape } from "./Services/WorkflowEngine.ts";
import type { WorkflowEventStoreShape } from "./Services/WorkflowEventStore.ts";
import type { WorkflowReadModelShape } from "./Services/WorkflowReadModel.ts";
import type { WorkflowThreadJanitorShape } from "./Services/WorkflowThreadJanitor.ts";
import type { WorkflowWebhookShape } from "./Services/WorkflowWebhook.ts";
import type { WorkflowWorktreeJanitorShape } from "./Services/WorkflowWorktreeJanitor.ts";

export interface WorkflowBoardOwnedStateDeletionDeps {
  readonly boardRegistry: Pick<BoardRegistryShape, "unregister">;
  readonly engine: Pick<WorkflowEngineShape, "cancelBoardPipelines">;
  readonly eventStore: Pick<WorkflowEventStoreShape, "deleteForBoard">;
  readonly readModel: Pick<WorkflowReadModelShape, "deleteBoard" | "deleteBoardTicketState">;
  readonly versionStore: Pick<WorkflowBoardVersionStoreShape, "deleteForBoard">;
  readonly sql: Pick<SqlClient.SqlClient, "withTransaction">;
  readonly worktreeJanitor?: Pick<WorkflowWorktreeJanitorShape, "collectBoardPlan" | "run">;
  readonly threadJanitor?: Pick<
    WorkflowThreadJanitorShape,
    "collectBoardThreads" | "deleteThreads"
  >;
  readonly webhook?: Pick<WorkflowWebhookShape, "deleteForBoard">;
  // Per-agent session teardown: both queries join projection_ticket, so the
  // threads must be listed BEFORE the cascade and the rows deleted INSIDE the
  // transaction (before deleteBoardTicketState clears projection_ticket).
  // `stopSession` is a live side effect that runs after the commit, best-effort.
  readonly agentSessions?: Pick<WorkflowAgentSessionStoreShape, "listByBoard" | "deleteByBoard">;
  readonly provider?: Pick<ProviderServiceShape, "stopSession">;
}

export interface WorkflowBoardTicketStateDeletionDeps {
  readonly saveLocks: Pick<WorkflowBoardSaveLocksShape, "withSaveLock">;
  readonly engine: Pick<WorkflowEngineShape, "cancelTicketPipelines">;
  readonly eventStore: Pick<WorkflowEventStoreShape, "deleteForTicket">;
  readonly readModel: Pick<WorkflowReadModelShape, "deleteTicketState">;
  readonly sql: Pick<SqlClient.SqlClient, "withTransaction">;
  readonly worktreeJanitor?: Pick<WorkflowWorktreeJanitorShape, "collectTicketPlan" | "run">;
  readonly threadJanitor?: Pick<
    WorkflowThreadJanitorShape,
    "collectTicketThreads" | "deleteThreads"
  >;
  // Per-agent session teardown for the per-ticket cascade (A8): used by the
  // terminal-retention sweep so a swept terminal ticket's stored agent sessions
  // are dropped and their live provider sessions stopped (best-effort).
  readonly agentSessions?: Pick<WorkflowAgentSessionStoreShape, "listByTicket" | "deleteByTicket">;
  readonly provider?: Pick<ProviderServiceShape, "stopSession">;
}

const noCleanup = Effect.succeed(null);
const noThreads = Effect.succeed([] as ReadonlyArray<string>);

export const deleteWorkflowBoardOwnedState = (
  deps: WorkflowBoardOwnedStateDeletionDeps,
  boardId: BoardId,
) =>
  Effect.gen(function* () {
    // Collected before the cascade — the repo root and ticket list are only
    // resolvable while the projections still exist.
    const cleanupPlan = yield* deps.worktreeJanitor?.collectBoardPlan(boardId) ?? noCleanup;
    const threadIds = yield* deps.threadJanitor?.collectBoardThreads(boardId) ?? noThreads;
    // Collected here because listByBoard joins projection_ticket, which the
    // cascade below deletes. Best-effort: a failure must not block the cascade.
    const agentSessionRows: ReadonlyArray<{ readonly threadId: string }> =
      deps.agentSessions === undefined
        ? []
        : yield* deps.agentSessions.listByBoard(boardId).pipe(Effect.orElseSucceed(() => []));
    yield* deps.engine.cancelBoardPipelines(boardId);
    // The DB cascade runs in one transaction so a mid-cascade SQL/IO failure
    // (or SQLITE_BUSY) rolls back instead of leaving orphaned event-store rows
    // whose backing projection_ticket rows are gone — mirroring the per-ticket
    // path. eventStore.deleteForBoard must precede deleteBoardTicketState, which
    // clears the projection_ticket rows the IN-subquery resolves against.
    yield* deps.sql.withTransaction(
      Effect.gen(function* () {
        yield* deps.webhook?.deleteForBoard(boardId) ?? Effect.void;
        yield* deps.versionStore.deleteForBoard(boardId);
        // Inside the tx, before deleteBoardTicketState clears the
        // projection_ticket rows the IN-subquery resolves against.
        yield* deps.agentSessions?.deleteByBoard(boardId) ?? Effect.void;
        yield* deps.eventStore.deleteForBoard(boardId);
        yield* deps.readModel.deleteBoardTicketState(boardId);
        yield* deps.readModel.deleteBoard(boardId);
      }),
    );
    // In-memory registry + git/thread cleanup stay outside the transaction:
    // a Ref update and filesystem/provider work cannot be rolled back, and
    // unregistering only after the DB commit keeps the in-memory view from
    // diverging if the transaction aborts.
    yield* deps.boardRegistry.unregister(boardId);
    // Best-effort live provider teardown for the now-deleted agent sessions —
    // a provider error must never surface from board deletion.
    if (deps.provider !== undefined && agentSessionRows.length > 0) {
      const provider = deps.provider;
      yield* Effect.forEach(
        agentSessionRows,
        (row) =>
          provider
            .stopSession({ threadId: row.threadId as ThreadId })
            .pipe(Effect.catch(() => Effect.void)),
        { discard: true },
      );
    }
    yield* deps.worktreeJanitor?.run(cleanupPlan) ?? Effect.void;
    yield* deps.threadJanitor?.deleteThreads(threadIds) ?? Effect.void;
  });

export const deleteWorkflowBoardTicketOwnedStateWhen = <E, R>(
  deps: WorkflowBoardTicketStateDeletionDeps,
  boardId: BoardId,
  ticketId: TicketId,
  shouldDelete: Effect.Effect<boolean, E, R>,
) =>
  Effect.gen(function* () {
    const deleted = yield* deps.saveLocks.withSaveLock(
      boardId,
      Effect.gen(function* () {
        const cleanupPlan = yield* deps.worktreeJanitor?.collectTicketPlan(ticketId) ?? noCleanup;
        const threadIds = yield* deps.threadJanitor?.collectTicketThreads(ticketId) ?? noThreads;
        // Collected before the cascade so the threads survive deleteByTicket and
        // can be stopped after the commit. Best-effort: never block the delete.
        const agentSessionRows: ReadonlyArray<{ readonly threadId: string }> =
          deps.agentSessions === undefined
            ? []
            : yield* deps.agentSessions.listByTicket(ticketId).pipe(Effect.orElseSucceed(() => []));
        const deleted = yield* deps.sql.withTransaction(
          Effect.gen(function* () {
            if (!(yield* shouldDelete)) {
              return false;
            }

            yield* deps.engine.cancelTicketPipelines(ticketId);
            yield* (
              deps.agentSessions?.deleteByTicket(ticketId).pipe(Effect.catch(() => Effect.void)) ??
                Effect.void
            );
            yield* deps.eventStore.deleteForTicket(ticketId);
            yield* deps.readModel.deleteTicketState(ticketId);
            return true;
          }),
        );
        if (deleted) {
          // Git/filesystem cleanup stays outside the DB transaction but under
          // the board save lock so a concurrent re-create of the same ticket
          // worktree cannot interleave with its removal.
          if (deps.provider !== undefined && agentSessionRows.length > 0) {
            const provider = deps.provider;
            yield* Effect.forEach(
              agentSessionRows,
              (row) =>
                provider
                  .stopSession({ threadId: row.threadId as ThreadId })
                  .pipe(Effect.catch(() => Effect.void)),
              { discard: true },
            );
          }
          yield* deps.worktreeJanitor?.run(cleanupPlan) ?? Effect.void;
          yield* deps.threadJanitor?.deleteThreads(threadIds) ?? Effect.void;
        }
        return deleted;
      }),
    );
    return deleted;
  });

export const deleteWorkflowBoardTicketOwnedState = (
  deps: WorkflowBoardTicketStateDeletionDeps,
  boardId: BoardId,
  ticketId: TicketId,
) =>
  deleteWorkflowBoardTicketOwnedStateWhen(deps, boardId, ticketId, Effect.succeed(true)).pipe(
    Effect.asVoid,
  );
