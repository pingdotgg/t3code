import { describe, expect, it } from "vite-plus/test";

import { formatStartupCrashReport, parseStartupCrashRecords } from "./crash-log-model";

// Verbatim shape of the entry expo-updates wrote for the build 56 launch crash.
const BUNDLE =
  "/Users/expo/workingdir/build/apps/mobile/ios/build/Build/Intermediates.noindex/ArchiveIntermediates/T3Code/BuildProductsPath/Release-iphoneos/main.jsbundle";
const FATAL = {
  timestamp: 1789277752000,
  level: "error",
  code: "JSRuntimeError",
  message: [
    "ErrorRecovery fatal exception: Fatal error: Time: 1789277752033.127930",
    "Domain: RCTErrorDomain",
    "Code: 0",
    "Description: Unhandled JS Exception: TypeError: Cannot read property 'defaultModelSelection' of null",
    "",
    "This error is located at:",
    `    at NewTaskFlowProvider (${BUNDLE}:590585:51)`,
    `    at NavigationProvider (${BUNDLE}:139067:3)`,
    "    at RNSSafeAreaView (<anonymous>)",
  ].join("\n"),
};

describe("parseStartupCrashRecords", () => {
  it("extracts the JS error and a compact component stack from a fatal entry", () => {
    const [record] = parseStartupCrashRecords([FATAL]);
    expect(record?.description).toBe(
      "TypeError: Cannot read property 'defaultModelSelection' of null",
    );
    expect(record?.frames).toEqual([
      "NewTaskFlowProvider (main.jsbundle:590585:51)",
      "NavigationProvider (main.jsbundle:139067:3)",
      "RNSSafeAreaView",
    ]);
    expect(record?.detail).toContain("Domain: RCTErrorDomain");
  });

  it("ignores update-check noise and orders crashes newest first", () => {
    const records = parseStartupCrashRecords([
      { timestamp: 1, level: "info", code: "NoUpdatesAvailable", message: "checked" },
      { ...FATAL, timestamp: 10 },
      { timestamp: 5, level: "error", code: "UpdateFailedToLoad", message: "nope" },
      { ...FATAL, timestamp: 20 },
    ]);
    expect(records.map((record) => record.timestamp)).toEqual([20, 10]);
  });

  it("skips a runtime error entry without a description line", () => {
    expect(
      parseStartupCrashRecords([
        { ...FATAL, message: "ErrorRecovery fatal exception: Fatal exception: Name: x" },
      ]),
    ).toEqual([]);
  });
});

describe("formatStartupCrashReport", () => {
  it("writes the app version and each crash's full detail", () => {
    const report = formatStartupCrashReport(parseStartupCrashRecords([FATAL]), {
      version: "1.1.1",
      build: "56",
    });
    expect(report.startsWith("T3 Code 1.1.1 (56)\n")).toBe(true);
    expect(report).toContain("2026-09-13T05:35:52.000Z");
    expect(report).toContain("at NewTaskFlowProvider");
  });

  it("says so when nothing was recorded", () => {
    expect(formatStartupCrashReport([], { version: "1.1.1", build: "56" })).toBe(
      "T3 Code 1.1.1 (56)\nNo startup crashes recorded.",
    );
  });
});
