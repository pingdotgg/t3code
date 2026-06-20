import type {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2StoredEvent,
} from "@t3tools/contracts";

/** Converts a committed event and its resulting shell snapshot into one delta. */
export function shellStreamItemFromSnapshot(input: {
  readonly stored: OrchestrationV2StoredEvent;
  readonly snapshot: OrchestrationV2ShellSnapshot;
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
