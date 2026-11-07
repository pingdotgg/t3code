export const THEME_SELECTION_STORAGE_KEY = "t3code:theme-selection:v1";

/** Keep device selection atomic while reading the previous installation's keys until first write. */
export function themeSelectionStorage(storage: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}) {
  // Inlined because generate-theme-boot serializes this function into index.html.
  const key = "t3code:theme-selection:v1";
  const fields: Readonly<Record<string, string>> = {
    "t3code:theme": "theme",
    "t3code:theme-appearance-mode": "mode",
    "t3code:theme-follow-system": "followSystem",
    "t3code:theme-halves:v1": "halves",
  };
  const read = (): Record<string, string | null> | null => {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("selection" in value)
    )
      throw new Error("Invalid theme selection.");
    const selection = value.selection;
    if (
      typeof selection !== "object" ||
      selection === null ||
      Array.isArray(selection) ||
      Object.values(selection).some((value) => value !== null && typeof value !== "string")
    )
      throw new Error("Invalid theme selection.");
    return selection as Record<string, string | null>;
  };
  const patch = (updates: Readonly<Record<string, string | null>>) => {
    const selection =
      read() ??
      Object.fromEntries(
        Object.entries(fields).map(([legacy, field]) => [field, storage.getItem(legacy)]),
      );
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        selection: {
          ...selection,
          ...Object.fromEntries(
            Object.entries(updates).map(([legacyKey, value]) => [fields[legacyKey]!, value]),
          ),
        },
      }),
    );
  };
  return {
    patch,
    getItem: (legacyKey: string) => {
      if (!fields[legacyKey]) return storage.getItem(legacyKey);
      const selection = read();
      return selection ? (selection[fields[legacyKey]!] ?? null) : storage.getItem(legacyKey);
    },
    setItem: (legacyKey: string, value: string) =>
      fields[legacyKey] ? patch({ [legacyKey]: value }) : storage.setItem(legacyKey, value),
    removeItem: (legacyKey: string) =>
      fields[legacyKey] ? patch({ [legacyKey]: null }) : storage.removeItem(legacyKey),
  };
}

export function resolveThemeSelectionAppearance(selection: {
  mode: "light" | "dark" | "system" | null;
  systemDark: boolean;
  baseAppearance: "light" | "dark";
  appearances: ReadonlyArray<"light" | "dark"> | null;
  hasHalf: boolean;
}): "light" | "dark" {
  const wanted =
    selection.mode === "system" ? (selection.systemDark ? "dark" : "light") : selection.mode;
  if (wanted === null) return selection.baseAppearance;
  return selection.hasHalf ||
    selection.appearances === null ||
    selection.appearances.includes(wanted)
    ? wanted
    : selection.baseAppearance;
}
