import type {
  ApplicationStoredEvent,
  OrchestrationProjectShell,
  OrchestrationV2ArchivedShellStreamItem,
  OrchestrationV2OlderSettledCount,
  OrchestrationV2OlderSettledThreads,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2StoredEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  isLiveSubagentShell,
  isOlderSettledThreadShell,
  OrchestrationProjectShell as ProjectShellSchema,
  OrchestrationV2ThreadShell as ThreadShellSchema,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type * as Arr from "effect/Array";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { bufferLatestLiveStream } from "./LiveStreamBudget.ts";

type ShellDelta = Extract<OrchestrationV2ShellStreamItem, { readonly sequence: number }>;

/** Snapshots, synchronization, and enrichment markers must bypass full-state coalescing. */
export const bufferShellLiveStream = <E, R>(
  source: Stream.Stream<ShellDelta, E, R>,
  limits?: { readonly maxItems?: number; readonly maxSerializedBytes?: number },
) =>
  bufferLatestLiveStream(
    source,
    (item) => {
      switch (item.kind) {
        case "project.updated":
          return `project:${item.project.id}`;
        case "project.removed":
          return `project:${item.projectId}`;
        case "thread.updated":
          return `thread:${item.location}:${item.thread.id}`;
        case "thread.removed":
          return `thread:${item.location}:${item.threadId}`;
      }
    },
    limits,
  );

export function buildActiveShellSnapshot(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: OrchestrationV2ThreadShellSnapshot;
  readonly snapshotSequence: number;
}): OrchestrationV2ShellSnapshot {
  return {
    schemaVersion: input.threads.schemaVersion,
    snapshotSequence: input.snapshotSequence,
    projects: input.projects,
    threads: input.threads.threads,
    archivedThreads: [],
  };
}

/**
 * Idle subagent children have no sidebar row, so clients that opt in read them from their thread
 * family instead. A child stays while it is live or the parent of another child, so the request
 * and working walks over shell rows never meet a gap in a nested chain.
 */
export function omitIdleSubagentShells(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  const parentIds = new Set<string>();
  for (const thread of threads) {
    if (thread.lineage.relationshipToParent === "subagent" && thread.lineage.parentThreadId) {
      parentIds.add(thread.lineage.parentThreadId);
    }
  }
  return threads.filter(
    (thread) =>
      thread.lineage.relationshipToParent !== "subagent" ||
      isLiveSubagentShell(thread) ||
      parentIds.has(thread.id),
  );
}

/**
 * The active rows a shell subscriber gets, and the subagent ids whose transcript events its stream
 * drops. The ids come from every row, so an omitted child that wakes keeps that filter.
 */
export function activeShellRowsForSubscriber(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  omitIdleSubagents: boolean,
): {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly subagentThreadIds: Set<string>;
} {
  return {
    threads: omitIdleSubagents ? omitIdleSubagentShells(threads) : threads,
    subagentThreadIds: new Set(
      threads
        .filter((thread) => thread.lineage.relationshipToParent === "subagent")
        .map((thread) => thread.id),
    ),
  };
}

const NEWEST_SETTLED_KEPT = 25;

/**
 * Opted-in snapshots keep the 25 newest settled top-level threads (and ties) and count the rest per
 * project in `olderSettled`; clients page them with `getOlderSettledThreads`. Older rows stay while
 * pinned, snoozed, live, or above a kept subagent, so walks over shell rows still find them.
 */
