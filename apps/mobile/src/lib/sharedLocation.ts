export interface DraftComposerLocationAttachment {
  readonly id: string;
  readonly type: "location";
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly address: string;
  readonly accuracy: number | null;
}

interface GeocodedAddress {
  readonly name?: string | null;
  readonly formattedAddress?: string | null;
  readonly streetNumber?: string | null;
  readonly street?: string | null;
  readonly district?: string | null;
  readonly city?: string | null;
  readonly region?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
}

const POSITION_TIMEOUT_MS = 20_000;
const GEOCODE_TIMEOUT_MS = 10_000;

class LocationPickTimeout extends Error {}

function withTimeout<A>(
  operation: () => Promise<A>,
  timeoutMs: number,
  message: string,
): Promise<A> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LocationPickTimeout(message)), timeoutMs);

    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

function singleLine(value: string | null | undefined): string {
  return (
    (value ?? "")
      // Remove address line breaks/control characters before building the prompt.
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

function geocodedAddressLine(address: GeocodedAddress): string {
  const formatted = singleLine(address.formattedAddress);
  if (formatted) return formatted;

  const street = [address.streetNumber, address.street].map(singleLine).filter(Boolean).join(" ");
  const parts = [
    street,
    address.district,
    address.city,
    address.region,
    address.postalCode,
    address.country,
  ]
    .map(singleLine)
    .filter((part, index, all) => part.length > 0 && all.indexOf(part) === index);
  return parts.join(", ");
}

function isValidCoordinates(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function isValidAccuracy(accuracy: number): boolean {
  return Number.isFinite(accuracy) && accuracy >= 0;
}

/** Request foreground permission and attach one current position with its nearest geocoded address. */
export async function pickCurrentLocation(): Promise<DraftComposerLocationAttachment> {
  let location: typeof import("expo-location");
  try {
    location = await import("expo-location");
  } catch {
    throw new Error("Location is unavailable in this app.");
  }

  let permission: { readonly granted: boolean };
  try {
    permission = await location.requestForegroundPermissionsAsync();
  } catch {
    throw new Error("Could not request location permission.");
  }
  if (!permission.granted) {
    throw new Error("Location permission was denied.");
  }

  let servicesEnabled: boolean;
  try {
    servicesEnabled = await location.hasServicesEnabledAsync();
  } catch {
    throw new Error("Could not check location services.");
  }
  if (!servicesEnabled) {
    throw new Error("Location services are turned off.");
  }

  let position: Awaited<ReturnType<typeof location.getCurrentPositionAsync>>;
  try {
    position = await withTimeout(
      () => location.getCurrentPositionAsync({ accuracy: location.Accuracy.Balanced }),
      POSITION_TIMEOUT_MS,
      "Could not get your current location in time. Try again.",
    );
  } catch (error) {
    if (error instanceof LocationPickTimeout) throw error;
    throw new Error("Could not get your current location.", { cause: error });
  }

  const { latitude, longitude, accuracy } = position.coords;
  if (!isValidCoordinates(latitude, longitude)) {
    throw new Error("Could not get your current location.");
  }

  let results: ReadonlyArray<GeocodedAddress>;
  try {
    results = await withTimeout(
      () => location.reverseGeocodeAsync({ latitude, longitude }),
      GEOCODE_TIMEOUT_MS,
      "Could not look up an address in time. Try again.",
    );
  } catch (error) {
    if (error instanceof LocationPickTimeout) throw error;
    throw new Error("Could not look up an address for your current location.", { cause: error });
  }

  const nearest = results[0];
  if (!nearest) {
    throw new Error("Could not find an address for your current location.");
  }

  const address = geocodedAddressLine(nearest);
  if (!address) {
    throw new Error("Could not find an address for your current location.");
  }
  const name = singleLine(nearest.name) || address || "Current location";
  const { uuidv4 } = await import("./uuid");

  return {
    id: uuidv4(),
    type: "location",
    name,
    latitude,
    longitude,
    address,
    accuracy: accuracy !== null && isValidAccuracy(accuracy) ? accuracy : null,
  };
}

function formatNumber(value: number): string {
  return String(value);
}

function normalizedName(location: DraftComposerLocationAttachment): string {
  return singleLine(location.name) || "Current location";
}

function normalizedAddress(location: DraftComposerLocationAttachment): string {
  return singleLine(location.address) || "Unknown address";
}

/** A safe map link built from the numeric coordinates and sanitized place name. */
export function sharedLocationMapsUrl(
  location: DraftComposerLocationAttachment,
  platform: "ios" | "android",
): string {
  if (!isValidCoordinates(location.latitude, location.longitude)) {
    throw new Error("Invalid location coordinates.");
  }

  const latitude = formatNumber(location.latitude);
  const longitude = formatNumber(location.longitude);
  const name = normalizedName(location);
  if (platform === "ios") {
    return `https://maps.apple.com/?ll=${latitude},${longitude}&q=${encodeURIComponent(name)}`;
  }
  return `geo:${latitude},${longitude}?q=${latitude},${longitude}(${encodeURIComponent(name)})`;
}

/** Serialize one location as a canonical text block suitable for the composer prompt. */
export function serializeSharedLocation(location: DraftComposerLocationAttachment): string {
  if (!isValidCoordinates(location.latitude, location.longitude)) {
    throw new Error("Invalid location coordinates.");
  }
  if (location.accuracy !== null && !isValidAccuracy(location.accuracy)) {
    throw new Error("Invalid location accuracy.");
  }

  const accuracy = location.accuracy === null ? "Unknown" : `±${formatNumber(location.accuracy)}m`;
  return [
    "<shared-location>",
    `Place: ${normalizedName(location)}`,
    `Address: ${normalizedAddress(location)}`,
    `Coordinates: ${formatNumber(location.latitude)}, ${formatNumber(location.longitude)}`,
    `Accuracy: ${accuracy}`,
    `Map: ${sharedLocationMapsUrl(location, "ios")}`,
    "</shared-location>",
  ].join("\n");
}

/** Append location-only composer attachments as canonical blocks, preserving existing text. */
export function appendSharedLocations(
  text: string,
  locations: ReadonlyArray<DraftComposerLocationAttachment>,
): string {
  if (locations.length === 0) return text;
  const blocks = locations.map(serializeSharedLocation).join("\n\n");
  if (text.length === 0) return blocks;
  return `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${blocks}`;
}

const CANONICAL_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?/u;

function parseCanonicalNumber(value: string): number | undefined {
  if (!CANONICAL_NUMBER.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && formatNumber(parsed) === value ? parsed : undefined;
}

function parseCanonicalLocationBlock(block: string): DraftComposerLocationAttachment | undefined {
  const lines = block.split("\n");
  if (lines.length !== 7 || lines[0] !== "<shared-location>" || lines[6] !== "</shared-location>") {
    return undefined;
  }

  const placePrefix = "Place: ";
  const addressPrefix = "Address: ";
  const coordinatesPrefix = "Coordinates: ";
  const accuracyPrefix = "Accuracy: ";
  const mapPrefix = "Map: ";
  if (
    !lines[1]!.startsWith(placePrefix) ||
    !lines[2]!.startsWith(addressPrefix) ||
    !lines[3]!.startsWith(coordinatesPrefix) ||
    !lines[4]!.startsWith(accuracyPrefix) ||
    !lines[5]!.startsWith(mapPrefix)
  ) {
    return undefined;
  }

  const name = lines[1]!.slice(placePrefix.length);
  const address = lines[2]!.slice(addressPrefix.length);
  if (!name || !address || singleLine(name) !== name || singleLine(address) !== address) {
    return undefined;
  }

  const coordinates =
    /^Coordinates: (-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?), (-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?)$/u.exec(
      lines[3]!,
    );
  if (!coordinates) return undefined;
  const latitude = parseCanonicalNumber(coordinates[1]!);
  const longitude = parseCanonicalNumber(coordinates[2]!);
  if (
    latitude === undefined ||
    longitude === undefined ||
    !isValidCoordinates(latitude, longitude)
  ) {
    return undefined;
  }

  const accuracyText = lines[4]!.slice(accuracyPrefix.length);
  let accuracy: number | null;
  if (accuracyText === "Unknown") {
    accuracy = null;
  } else {
    const match = /^±(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?)m$/u.exec(accuracyText);
    if (!match) return undefined;
    const parsedAccuracy = parseCanonicalNumber(match[1]!);
    if (parsedAccuracy === undefined || !isValidAccuracy(parsedAccuracy)) return undefined;
    accuracy = parsedAccuracy;
  }

  const location: DraftComposerLocationAttachment = {
    id: "",
    type: "location",
    name,
    address,
    latitude,
    longitude,
    accuracy,
  };
  if (lines[5] !== `${mapPrefix}${sharedLocationMapsUrl(location, "ios")}`) return undefined;
  return location;
}

function removeBlockAndCanonicalSeparator(text: string, start: number, end: number): string {
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (before.endsWith("\n\n")) return `${before.slice(0, -2)}${after}`;
  if (before.length === 0 && after.startsWith("\n\n")) return after.slice(2);
  return `${before}${after}`;
}

/** Extract valid canonical location blocks; malformed blocks and surrounding prose stay intact. */
export function parseSharedLocations(text: string): {
  readonly text: string;
  readonly locations: ReadonlyArray<DraftComposerLocationAttachment>;
} {
  const valid: Array<{
    readonly start: number;
    readonly end: number;
    readonly location: DraftComposerLocationAttachment;
  }> = [];
  const blockPattern = /<shared-location>\n[\s\S]*?\n<\/shared-location>/gu;
  for (const match of text.matchAll(blockPattern)) {
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
