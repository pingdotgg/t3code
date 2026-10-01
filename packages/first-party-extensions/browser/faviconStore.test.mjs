import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  FAVICON_CACHE_MAX_ENTRIES,
  FAVICON_REF_MAX_ENTRIES,
  dropCapturedFavicon,
  emptyFaviconCache,
  expireStaleFaviconFailure,
  FAVICON_FAILURE_TTL_MS,
  applyResolvedFaviconRefs,
  panelTabIndicators,
  pendingFaviconRefs,
  recordCapturedFavicon,
  recordResolvedFaviconRef,
  faviconFallbackGlyph,
  faviconOriginKey,
  recordProviderFaviconFailure,
  resolveFavicon,
} from "./faviconStore.ts";

NodeTest.describe("faviconOriginKey", () => {
  NodeTest.it("folds loopback spellings onto localhost, keeping the port", () => {
    NodeAssert.equal(faviconOriginKey("http://127.0.0.1:3000/admin"), "http://localhost:3000");
    NodeAssert.equal(faviconOriginKey("http://[::1]:3000/"), "http://localhost:3000");
    NodeAssert.equal(faviconOriginKey("http://LOCALHOST:3000"), "http://localhost:3000");
    NodeAssert.equal(faviconOriginKey("http://0.0.0.0:8080"), "http://localhost:8080");
  });

  NodeTest.it("keeps public hosts and makes default ports explicit", () => {
    NodeAssert.equal(faviconOriginKey("https://Example.com/path?q=1"), "https://example.com:443");
    NodeAssert.equal(faviconOriginKey("http://example.com"), "http://example.com:80");
    NodeAssert.equal(faviconOriginKey("https://example.com:8443"), "https://example.com:8443");
  });

  NodeTest.it("separates origins by port", () => {
    NodeAssert.notEqual(
      faviconOriginKey("http://localhost:3000"),
      faviconOriginKey("http://localhost:5173"),
    );
  });

  NodeTest.it("rejects non-http(s), unparseable, and oversized urls", () => {
    NodeAssert.equal(faviconOriginKey("ftp://example.com"), null);
    NodeAssert.equal(faviconOriginKey("not a url"), null);
    NodeAssert.equal(faviconOriginKey(""), null);
    NodeAssert.equal(faviconOriginKey(`https://example.com/${"a".repeat(4100)}`), null);
  });
});

NodeTest.describe("recordProviderFaviconFailure", () => {
  NodeTest.it("records one entry per origin, sharing loopback spellings", () => {
    let cache = emptyFaviconCache();
    cache = recordProviderFaviconFailure(cache, "http://127.0.0.1:3000/a", 1_000);
    cache = recordProviderFaviconFailure(cache, "http://localhost:3000/b", 2_000);
    NodeAssert.deepEqual(cache.byOrigin, { "http://localhost:3000": { providerFailedAt: 2_000 } });
  });

  NodeTest.it("keeps the newest failure timestamp and no-ops otherwise", () => {
    let cache = recordProviderFaviconFailure(emptyFaviconCache(), "https://example.com/", 2_000);
    const sameRef = recordProviderFaviconFailure(cache, "https://example.com/other", 2_000);
    NodeAssert.equal(sameRef, cache);
    const older = recordProviderFaviconFailure(cache, "https://example.com/other", 1_000);
    NodeAssert.equal(older, cache);
    cache = recordProviderFaviconFailure(cache, "https://example.com/other", 3_000);
    NodeAssert.deepEqual(cache.byOrigin, {
      "https://example.com:443": { providerFailedAt: 3_000 },
    });
  });

  NodeTest.it("drops the oldest-recorded origins past the cap", () => {
    let cache = emptyFaviconCache();
    for (let port = 1; port <= FAVICON_CACHE_MAX_ENTRIES + 1; port++) {
      cache = recordProviderFaviconFailure(cache, `http://localhost:${port}`, port);
    }
    NodeAssert.equal(Object.keys(cache.byOrigin).length, FAVICON_CACHE_MAX_ENTRIES);
    NodeAssert.equal(cache.byOrigin["http://localhost:1"], undefined);
    NodeAssert.deepEqual(cache.byOrigin["http://localhost:2"], { providerFailedAt: 2 });
  });

  NodeTest.it("ignores urls without an origin key", () => {
    const cache = emptyFaviconCache();
    NodeAssert.equal(recordProviderFaviconFailure(cache, "file:///tmp/x", 1_000), cache);
  });
});

