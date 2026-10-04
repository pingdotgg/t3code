import * as Cause from "effect/Cause";

/** Recognizes disk exhaustion through the provider, SQL and platform error wrappers. */
export function isStorageFullError(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  for (let remaining = 32; pending.length > 0 && remaining > 0; remaining--) {
    const current = pending.pop();
    if (current == null || seen.has(current)) continue;
    seen.add(current);
    if (typeof current === "string") {
      if (
        /\bENOSPC\b|\bSQLITE_FULL\b|no space left on device|database or disk is full/i.test(current)
      )
        return true;
      continue;
    }
    if (typeof current !== "object") continue;
    try {
      if (Cause.isCause(current)) {
        for (const reason of current.reasons.slice(0, remaining)) {
          if (Cause.isFailReason(reason)) pending.push(reason.error);
          else if (Cause.isDieReason(reason)) pending.push(reason.defect);
        }
        continue;
      }
      const value = current as Record<string, unknown>;
      if (
        value.code === "ENOSPC" ||
        value.code === "SQLITE_FULL" ||
        (value.code === "ERR_SQLITE_ERROR" && value.errcode === 13)
      )
        return true;
      pending.push(value.cause, value.reason, value.message);
    } catch {
      continue;
    }
  }
  return false;
}
