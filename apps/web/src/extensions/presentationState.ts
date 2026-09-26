import { copyJson, type Json, type ViewRecord } from "@t3tools/extension-sdk/contracts";
import * as Schema from "effect/Schema";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
const STORAGE_KEY = "t3code.api-presentations.v1";
function read(): { key: string; state: Json }[] {
  try {
    const serialized = getLocalStorageItem(STORAGE_KEY, Schema.String);
    if (!serialized || serialized.length > 2 * 1024 * 1024) return [];
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value) || value.length > 32) return [];
    return value.flatMap((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.key !== "string" ||
        item.key.length > 8192
      )
        return [];
      return [{ key: item.key, state: copyJson(item.state) }];
    });
  } catch {
    return [];
  }
}
/** Opaque provider state is scoped to both stable resource identity and presentation contract. */
export function presentationStateKey(requestKey: string, record: ViewRecord) {
  return JSON.stringify([requestKey, record.surfaceId, record.stateVersion, record.context]);
}
export function restorePresentationState(key: string, record: ViewRecord): ViewRecord {
  const saved = read().find((item) => item.key === key);
  return saved ? { ...record, restoreState: saved.state } : record;
}
export function savePresentationState(key: string, record: ViewRecord) {
  if (key.length > 8192) throw new Error("Presentation identity exceeds storage limit");
  const entries = read()
    .filter((item) => item.key !== key)
    .slice(-31);
  entries.push({ key, state: copyJson(record.restoreState) });
  let serialized = JSON.stringify(entries);
  while (serialized.length > 2 * 1024 * 1024 && entries.length > 1) {
    entries.shift();
    serialized = JSON.stringify(entries);
  }
  setLocalStorageItem(STORAGE_KEY, serialized, Schema.String);
}