NodeTest.describe("expireStaleFaviconFailure", () => {
  NodeTest.it("retries an origin only once its failure is older than the TTL", () => {
    let cache = recordProviderFaviconFailure(emptyFaviconCache(), "https://example.com/", 1_000);
    cache = recordProviderFaviconFailure(cache, "https://example.org/", 1_000);
    const stale = 1_000 + FAVICON_FAILURE_TTL_MS;
    NodeAssert.equal(expireStaleFaviconFailure(cache, "https://example.com/a", stale - 1), cache);
    const expired = expireStaleFaviconFailure(cache, "https://example.com/a", stale);
    NodeAssert.deepEqual(resolveFavicon(expired, "https://example.com/"), {
      kind: "image",
      src: "https://www.google.com/s2/favicons?domain=example.com&sz=32",
      tier: "provider",
    });
    // Another origin's failure waits for its own surface to mount or navigate.
    NodeAssert.deepEqual(resolveFavicon(expired, "https://example.org/"), { kind: "glyph" });
  });

  NodeTest.it("returns the same cache for unknown origins and non-urls", () => {
    const cache = recordProviderFaviconFailure(emptyFaviconCache(), "https://example.com/", 1_000);
    const late = 10 * FAVICON_FAILURE_TTL_MS;
    NodeAssert.equal(expireStaleFaviconFailure(cache, "https://example.org/", late), cache);
    NodeAssert.equal(expireStaleFaviconFailure(cache, "not a url", late), cache);
    NodeAssert.equal(expireStaleFaviconFailure(cache, null, late), cache);
  });
});

NodeTest.describe("resolveFavicon", () => {
  NodeTest.it("resolves public https origins to the provider image", () => {
    const resolution = resolveFavicon(emptyFaviconCache(), "https://example.com/some/page");
    NodeAssert.deepEqual(resolution, {
      kind: "image",
      src: "https://www.google.com/s2/favicons?domain=example.com&sz=32",
      tier: "provider",
    });
  });

  NodeTest.it("prefers the captured favicon over the provider, loopback included", () => {
    const icon = "data:image/png;base64,AAAA";
    let cache = recordCapturedFavicon(
      emptyFaviconCache(),
      "http://127.0.0.1:5173/app",
      { ref: "r1", src: icon },
      1_000,
    );
    NodeAssert.deepEqual(resolveFavicon(cache, "http://localhost:5173/other"), {
      kind: "image",
      src: icon,
      tier: "captured",
      ref: "r1",
    });
    // A failed provider image does not hide a capture for the same origin.
    cache = recordProviderFaviconFailure(cache, "https://example.com/", 1_000);
    cache = recordCapturedFavicon(cache, "https://example.com/", { ref: "r2", src: icon }, 2_000);
    NodeAssert.equal(resolveFavicon(cache, "https://example.com/").tier, "captured");
  });

  NodeTest.it("falls back to the provider tier once a capture is dropped", () => {
    const icon = "data:image/png;base64,AAAA";
    const captured = recordCapturedFavicon(
      emptyFaviconCache(),
      "https://example.com/",
      { ref: "r1", src: icon },
      1_000,
    );
    NodeAssert.equal(
      recordCapturedFavicon(captured, "https://example.com/x", { ref: "r1", src: icon }, 2_000),
      captured,
    );
    const dropped = dropCapturedFavicon(captured, "https://example.com/");
    NodeAssert.equal(resolveFavicon(dropped, "https://example.com/").tier, "provider");
    NodeAssert.equal(dropCapturedFavicon(dropped, "https://example.com/"), dropped);
  });

  NodeTest.it("refuses non-image captures and caps captured origins", () => {
    const refused = recordCapturedFavicon(
      emptyFaviconCache(),
      "https://example.com/",
      { ref: "r1", src: "https://evil.example/icon.png" },
      1,
    );
    NodeAssert.deepEqual(refused.captured, {});
    let cache = emptyFaviconCache();
    for (let port = 1; port <= FAVICON_CACHE_MAX_ENTRIES + 1; port += 1)
      cache = recordCapturedFavicon(
        cache,
        `http://localhost:${port}/`,
        { ref: `r${port}`, src: "data:image/png;base64,AAAA" },
        port,
      );
    NodeAssert.equal(Object.keys(cache.captured).length, FAVICON_CACHE_MAX_ENTRIES);
    NodeAssert.equal(cache.captured["http://localhost:1"], undefined);
  });

  NodeTest.it("renders the glyph for private and loopback origins", () => {
    for (const url of ["http://localhost:3000/", "http://127.0.0.1:5173/", "http://192.168.1.4/"]) {
      NodeAssert.deepEqual(resolveFavicon(emptyFaviconCache(), url), { kind: "glyph" });
    }
  });

  NodeTest.it("renders the glyph once the provider image failed, and for null urls", () => {
    const failed = recordProviderFaviconFailure(emptyFaviconCache(), "https://example.com/", 1_000);
    NodeAssert.deepEqual(resolveFavicon(failed, "https://example.com/other/page"), {
      kind: "glyph",
    });
    NodeAssert.deepEqual(resolveFavicon(emptyFaviconCache(), null), { kind: "glyph" });
    NodeAssert.deepEqual(resolveFavicon(emptyFaviconCache(), "ftp://example.com/"), {
      kind: "glyph",
    });
  });
});

