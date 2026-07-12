import { describe, expect, it, vi } from "vite-plus/test";
import { AtomRegistry } from "effect/unstable/reactivity";

vi.mock("expo-constants", () => ({ default: { expoConfig: null } }));
vi.mock("react-native", () => ({
  AppState: { addEventListener: vi.fn() },
  Dimensions: { get: () => ({ width: 390, height: 844 }) },
  PixelRatio: { get: () => 3 },
}));

import { ALPINE_WASHES, stableIndex, washColors } from "./alpine-theme";
import { makeMemorySceneryStorage } from "./scenery-storage";
import {
  displayNamesFromState,
  SceneryStore,
  SCENE_NAMES,
  sceneryStateAtom,
} from "./scenery-store";
import type { SceneryPhoto, UnsplashClient } from "./unsplash";
import { extractPlaceName, makeUnsplashClient, sizedImageURL } from "./unsplash";

function photo(id: string, overrides: Partial<SceneryPhoto> = {}): SceneryPhoto {
  return {
    id,
    name: "",
    placeName: null,
    averageColorHex: "#889988",
    heroURL: `https://images.unsplash.com/photo-${id}?ixid=abc&w=1080`,
    thumbURL: `https://images.unsplash.com/photo-${id}?ixid=abc&w=200`,
    rawURL: `https://images.unsplash.com/photo-${id}?ixid=abc`,
    downloadLocationURL: `https://api.unsplash.com/photos/${id}/download?ixid=abc`,
    photographerName: "Test Photographer",
    photographerProfileURL: "https://unsplash.com/@test",
    ...overrides,
  };
}

function makeClient(photos: ReadonlyArray<SceneryPhoto>): UnsplashClient & {
  readonly searches: string[];
  readonly registered: string[];
} {
  const searches: string[] = [];
  const registered: string[] = [];
  return {
    searches,
    registered,
    searchPhotos: async (query, count) => {
      searches.push(query);
      return photos.slice(0, count);
    },
    registerDownload: async (url) => {
      registered.push(url);
    },
  };
}

function makeStore(options: {
  readonly client: UnsplashClient | null;
  readonly storage?: ReturnType<typeof makeMemorySceneryStorage>;
  readonly now?: () => Date;
}) {
  const registry = AtomRegistry.make();
  const storage = options.storage ?? makeMemorySceneryStorage();
  const store = new SceneryStore({
    registry,
    storage,
    client: options.client,
    now: options.now ?? (() => new Date("2026-07-04T12:00:00Z")),
    heroPixelWidth: 2048,
  });
  return { store, registry, storage };
}

describe("stableIndex", () => {
  it("is deterministic and in range", () => {
    for (const seed of ["thread-1", "thread-2", "träd-ü", ""]) {
      const first = stableIndex(seed, ALPINE_WASHES.length);
      expect(first).toBe(stableIndex(seed, ALPINE_WASHES.length));
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(ALPINE_WASHES.length);
    }
  });

  it("spreads distinct seeds across buckets", () => {
    const buckets = new Set(
      Array.from({ length: 50 }, (_, index) => stableIndex(`thread-${index}`, 6)),
    );
    expect(buckets.size).toBeGreaterThan(1);
  });

  it("returns 0 for an empty pool", () => {
    expect(stableIndex("anything", 0)).toBe(0);
  });

  it("washColors always resolves a pair", () => {
    expect(washColors("some-thread")).toHaveLength(2);
  });
});

