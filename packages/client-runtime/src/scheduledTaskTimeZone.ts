import * as DateTime from "effect/DateTime";

/**
 * Short label for the server zone a fixed-time schedule runs in. With a run time it names
 * that instant's offset (PST/PDT); without one it uses the generic name (PT).
 */
export function scheduleTimeZoneLabel(
  timeZone: string | undefined,
  runAt?: string | null,
): string | undefined {
  if (timeZone === undefined) return undefined;
  if (timeZone === "Etc/UTC" || timeZone === "UTC" || timeZone === "GMT") return "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: runAt ? "short" : "shortGeneric",
    })
      .formatToParts(runAt ? DateTime.toEpochMillis(DateTime.makeUnsafe(runAt)) : undefined)
      .find((part) => part.type === "timeZoneName")?.value;
  } catch {
    return undefined;
  }
}