NodeTest.describe("faviconFallbackGlyph", () => {
  NodeTest.it("derives the host's first letter, uppercased", () => {
    NodeAssert.equal(faviconFallbackGlyph("https://example.com/"), "E");
    NodeAssert.equal(faviconFallbackGlyph("http://localhost:3000/app"), "L");
    NodeAssert.equal(faviconFallbackGlyph("http://192.168.1.4:8080/"), "1");
  });

  NodeTest.it("falls back to a neutral dot without a usable host letter", () => {
    NodeAssert.equal(faviconFallbackGlyph(null), "•");
    NodeAssert.equal(faviconFallbackGlyph("::::"), "•");
  });
});

const session = (overrides = {}) => ({
  tabId: "tab-1",
  requestedUrl: "http://localhost:5173/",
  navigation: { kind: "loaded", url: "http://localhost:5173/", title: "Dev" },
  canGoBack: false,
  canGoForward: false,
  viewport: { _tag: "fill" },
  engine: { state: "ready", generation: "1" },
  zoomFactor: 1,
  appearance: "system",
  audioMuted: false,
  audible: false,
  ...overrides,
});

NodeTest.describe("pendingFaviconRefs", () => {
  NodeTest.it("asks once per unresolved ref and skips resolved or captured ones", () => {
    const sessions = [
      session({ faviconRef: "r1" }),
      session({ tabId: "tab-2", faviconRef: "r1" }),
      session({
        tabId: "tab-3",
        faviconRef: "r2",
        navigation: { kind: "loaded", url: "https://example.com/", title: "" },
      }),
      session({ tabId: "tab-4" }),
    ];
    NodeAssert.deepEqual(pendingFaviconRefs(emptyFaviconCache(), sessions), ["r1", "r2"]);
    const resolved = recordResolvedFaviconRef(emptyFaviconCache(), "r1", null, 1);
    NodeAssert.deepEqual(pendingFaviconRefs(resolved, sessions), ["r2"]);
    const captured = recordCapturedFavicon(
      emptyFaviconCache(),
      "https://example.com/",
      { ref: "r2", src: "data:image/png;base64,AAAA" },
      1,
    );
    NodeAssert.deepEqual(pendingFaviconRefs(captured, [sessions[2]]), []);
  });
});

