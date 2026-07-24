import {
  type PinnedThreadKeysByProjectKey,
  type SidebarStateMutation,
  SidebarStateError,
  type SidebarStateSnapshot,
} from "@t3tools/contracts";
import { Context, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const SidebarStateRow = Schema.Struct({
  revision: Schema.Int,
});

const PinnedThreadRow = Schema.Struct({
  projectKey: Schema.String,
  threadKey: Schema.String,
  position: Schema.Int,
});

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recordsEqual(
  left: PinnedThreadKeysByProjectKey,
  right: PinnedThreadKeysByProjectKey,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([projectKey, threadKeys]) =>
      arraysEqual(threadKeys, right[projectKey] ?? []),
    )
  );
}

export function applySidebarStateMutation(
  snapshot: SidebarStateSnapshot,
  mutation: SidebarStateMutation,
): PinnedThreadKeysByProjectKey {
  const next: Record<string, string[]> = Object.fromEntries(
    Object.entries(snapshot.pinnedThreadKeysByProjectKey).map(([projectKey, threadKeys]) => [
      projectKey,
      [...threadKeys],
    ]),
  );

  switch (mutation.type) {
    case "set-pinned": {
      const current = next[mutation.projectKey] ?? [];
      const isPinned = current.includes(mutation.threadKey);
      if (isPinned === mutation.pinned) {
        return snapshot.pinnedThreadKeysByProjectKey;
      }
      if (mutation.pinned) {
        next[mutation.projectKey] = [
          mutation.threadKey,
          ...current.filter((threadKey) => threadKey !== mutation.threadKey),
        ];
      } else {
        const remaining = current.filter((threadKey) => threadKey !== mutation.threadKey);
        if (remaining.length === 0) {
          delete next[mutation.projectKey];
        } else {
          next[mutation.projectKey] = remaining;
        }
      }
      return next;
    }
    case "reorder-pinned": {
      const current = next[mutation.projectKey] ?? [];
      const draggedIndex = current.indexOf(mutation.draggedThreadKey);
      const targetIndex = current.indexOf(mutation.targetThreadKey);
      if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
        return snapshot.pinnedThreadKeysByProjectKey;
      }
      const reordered = [...current];
      const [dragged] = reordered.splice(draggedIndex, 1);
      if (!dragged) {
        return snapshot.pinnedThreadKeysByProjectKey;
      }
      reordered.splice(targetIndex, 0, dragged);
      next[mutation.projectKey] = reordered;
      return next;
    }
    case "import-pins": {
      for (const [projectKey, importedThreadKeys] of Object.entries(
        mutation.pinnedThreadKeysByProjectKey,
      )) {
        const current = next[projectKey] ?? [];
        const merged = [...current];
        for (const threadKey of importedThreadKeys) {
          if (!merged.includes(threadKey)) {
            merged.push(threadKey);
          }
        }
        if (merged.length > 0) {
          next[projectKey] = merged;
        }
      }
      return recordsEqual(next, snapshot.pinnedThreadKeysByProjectKey)
        ? snapshot.pinnedThreadKeysByProjectKey
        : next;
    }
  }
}

export interface SidebarStateShape {
  readonly get: Effect.Effect<SidebarStateSnapshot, SidebarStateError>;
  readonly update: (
    mutation: SidebarStateMutation,
  ) => Effect.Effect<SidebarStateSnapshot, SidebarStateError>;
  readonly changes: Stream.Stream<SidebarStateSnapshot, SidebarStateError>;
}

export class SidebarState extends Context.Service<SidebarState, SidebarStateShape>()(
  "t3/sidebarState/SidebarState",
) {}

