export type ThreadSettingsRouteSessionIdentity = {
  readonly ownerId: string;
  readonly purpose?: "settings" | "fork";
};

/** Keep an active fork picker stable while the source thread continues updating behind its sheet. */
export function refreshThreadSettingsRouteSession<
  Current extends ThreadSettingsRouteSessionIdentity,
  Next extends ThreadSettingsRouteSessionIdentity,
>(current: Current | null, next: Next): Current | Next {
  return current?.ownerId === next.ownerId && current.purpose === "fork" ? current : next;
}

/** Retry one target idempotently; choosing another model starts a distinct fork request. */
export function forkThreadIdForSelection<ThreadId>(input: {
  readonly threadId: ThreadId;
  readonly attemptedSelectionKey: string | null;
  readonly nextSelectionKey: string;
  readonly createThreadId: () => ThreadId;
}): ThreadId {
  return input.attemptedSelectionKey !== null &&
    input.attemptedSelectionKey !== input.nextSelectionKey
    ? input.createThreadId()
    : input.threadId;
}
