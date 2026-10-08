import {
  COMPOSER_CONTEXT_MAX_RECORDS,
  type ComposerContextId,
  type ComposerContextRecord,
  LocationContextRecord as LocationContextRecordSchema,
  SharedLocation as SharedLocationSchema,
  type LocationContextRecord,
  type OrchestrationMessageContext,
  type SharedLocation,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isSharedLocation = Schema.is(SharedLocationSchema);
const isLocationRecord = Schema.is(LocationContextRecordSchema);
const CANONICAL_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/u;
const LOCATION_BLOCK = /<shared-location>\n[\s\S]*?\n<\/shared-location>/gu;

function assertValidLocation(location: SharedLocation): void {
  if (!isSharedLocation(location)) throw new Error("Invalid shared location.");
}

function formatNumber(value: number): string {
  return String(value);
}

function isValidCaptureTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Preserve the phone's calendar date without depending on the environment's time zone. */
export function sharedLocationLocalCaptureTime(location: SharedLocation): string | undefined {
  if (!location.capturedAt || !location.timeZone) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: location.timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(Date.parse(location.capturedAt));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} (${location.timeZone})`;
  } catch {
    // Older runtimes may not recognize a newer IANA zone name.
    return undefined;
  }
}

/** A map link from the numeric coordinates; the place name remains a label. */
export function sharedLocationMapsUrl(
  location: SharedLocation,
  platform: "ios" | "android" | "web",
): string {
  assertValidLocation(location);
  const latitude = formatNumber(location.latitude);
  const longitude = formatNumber(location.longitude);
  if (platform === "ios") {
    return `https://maps.apple.com/?ll=${latitude},${longitude}&q=${encodeURIComponent(location.name)}`;
  }
  if (platform === "android") {
    return `geo:${latitude},${longitude}?q=${latitude},${longitude}(${encodeURIComponent(location.name)})`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude},${longitude}`)}`;
}

/** Serialize one location in the canonical text format, preserving the seven-line legacy shape. */
export function serializeSharedLocation(location: SharedLocation): string {
  assertValidLocation(location);
  const accuracy = location.accuracy === null ? "Unknown" : `±${formatNumber(location.accuracy)}m`;
  const capturedAt =
    typeof location.capturedAt === "string" && isValidCaptureTime(location.capturedAt)
      ? `Captured at: ${location.capturedAt}`
      : undefined;
  const localCaptureTime = sharedLocationLocalCaptureTime(location);
  return [
    "<shared-location>",
    `Place: ${location.name}`,
    `Address: ${location.address}`,
    `Coordinates: ${formatNumber(location.latitude)}, ${formatNumber(location.longitude)}`,
    `Accuracy: ${accuracy}`,
    ...(capturedAt === undefined ? [] : [capturedAt]),
    ...(location.timeZone === undefined ? [] : [`Device time zone: ${location.timeZone}`]),
    ...(localCaptureTime === undefined ? [] : [`Captured locally: ${localCaptureTime}`]),
    `Map: ${sharedLocationMapsUrl(location, "ios")}`,
    "</shared-location>",
  ].join("\n");
}

/** Append location blocks after existing prose, leaving text untouched when there are none. */
export function appendSharedLocations(
  text: string,
  locations: ReadonlyArray<SharedLocation>,
): string {
  if (locations.length === 0) return text;
  const blocks = locations.map(serializeSharedLocation).join("\n\n");
  if (text.length === 0) return blocks;
  return `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${blocks}`;
}

