import type {
  OrchestrationV2ArchivedShellStreamItem,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
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

/** Keep only the newest stored event per thread within a coalescing window. */
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

/**
 * Converts a committed event and the affected thread's current shell into one
 * delta. `shell` is null when the thread is deleted or unknown.
 */
export function shellStreamItemFromThreadShell(input: {
  readonly stored: OrchestrationV2StoredEvent;
  readonly shell: OrchestrationV2ThreadShell | null;
}): Exclude<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }> {
  if (input.shell !== null) {
    return {
      kind: "thread.updated",
      sequence: input.stored.sequence,
      location: input.shell.archivedAt === null ? "active" : "archive",
      thread: input.shell,
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
