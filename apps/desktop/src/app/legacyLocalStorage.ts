export const LEGACY_LOCAL_STORAGE_IMPORT_KEY = "t3code:v1-local-storage-imported:v1";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const DRAFT_CONTENT_FIELDS = [
  "prompt",
  "attachments",
  "files",
  "terminalContexts",
  "previewAnnotations",
  "reviewComments",
  "threadContexts",
  "elementContexts",
] as const;

function recoverEmptyDraft(legacy: unknown, current: unknown) {
  const oldDraft = record(legacy);
  const newDraft = record(current);
  if (!oldDraft || !newDraft) return current;
  const hasContent = DRAFT_CONTENT_FIELDS.some((key) => {
    const value = newDraft[key];
    return typeof value === "string" ? value.length > 0 : Array.isArray(value) && value.length > 0;
  });
  if (hasContent) return current;
  const recovered = { ...newDraft };
  for (const key of DRAFT_CONTENT_FIELDS) {
    if (oldDraft[key] !== undefined) recovered[key] = oldDraft[key];
  }
  return recovered;
}

/** Preserve V2 choices, adding only V1 stash entries and draft buckets missing in V2. */
function mergeLegacyLocalStorageValue(key: string, legacy: string, current: string | null) {
  if (current === null) return legacy;
  if (key !== "t3code:prompt-stash:v2" && key !== "t3code:composer-drafts:v1") return current;
  try {
    const oldEnvelope = record(JSON.parse(legacy));
    const newEnvelope = record(JSON.parse(current));
    const oldState = record(oldEnvelope?.state);
    const newState = record(newEnvelope?.state);
    // Let the client's own migrations handle an untouched legacy value. Mixing
    // different schema versions would label old fields with the new version.
    if (!oldState || !newState || oldEnvelope?.version !== newEnvelope?.version) return current;
    if (key === "t3code:prompt-stash:v2") {
      if (!Array.isArray(oldState.entries) || !Array.isArray(newState.entries)) return current;
      const ids = new Set(newState.entries.map((entry: unknown) => record(entry)?.id));
      const additions = oldState.entries.filter((entry: unknown) => {
        const id = record(entry)?.id;
        if (typeof id !== "string" || ids.has(id)) return false;
        ids.add(id);
        return true;
      });
      return JSON.stringify({
        ...newEnvelope,
        state: { ...newState, entries: [...newState.entries, ...additions] },
      });
    }
    const state = { ...oldState, ...newState };
    for (const key of Object.keys(oldState)) {
      // These are persisted maps, including legacy unscoped thread/project IDs.
      if (!/By(?:Thread|Project|LogicalProject)(?:Id|Key)$/.test(key)) continue;
      const oldMap = record(oldState[key]);
      const newMap = record(newState[key]);
      if (oldMap && newMap) {
        const merged = { ...oldMap, ...newMap };
        if (key === "draftsByThreadKey" || key === "draftsByThreadId") {
          for (const id of Object.keys(oldMap)) {
            if (Object.hasOwn(newMap, id)) merged[id] = recoverEmptyDraft(oldMap[id], newMap[id]);
          }
        }
        state[key] = merged;
      }
    }
    return JSON.stringify({ ...newEnvelope, state });
  } catch {
    return current;
  }
}

/** Mark completion only after every write succeeds. Retrying partial imports is idempotent. */
export function importLegacyLocalStorage(
  storage: Pick<Storage, "getItem" | "setItem">,
  entries: ReadonlyArray<readonly [string, string]>,
) {
  if (storage.getItem(LEGACY_LOCAL_STORAGE_IMPORT_KEY) !== null) return;
  for (const [key, value] of entries) {
    if (!key.startsWith("t3code:") || key === LEGACY_LOCAL_STORAGE_IMPORT_KEY) continue;
    const current = storage.getItem(key);
    const merged = mergeLegacyLocalStorageValue(key, value, current);
    if (merged !== current) storage.setItem(key, merged);
  }
  storage.setItem(LEGACY_LOCAL_STORAGE_IMPORT_KEY, "1");
}
