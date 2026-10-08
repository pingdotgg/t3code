import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  requestPermission: vi.fn(),
  hasServicesEnabled: vi.fn(),
  getPosition: vi.fn(),
  reverseGeocode: vi.fn(),
}));

vi.mock("expo-location", () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: mocks.requestPermission,
  hasServicesEnabledAsync: mocks.hasServicesEnabled,
  getCurrentPositionAsync: mocks.getPosition,
  reverseGeocodeAsync: mocks.reverseGeocode,
}));
vi.mock("./uuid", () => ({ uuidv4: () => "location-id" }));

import {
  appendSharedLocations,
  parseSharedLocations,
  pickCurrentLocation,
  serializeSharedLocation,
  sharedLocationMapsUrl,
  type DraftComposerLocationAttachment,
} from "./sharedLocation";

const location: DraftComposerLocationAttachment = {
  id: "draft-id",
  type: "location",
  name: "Main Library",
  latitude: 37.7793,
  longitude: -122.4192,
  address: "100 Larkin St, San Francisco, CA",
  accuracy: 12.5,
};

const position = {
  coords: { latitude: 37.7793, longitude: -122.4192, accuracy: 12.5 },
  timestamp: Date.parse("2026-10-07T18:00:00.000Z"),
};

beforeEach(() => {
  mocks.requestPermission.mockReset().mockResolvedValue({ granted: true });
  mocks.hasServicesEnabled.mockReset().mockResolvedValue(true);
  mocks.getPosition.mockReset().mockResolvedValue(position);
  mocks.reverseGeocode.mockReset().mockResolvedValue([
    { name: " Main Library\nNorth ", formattedAddress: "100 Larkin St,\nSan Francisco, CA" },
    { name: "Ignored result", formattedAddress: "Not the nearest result" },
  ]);
});

describe("shared location picking", () => {
  it("requests foreground access, then gets one position and its nearest address", async () => {
    const attachment = await pickCurrentLocation();

    expect(mocks.requestPermission).toHaveBeenCalledTimes(1);
    expect(mocks.hasServicesEnabled).toHaveBeenCalledTimes(1);
    expect(mocks.getPosition).toHaveBeenCalledWith({ accuracy: 3 });
    expect(mocks.reverseGeocode).toHaveBeenCalledWith({ latitude: 37.7793, longitude: -122.4192 });
    expect(attachment).toEqual({
      id: "location-id",
      type: "location",
      name: "Main Library North",
      latitude: 37.7793,
      longitude: -122.4192,
      address: "100 Larkin St, San Francisco, CA",
      accuracy: 12.5,
      capturedAt: "2026-10-07T18:00:00.000Z",
    });
  });

  it("rejects denied permission before reading location", async () => {
    mocks.requestPermission.mockResolvedValue({ granted: false });

    await expect(pickCurrentLocation()).rejects.toThrow("Location permission was denied.");
    expect(mocks.getPosition).not.toHaveBeenCalled();
    expect(mocks.reverseGeocode).not.toHaveBeenCalled();
  });

  it("reports location services being off", async () => {
    mocks.hasServicesEnabled.mockResolvedValue(false);

    await expect(pickCurrentLocation()).rejects.toThrow("Location services are turned off.");
    expect(mocks.getPosition).not.toHaveBeenCalled();
  });

  it("does not create an attachment when there is no geocoded result", async () => {
    mocks.reverseGeocode.mockResolvedValue([]);

    await expect(pickCurrentLocation()).rejects.toThrow(
      "Could not find an address for your current location.",
    );
  });

  it("hides provider errors when a position fix fails", async () => {
    mocks.getPosition.mockRejectedValue(new Error("native failure with private data"));

    await expect(pickCurrentLocation()).rejects.toThrow("Could not get your current location.");
  });

  it("hides provider errors when reverse geocoding fails", async () => {
    mocks.reverseGeocode.mockRejectedValue(new Error("native failure with private data"));

    await expect(pickCurrentLocation()).rejects.toThrow(
      "Could not look up an address for your current location.",
    );
  });

  it("times out a slow position fix after about 20 seconds", async () => {
    vi.useFakeTimers();
    let positionRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      positionRequested = resolve;
    });
    mocks.getPosition.mockImplementation(() => {
      positionRequested();
      return new Promise(() => {});
    });

    try {
      const pending = pickCurrentLocation();
      await requested;
      const rejected = expect(pending).rejects.toThrow(
        "Could not get your current location in time. Try again.",
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a slow reverse geocode after about 10 seconds", async () => {
    vi.useFakeTimers();
    let geocodeRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      geocodeRequested = resolve;
    });
    mocks.reverseGeocode.mockImplementation(() => {
      geocodeRequested();
      return new Promise(() => {});
    });

    try {
      const pending = pickCurrentLocation();
      await requested;
      const rejected = expect(pending).rejects.toThrow(
        "Could not look up an address in time. Try again.",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("shared location text codec", () => {
  it("round trips canonical blocks without losing surrounding text", () => {
    const block = serializeSharedLocation(location);
    const appended = appendSharedLocations("Check this place.", [location]);
    expect(appended).toBe(`Check this place.\n\n${block}`);

    const parsed = parseSharedLocations(`Before.\n\n${block}\n\nAfter.`);
    expect(parsed.text).toBe("Before.\n\nAfter.");
    expect(parsed.locations).toEqual([{ ...location, id: "shared-location:9" }]);
  });

  it("keeps noncanonical blocks intact instead of trusting their map URL", () => {
    const block = serializeSharedLocation(location).replace(
      "https://maps.apple.com/",
      "https://example.invalid/",
    );
    const text = `Keep this.\n\n${block}\n\nAnd this.`;

    expect(parseSharedLocations(text)).toEqual({ text, locations: [] });
  });

  it("rejects out-of-range coordinates and negative accuracy without consuming the block", () => {
    const serialized = serializeSharedLocation(location);
    for (const block of [
      serialized.replace("Coordinates: 37.7793, -122.4192", "Coordinates: 91, -122.4192"),
      serialized.replace("Accuracy: ±12.5m", "Accuracy: ±-1m"),
    ]) {
      expect(parseSharedLocations(block)).toEqual({ text: block, locations: [] });
    }
  });

  it("builds platform map links from coordinates and an encoded place name", () => {
    expect(sharedLocationMapsUrl(location, "ios")).toBe(
      "https://maps.apple.com/?ll=37.7793,-122.4192&q=Main%20Library",
    );
    expect(sharedLocationMapsUrl({ ...location, name: "Main & 1st" }, "android")).toBe(
      "geo:37.7793,-122.4192?q=37.7793,-122.4192(Main%20%26%201st)",
    );
  });
});