export function omitOlderSettledShells(input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly snapshotSequence: number;
  readonly now: DateTime.Utc;
}): {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly olderSettled: OrchestrationV2OlderSettledThreads;
} {
  const nowMs = DateTime.toEpochMillis(input.now);
  const settledTimes = input.threads
    .flatMap((thread) =>
      thread.lineage.relationshipToParent !== "subagent" &&
      thread.settledOverride === "settled" &&
      thread.settledAt !== null
        ? [DateTime.toEpochMillis(thread.settledAt)]
        : [],
    )
    .sort((left, right) => right - left);
  // With fewer than 25, the oldest one is the cut, so nothing is older.
  const beforeMs = settledTimes[NEWEST_SETTLED_KEPT - 1] ?? settledTimes.at(-1) ?? nowMs;
  const ancestorIds = new Set<string>();
  for (const thread of input.threads) {
    if (thread.lineage.relationshipToParent !== "subagent") continue;
    if (thread.lineage.parentThreadId !== null) ancestorIds.add(thread.lineage.parentThreadId);
    ancestorIds.add(thread.lineage.rootThreadId);
  }
  const counts = new Map<ProjectId, number>();
  const threads = input.threads.filter((thread) => {
    if (!isOlderSettledThreadShell(thread, beforeMs)) return true;
    counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
    return (
      thread.pinnedAt != null ||
      (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs) ||
      isLiveSubagentShell(thread) ||
      ancestorIds.has(thread.id)
    );
  });
  return {
    threads,
    olderSettled: {
      before: DateTime.formatIso(DateTime.makeUnsafe(beforeMs)),
      asOfSequence: input.snapshotSequence,
      counts: Array.from(counts, ([projectId, count]) => ({ projectId, count })),
    },
  };
}

/**
 * The snapshot a shell subscriber gets for its opt-ins, and the subagent ids whose transcript
 * events its stream drops (from every row, so an omitted child that wakes keeps that filter).
 */
export function shellSnapshotForSubscriber(
  base: OrchestrationV2ShellSnapshot,
  options: {
    readonly omitIdleSubagents: boolean;
    readonly omitOlderSettled: boolean;
    readonly now: DateTime.Utc;
  },
): {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly subagentThreadIds: Set<string>;
} {
  const rows = activeShellRowsForSubscriber(base.threads, options.omitIdleSubagents);
  if (!options.omitOlderSettled) {
    return {
      snapshot: { ...base, threads: rows.threads },
      subagentThreadIds: rows.subagentThreadIds,
    };
  }
  const older = omitOlderSettledShells({
    threads: rows.threads,
    snapshotSequence: base.snapshotSequence,
    now: options.now,
  });
  return {
    snapshot: { ...base, threads: older.threads, olderSettled: older.olderSettled },
    subagentThreadIds: rows.subagentThreadIds,
  };
}

/**
 * One transaction covers the reads so they agree; the threads are decoded after it commits,
 * because the server shares one SQLite connection and decoding a large shell takes longer than
 * reading it.
 */
export const loadShellSnapshotParts = Effect.fn("ShellStream.loadShellSnapshotParts")(function* <
  E1,
  E2,
  E3,
  E4,
>(input: {
  readonly sql: SqlClient.SqlClient;
  readonly readThreads: Effect.Effect<Effect.Effect<OrchestrationV2ThreadShellSnapshot, E2>, E1>;
  readonly listProjects: Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, E3>;
  readonly latestSequence: Effect.Effect<number, E4>;
}) {
  const read = yield* input.sql
    .withTransaction(
      Effect.all({
        decodeThreads: input.readThreads,
        projects: input.listProjects,
        snapshotSequence: input.latestSequence,
      }),
    )
    .pipe(NodeSqliteClient.readOnly);
  return {
    projects: read.projects,
    threads: yield* read.decodeThreads,
    snapshotSequence: read.snapshotSequence,
  };
});

