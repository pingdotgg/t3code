import { describe, expect, it } from "vite-plus/test";

import {
  decodeThirdPartyLicenseManifest,
  filterThirdPartyLicenseEntries,
  findThirdPartyLicenseEntry,
  formatLicenseBundles,
  thirdPartyLicenseEntryKey,
  type ThirdPartyLicenseEntry,
} from "./thirdPartyLicenses.js";

const ENTRIES: ReadonlyArray<ThirdPartyLicenseEntry> = [
  {
    bundles: ["web"],
    kind: "package",
    license: "MIT",
    name: "react",
    noticeText: "React license",
    sourceUrl: "https://react.dev",
    version: "19.2.6",
  },
  {
    bundles: ["assets", "mobile"],
    kind: "custom",
    license: "CC-BY-4.0",
    name: "sample-icons",
    noticeText: "Icon notice",
    sourceUrl: null,
    version: null,
  },
];

describe("third-party license manifests", () => {
  it("decodes the generated manifest shape", () => {
    expect(decodeThirdPartyLicenseManifest({ schemaVersion: 1, entries: ENTRIES })).toEqual({
      schemaVersion: 1,
      entries: ENTRIES,
    });
  });

  it("rejects unsupported manifest versions", () => {
    expect(() => decodeThirdPartyLicenseManifest({ schemaVersion: 2, entries: [] })).toThrow(
      "unsupported format",
    );
  });

  it("rejects unsafe source links", () => {
    expect(() =>
      decodeThirdPartyLicenseManifest({
        schemaVersion: 1,
        entries: [{ ...ENTRIES[0]!, sourceUrl: "javascript:alert(1)" }],
      }),
    ).toThrow("invalid shape");
  });

  it("rejects duplicate navigation keys", () => {
    expect(() =>
      decodeThirdPartyLicenseManifest({ schemaVersion: 1, entries: [ENTRIES[0]!, ENTRIES[0]!] }),
    ).toThrow("duplicate entry");
  });

  it("filters by package, license, version, and bundle", () => {
    expect(filterThirdPartyLicenseEntries(ENTRIES, "react 19.2")).toEqual([ENTRIES[0]]);
    expect(filterThirdPartyLicenseEntries(ENTRIES, "cc-by mobile")).toEqual([ENTRIES[1]]);
    expect(filterThirdPartyLicenseEntries(ENTRIES, "apache")).toEqual([]);
  });

  it("formats platform bundle names for display", () => {
    expect(
      formatLicenseBundles(["android", "assets", "ios", "mobile", "plugin", "constructor"]),
    ).toBe("Android, Assets, iOS, Mobile, plugin, constructor");
  });

  it("finds an entry by its stable navigation key", () => {
    const entry = ENTRIES[0]!;
    expect(findThirdPartyLicenseEntry(ENTRIES, thirdPartyLicenseEntryKey(entry))).toBe(entry);
  });

  it("uses path-safe navigation keys for scoped packages", () => {
    expect(thirdPartyLicenseEntryKey({ ...ENTRIES[0]!, name: "@scope/package" })).not.toContain(
      "/",
    );
  });

  it("uses distinct navigation keys when names and versions contain delimiters", () => {
    const first = thirdPartyLicenseEntryKey({ ...ENTRIES[0]!, name: "a:1", version: null });
    const second = thirdPartyLicenseEntryKey({ ...ENTRIES[0]!, name: "a", version: "1:custom" });

    expect(first).not.toBe(second);
  });
});
