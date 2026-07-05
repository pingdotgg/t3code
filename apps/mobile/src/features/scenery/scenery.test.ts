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
import { SceneryStore, SCENE_NAMES, sceneryStateAtom } from "./scenery-store";
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

  it("numbers thread titles on scene reuse", async () => {
    const client = makeClient([photo("p0")]);
    const { store } = makeStore({ client });
    await store.start();

    const scene = store.peekNextScene();
    expect(scene).not.toBeNull();
    expect(store.threadTitle(scene!)).toBe(SCENE_NAMES[0]);
    store.assign(scene!.id, "thread-1");
    expect(store.threadTitle(scene!)).toBe(`${SCENE_NAMES[0]} · 2`);
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

  it("unassign frees a reservation and its title number", async () => {
    const client = makeClient([photo("p0")]);
    const { store, storage } = makeStore({ client });
    await store.start();

    const scene = store.peekNextScene()!;
    store.assign(scene.id, "pending-thread");
    expect(store.threadTitle(scene)).toBe(`${SCENE_NAMES[0]} · 2`);

    store.unassign("pending-thread");
    expect(store.threadTitle(scene)).toBe(SCENE_NAMES[0]);
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
    expect(new URL(store.variantURL(scene, "wallpaper")).searchParams.get("blur")).toBe("35");
    expect(new URL(store.variantURL(scene, "frost")).searchParams.get("w")).toBe("800");
  });
});
