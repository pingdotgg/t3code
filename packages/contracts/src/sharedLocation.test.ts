import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ComposerContextRecord } from "./composerContext.ts";
import { SharedLocation } from "./sharedLocation.ts";

const isSharedLocation = Schema.is(SharedLocation);
const base = {
  name: "Somewhere",
  address: "123 Example Street",
  latitude: 0,
  longitude: 0,
  accuracy: null,
};

describe("SharedLocation", () => {
  it("accepts coordinate boundaries and optional nullable capture time", () => {
    expect(isSharedLocation({ ...base, latitude: -90, longitude: -180 })).toBe(true);
    expect(isSharedLocation({ ...base, latitude: 90, longitude: 180, capturedAt: null })).toBe(
      true,
    );
    expect(isSharedLocation({ ...base, capturedAt: "2026-10-07T12:00:00.000Z" })).toBe(true);
  });

  it("rejects out-of-range or non-finite coordinates and accuracy", () => {
    for (const value of [
      { ...base, latitude: -90.001 },
      { ...base, latitude: 90.001 },
      { ...base, longitude: -180.001 },
      { ...base, longitude: 180.001 },
      { ...base, latitude: Number.NaN },
      { ...base, longitude: Number.POSITIVE_INFINITY },
      { ...base, accuracy: -0.1 },
      { ...base, accuracy: Number.POSITIVE_INFINITY },
    ]) {
      expect(isSharedLocation(value)).toBe(false);
    }
  });

  it("bounds place and address fields and requires single-line text", () => {
    expect(isSharedLocation({ ...base, name: "" })).toBe(false);
    expect(isSharedLocation({ ...base, address: "" })).toBe(false);
    expect(isSharedLocation({ ...base, address: "  " })).toBe(false);
    expect(isSharedLocation({ ...base, capturedAt: "invalid" })).toBe(false);
    expect(isSharedLocation({ ...base, name: "A\nB" })).toBe(false);
    expect(isSharedLocation({ ...base, address: `a${"b".repeat(2_048)}` })).toBe(false);
    expect(isSharedLocation({ ...base, name: "a".repeat(256) })).toBe(false);
    expect(isSharedLocation({ ...base, name: "A\u2028B" })).toBe(false);
  });

  it("keeps nested location data intact in a forward-compatible unknown payload", () => {
    const decoded = Schema.decodeOption(ComposerContextRecord)({
      version: 1,
      contextId: "ctx_future",
      label: "Future location",
      kind: "location-v2",
      payload: { ...base, source: "device", vendorField: { precision: "balanced" } },
    });
    expect(Option.getOrThrow(decoded)).toEqual({
      version: 1,
      contextId: "ctx_future",
      label: "Future location",
      kind: "location-v2",
      payload: { ...base, source: "device", vendorField: { precision: "balanced" } },
    });
  });
});
