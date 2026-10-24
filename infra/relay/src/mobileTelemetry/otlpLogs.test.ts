import { describe, expect, it } from "@effect/vitest";

import {
  applySymbolication,
  collectJsExceptions,
  bundleSourceMapKey,
  type BundleIdentity,
} from "./otlpLogs.ts";
import { decodeSourceMap } from "./sourceMap.ts";

const UPDATE_ID = "0198e8a4-1111-7000-8000-000000000001";
const BUILD_ID = "0198e8a4-2222-7000-8000-000000000002";

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });

const logsPayload = (
  resource: ReadonlyArray<ReturnType<typeof str>>,
  records: ReadonlyArray<ReadonlyArray<unknown>>,
) => ({
  resourceLogs: [
    {
      resource: { attributes: resource },
      scopeLogs: [
        {
          scope: { name: "expo-observe" },
          logRecords: records.map((attributes) => ({ severityNumber: 17, attributes })),
        },
      ],
    },
  ],
});

const attributeValue = (attributes: ReadonlyArray<unknown>, key: string) =>
  (attributes as ReadonlyArray<{ key: string; value: { stringValue?: string } }>).find(
    (attribute) => attribute.key === key,
  )?.value.stringValue;

describe("bundleSourceMapKey", () => {
  it("uses the update's map for an OTA launch, even when the build is known", () => {
    expect(
      bundleSourceMapKey({ platform: "android", updateId: UPDATE_ID, easBuildId: BUILD_ID }),
    ).toBe(`android/ota/${UPDATE_ID}.map`);
  });

  it("uses the build's map for an embedded launch", () => {
    expect(bundleSourceMapKey({ platform: "ios", updateId: undefined, easBuildId: BUILD_ID })).toBe(
      `ios/build/${BUILD_ID}.map`,
    );
  });

  it("names no map for ids that are not plain identifiers", () => {
    const identity: BundleIdentity = {
      platform: "ios",
      updateId: "../build/other",
      easBuildId: BUILD_ID,
    };
    expect(bundleSourceMapKey(identity)).toBeUndefined();
  });
});

describe("collectJsExceptions", () => {
  it("finds JavaScript exceptions with their bundle, skipping native crashes", () => {
    const payload = logsPayload(
      [
        str("os.type", "darwin"),
        str("expo.app.updates.id", UPDATE_ID),
        str("expo.eas_build.id", BUILD_ID),
      ],
      [
        [str("expo.error.source", "global"), str("exception.stacktrace", "js stack")],
        [str("expo.error.source", "nativeCrash"), str("exception.stacktrace", "native stack")],
        [str("event.name", "app.log")],
        [str("expo.error.source", "reportedByUser"), { key: "exception.stacktrace", value: {} }],
      ],
    );
    const exceptions = collectJsExceptions(payload);
    expect(exceptions.map(({ identity, stack }) => ({ identity, stack }))).toEqual([
      {
        identity: { platform: "ios", updateId: UPDATE_ID, easBuildId: BUILD_ID },
        stack: "js stack",
      },
    ]);
  });

  it("ignores resources of an unknown platform and malformed payloads", () => {
    const payload = logsPayload(
      [str("os.type", "windows")],
      [[str("exception.stacktrace", "stack")]],
    );
    expect(collectJsExceptions(payload)).toEqual([]);
    expect(collectJsExceptions(undefined)).toEqual([]);
    expect(collectJsExceptions({ resourceLogs: "nope" })).toEqual([]);
  });
});

describe("applySymbolication", () => {
  const map = decodeSourceMap({ version: 3, sources: ["src/App.tsx"], mappings: "AAAA,UAAE" })!;
  const exceptionWith = (stack: string) =>
    collectJsExceptions(
      logsPayload(
        [str("os.type", "linux"), str("expo.app.update_id", UPDATE_ID)],
        [[str("exception.stacktrace", stack)]],
      ),
    )[0]!;

  it("replaces the stack and keeps the original", () => {
    const stack = "Error: x\n    at render (address at index.android.bundle:1:12)";
    const exception = exceptionWith(stack);
    expect(applySymbolication(exception, { key: "android/ota/x.map", map }, Infinity)).toEqual({
      status: "symbolicated",
      mappedFrames: 1,
      growth: "src/App.tsx:1:3".length - "address at index.android.bundle:1:12".length,
    });
    expect(attributeValue(exception.attributes, "exception.stacktrace")).toBe(
      "Error: x\n    at render (src/App.tsx:1:3)",
    );
    expect(attributeValue(exception.attributes, "relay.symbolication.raw_stacktrace")).toBe(stack);
    expect(attributeValue(exception.attributes, "relay.symbolication.source_map")).toBe(
      "android/ota/x.map",
    );
  });

  it("records why a stack stayed as it was", () => {
    const missing = exceptionWith("Error\n    at f (address at index.android.bundle:1:12)");
    expect(applySymbolication(missing, undefined, Infinity).status).toBe("source_map_missing");
    expect(attributeValue(missing.attributes, "relay.symbolication.status")).toBe(
      "source_map_missing",
    );

    const native = exceptionWith("Error\n    at f (native)");
    expect(applySymbolication(native, { key: "k", map }, Infinity).status).toBe("no_bundle_frames");
    expect(attributeValue(native.attributes, "exception.stacktrace")).toBe(
      "Error\n    at f (native)",
    );
  });
});
