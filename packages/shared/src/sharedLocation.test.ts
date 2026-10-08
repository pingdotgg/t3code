import { ComposerContextId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendSharedLocations,
  locationContextRecord,
  parseSharedLocations,
  serializeSharedLocation,
  sharedLocationMapsUrl,
} from "./sharedLocation.ts";

const location = {
  name: "Central Library",
  address: "100 Main Street, New York, NY",
  latitude: 40.7128,
  longitude: -74.006,
  accuracy: 12,
} as const;

describe("shared location codec", () => {
  it("keeps the seven-line legacy block shape and parses its stable offset id", () => {
    const block = serializeSharedLocation(location);
    expect(block.split("\n")).toHaveLength(7);
    const source = `Before\n\n${block}\n\nAfter`;
    const parsed = parseSharedLocations(source);
    expect(parsed.text).toBe("Before\n\nAfter");
    expect(parsed.locations).toEqual([
      { ...location, id: `shared-location:${source.indexOf("<shared-location>")}` },
    ]);
  });

  it("round-trips a valid capture timestamp as an extra line", () => {
    const timestamped = { ...location, capturedAt: "2026-10-07T12:34:56.000Z" };
    const block = serializeSharedLocation(timestamped);
    expect(block.split("\n")).toHaveLength(8);
    expect(block).toContain("Captured at: 2026-10-07T12:34:56.000Z");
    expect(parseSharedLocations(block).locations[0]).toMatchObject(timestamped);
  });

  it("rejects an invalid capture time and leaves malformed blocks untouched", () => {
    expect(() => serializeSharedLocation({ ...location, capturedAt: "not a timestamp" })).toThrow(
      "Invalid shared location",
    );

    const malformed = "<shared-location>\nCoordinates: nowhere\n</shared-location>";
    expect(parseSharedLocations(malformed)).toEqual({ text: malformed, locations: [] });
  });

  it("appends blocks without changing existing prose or empty inputs", () => {
    const block = serializeSharedLocation(location);
    expect(appendSharedLocations("hello", [location])).toBe(`hello\n\n${block}`);
    expect(appendSharedLocations("hello\n", [location])).toBe(`hello\n\n${block}`);
    expect(appendSharedLocations("hello", [])).toBe("hello");
  });

  it("builds platform map links from coordinates and keeps supplied names as labels", () => {
    expect(sharedLocationMapsUrl(location, "ios")).toContain("ll=40.7128,-74.006");
    expect(sharedLocationMapsUrl(location, "ios")).toContain("q=Central%20Library");
    expect(sharedLocationMapsUrl(location, "android")).toMatch(/^geo:40\.7128,-74\.006\?/u);
    expect(sharedLocationMapsUrl(location, "web")).toContain("query=40.7128%2C-74.006");
  });

  it("creates typed context records with the original place and address", () => {
    expect(locationContextRecord(location, ComposerContextId.make("legacy_location_1"))).toEqual({
      version: 1,
      contextId: "legacy_location_1",
      label: "Central Library",
      kind: "location",
      payload: location,
    });
  });
});
