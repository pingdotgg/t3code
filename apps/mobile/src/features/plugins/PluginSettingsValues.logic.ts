import type { PluginSettingRow } from "@t3tools/client-runtime/state/pluginSettings";

/** A field's value as text; a secret shows only whether one is saved. */
export function describePluginSettingValue({ field, value, saved, isDefault }: PluginSettingRow) {
  if (field.type === "secret") return saved ? "Saved" : "Not set";
  if (value === undefined) return "Not set";
  const text =
    field.type === "boolean"
      ? value === true
        ? "On"
        : "Off"
      : field.type === "select"
        ? (field.options.find((option) => option.value === value)?.label ?? String(value))
        : String(value);
  // A saved value that no longer fits falls back to the default, and says so.
  return isDefault ? `${text} (default)` : text;
}
