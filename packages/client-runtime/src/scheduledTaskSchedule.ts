import { isValidTimeZone } from "@t3tools/contracts";

/** Blank means the environment's local time; undefined means the text is not a zone this client knows. */
function parseTimeZoneDraft(value: string): string | null | undefined {
  const zone = value.trim();
  if (zone === "") return null;
  // Intl matches names case-insensitively; store the canonical spelling.
  return isValidTimeZone(zone)
    ? Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone
    : undefined;
}

/**
 * The `timeZone` part of a fixed-time save, or undefined when the entry blocks saving.
 * A zone left as it was loaded is omitted when this client's time zone data lacks it;
 * the server keeps the stored zone, so other edits to the task still save.
 */
export function timeZoneForSave(
  value: string,
  saved: string,
): { readonly timeZone?: string | null } | undefined {
  const timeZone = parseTimeZoneDraft(value);
  if (timeZone !== undefined) return { timeZone };
  return value === saved ? {} : undefined;
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Zones this client knows, starting with its own. */
export function timeZoneSuggestions(): ReadonlyArray<string> {
  const local = localTimeZone();
  const known =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [local, ...known.filter((zone) => zone !== local)];
}
