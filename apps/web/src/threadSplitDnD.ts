import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

export const THREAD_SCOPED_DRAG_MIME = "application/x-t3-scoped-thread";

export interface ThreadScopedDragPayload {
  environmentId: string;
  threadId: string;
}

export function writeScopedThreadToDataTransfer(
  dataTransfer: DataTransfer,
  threadRef: ScopedThreadRef,
): void {
  const payload: ThreadScopedDragPayload = {
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  };
  const json = JSON.stringify(payload);
  dataTransfer.setData(THREAD_SCOPED_DRAG_MIME, json);
  dataTransfer.setData("text/plain", json);
  dataTransfer.effectAllowed = "copy";
}

export function readScopedThreadRefFromDataTransfer(
  dataTransfer: DataTransfer,
): ScopedThreadRef | null {
  const primary = dataTransfer.getData(THREAD_SCOPED_DRAG_MIME).trim();
  const fallback = dataTransfer.getData("text/plain").trim();
  const raw = primary.length > 0 ? primary : fallback;
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const environmentId = (parsed as ThreadScopedDragPayload).environmentId;
    const threadId = (parsed as ThreadScopedDragPayload).threadId;
    if (typeof environmentId !== "string" || typeof threadId !== "string") {
      return null;
    }
    if (!environmentId.trim() || !threadId.trim()) {
      return null;
    }
    return scopeThreadRef(environmentId.trim() as EnvironmentId, threadId.trim() as ThreadId);
  } catch {
    return null;
  }
}

export function dragEventHasScopedThreadPayload(event: {
  readonly dataTransfer: DataTransfer | null;
}): boolean {
  return (
    event.dataTransfer?.types.includes(THREAD_SCOPED_DRAG_MIME) === true ||
    event.dataTransfer?.types.includes("text/plain") === true
  );
}