const makeSidebarState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mutex = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<SidebarStateSnapshot>();

  const readStateRow = SqlSchema.findOne({
    Request: Schema.Void,
    Result: SidebarStateRow,
    execute: () => sql`SELECT revision FROM sidebar_state WHERE id = 1`,
  });
  const readPinnedRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PinnedThreadRow,
    execute: () => sql`
      SELECT
        project_key AS "projectKey",
        thread_key AS "threadKey",
        position
      FROM sidebar_pinned_threads
      ORDER BY project_key ASC, position ASC
    `,
  });

  const loadSnapshot = Effect.gen(function* () {
    const [state, rows] = yield* Effect.all([readStateRow(undefined), readPinnedRows(undefined)]);
    const pinnedThreadKeysByProjectKey: Record<string, string[]> = {};
    for (const row of rows) {
      (pinnedThreadKeysByProjectKey[row.projectKey] ??= []).push(row.threadKey);
    }
    return {
      revision: state.revision,
      pinnedThreadKeysByProjectKey,
    } satisfies SidebarStateSnapshot;
  });

  const initial: SidebarStateSnapshot = yield* loadSnapshot;
  const stateRef = yield* Ref.make(initial);

  const persist = (
    snapshot: SidebarStateSnapshot,
    nextPins: PinnedThreadKeysByProjectKey,
    changedProjectKeys: readonly string[],
    mutationId: string,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        for (const projectKey of changedProjectKeys) {
          yield* sql`
            DELETE FROM sidebar_pinned_threads
            WHERE project_key = ${projectKey}
          `;
          const threadKeys = nextPins[projectKey] ?? [];
          for (let position = 0; position < threadKeys.length; position += 1) {
            yield* sql`
              INSERT INTO sidebar_pinned_threads (project_key, thread_key, position)
              VALUES (${projectKey}, ${threadKeys[position]!}, ${position})
            `;
          }
        }
        yield* sql`
          UPDATE sidebar_state
          SET revision = ${snapshot.revision + 1}
          WHERE id = 1
        `;
        yield* sql`
          INSERT INTO sidebar_applied_mutations (mutation_id)
          VALUES (${mutationId})
        `;
      }),
    );

  const recordAppliedMutation = (mutationId: string) =>
    sql`
      INSERT INTO sidebar_applied_mutations (mutation_id)
      VALUES (${mutationId})
    `;

  const toError = (cause: unknown) =>
    new SidebarStateError({
      message: "Failed to persist sidebar state.",
      cause,
    });

  const update: SidebarStateShape["update"] = (mutation) =>
    mutex
      .withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* Ref.get(stateRef);
            const appliedRows = yield* sql<{ readonly applied: number }>`
              SELECT 1 AS applied
              FROM sidebar_applied_mutations
              WHERE mutation_id = ${mutation.mutationId}
              LIMIT 1
            `;
            if (appliedRows.length > 0) {
              return current;
            }
            const nextPins = applySidebarStateMutation(current, mutation);
            if (nextPins === current.pinnedThreadKeysByProjectKey) {
              yield* recordAppliedMutation(mutation.mutationId);
              return current;
            }
            const changedProjectKeys = new Set([
              ...Object.keys(current.pinnedThreadKeysByProjectKey),
              ...Object.keys(nextPins),
            ])
              .values()
              .filter(
                (projectKey) =>
                  !arraysEqual(
                    current.pinnedThreadKeysByProjectKey[projectKey] ?? [],
                    nextPins[projectKey] ?? [],
                  ),
              )
              .toArray();
            yield* persist(current, nextPins, changedProjectKeys, mutation.mutationId);
            const next = {
              revision: current.revision + 1,
              pinnedThreadKeysByProjectKey: nextPins,
            } satisfies SidebarStateSnapshot;
            yield* Ref.set(stateRef, next);
            yield* PubSub.publish(changes, next);
            return next;
          }),
        ),
      )
      .pipe(Effect.mapError(toError));

  return {
    get: Ref.get(stateRef),
    update,
    changes: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = yield* Ref.get(stateRef);
        return Stream.concat(
          Stream.make(snapshot),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((next) => next.revision > snapshot.revision),
          ),
        );
      }),
    ),
  } satisfies SidebarStateShape;
});

export const SidebarStateLive = Layer.effect(SidebarState, makeSidebarState);