describe("sizedImageURL", () => {
  it("replaces sizing params and keeps identity params", () => {
    const url = sizedImageURL("https://images.unsplash.com/photo-1?ixid=abc&w=1080&q=60", {
      width: 2048,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("ixid")).toBe("abc");
    expect(parsed.searchParams.get("w")).toBe("2048");
    expect(parsed.searchParams.get("q")).toBe("85");
    expect(parsed.searchParams.get("fm")).toBe("jpg");
    expect(parsed.searchParams.get("fit")).toBe("max");
    expect(parsed.searchParams.get("blur")).toBeNull();
  });

  it("applies CDN pre-blur when requested", () => {
    const url = sizedImageURL("https://images.unsplash.com/photo-1?ixid=abc", {
      width: 800,
      blur: 90,
    });
    expect(new URL(url).searchParams.get("blur")).toBe("90");
  });

  it("applies CDN saturation when requested (mirrors mac's wallpaper .saturation(1.05))", () => {
    const url = sizedImageURL("https://images.unsplash.com/photo-1?ixid=abc", {
      width: 800,
      saturation: 5,
    });
    expect(new URL(url).searchParams.get("sat")).toBe("5");
  });

  it("returns unparseable input unchanged", () => {
    expect(sizedImageURL("not a url", { width: 100 })).toBe("not a url");
  });
});

describe("extractPlaceName", () => {
  it("prefers location.name over city/country", () => {
    expect(
      extractPlaceName({ name: "Tre Cime di Lavaredo", city: "Auronzo", country: "Italy" }),
    ).toBe("Tre Cime di Lavaredo");
  });

  it("falls back to city, then country", () => {
    expect(extractPlaceName({ city: "Ortisei", country: "Italy" })).toBe("Ortisei");
    expect(extractPlaceName({ country: "Italy" })).toBe("Italy");
  });

  it("returns null without any location metadata", () => {
    expect(extractPlaceName(null)).toBeNull();
    expect(extractPlaceName(undefined)).toBeNull();
    expect(extractPlaceName({ name: "  " })).toBeNull();
  });

  it("collapses whitespace and truncates long labels", () => {
    expect(extractPlaceName({ name: "Val   di   Funes" })).toBe("Val di Funes");
    const long = "A".repeat(60);
    expect(extractPlaceName({ name: long })).toBe(`${"A".repeat(45)}...`);
  });
});

describe("makeUnsplashClient", () => {
  it("returns null without a key", () => {
    expect(makeUnsplashClient(null)).toBeNull();
    expect(makeUnsplashClient("")).toBeNull();
  });
});

describe("SceneryStore", () => {
  it("stays dark without a client: ready with empty pool, wash fallbacks", async () => {
    const { store, registry } = makeStore({ client: null });
    await store.start();
    const state = registry.get(sceneryStateAtom);
    expect(state.ready).toBe(true);
    expect(state.pool).toHaveLength(0);
    expect(store.photoFor("thread-1")).toBeNull();
    expect(store.peekNextScene()).toBeNull();
    expect(store.dailyFeatured()).toBeNull();
  });

  it("builds a pool with curated scene names paired in fetch order", async () => {
    const photos = Array.from({ length: 30 }, (_, index) => photo(`p${index}`));
    const client = makeClient(photos);
    const { store, registry, storage } = makeStore({ client });
    await store.start();

    const state = registry.get(sceneryStateAtom);
    // 12 + 8 + 6 requested, but the fake client returns the same photos for
    // every query, so dedupe leaves the first 12 unique ids.
    expect(client.searches).toHaveLength(3);
    expect(state.pool.length).toBeGreaterThan(0);
    expect(state.pool[0]?.name).toBe(SCENE_NAMES[0]);
    expect(state.pool[1]?.name).toBe(SCENE_NAMES[1]);
    expect(storage.state.pool?.photos.length).toBe(state.pool.length);
  });

  it("keeps the plain place name as the thread title, even when reused", async () => {
    // Mirrors mac's SceneryStore.threadTitle: duplicate primary titles across
    // threads are expected; displayNames differentiates them once the server
    // generates a description.
    const client = makeClient([photo("p0")]);
    const { store } = makeStore({ client });
    await store.start();

    const scene = store.peekNextScene();
    expect(scene).not.toBeNull();
    expect(store.threadTitle(scene!)).toBe(SCENE_NAMES[0]);
    store.assign(scene!.id, "thread-1");
    expect(store.threadTitle(scene!)).toBe(SCENE_NAMES[0]);
  });

  it("spreads scenes least-used-first and keeps assignments stable", async () => {
    const client = makeClient([photo("p0"), photo("p1"), photo("p2")]);
    const { store, storage } = makeStore({ client });
    await store.start();

    const first = store.peekNextScene()!;
    store.assign(first.id, "thread-1");
    const second = store.peekNextScene()!;
    expect(second.id).not.toBe(first.id);

    expect(store.photoFor("thread-1")?.id).toBe(first.id);
    expect(storage.state.assignments["thread-1"]).toBe(first.id);
    // Unassigned threads get a stable hash fallback, not null.
    expect(store.photoFor("thread-legacy")).not.toBeNull();
    expect(store.photoFor("thread-legacy")?.id).toBe(store.photoFor("thread-legacy")?.id);
  });

  it("reuses a fresh cached pool without refetching", async () => {
    const client = makeClient([photo("p0")]);
    const storage = makeMemorySceneryStorage();
    storage.state.pool = {
      fetchedAt: "2026-07-01T00:00:00Z",
      photos: [{ ...photo("cached"), name: "Seceda" }],
    };
    const { store, registry } = makeStore({ client, storage });
    await store.start();

    expect(client.searches).toHaveLength(0);
    expect(registry.get(sceneryStateAtom).pool[0]?.id).toBe("cached");
  });

  it("refreshes a stale pool but keeps assigned photos alive", async () => {
    const client = makeClient([photo("fresh-0"), photo("fresh-1")]);
    const storage = makeMemorySceneryStorage();
    storage.state.pool = {
      fetchedAt: "2026-01-01T00:00:00Z",
      photos: [{ ...photo("old-assigned"), name: "Marmolada" }, photo("old-unassigned")],
    };
    storage.state.assignments = { "thread-1": "old-assigned" };
    const { store, registry } = makeStore({ client, storage });
    await store.start();

    const pool = registry.get(sceneryStateAtom).pool;
    expect(pool.some((entry) => entry.id === "old-assigned")).toBe(true);
    expect(pool.some((entry) => entry.id === "old-unassigned")).toBe(false);
    expect(store.photoFor("thread-1")?.name).toBe("Marmolada");
  });

  it("refreshing the pool keeps an assigned photo's name even when it reappears in the new results", async () => {
    // Same photo id comes back from the refreshed search (e.g. Unsplash
    // resurfaces it), but at a different index than before. Recomputing its
    // name from the new index/placeName would silently rename thread-1's
    // scene out from under it; the prior assigned name must win.
    const client = makeClient([photo("fresh-0"), { ...photo("reused"), placeName: "Seiser Alm" }]);
    const storage = makeMemorySceneryStorage();
    storage.state.pool = {
      fetchedAt: "2026-01-01T00:00:00Z",
      photos: [{ ...photo("reused"), name: "Seceda" }],
    };
    storage.state.assignments = { "thread-1": "reused" };
    const { store, registry } = makeStore({ client, storage });
    await store.start();

    const pool = registry.get(sceneryStateAtom).pool;
    expect(pool.find((entry) => entry.id === "reused")?.name).toBe("Seceda");
    expect(store.photoFor("thread-1")?.name).toBe("Seceda");
    // Non-identity metadata still refreshes.
    expect(pool.find((entry) => entry.id === "reused")?.placeName).toBe("Seiser Alm");
  });

  it("rotates the daily featured photo by day of year", async () => {
    const client = makeClient([photo("p0"), photo("p1"), photo("p2")]);
    let now = new Date("2026-07-04T12:00:00Z");
    const { store, registry } = makeStore({ client, now: () => now });
    await store.start();

    const first = registry.get(sceneryStateAtom).featuredPhotoId;
    expect(first).not.toBeNull();
    now = new Date("2026-07-05T12:00:00Z");
    store.refreshDailyFeatured();
    const second = registry.get(sceneryStateAtom).featuredPhotoId;
    expect(second).not.toBe(first);
    expect(store.dailyFeatured()?.id).toBe(second);
  });

  it("ignores a cached pool when the build has no client (keyless = washes only)", async () => {
    const storage = makeMemorySceneryStorage();
    storage.state.pool = {
      fetchedAt: "2026-07-01T00:00:00Z",
      photos: [{ ...photo("cached"), name: "Seceda" }],
    };
    storage.state.assignments = { "thread-1": "cached" };
    const { store, registry } = makeStore({ client: null, storage });
    await store.start();

    const state = registry.get(sceneryStateAtom);
    expect(state.pool).toHaveLength(0);
    expect(store.photoFor("thread-1")).toBeNull();
    // Assignments survive so a future keyed build restores the scene.
    expect(state.assignments["thread-1"]).toBe("cached");
  });

  it("resolves cached-pool readiness without waiting for the network refresh", async () => {
    let released = false;
    let releaseSearch: (() => void) | null = null;
    const hangingClient: UnsplashClient = {
      // First search hangs until released; later ones resolve immediately.
      searchPhotos: () =>
        released
          ? Promise.resolve([photo("p0")])
          : new Promise((resolve) => {
              releaseSearch = () => {
                released = true;
                resolve([photo("p0")]);
              };
            }),
      registerDownload: async () => {},
    };
    const { store } = makeStore({ client: hangingClient });

    // Must resolve while the Unsplash search is still pending.
    await store.whenCachedPoolLoaded();
    expect(store.peekNextScene()).toBeNull();

    releaseSearch!();
    await store.start();
    expect(store.peekNextScene()).not.toBeNull();
  });

  it("unassign frees a reservation so least-used spread sees it again", async () => {
    const client = makeClient([photo("p0"), photo("p1")]);
    const { store, storage } = makeStore({ client });
    await store.start();

    const scene = store.peekNextScene()!;
    store.assign(scene.id, "pending-thread");
    const next = store.peekNextScene()!;
    expect(next.id).not.toBe(scene.id);

    store.unassign("pending-thread");
    expect(store.peekNextScene()?.id).toBe(scene.id);
    expect(storage.state.assignments["pending-thread"]).toBeUndefined();
    // Unassigning an unknown key is a no-op.
    store.unassign("never-assigned");
  });

  it("pings download_location once per photo", async () => {
    const client = makeClient([photo("p0")]);
    const { store, storage } = makeStore({ client });
    await store.start();

    store.registerDownloadIfNeeded("p0");
    store.registerDownloadIfNeeded("p0");
    await Promise.resolve();
    expect(client.registered).toHaveLength(1);
    expect(storage.state.registeredDownloads).toEqual(["p0"]);
  });

  it("serves variant URLs from the raw base with sizing params", async () => {
    const client = makeClient([photo("p0")]);
    const { store } = makeStore({ client });
    await store.start();

    const scene = store.peekNextScene()!;
    expect(store.variantURL(scene, "thumb")).toBe(scene.thumbURL);
    expect(new URL(store.variantURL(scene, "hero")).searchParams.get("w")).toBe("2048");
    const wallpaperUrl = new URL(store.variantURL(scene, "wallpaper"));
    expect(wallpaperUrl.searchParams.get("blur")).toBe("35");
    expect(wallpaperUrl.searchParams.get("sat")).toBe("5");
    expect(new URL(store.variantURL(scene, "frost")).searchParams.get("w")).toBe("800");
  });

  it("names a pool photo after its real Unsplash location, not the curated cycle", async () => {
    const client = makeClient([
      photo("p0", { placeName: "Tre Cime di Lavaredo" }),
      photo("p1"), // no location metadata: falls back to curated cycling
    ]);
    const { store, registry } = makeStore({ client });
    await store.start();

    const state = registry.get(sceneryStateAtom);
    expect(state.pool.find((entry) => entry.id === "p0")?.name).toBe("Tre Cime di Lavaredo");
    expect(state.pool.find((entry) => entry.id === "p1")?.name).toBe(SCENE_NAMES[1]);
  });

  it("never names a photo after the bare set title, even from location metadata", async () => {
    const client = makeClient([photo("p0", { placeName: "Dolomites" })]);
    const { store, registry } = makeStore({ client });
    await store.start();

    // Falls back to the curated cycle instead of surfacing "Dolomites"
    // literally as a scene/thread name.
    expect(registry.get(sceneryStateAtom).pool[0]?.name).toBe(SCENE_NAMES[0]);
  });

  it("peekNextScene prefers distinctly-named candidates over generically-named ones", async () => {
    // p0 resolves to the bare set title (simulated directly on the pool,
    // bypassing refreshPool's own guard, to exercise peekNextScene's filter
    // in isolation); p1 gets a real place name.
    const client = makeClient([photo("p0"), photo("p1", { placeName: "Seceda" })]);
    const { store, storage } = makeStore({ client });
    await store.start();
    storage.state.pool = {
      fetchedAt: new Date("2026-07-04T12:00:00Z").toISOString(),
      photos: [
        { ...photo("p0"), name: "Dolomites" },
        { ...photo("p1"), name: "Seceda" },
      ],
    };
    // Reuse the same (fresh, so unused) client — a fresh pool is loaded from
    // disk without refetching, per the "reuses a fresh cached pool" case.
    const { store: reloaded } = makeStore({ client, storage });
    await reloaded.start();

    // Both candidates are tied at zero uses; the generically-named one is
    // filtered out, so the distinctly-named photo wins even though it isn't
    // first in pool order.
    expect(reloaded.peekNextScene()?.id).toBe("p1");
  });

  it("threadTitle strips pool-index and legacy lap-numbering pollution", async () => {
    const client = makeClient([photo("p0")]);
    const { store } = makeStore({ client });
    await store.start();

    expect(store.threadTitle({ ...photo("x"), name: "Tre Cime 2" })).toBe("Tre Cime");
    expect(store.threadTitle({ ...photo("x"), name: "Seceda · 3" })).toBe("Seceda");
    expect(store.threadTitle({ ...photo("x"), name: "Dolomites 5" })).toBe("Dolomites");
    // A genuine location-derived name (not in SCENE_NAMES) passes through.
    expect(store.threadTitle({ ...photo("x"), name: "Val di Funes, Italy" })).toBe(
      "Val di Funes, Italy",
    );
  });

  it("displayNames: primary is the stable scene name, description appears only once titled", async () => {
    const client = makeClient([photo("p0")]);
    const { store } = makeStore({ client });
    await store.start();

    const scene = store.peekNextScene()!;
    store.assign(scene.id, "thread-1");
    const seedTitle = store.threadTitle(scene);

    // No description yet: server title still matches the scene seed.
    expect(store.displayNames("thread-1", seedTitle)).toEqual({
      primary: seedTitle,
      description: null,
    });
    // Old-style numbered seed is also treated as "not yet titled".
    expect(store.displayNames("thread-1", `${seedTitle} · 2`)).toEqual({
      primary: seedTitle,
      description: null,
    });
    // Once the server retitles past the seed, it becomes the description.
    expect(store.displayNames("thread-1", "Fix the flaky retry test")).toEqual({
      primary: seedTitle,
      description: "Fix the flaky retry test",
    });
    // Unresolvable thread (empty pool / no scene): the title passes through.
    const { store: emptyStore } = makeStore({ client: null });
    await emptyStore.start();
    expect(emptyStore.displayNames("thread-x", "Some title")).toEqual({
      primary: "Some title",
      description: null,
    });
  });

  it("displayNames suppresses a curated pool-index seed title, not just the bare scene name", async () => {
    // A thread whose stored title is still the pool-builder's numbered
    // fallback ("Tre Cime 2") for the scene it's assigned to ("Tre Cime")
    // must read as "not yet titled" — the same as an exact or " · "-numbered
    // match — not as a real server-generated description.
    const client = makeClient([{ ...photo("p0"), name: "Tre Cime" }]);
    const { store } = makeStore({ client });
    await store.start();
    store.assign("p0", "thread-1");

    expect(store.displayNames("thread-1", "Tre Cime 2")).toEqual({
      primary: "Tre Cime",
      description: null,
    });
  });

  it("displayNamesFromState mirrors displayNames from published SceneryState (thread-list-row hook path)", async () => {
    const client = makeClient([photo("p0")]);
    const { store, registry } = makeStore({ client });
    await store.start();

    const scene = store.peekNextScene()!;
    store.assign(scene.id, "thread-1");
    const state = registry.get(sceneryStateAtom);
    const seedTitle = store.threadTitle(scene);

    expect(displayNamesFromState(state, "thread-1", seedTitle)).toEqual(
      store.displayNames("thread-1", seedTitle),
    );
    expect(displayNamesFromState(state, "thread-1", "Fix the flaky retry test")).toEqual(
      store.displayNames("thread-1", "Fix the flaky retry test"),
    );
    // Empty pool: no resolvable scene, so the title passes through untouched
    // — the fallback row components rely on to render exactly as before.
    const emptyState = { ready: true, pool: [], assignments: {}, featuredPhotoId: null };
    expect(displayNamesFromState(emptyState, "thread-x", "Some title")).toEqual({
      primary: "Some title",
      description: null,
    });
  });
});
