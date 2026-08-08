import { describe, expect, it } from "vite-plus/test";

import {
  BROWSER_FAVICON_MAX_ENTRIES,
  type BrowserFaviconEntry,
  evictExcessFavicons,
  faviconKey,
  isStorableFaviconDataUrl,
  migratePersistedBrowserFaviconState,
} from "./browserFaviconLogic";

function entry(updatedAt = 0): BrowserFaviconEntry {
  return { dataUrl: "data:image/png;base64,AAAA", updatedAt };
}

describe("faviconKey", () => {
  it("combines project key with the canonical origin", () => {
    expect(faviconKey("proj-a", "http://myapp.test:3000/admin?x=1", null)).toBe(
      "proj-a http://myapp.test:3000",
    );
  });

  it("collapses loopback hosts and the environment host to the same key", () => {
    const viaResolvedHost = faviconKey("proj-a", "http://192.168.64.2:3000/", "192.168.64.2");
    const viaLocalhost = faviconKey("proj-a", "http://localhost:3000/", "192.168.64.2");
    expect(viaResolvedHost).not.toBeNull();
    expect(viaResolvedHost).toBe(viaLocalhost);
  });

  it("collapses loopback even when there is no connected environment", () => {
    const a = faviconKey("proj-a", "http://localhost:3000/", null);
    const b = faviconKey("proj-a", "http://127.0.0.1:3000/", null);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("does not collapse an unrelated remote host or a different LAN device", () => {
    const remote = faviconKey("proj-a", "http://example.com:3000/", "192.168.64.2");
    const otherLan = faviconKey("proj-a", "http://192.168.1.50:3000/", "192.168.64.2");
    const local = faviconKey("proj-a", "http://localhost:3000/", "192.168.64.2");
    expect(remote).not.toBeNull();
    expect(otherLan).not.toBeNull();
    expect(remote).not.toBe(otherLan);
    expect(remote).not.toBe(local);
    expect(otherLan).not.toBe(local);
  });

  it("separates ports, schemes, and projects", () => {
    expect(faviconKey("proj-a", "http://localhost:3000/", null)).not.toBe(
      faviconKey("proj-a", "http://localhost:5173/", null),
    );
    expect(faviconKey("proj-a", "http://myapp.test/", null)).not.toBe(
      faviconKey("proj-a", "https://myapp.test/", null),
    );
    expect(faviconKey("proj-a", "http://localhost:3000/", null)).not.toBe(
      faviconKey("proj-b", "http://localhost:3000/", null),
    );
  });

  it("rejects non-http(s) and unparseable urls", () => {
    expect(faviconKey("proj-a", "ftp://example.com/", null)).toBeNull();
    expect(faviconKey("proj-a", "not a url", null)).toBeNull();
    expect(faviconKey("", "http://localhost:3000/", null)).toBeNull();
  });
});

describe("isStorableFaviconDataUrl", () => {
  it("accepts image data urls within the cap", () => {
    expect(isStorableFaviconDataUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isStorableFaviconDataUrl("data:image/svg+xml;base64,AAAA")).toBe(true);
    expect(isStorableFaviconDataUrl("data:image/x-icon;base64,AAAA")).toBe(true);
  });

  it("rejects non-image data urls, other schemes, and oversized values", () => {
    expect(isStorableFaviconDataUrl("data:text/html;base64,AAAA")).toBe(false);
    expect(isStorableFaviconDataUrl("data:image/svg+xml,<svg></svg>")).toBe(false);
    expect(isStorableFaviconDataUrl("http://example.com/favicon.ico")).toBe(false);
    expect(isStorableFaviconDataUrl(42)).toBe(false);
    expect(isStorableFaviconDataUrl(`data:image/png;base64,${"A".repeat(8192)}`)).toBe(false);
  });

  it("rejects data urls with no payload", () => {
    expect(isStorableFaviconDataUrl("data:image/x-icon;base64,")).toBe(false);
    expect(isStorableFaviconDataUrl("data:image/png;base64,")).toBe(false);
    expect(isStorableFaviconDataUrl("data:image/png;base64,   ")).toBe(false);
    expect(isStorableFaviconDataUrl("data:image/png;base64,%%%%")).toBe(false);
    expect(isStorableFaviconDataUrl("data:image/png;base64,AAA\n")).toBe(false);
    expect(isStorableFaviconDataUrl("data:image/png")).toBe(false);
  });
});

describe("evictExcessFavicons", () => {
  it("keeps the most recently updated entries when over the cap", () => {
    const byKey = Object.fromEntries(
      Array.from({ length: BROWSER_FAVICON_MAX_ENTRIES + 2 }, (_, i) => [`k-${i}`, entry(i)]),
    );
    const next = evictExcessFavicons(byKey);
    expect(Object.keys(next)).toHaveLength(BROWSER_FAVICON_MAX_ENTRIES);
    expect(next["k-0"]).toBeUndefined();
    expect(next["k-1"]).toBeUndefined();
    expect(next[`k-${BROWSER_FAVICON_MAX_ENTRIES + 1}`]).toBeDefined();
  });
});

describe("migratePersistedBrowserFaviconState", () => {
  it("returns empty state for junk payloads", () => {
    expect(migratePersistedBrowserFaviconState(null)).toEqual({ byKey: {} });
    expect(migratePersistedBrowserFaviconState("nope")).toEqual({ byKey: {} });
    expect(migratePersistedBrowserFaviconState({ byKey: 42 })).toEqual({ byKey: {} });
  });

  it("drops entries with invalid data urls or timestamps", () => {
    const migrated = migratePersistedBrowserFaviconState({
      byKey: {
        good: { dataUrl: "data:image/png;base64,AAAA", updatedAt: 10 },
        badScheme: { dataUrl: "http://example.com/i.ico", updatedAt: 10 },
        badTime: { dataUrl: "data:image/png;base64,AAAA", updatedAt: Number.NaN },
        notAnObject: "junk",
      },
    });
    expect(migrated.byKey).toEqual({
      good: { dataUrl: "data:image/png;base64,AAAA", updatedAt: 10 },
    });
  });
});
