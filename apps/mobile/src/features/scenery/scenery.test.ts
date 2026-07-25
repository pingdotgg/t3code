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
  sceneryStateAtom,
  WORLD_LOCATIONS,
} from "./scenery-store";
import type { SceneryPhoto, UnsplashClient } from "./unsplash";
import { makeUnsplashClient, sizedImageURL } from "./unsplash";

function photo(id: string, overrides: Partial<SceneryPhoto> = {}): SceneryPhoto {
  return {
    id,
    name: "",
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

/**
 * Fake client returning the same photos for every query. The store keeps the
 * first not-yet-seen photo per location query, so N photos here yield a pool
 * of min(N, 24) photos named after the first N WORLD_LOCATIONS entries.
 */
function makeClient(photos: ReadonlyArray<SceneryPhoto>): UnsplashClient & {
  readonly searches: string[];
  readonly registered: string[];
} {
  const searches: string[] = [];
  const registered: string[] = [];
  return {
    searches,
    registered,
    searchPhotos: async (query, _count) => {
      searches.push(query);
      return photos;
    },
    registerDownload: async (url) => {
      registered.push(url);
    },
  };
}

/** Fake client returning one distinct photo per curated location query. */
function makeWorldClient(
  options: { readonly emptyQueries?: ReadonlyArray<string> } = {},
): UnsplashClient & {
  readonly searches: string[];
  readonly counts: number[];
  readonly registered: string[];
} {
  const searches: string[] = [];
  const counts: number[] = [];
  const registered: string[] = [];
  return {
    searches,
    counts,
    registered,
    searchPhotos: async (query, count) => {
      searches.push(query);
      counts.push(count);
      if (options.emptyQueries?.includes(query)) return [];
      const index = WORLD_LOCATIONS.findIndex((location) => location.query === query);
      return index >= 0 ? [photo(`p${index}`)] : [];
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

  it("builds the pool from one search per curated location, named verbatim", async () => {
    const client = makeWorldClient();
    const { store, registry, storage } = makeStore({ client });
    await store.start();

    const state = registry.get(sceneryStateAtom);
    expect(client.searches).toEqual(WORLD_LOCATIONS.map((location) => location.query));
    // Two results requested per location for dedupe resilience.
    expect(client.counts.every((count) => count === 2)).toBe(true);
    expect(state.pool).toHaveLength(WORLD_LOCATIONS.length);
    for (const [index, location] of WORLD_LOCATIONS.entries()) {
      expect(state.pool[index]?.name).toBe(location.name);
    }
    expect(storage.state.pool?.photos.length).toBe(state.pool.length);
  });

  it("skips a location whose search returns nothing without failing the build", async () => {
    const client = makeWorldClient({ emptyQueries: [WORLD_LOCATIONS[0]!.query] });
    const { store, registry } = makeStore({ client });
    await store.start();

    const state = registry.get(sceneryStateAtom);
    expect(state.pool).toHaveLength(WORLD_LOCATIONS.length - 1);
    expect(state.pool.some((entry) => entry.name === WORLD_LOCATIONS[0]!.name)).toBe(false);
    expect(state.pool.some((entry) => entry.name === WORLD_LOCATIONS[1]!.name)).toBe(true);
  });

  it("keeps the curated location name as the thread title, even when reused", async () => {
    const client = makeClient([photo("p0")]);
    const { store } = makeStore({ client });
    await store.start();

    const scene = store.peekNextScene();
    expect(scene).not.toBeNull();
    expect(store.threadTitle(scene!)).toBe(WORLD_LOCATIONS[0]!.name);
    store.assign(scene!.id, "thread-1");
    expect(store.threadTitle(scene!)).toBe(WORLD_LOCATIONS[0]!.name);
  });

  it("peekNextScene holds the pending random pick until assign commits it, then picks again", async () => {
    const client = makeClient([photo("p0"), photo("p1")]);
    const { store } = makeStore({ client });
    await store.start();

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const first = store.peekNextScene()!;
      expect(first.id).toBe("p0");
      // Repeated peeks (draft queue, then online create) see the same scene.
      expect(store.peekNextScene()?.id).toBe("p0");

      store.assign(first.id, "thread-1");
      randomSpy.mockReturnValue(0.999);
      const second = store.peekNextScene()!;
      expect(second.id).toBe("p1");
      expect(store.peekNextScene()?.id).toBe("p1");
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("peekNextScene skips scenes occupied by excluded thread keys", async () => {
    const client = makeClient([photo("p0"), photo("p1")]);
    const { store } = makeStore({ client });
    await store.start();

    store.assign("p0", "env:thread-1");
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      // Without the exclusion, random = 0 would pick the occupied p0.
      const pick = store.peekNextScene({ excludingThreadKeys: new Set(["env:thread-1"]) })!;
      expect(pick.id).toBe("p1");
      // The pending pick holds for subsequent peeks.
      expect(store.peekNextScene()?.id).toBe("p1");
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("peekNextScene treats an excluded thread's stable-hash scene as occupied", async () => {
    const client = makeClient([photo("p0"), photo("p1")]);
    const { store } = makeStore({ client });
    await store.start();

    // No explicit assignment: the thread still displays (and therefore
    // occupies) its stable-hash scene.
    const hashed = store.photoFor("env:busy")!;
    const pick = store.peekNextScene({ excludingThreadKeys: new Set(["env:busy"]) })!;
    expect(pick.id).not.toBe(hashed.id);
  });

  it("peekNextScene allows duplicates only once every pool photo is occupied", async () => {
    const client = makeClient([photo("p0")]);
    const { store } = makeStore({ client });
    await store.start();

    store.assign("p0", "env:thread-1");
    const pick = store.peekNextScene({ excludingThreadKeys: new Set(["env:thread-1"]) })!;
    expect(pick.id).toBe("p0");
  });

  it("peekNextScene re-samples a pending pick that an exclusion now covers", async () => {
    const client = makeClient([photo("p0"), photo("p1")]);
    const { store } = makeStore({ client });
    await store.start();

    // A thread created elsewhere occupies p0 via the stable-hash fallback.
    const busyKey = ["env:k0", "env:k1", "env:k2", "env:k3"].find(
      (key) => store.photoFor(key)?.id === "p0",
    )!;

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      // Preview sampled p0 before the busy thread was known.
      expect(store.peekNextScene()!.id).toBe("p0");
      // The exclusion now covers the pending pick: re-sample instead of
      // committing a duplicate.
      const pick = store.peekNextScene({ excludingThreadKeys: new Set([busyKey]) })!;
      expect(pick.id).toBe("p1");
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("photoFor keeps the explicit assignment and falls back to a stable hash", async () => {
    const client = makeClient([photo("p0"), photo("p1"), photo("p2")]);
    const { store, storage } = makeStore({ client });
    await store.start();

    const scene = store.peekNextScene()!;
    store.assign(scene.id, "thread-1");
    expect(store.photoFor("thread-1")?.id).toBe(scene.id);
    expect(storage.state.assignments["thread-1"]).toBe(scene.id);
    // Unassigned threads get a stable hash fallback, not null.
    expect(store.photoFor("thread-legacy")).not.toBeNull();
    expect(store.photoFor("thread-legacy")?.id).toBe(store.photoFor("thread-legacy")?.id);
  });

  it("reuses a fresh cached pool without refetching", async () => {
    const client = makeClient([photo("p0")]);
    const storage = makeMemorySceneryStorage();
    storage.state.pool = {
      fetchedAt: "2026-07-01T00:00:00Z",
      photos: [{ ...photo("cached"), name: "Kyoto, Japan" }],
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
      photos: [{ ...photo("old-assigned"), name: "Tre Cime, Italy" }, photo("old-unassigned")],
    };
    storage.state.assignments = { "thread-1": "old-assigned" };
    const { store, registry } = makeStore({ client, storage });
    await store.start();

    const pool = registry.get(sceneryStateAtom).pool;
    expect(pool.some((entry) => entry.id === "old-assigned")).toBe(true);
    expect(pool.some((entry) => entry.id === "old-unassigned")).toBe(false);
    expect(store.photoFor("thread-1")?.name).toBe("Tre Cime, Italy");
  });

  it("refreshing the pool keeps an assigned photo's name even when it reappears in the new results", async () => {
    // The world client returns photo id "p0" for the first location query;
    // a stale cached pool already holds that id under an older curated name.
    // Recomputing its name would silently rename thread-1's scene out from
    // under it; the prior assigned name must win.
    const client = makeWorldClient();
    const storage = makeMemorySceneryStorage();
    storage.state.pool = {
      fetchedAt: "2026-01-01T00:00:00Z",
      photos: [{ ...photo("p0"), name: "Legacy Name, Italy" }],
    };
    storage.state.assignments = { "thread-1": "p0" };
    const { store, registry } = makeStore({ client, storage });
    await store.start();

    const pool = registry.get(sceneryStateAtom).pool;
    expect(pool.find((entry) => entry.id === "p0")?.name).toBe("Legacy Name, Italy");
    expect(store.photoFor("thread-1")?.name).toBe("Legacy Name, Italy");
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
      photos: [{ ...photo("cached"), name: "Kyoto, Japan" }],
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

  it("unassign removes the assignment; unknown keys are a no-op", async () => {
    const client = makeClient([photo("p0"), photo("p1")]);
    const { store, registry, storage } = makeStore({ client });
    await store.start();

    const scene = store.peekNextScene()!;
    store.assign(scene.id, "pending-thread");
    expect(storage.state.assignments["pending-thread"]).toBe(scene.id);

    store.unassign("pending-thread");
    expect(storage.state.assignments["pending-thread"]).toBeUndefined();
    // The explicit binding is gone; the thread falls back to its stable hash.
    const pool = registry.get(sceneryStateAtom).pool;
    const fallback = pool[stableIndex("pending-thread", pool.length)];
    expect(store.photoFor("pending-thread")?.id).toBe(fallback?.id);
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
    expect(wallpaperUrl.searchParams.get("blur")).toBe("50");
    expect(wallpaperUrl.searchParams.get("sat")).toBe("5");
    expect(new URL(store.variantURL(scene, "frost")).searchParams.get("w")).toBe("800");
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
