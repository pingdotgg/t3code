import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { type ProjectionStoreV2Shape } from "../ProjectionStorePrelude/ProjectionStoreV2Shape.ts";
import { type ShellRunItemCountRow, type ShellRunRow, type ShellThreadRow } from "../ProjectionStorePrelude/BuildVisibleTurnItems.ts";
import { shellForkSourceIds, shellFromState, visibleItemCountForShell } from "../ProjectionStorePrelude/ThreadShellFromProjection.ts";
import { ProjectionStoreReadError } from "../ProjectionStorePrelude/ProjectionSettlementCandidate.ts";
import type { ApplyRecordTailPart } from "./ApplyRecordTail.ts";
import type { ApplyRunTailPart } from "./ApplyRunTail.ts";
import type { RetainedWindowRowsPart } from "./RetainedWindowRows.ts";
import type { ReadCanonicalProjectionPart } from "./ReadCanonicalProjection.ts";
import type { ReadProjectionPart } from "./ReadProjection.ts";
import type { GetUnreadableThreadIdsPart } from "./GetUnreadableThreadIds.ts";
import type { GetRuntimeRecoveryProjectionPart } from "./GetRuntimeRecoveryProjection.ts";
import type { GetCheckpointRollbackContextPart } from "./GetCheckpointRollbackContext.ts";
import type { ReadTimelineIndexPart } from "./ReadTimelineIndex.ts";
import type { SelectShellThreadRowsPart } from "./SelectShellThreadRows.ts";
import type { ShellThreadStateFromRowPart } from "./ShellThreadStateFromRow.ts";

type Deps = Record<never, never> & ApplyRecordTailPart & ApplyRunTailPart & RetainedWindowRowsPart & ReadCanonicalProjectionPart & ReadProjectionPart & GetUnreadableThreadIdsPart & GetRuntimeRecoveryProjectionPart & GetCheckpointRollbackContextPart & ReadTimelineIndexPart & SelectShellThreadRowsPart & ShellThreadStateFromRowPart;

export const installGetThreadShell = Effect.fnUntraced(function* (deps: Deps) {
  const { pendingBackgroundDataByThreadId, runMapsByThreadId, selectShellItemCounts, selectShellPendingTurnItemRows, selectShellProviderThreadRows, selectShellRunItemCounts, selectShellRunRows, selectShellThreadRows, shellItemCountMap, shellThreadStateFromRow, sql } = deps;

const getThreadShell: ProjectionStoreV2Shape["getThreadShell"] = (threadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rowsByThreadId = new Map<ThreadId, ShellThreadRow>();
          const pending: Array<ThreadId> = [threadId];
          while (pending.length > 0) {
            const nextId = pending.pop();
            if (nextId === undefined || rowsByThreadId.has(nextId)) {
              continue;
            }
            const rows = yield* selectShellThreadRows(nextId);
            const row = rows[0];
            if (row === undefined) {
              continue;
            }
            rowsByThreadId.set(nextId, row);
            if (row.forked_from_run_source_thread_id !== null) {
              pending.push(ThreadId.make(row.forked_from_run_source_thread_id));
            }
          }
          if (!rowsByThreadId.has(threadId)) {
            return null;
          }

          const threadIds = [...rowsByThreadId.keys()];
          const forkSourceIds = shellForkSourceIds([...rowsByThreadId.values()]);
          const [
            runRows,
            itemCountRows,
            shellItemCountRows,
            providerThreadRows,
            pendingTurnItemRows,
          ] = yield* Effect.all([
            forkSourceIds.length === 0
              ? Effect.succeed([] as ReadonlyArray<ShellRunRow>)
              : selectShellRunRows(forkSourceIds),
            forkSourceIds.length === 0
              ? Effect.succeed([] as ReadonlyArray<ShellRunItemCountRow>)
              : selectShellRunItemCounts(forkSourceIds),
            selectShellItemCounts(threadIds),
            selectShellProviderThreadRows(threadIds),
            selectShellPendingTurnItemRows(
              threadIds,
              [...rowsByThreadId.values()].flatMap((row) =>
                row.active_run_id !== null && row.active_run_status === "running"
                  ? [row.active_run_id]
                  : [],
              ),
            ),
          ]);
          const { runOrdinalsByThreadId, itemCountsByThreadId } = runMapsByThreadId({
            runRows,
            itemCountRows,
          });
          const shellItemCountsByThreadId = shellItemCountMap(shellItemCountRows);
          const { providerThreadsByThreadId, pendingTurnItemsByThreadId } =
            yield* pendingBackgroundDataByThreadId({ providerThreadRows, pendingTurnItemRows });

          const states = yield* Effect.forEach([...rowsByThreadId.values()], (row) =>
            shellThreadStateFromRow({
              row,
              runOrdinalsByThreadId,
              itemCountsByThreadId,
              shellItemCountsByThreadId,
              providerThreadsByThreadId,
              pendingTurnItemsByThreadId,
            }),
          );
          const statesByThreadId = new Map(states.map((state) => [state.thread.id, state]));
          const state = statesByThreadId.get(threadId);
          if (state === undefined) {
            return null;
          }
          return shellFromState({
            state,
            visibleItemCount: visibleItemCountForShell({ threadId, statesByThreadId }),
          });
        }),
      )
      .pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })));

const readOnReader =
    <Args extends ReadonlyArray<unknown>, A, E, R>(
      method: (...args: Args) => Effect.Effect<A, E, R>,
    ) =>
    (...args: Args): Effect.Effect<A, E, R> =>
      method(...args).pipe(NodeSqliteClient.readOnly);

  return { getThreadShell, readOnReader };
});

export type GetThreadShellPart = ReturnType<typeof installGetThreadShell> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installGetThreadShell>;
