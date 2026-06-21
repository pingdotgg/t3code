import type {
  OrchestrationV2ArchivedShellStreamItem,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2StoredEvent,
} from "@t3tools/contracts";

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