NodeTest.describe("applyResolvedFaviconRefs", () => {
  const icon = "data:image/png;base64,AAAA";
  const app = session({ faviconRef: "shared" });
  const docs = session({
    tabId: "tab-2",
    faviconRef: "shared",
    navigation: { kind: "loaded", url: "http://localhost:3000/docs", title: "" },
  });

  NodeTest.it("gives one read of a shared ref to every origin carrying it", () => {
    const cache = applyResolvedFaviconRefs(
      recordResolvedFaviconRef(emptyFaviconCache(), "shared", icon, 1),
      [app, docs],
      2,
    );
    NodeAssert.equal(resolveFavicon(cache, "http://localhost:5173/").tier, "captured");
    NodeAssert.equal(resolveFavicon(cache, "http://localhost:3000/").tier, "captured");
    NodeAssert.equal(applyResolvedFaviconRefs(cache, [app, docs], 3), cache);
  });

  NodeTest.it("reaches a view whose session arrives after the read, with no second read", () => {
    let cache = recordResolvedFaviconRef(emptyFaviconCache(), "shared", icon, 1);
    cache = applyResolvedFaviconRefs(cache, [app], 2);
    NodeAssert.deepEqual(pendingFaviconRefs(cache, [app, docs]), []);
    cache = applyResolvedFaviconRefs(cache, [docs], 3);
    NodeAssert.equal(resolveFavicon(cache, "http://localhost:3000/").tier, "captured");
  });

  NodeTest.it("keeps refused refs and broken images off every origin", () => {
    const refused = recordResolvedFaviconRef(emptyFaviconCache(), "shared", null, 1);
    NodeAssert.equal(applyResolvedFaviconRefs(refused, [app, docs], 2), refused);
    const notImage = recordResolvedFaviconRef(emptyFaviconCache(), "shared", "https://x/i.png", 1);
    NodeAssert.equal(notImage.resolved.shared.src, null);

    const shown = applyResolvedFaviconRefs(
      recordResolvedFaviconRef(emptyFaviconCache(), "shared", icon, 1),
      [app, docs],
      2,
    );
    const dropped = dropCapturedFavicon(shown, "http://localhost:5173/");
    NodeAssert.equal(dropped.resolved.shared.src, null);
    NodeAssert.equal(applyResolvedFaviconRefs(dropped, [app], 3), dropped);
    NodeAssert.deepEqual(pendingFaviconRefs(dropped, [app]), []);
  });

  NodeTest.it("keeps ref results bounded", () => {
    let cache = emptyFaviconCache();
    for (let index = 0; index <= FAVICON_REF_MAX_ENTRIES; index += 1)
      cache = recordResolvedFaviconRef(cache, `r${index}`, icon, index);
    NodeAssert.equal(Object.keys(cache.resolved).length, FAVICON_REF_MAX_ENTRIES);
    NodeAssert.equal(cache.resolved.r0, undefined);
  });

  const other = "data:image/png;base64,BBBB";
  const routeA = session({
    faviconRef: "a",
    navigation: { kind: "loaded", url: "http://localhost:3000/a", title: "" },
  });
  const routeB = session({
    tabId: "tab-2",
    faviconRef: "b",
    navigation: { kind: "loaded", url: "http://localhost:3000/b", title: "" },
  });
  const bothResolved = recordResolvedFaviconRef(
    recordResolvedFaviconRef(emptyFaviconCache(), "a", icon, 1),
    "b",
    other,
    2,
  );

  NodeTest.it("settles two same-origin tabs with different refs: repeats change nothing", () => {
    const first = applyResolvedFaviconRefs(bothResolved, [routeA, routeB], 3);
    NodeAssert.notEqual(first, bothResolved);
    // The view's apply effect keys on `resolved`; applying must not touch it.
    NodeAssert.equal(first.resolved, bothResolved.resolved);
    let cache = first;
    let updates = 0;
    for (let pass = 0; pass < 20; pass += 1) {
      const next = applyResolvedFaviconRefs(cache, [routeA, routeB], 4 + pass);
      if (next !== cache) updates += 1;
      cache = next;
    }
    NodeAssert.equal(updates, 0);
    // Either order of the same tabs keeps the settled winner.
    NodeAssert.equal(applyResolvedFaviconRefs(cache, [routeB, routeA], 30), cache);
  });

  NodeTest.it("renders each same-origin tab with its own icon", () => {
    const cache = applyResolvedFaviconRefs(bothResolved, [routeA, routeB], 3);
    NodeAssert.equal(resolveFavicon(cache, "http://localhost:3000/a", "a").src, icon);
    NodeAssert.equal(resolveFavicon(cache, "http://localhost:3000/b", "b").src, other);
    // A URL-only surface (recents) gets the origin's one remembered capture.
    NodeAssert.equal(resolveFavicon(cache, "http://localhost:3000/").tier, "captured");
    // A broken tab icon falls back without taking the other tab's icon down.
    const broken = dropCapturedFavicon(cache, "http://localhost:3000/a", "a");
    NodeAssert.equal(broken.resolved.a.src, null);
    NodeAssert.equal(resolveFavicon(broken, "http://localhost:3000/b", "b").src, other);
    NodeAssert.equal(dropCapturedFavicon(broken, "http://localhost:3000/a", "a"), broken);
  });

  NodeTest.it("names the displayed fallback ref, so its failure clears that capture", () => {
    // Tab `b` captured the origin; the tab navigated to ref `a`, whose read failed.
    let cache = recordResolvedFaviconRef(emptyFaviconCache(), "b", other, 1);
    cache = applyResolvedFaviconRefs(cache, [routeB], 2);
    cache = recordResolvedFaviconRef(cache, "a", null, 3);
    const shown = resolveFavicon(cache, "http://localhost:3000/a", "a");
    NodeAssert.deepEqual(shown, { kind: "image", src: other, tier: "captured", ref: "b" });
    // The rendered image failing must invalidate `b`, not the requested `a`.
    const broken = dropCapturedFavicon(cache, "http://localhost:3000/a", shown.ref);
    NodeAssert.equal(broken.resolved.b.src, null);
    NodeAssert.deepEqual(resolveFavicon(broken, "http://localhost:3000/a", "a"), { kind: "glyph" });
  });

  NodeTest.it("never evicts an origin live tabs show, so over-cap tabs still settle", () => {
    let cache = emptyFaviconCache();
    const tabs = [];
    for (let index = 0; index <= FAVICON_CACHE_MAX_ENTRIES + 5; index += 1) {
      cache = recordResolvedFaviconRef(cache, `r${index}`, icon, index);
      tabs.push(
        session({
          tabId: `tab-${index}`,
          faviconRef: `r${index}`,
          navigation: { kind: "loaded", url: `http://localhost:${4000 + index}/`, title: "" },
        }),
      );
    }
    cache = applyResolvedFaviconRefs(cache, tabs, 100);
    NodeAssert.equal(Object.keys(cache.captured).length, tabs.length);
    NodeAssert.equal(applyResolvedFaviconRefs(cache, tabs, 101), cache);
  });
});