function parseCanonicalNumber(value: string): number | undefined {
  if (!CANONICAL_NUMBER.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && formatNumber(parsed) === value ? parsed : undefined;
}

function parseCanonicalLocationBlock(block: string): SharedLocation | undefined {
  const lines = block.split("\n");
  if (
    lines.length < 7 ||
    lines.length > 10 ||
    lines[0] !== "<shared-location>" ||
    lines.at(-1) !== "</shared-location>"
  ) {
    return undefined;
  }

  const mapIndex = lines.length - 2;
  let optionalIndex = 5;
  const capturedAtLine = lines[optionalIndex]?.startsWith("Captured at: ")
    ? lines[optionalIndex++]
    : undefined;
  const timeZoneLine = lines[optionalIndex]?.startsWith("Device time zone: ")
    ? lines[optionalIndex++]
    : undefined;
  if (lines[optionalIndex]?.startsWith("Captured locally: ")) optionalIndex++;
  if (optionalIndex !== mapIndex) return undefined;
  if (
    !lines[1]!.startsWith("Place: ") ||
    !lines[2]!.startsWith("Address: ") ||
    !lines[3]!.startsWith("Coordinates: ") ||
    !lines[4]!.startsWith("Accuracy: ") ||
    !lines[mapIndex]!.startsWith("Map: ")
  ) {
    return undefined;
  }

  const name = lines[1]!.slice("Place: ".length);
  const address = lines[2]!.slice("Address: ".length);
  const coordinates =
    /^Coordinates: (-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?), (-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?)$/u.exec(
      lines[3]!,
    );
  if (!coordinates) return undefined;
  const latitude = parseCanonicalNumber(coordinates[1]!);
  const longitude = parseCanonicalNumber(coordinates[2]!);
  if (latitude === undefined || longitude === undefined) return undefined;

  const accuracyText = lines[4]!.slice("Accuracy: ".length);
  let accuracy: number | null;
  if (accuracyText === "Unknown") {
    accuracy = null;
  } else {
    const match = /^±(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?)m$/u.exec(accuracyText);
    if (!match) return undefined;
    const parsedAccuracy = parseCanonicalNumber(match[1]!);
    if (parsedAccuracy === undefined || parsedAccuracy < 0) return undefined;
    accuracy = parsedAccuracy;
  }

  const capturedAt = capturedAtLine?.slice("Captured at: ".length);
  if (capturedAt !== undefined && !isValidCaptureTime(capturedAt)) return undefined;
  const timeZone = timeZoneLine?.slice("Device time zone: ".length);

  const location: SharedLocation = {
    name,
    address,
    latitude,
    longitude,
    accuracy,
    ...(capturedAt === undefined ? {} : { capturedAt }),
    ...(timeZone === undefined ? {} : { timeZone }),
  };
  if (!isSharedLocation(location)) return undefined;
  if (serializeSharedLocation(location) !== block) return undefined;
  return location;
}

function removeBlockAndCanonicalSeparator(text: string, start: number, end: number): string {
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (before.endsWith("\n\n")) return `${before.slice(0, -2)}${after}`;
  if (before.length === 0 && after.startsWith("\n\n")) return after.slice(2);
  return `${before}${after}`;
}

/** Extract canonical blocks while preserving malformed blocks and stable source-offset ids. */
export function parseSharedLocations(text: string): {
  readonly text: string;
  readonly locations: ReadonlyArray<SharedLocation & { readonly id: string }>;
} {
  if (!text.includes("<shared-location>")) return { text, locations: [] };
  const valid: Array<{
    readonly start: number;
    readonly end: number;
    readonly location: SharedLocation & { readonly id: string };
  }> = [];
  for (const match of text.matchAll(LOCATION_BLOCK)) {
    const block = match[0];
    const start = match.index;
    const end = start + block.length;
    if ((start > 0 && text[start - 1] !== "\n") || (end < text.length && text[end] !== "\n")) {
      continue;
    }
    const location = parseCanonicalLocationBlock(block);
    if (location)
      valid.push({ start, end, location: { ...location, id: `shared-location:${start}` } });
  }

  let remainingText = text;
  for (let index = valid.length - 1; index >= 0; index -= 1) {
    const block = valid[index]!;
    remainingText = removeBlockAndCanonicalSeparator(remainingText, block.start, block.end);
  }
  return { text: remainingText, locations: valid.map(({ location }) => location) };
}

/** Build a typed composer payload without interpreting the supplied place or address. */
export function locationContextRecord(
  location: SharedLocation,
  contextId: ComposerContextId,
): LocationContextRecord {
  assertValidLocation(location);
  return {
    version: 1,
    contextId,
    label: (location.name || location.address || "Location").slice(0, 200),
    kind: "location",
    payload: {
      name: location.name,
      address: location.address,
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.accuracy,
      ...(location.capturedAt === undefined ? {} : { capturedAt: location.capturedAt }),
      ...(location.timeZone === undefined ? {} : { timeZone: location.timeZone }),
    },
  };
}

function isLocationContextRecord(record: ComposerContextRecord): record is LocationContextRecord {
  return isLocationRecord(record);
}

function formatLocationReference(record: LocationContextRecord): string {
  const label = record.label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return `[${label || "location"}](t3-context://v1/location/${record.contextId})`;
}

/** Upgrade canonical location text blocks to typed inline context references in memory. */
export function normalizeSharedLocationMessage(input: {
  readonly text: string;
  readonly context?: OrchestrationMessageContext;
}): { readonly text: string; readonly context?: OrchestrationMessageContext } {
  const parsed = parseSharedLocations(input.text);
  if (parsed.locations.length === 0) {
    return {
      text: input.text,
      ...(input.context === undefined ? {} : { context: input.context }),
    };
  }

  const records = [...(input.context?.records ?? [])];
  const recordsById = new Map(records.map((record) => [record.contextId, record]));
  const recordByOffset = new Map<number, LocationContextRecord>();
  const addedRecords: LocationContextRecord[] = [];
  const occupiedIds = new Set(recordsById.keys());

  for (const location of parsed.locations) {
    const offset = Number(location.id.slice("shared-location:".length));
    const payload = {
      name: location.name,
      address: location.address,
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.accuracy,
      ...(location.capturedAt === undefined ? {} : { capturedAt: location.capturedAt }),
      ...(location.timeZone === undefined ? {} : { timeZone: location.timeZone }),
    };
    const baseId = `legacy_location_${offset}`;
    let contextId = baseId as ComposerContextId;
    let suffix = 2;
    while (occupiedIds.has(contextId)) {
      const existing = recordsById.get(contextId);
      if (
        existing !== undefined &&
        isLocationContextRecord(existing) &&
        JSON.stringify(existing.payload) === JSON.stringify(payload)
      ) {
        recordByOffset.set(offset, existing);
        break;
      }
      contextId = `${baseId}_${suffix++}` as ComposerContextId;
    }
    if (recordByOffset.has(offset)) continue;
    if (records.length + addedRecords.length >= COMPOSER_CONTEXT_MAX_RECORDS) continue;

    const record = locationContextRecord(location, contextId);
    recordByOffset.set(offset, record);
    addedRecords.push(record);
    occupiedIds.add(contextId);
    recordsById.set(contextId, record);
  }

  let text = "";
  let cursor = 0;
  for (const match of input.text.matchAll(LOCATION_BLOCK)) {
    const offset = match.index;
    const record = recordByOffset.get(offset);
    if (!record) continue;
    text += input.text.slice(cursor, offset);
    text += formatLocationReference(record);
    cursor = offset + match[0].length;
  }
  text += input.text.slice(cursor);

  return {
    text,
    context: {
      version: 1,
      records: [...records, ...addedRecords],
    },
  };
}