/** A page of older settled threads, read and decoded like `loadShellSnapshotParts`. */
export const loadOlderSettledThreadsPage = Effect.fn("ShellStream.loadOlderSettledThreadsPage")(
  function* <E1, E2, E3, E4>(input: {
    readonly sql: SqlClient.SqlClient;
    readonly listThreads: Effect.Effect<
      {
        readonly threadIds: ReadonlyArray<ThreadId>;
        readonly counts: ReadonlyArray<OrchestrationV2OlderSettledCount>;
      },
      E1
    >;
    readonly readThreads: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<Effect.Effect<OrchestrationV2ThreadShellSnapshot, E3>, E2>;
    readonly latestSequence: Effect.Effect<number, E4>;
  }) {
    const read = yield* input.sql
      .withTransaction(
        Effect.gen(function* () {
          const listed = yield* input.listThreads;
          return {
            listed,
            decodeThreads:
              listed.threadIds.length === 0 ? null : yield* input.readThreads(listed.threadIds),
            snapshotSequence: yield* input.latestSequence,
          };
        }),
      )
      .pipe(NodeSqliteClient.readOnly);
    const threads = read.decodeThreads === null ? [] : (yield* read.decodeThreads).threads;
    const order = new Map(read.listed.threadIds.map((threadId, index) => [threadId, index]));
    return {
      snapshotSequence: read.snapshotSequence,
      threads: threads.toSorted((left, right) => order.get(left.id)! - order.get(right.id)!),
      counts: read.listed.counts,
    };
  },
);

export type ShellApplicationEvent =
  | Pick<
      Extract<ApplicationStoredEvent, { readonly aggregateKind: "project" }>,
      "aggregateKind" | "aggregateId" | "type" | "sequence"
    >
  | {
      readonly sequence: number;
      readonly event: Pick<OrchestrationV2StoredEvent["event"], "threadId">;
    };

/** Focused subagents receive these updates through their thread subscription. */
export function shouldPublishShellApplicationEvent(
  stored: ApplicationStoredEvent,
  subagentThreadIds: Set<string>,
): boolean {
  if ("aggregateKind" in stored) return true;
  const { event } = stored;
  if (event.type === "thread.created") {
    if (event.payload.lineage.relationshipToParent === "subagent") {
      subagentThreadIds.add(event.threadId);
    }
    return true;
  }
  if (event.type === "thread.deleted") {
    // Replay and the live tail overlap; keep known IDs so late events stay filtered.
    return true;
  }
  return !(
    subagentThreadIds.has(event.threadId) &&
    (event.type === "node.updated" ||
      event.type === "turn-item.updated" ||
      event.type === "provider-turn.updated" ||
      event.type === "message.updated")
  );
}

/** Shell updates refetch an aggregate; drop transcript bodies before retaining an event. */
export function toShellApplicationEvent(stored: ApplicationStoredEvent): ShellApplicationEvent {
  return "aggregateKind" in stored
    ? {
        aggregateKind: stored.aggregateKind,
        aggregateId: stored.aggregateId,
        type: stored.type,
        sequence: stored.sequence,
      }
    : { sequence: stored.sequence, event: { threadId: stored.event.threadId } };
}

export function coalesceShellApplicationEvents<A extends ShellApplicationEvent>(
  events: ReadonlyArray<A>,
): ReadonlyArray<A> {
  const latestByAggregate = new Map<string, A>();
  for (const stored of events) {
    const key =
      "aggregateKind" in stored
        ? `project:${stored.aggregateId}`
        : `thread:${stored.event.threadId}`;
    latestByAggregate.set(key, stored);
  }
  return Array.from(latestByAggregate.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );
}