NodeTest.describe("panelTabIndicators", () => {
  NodeTest.it("shows the presented page, its captured icon, and audio across sessions", () => {
    const icon = "data:image/png;base64,AAAA";
    const cache = recordCapturedFavicon(
      emptyFaviconCache(),
      "http://localhost:5173/",
      { ref: "r1", src: icon },
      1,
    );
    const presented = session();
    NodeAssert.deepEqual(
      panelTabIndicators(cache, presented, [
        presented,
        session({ tabId: "tab-2", audible: true, audioMuted: true }),
      ]),
      { pageUrl: "http://localhost:5173/", faviconDataUrl: icon, audio: "muted" },
    );
    NodeAssert.deepEqual(
      panelTabIndicators(emptyFaviconCache(), presented, [
        session({ audible: true, audioMuted: true }),
        session({ tabId: "tab-2", audible: true }),
      ]),
      { pageUrl: "http://localhost:5173/", audio: "audible" },
    );
  });

  NodeTest.it("is null with no presented page and no audio", () => {
    NodeAssert.equal(panelTabIndicators(emptyFaviconCache(), null, [session()]), null);
    NodeAssert.equal(
      panelTabIndicators(
        emptyFaviconCache(),
        session({ requestedUrl: null, navigation: { kind: "idle", url: null, title: "" } }),
        [],
      ),
      null,
    );
  });
});
