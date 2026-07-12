/**
 * Structural signature for native stack screen options so callers can skip
 * setOptions when they pass a fresh object/function identity with the same
 * content. Unstable setOptions loops re-enter PreventRemoveProvider and crash
 * Release builds with "Maximum update depth exceeded".
 */
export function buildNativeStackOptionsSignature(options: unknown): string {
  if (options === undefined || options === null || typeof options !== "object") {
    return "";
  }
  const record = options as Record<string, unknown>;
  return stableJsonStringify({
    headerBackVisible: record.headerBackVisible ?? null,
    headerSearchBarOptions: record.headerSearchBarOptions ?? null,
    headerTintColor: record.headerTintColor === undefined ? null : String(record.headerTintColor),
    headerTitle: record.headerTitle ?? null,
    headerTitleStyle: record.headerTitleStyle ?? null,
    title: record.title ?? null,
    unstable_headerCenterItems: invokeHeaderItemsFactory(record.unstable_headerCenterItems),
    unstable_headerLeftItems: invokeHeaderItemsFactory(record.unstable_headerLeftItems),
    unstable_headerRightItems: invokeHeaderItemsFactory(record.unstable_headerRightItems),
    unstable_headerSubtitle: record.unstable_headerSubtitle ?? null,
    unstable_headerToolbarItems: invokeHeaderItemsFactory(record.unstable_headerToolbarItems),
  });
}

function invokeHeaderItemsFactory(value: unknown): unknown {
  if (typeof value !== "function") {
    return value ?? null;
  }
  try {
    return (value as () => unknown)();
  } catch {
    return "[header-items-threw]";
  }
}

function stableJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, entry) => {
      if (typeof entry === "function") {
        return "[fn]";
      }
      if (typeof entry === "symbol") {
        return String(entry);
      }
      return entry;
    });
  } catch {
    return "[unserializable]";
  }
}