/** Emit the authoritative initial snapshot before marked enrichment. */
export function composeShellStreamWithEnrichment<A, E, R, A2, E2, R2, A3, E3, R3>(input: {
  readonly initial: Stream.Stream<A, E, R>;
  readonly tail: Stream.Stream<A2, E2, R2>;
  readonly enrichment: Stream.Stream<A3, E3, R3>;
}): Stream.Stream<A | A2 | A3, E | E2 | E3, R | R2 | R3> {
  const merged = Stream.fromPull(
    Effect.gen(function* () {
      const output = yield* Queue.bounded<
        {
          readonly items: Arr.NonEmptyReadonlyArray<A2 | A3>;
          readonly acknowledged?: Deferred.Deferred<void>;
        },
        E2 | E3 | Cause.Done
      >(0);
      yield* Effect.addFinalizer(() => Queue.shutdown(output));
      let remaining = 2;
      const drain = (effect: Effect.Effect<void, E2 | E3, R2 | R3>) =>
        effect.pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Exit.isFailure(exit)
              ? Queue.failCause(output, exit.cause)
              : --remaining === 0
                ? Queue.end(output)
                : Effect.void,
          ),
          Effect.forkScoped,
        );
      yield* drain(
        input.tail.pipe(
          Stream.runForEachArray((items) =>
            Effect.gen(function* () {
              const acknowledged = yield* Deferred.make<void>();
              yield* Queue.offer(output, { items, acknowledged });
              yield* Deferred.await(acknowledged);
            }),
          ),
        ),
      );
      // Keep draining the sliding enrichment subscription after each handoff,
      // as Stream.merge does, while only the budgeted tail waits for an ACK.
      yield* drain(
        input.enrichment.pipe(Stream.runForEachArray((items) => Queue.offer(output, { items }))),
      );
      let previous: Deferred.Deferred<void> | undefined;
      // Stream.merge pulls ahead after handing off each batch. Wait for the next
      // downstream pull so shell delivery keeps that batch charged until its RPC ACK.
      return Effect.gen(function* () {
        if (previous) yield* Deferred.succeed(previous, undefined);
        const next = yield* Queue.take(output);
        previous = next.acknowledged;
        return next.items;
      });
    }),
  ).pipe(Stream.scoped);
  return Stream.concat(input.initial, merged);
}

const sameProjects = Schema.toEquivalence(Schema.Array(ProjectShellSchema));

export function dedupeShellEnrichment<E, R>(
  stream: Stream.Stream<OrchestrationV2ShellStreamItem, E, R>,
): Stream.Stream<OrchestrationV2ShellStreamItem, E, R> {
  return Stream.suspend(() => {
    let previous:
      | {
          readonly projects: ReadonlyArray<OrchestrationProjectShell>;
          readonly roots: ReadonlySet<string>;
        }
      | undefined;
    return stream.pipe(
      Stream.filter((item) => {
        if (item.kind !== "snapshot") {
          if (item.kind === "project.updated" || item.kind === "project.removed")
            previous = undefined;
          return true;
        }
        if (
          item.resolvedRepositoryIdentityRoots === undefined ||
          item.snapshot.threads.length > 0 ||
          item.snapshot.archivedThreads.length > 0
        ) {
          previous = undefined;
          return true;
        }
        const roots = new Set(item.resolvedRepositoryIdentityRoots);
        const prior = previous;
        if (
          prior !== undefined &&
          roots.size === prior.roots.size &&
          [...roots].every((root) => prior.roots.has(root)) &&
          sameProjects(prior.projects, item.snapshot.projects)
        )
          return false;
        previous = { projects: item.snapshot.projects, roots };
        return true;
      }),
    );
  });
}

export function shellStreamItemFromEnrichmentRefresh(input: {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly changes: ReadonlyArray<{ readonly workspaceRoot: string }>;
}): Extract<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }> {
  const resolvedRepositoryIdentityRoots = [
    ...new Set(input.changes.map((change) => change.workspaceRoot)),
  ];
  return {
    kind: "snapshot",
    snapshot: {
      ...input.snapshot,
      projects: input.snapshot.projects.filter((project) =>
        resolvedRepositoryIdentityRoots.includes(project.workspaceRoot),
      ),
      threads: [],
      archivedThreads: [],
    },
    resolvedRepositoryIdentityRoots,
  };
}

export function shellStreamItemsFromInitialSnapshot(input: {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
}): ReadonlyArray<Extract<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }>> {
  const authoritative = {
    kind: "snapshot" as const,
    snapshot: input.snapshot,
  };
  if (input.resolvedRepositoryIdentityRoots.length === 0) {
    return [authoritative];
  }
  return [
    authoritative,
    {
      kind: "snapshot" as const,
      snapshot: {
        ...input.snapshot,
        projects: input.snapshot.projects.filter((project) =>
          input.resolvedRepositoryIdentityRoots.includes(project.workspaceRoot),
        ),
        threads: [],
        archivedThreads: [],
      },
      resolvedRepositoryIdentityRoots: [...new Set(input.resolvedRepositoryIdentityRoots)],
    },
  ];
}

