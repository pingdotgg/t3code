import { ompRecordField, ompRecordString } from "./rpc.ts";

export function isOmpSessionSettled(state: unknown): boolean {
  return (
    ompRecordField(state, "isSettled") === true &&
    ompRecordField(state, "hasPendingAsyncWork") === false &&
    ompRecordField(state, "isStreaming") === false &&
    (ompRecordField(state, "queuedMessageCount") ?? 0) === 0
  );
}

export function ompPromptFailure(event: unknown): string | undefined {
  if (
    ompRecordField(event, "type") !== "prompt_result" ||
    ompRecordField(event, "status") !== "error"
  )
    return undefined;
  return ompRecordString(ompRecordField(event, "error"), "message") ?? "OMP prompt failed.";
}

export function ompForkMessageParent(
  entries: ReadonlyMap<string, { readonly parentId: string | null; readonly isMessage: boolean }>,
  boundaryId: string,
): string | null {
  const visited = new Set<string>();
  let current = entries.get(boundaryId)?.parentId ?? null;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const entry = entries.get(current);
    if (entry?.isMessage) return current;
    current = entry?.parentId ?? null;
  }
  return null;
}
