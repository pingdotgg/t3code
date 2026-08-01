import type {
  PreviewEvent,
  PreviewReviewSnapshot,
  PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";

function navigationUrl(session: PreviewSessionSnapshot): string | null {
  return session.navStatus._tag === "Idle" ? null : session.navStatus.url;
}

function eventUrl(event: PreviewEvent): string | null {
  switch (event.type) {
    case "closed":
      return null;
    case "failed":
      return event.url;
    case "opened":
    case "navigated":
    case "resized":
      return navigationUrl(event.snapshot);
  }
}

function eventIsNewerThanList(input: {
  readonly event: PreviewEvent;
  readonly serverEpoch: string | null;
  readonly revision: number | null;
}): boolean {
  return (
    input.serverEpoch === null ||
    input.revision === null ||
    input.event.serverEpoch !== input.serverEpoch ||
    input.event.revision > input.revision
  );
}

export function mergePreviewSessionSnapshots(
  serverSessions: ReadonlyArray<PreviewSessionSnapshot>,
  optimisticSessions: ReadonlyArray<PreviewSessionSnapshot>,
): ReadonlyArray<PreviewSessionSnapshot> {
  const merged = [...serverSessions];
  const indexByTabId = new Map(merged.map((session, index) => [session.tabId, index]));

  for (const optimistic of optimisticSessions) {
    const index = indexByTabId.get(optimistic.tabId);
    if (index === undefined) {
      indexByTabId.set(optimistic.tabId, merged.length);
      merged.push(optimistic);
      continue;
    }
    if (optimistic.updatedAt > merged[index]!.updatedAt) {
      merged[index] = optimistic;
    }
  }

  return merged;
}

export function upsertPreviewSessionSnapshot(
  sessions: ReadonlyArray<PreviewSessionSnapshot>,
  snapshot: PreviewSessionSnapshot,
): ReadonlyArray<PreviewSessionSnapshot> {
  const index = sessions.findIndex((session) => session.tabId === snapshot.tabId);
  if (index === -1) return [...sessions, snapshot];
  if (sessions[index] === snapshot) return sessions;
  const next = [...sessions];
  next[index] = snapshot;
  return next;
}

export function previewCaptureErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  if (/unknown request tag:\s*preview\.reviewSnapshot/iu.test(message)) {
    return "Preview review requires the updated T3 desktop and server. Restart them from this build, then refresh.";
  }
  return message || "The desktop preview could not capture a review snapshot.";
}

export function previewEventRequiresSessionRefresh(input: {
  readonly event: PreviewEvent;
  readonly threadId: ThreadId;
  readonly serverEpoch: string | null;
  readonly revision: number | null;
}): boolean {
  if (input.event.threadId !== input.threadId) return false;
  if (!eventIsNewerThanList(input)) return false;
  return input.event.serverEpoch !== input.serverEpoch || input.event.type !== "resized";
}

export function previewLiveUrlForSelection(input: {
  readonly selectedTabId: string | null;
  readonly selectedSession: PreviewSessionSnapshot | null;
  readonly snapshot: PreviewReviewSnapshot | null;
  readonly latestEvent: PreviewEvent | null;
  readonly threadId: ThreadId;
  readonly serverEpoch: string | null;
  readonly revision: number | null;
}): string | null {
  const tabId = input.selectedTabId;
  if (!tabId) return null;

  const event = input.latestEvent;
  if (
    event &&
    event.threadId === input.threadId &&
    event.tabId === tabId &&
    eventIsNewerThanList({
      event,
      serverEpoch: input.serverEpoch,
      revision: input.revision,
    })
  ) {
    if (event.type === "closed") return null;
    const url = eventUrl(event);
    if (url) return url;
  }

  if (input.selectedSession?.tabId === tabId) {
    const url = navigationUrl(input.selectedSession);
    if (url) return url;
  }

  if (input.snapshot?.threadId === input.threadId && input.snapshot.tabId === tabId) {
    return input.snapshot.url;
  }

  return null;
}

export function previewCaptureCanCommit(input: {
  readonly activeRequestId: number;
  readonly requestId: number;
  readonly selectedTabId: string | null;
  readonly requestedTabId: string;
  readonly threadId: ThreadId;
  readonly snapshot: PreviewReviewSnapshot;
}): boolean {
  return (
    input.activeRequestId === input.requestId &&
    input.selectedTabId === input.requestedTabId &&
    input.snapshot.tabId === input.requestedTabId &&
    input.snapshot.threadId === input.threadId
  );
}
