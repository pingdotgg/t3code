import type { ServerProvider } from "@t3tools/contracts";

const CHECKED_AT_ONLY_KEYS = new Set(["usageLimits", "versionAdvisory"]);

function sameIgnoringCheckedAt(previous: object, next: object, nested: boolean): boolean {
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  if (keys.length !== Object.keys(before).length) return false;
  return keys.every((key) => {
    if (key === "checkedAt") return key in before;
    const left = before[key];
    const right = after[key];
    if (Object.is(left, right)) return true;
    return (
      !nested &&
      CHECKED_AT_ONLY_KEYS.has(key) &&
      typeof left === "object" &&
      typeof right === "object" &&
      left !== null &&
      right !== null &&
      sameIgnoringCheckedAt(left, right, true)
    );
  });
}

/**
 * Keeps each provider from `previous` when `next` only moved its `checkedAt`
 * timestamps. Every status push restamps them, so views that never show them
 * would otherwise redraw each provider on every push. Relies on the config
 * projection already sharing unchanged nested values.
 */
export function reuseProvidersIgnoringCheckedAt(
  previous: ReadonlyArray<ServerProvider> | null,
  next: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  if (previous === null) return next;
  const previousById = new Map(previous.map((provider) => [provider.instanceId, provider]));
  let same = previous.length === next.length;
  const merged = next.map((provider, index) => {
    const before = previousById.get(provider.instanceId);
    const kept =
      before !== undefined && sameIgnoringCheckedAt(before, provider, false) ? before : provider;
    if (kept !== previous[index]) same = false;
    return kept;
  });
  return same ? previous : merged;
}
