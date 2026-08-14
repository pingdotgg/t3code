import { describe, expect, it } from "vite-plus/test";

import {
  BROWSER_FAVICON_MAX_ENTRIES,
  type BrowserFaviconEntry,
  evictExcessFavicons,
  faviconKey,
  faviconStorageLocation,
  isStorableFaviconDataUrl,
  migratePersistedBrowserFaviconState,
} from "./browserFaviconLogic";

const PNG = "data:image/png;base64,AAAA";

function entry(capturedAt = 0): BrowserFaviconEntry {
  return { dataUrl: PNG, capturedAt };
}

describe("browser favicon logic", () => {
  it("keys valid origins canonically while keeping distinct scopes separate", () => {
    expect(faviconKey("env:project", "http://myapp.test:3000/admin?x=1", null)).toBe(
      "env:project http://myapp.test:3000",
    );
    expect(faviconKey("env:project", "http://192.168.64.2:3000/", "192.168.64.2")).toBe(
      faviconKey("env:project", "http://localhost:3000/", "192.168.64.2"),
    );
    expect(faviconKey("env:project", "http://127.0.0.1:3000/", null)).toBe(
      faviconKey("env:project", "http://0.0.0.0:3000/", null),
    );
    const keys = [
      faviconKey("env:a", "http://localhost:3000/", null),
      faviconKey("env:b", "http://localhost:3000/", null),
      faviconKey("env:a", "http://localhost:5173/", null),
      faviconKey("env:a", "https://localhost:3000/", null),
      faviconKey("env:a", "http://192.168.1.50:3000/", "192.168.64.2"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(faviconKey("env:a", "not a url", null)).toBeNull();
    expect(faviconKey("env:a", "ftp://example.com/", null)).toBeNull();
    expect(faviconKey("", "http://localhost/", null)).toBeNull();
    expect(faviconKey("env:a", "http://local:3000/", null)).not.toBe(
      faviconKey("env:a", "http://localhost:3000/", null),
    );
  });

  it("retains an exact environment-host alias for offline lookup", () => {
    const expected = {
      aliases: ["192.168.64.2"],
      key: "env:project http://localhost:3000",
    };
    expect(
      faviconStorageLocation("env:project", "http://localhost:3000/app", "192.168.64.2"),
    ).toEqual(expected);
    expect(
      faviconStorageLocation("env:project", "http://192.168.64.2:3000/app", "192.168.64.2"),
    ).toEqual(expected);
    expect(
      faviconStorageLocation("env:project", "https://example.com/app", "192.168.64.2"),
    ).toEqual({ aliases: [], key: "env:project https://example.com:443" });
    expect(faviconStorageLocation("env:project", "http://localhost:3000/app", "fd00::1")).toEqual({
      aliases: ["fd00::1"],
      key: "env:project http://localhost:3000",
    });
    expect(faviconKey("env:project", "http://[2001:4860:4860::8888]/", null)).toBe(
      "env:project http://[2001:4860:4860::8888]:80",
    );
  });

  it("accepts only bounded base64 PNG data", () => {
    expect(isStorableFaviconDataUrl(PNG)).toBe(true);
    expect(isStorableFaviconDataUrl("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isStorableFaviconDataUrl("data:image/png;base64,")).toBe(false);
    expect(isStorableFaviconDataUrl("data:image/png;base64,%%%%")).toBe(false);
    expect(isStorableFaviconDataUrl(`data:image/png;base64,${"A".repeat(8192)}`)).toBe(false);
  });

  it("evicts old entries and sanitizes hydrated state", () => {
    const byKey = Object.fromEntries(
      Array.from({ length: BROWSER_FAVICON_MAX_ENTRIES + 2 }, (_, index) => [
        `key-${index}`,
        entry(index),
      ]),
    );
    const result = evictExcessFavicons(byKey);
    expect(Object.keys(result)).toHaveLength(BROWSER_FAVICON_MAX_ENTRIES);
    expect(result["key-0"]).toBeUndefined();
    expect(result["key-1"]).toBeUndefined();
    expect(
      migratePersistedBrowserFaviconState({
        byKey: {
          "env:project http://local:3000": entry(4),
          "env:project http://localhost:3000": entry(5),
          "env:project http://localhost:3003": {
            ...entry(6),
            aliases: [
              "192.168.64.2",
              "192.168.64.2",
              "192.168.64.3",
              "192.168.64.4",
              "192.168.64.5",
              "192.168.64.6",
              "Not Normalized",
              "not a host/",
              "x".repeat(5_000),
            ],
          },
          "env:project http://localhost:3001": {
            dataUrl: "https://example.com/icon.png",
            capturedAt: 6,
          },
          "env:project http://localhost:3002": { dataUrl: PNG, capturedAt: Number.NaN },
        },
      }),
    ).toEqual({
      byKey: {
        "env:project http://localhost:3000": entry(5),
        "env:project http://localhost:3003": {
          ...entry(6),
          aliases: ["192.168.64.2", "192.168.64.3", "192.168.64.4", "192.168.64.5"],
        },
      },
    });
  });
});
