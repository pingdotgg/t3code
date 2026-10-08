import { SharedLocation as SharedLocationSchema, type SharedLocation } from "@t3tools/contracts";
import { parseSharedLocations as parseLocationBlocks } from "@t3tools/shared/sharedLocation";
import * as Schema from "effect/Schema";
const isSharedLocation = Schema.is(SharedLocationSchema);

export {
  appendSharedLocations,
  serializeSharedLocation,
  sharedLocationMapsUrl,
} from "@t3tools/shared/sharedLocation";

export interface DraftComposerLocationAttachment extends SharedLocation {
  readonly id: string;
  readonly type: "location";
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
  const capturedAt = new Date(position.timestamp);
  if (!Number.isFinite(capturedAt.getTime())) {
    throw new Error("Could not resolve complete location details. Try again.");
  }
  const { uuidv4 } = await import("./uuid");
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Older native runtimes can still share a fix without local time metadata.
  }

  const attachment: DraftComposerLocationAttachment = {
    id: uuidv4(),
    type: "location",
    name,
    latitude,
    longitude,
    address,
    accuracy: accuracy !== null && isValidAccuracy(accuracy) ? accuracy : null,
    capturedAt: capturedAt.toISOString(),
    ...(timeZone ? { timeZone } : {}),
  };
  if (!isSharedLocation(attachment)) {
    throw new Error("Could not resolve complete location details. Try again.");
  }
  return attachment;
}

/** Restore the mobile draft kind when reading the shared, backward-compatible text format. */
export function parseSharedLocations(text: string) {
  const parsed = parseLocationBlocks(text);
  return {
    ...parsed,
    locations: parsed.locations.map((location): DraftComposerLocationAttachment => ({
      ...location,
      type: "location",
    })),
  };
}
