import type {
  ApplicationStoredEvent,
  OrchestrationV2ArchivedShellStreamItem,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";

/** Keep only the newest shell-relevant event per project/thread aggregate. */
export function coalesceShellApplicationEvents(
  events: ReadonlyArray<ApplicationStoredEvent>,
): ReadonlyArray<ApplicationStoredEvent> {
  const latestByAggregate = new Map<string, ApplicationStoredEvent>();
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

/**
 * Emit the initial shell prefix strictly first, then merge the post-prefix
 * tail with enrichment refreshes. Prevents a newer marked enrichment from
 * landing before the unmarked authoritative initial snapshot.
 */
export function composeShellStreamWithEnrichment<A, E, R, A2, E2, R2, A3, E3, R3>(input: {
  readonly initial: Stream.Stream<A, E, R>;
  readonly tail: Stream.Stream<A2, E2, R2>;
  readonly enrichment: Stream.Stream<A3, E3, R3>;
}): Stream.Stream<A | A2 | A3, E | E2 | E3, R | R2 | R3> {
  return Stream.concat(input.initial, Stream.merge(input.tail, input.enrichment));
}

/** Build a shell snapshot stream item for a batched enrichment completion. */
export function shellStreamItemFromEnrichmentRefresh(input: {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly changes: ReadonlyArray<{ readonly workspaceRoot: string }>;
}): Extract<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }> {
  return {
    kind: "snapshot",
    snapshot: input.snapshot,
    resolvedRepositoryIdentityRoots: [
      ...new Set(input.changes.map((change) => change.workspaceRoot)),
    ],
  };
}

/**
 * Initial subscribe frames: always emit the unmarked authoritative snapshot,
 * then a same-sequence enrichment frame only when some roots already resolved.
 */
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
      snapshot: input.snapshot,
      resolvedRepositoryIdentityRoots: [...new Set(input.resolvedRepositoryIdentityRoots)],
    },
  ];
}

/** Converts a committed event and its resulting shell snapshot into one delta. */
export function shellStreamItemFromSnapshot(input: {
  readonly stored: OrchestrationV2StoredEvent;
  readonly snapshot: OrchestrationV2ThreadShellSnapshot;
}): Exclude<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }> {
  const active = input.snapshot.threads.find((thread) => thread.id === input.stored.event.threadId);
  if (active !== undefined) {
    return {
      kind: "thread.updated",
      sequence: input.stored.sequence,
      location: "active",
      thread: active,
    };
  }

  const archived = input.snapshot.archivedThreads.find(
    (thread) => thread.id === input.stored.event.threadId,
  );
  if (archived !== undefined) {
    return {
      kind: "thread.updated",
      sequence: input.stored.sequence,
      location: "archive",
      thread: archived,
    };
  }

  return {
    kind: "thread.removed",
    sequence: input.stored.sequence,
    location:
      input.stored.event.type === "thread.deleted" && input.stored.event.payload.archivedAt !== null
        ? "archive"
        : "active",
    threadId: input.stored.event.threadId,
  };
}

/** Converts a committed event into an archive-only delta when it changes archive membership. */
export function archivedShellStreamItemFromSnapshot(input: {
  readonly stored: OrchestrationV2StoredEvent;
  readonly snapshot: OrchestrationV2ThreadShellSnapshot;
}): Exclude<OrchestrationV2ArchivedShellStreamItem, { readonly kind: "snapshot" }> | null {
  const archived = input.snapshot.archivedThreads.find(
    (thread) => thread.id === input.stored.event.threadId,
  );
  if (archived !== undefined) {
    return {
      kind: "thread.updated",
      sequence: input.stored.sequence,
      thread: archived,
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