export function shellStreamItemsFromResumeSnapshot(input: {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
}): ReadonlyArray<Extract<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }>> {
  return shellStreamItemsFromInitialSnapshot(input).filter(
    (item) => item.resolvedRepositoryIdentityRoots !== undefined,
  );
}

const sameThreadShell = Schema.toEquivalence(ThreadShellSchema);

const UNCHANGED_THREAD_SHELL_RESEND_MS = 5_000;

/** Resend unchanged shells after UNCHANGED_THREAD_SHELL_RESEND_MS so skipped deltas cannot leave resume cursors behind. */
export function skipUnchangedThreadShells<A extends OrchestrationV2ShellStreamItem, E, R>(
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> {
  return Stream.suspend(() => {
    const lastSent = new Map<
      OrchestrationV2ThreadShell["id"],
      { readonly thread: OrchestrationV2ThreadShell; readonly sentAt: number }
    >();
    return stream.pipe(
      Stream.filterEffect((item) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          if (item.kind === "thread.removed") {
            lastSent.delete(item.threadId);
            return true;
          }
          if (item.kind !== "thread.updated") return true;
          const previous = lastSent.get(item.thread.id);
          if (
            previous !== undefined &&
            now - previous.sentAt < UNCHANGED_THREAD_SHELL_RESEND_MS &&
            sameThreadShell(
              { ...item.thread, updatedAt: previous.thread.updatedAt },
              previous.thread,
            )
          ) {
            return false;
          }
          lastSent.set(item.thread.id, { thread: item.thread, sentAt: now });
          return true;
        }),
      ),
    );
  });
}

export function coalesceStoredThreadEvents(
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
): ReadonlyArray<OrchestrationV2StoredEvent> {
  const latestByThreadId = new Map<string, OrchestrationV2StoredEvent>();
  for (const stored of events) {
    latestByThreadId.set(stored.event.threadId, stored);
  }
  return Array.from(latestByThreadId.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export function shellStreamItemFromThreadShell(input: {
  readonly stored: Extract<ShellApplicationEvent, { readonly event: unknown }>;
  readonly shell: OrchestrationV2ThreadShell | null;
}): Extract<
  OrchestrationV2ShellStreamItem,
  { readonly kind: "thread.updated" | "thread.removed" }
> {
  if (input.shell !== null) {
    if (input.shell.archivedAt !== null) {
      return {
        kind: "thread.removed",
        sequence: input.stored.sequence,
        location: "active",
        threadId: input.shell.id,
      };
    }
    return {
      kind: "thread.updated",
      sequence: input.stored.sequence,
      location: "active",
      thread: input.shell,
    };
  }

  return {
    kind: "thread.removed",
    sequence: input.stored.sequence,
    location: "active",
    threadId: input.stored.event.threadId,
  };
}

export function archivedShellStreamItemFromThreadShell(input: {
  readonly stored: OrchestrationV2StoredEvent;
  readonly shell: OrchestrationV2ThreadShell | null;
}): Exclude<OrchestrationV2ArchivedShellStreamItem, { readonly kind: "snapshot" }> | null {
  if (input.shell !== null && input.shell.archivedAt !== null) {
    return {
      kind: "thread.updated",
      sequence: input.stored.sequence,
      thread: input.shell,
    };
  }
  if (
    input.stored.event.type === "thread.unarchived" ||
    (input.stored.event.type === "thread.deleted" && input.stored.event.payload.archivedAt !== null)
  ) {
    return {
      kind: "thread.removed",
      sequence: input.stored.sequence,
      threadId: input.stored.event.threadId,
    };
  }
  return null;
}
