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

/** The canonical IANA name, so aliases such as Asia/Calcutta match Asia/Kolkata. */
export function canonicalTimeZone(timeZone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function deviceTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Zones to offer for schedules, keeping a saved one the runtime no longer lists. */
export function scheduleTimeZoneChoices(saved: string): ReadonlyArray<string> {
  const zones = new Set(Intl.supportedValuesOf("timeZone"));
  zones.add("UTC");
  if (saved !== "") zones.add(saved);
  return [...zones].sort();
}

/** True when schedules on these environments run in a zone other than this device's. */
export function schedulesDifferFromDevice(
  scheduleZones: ReadonlyArray<string | undefined>,
  device: string,
): boolean {
  const here = canonicalTimeZone(device);
  return scheduleZones.some(
    (zone) => zone !== undefined && here !== undefined && canonicalTimeZone(zone) !== here,
  );
}
