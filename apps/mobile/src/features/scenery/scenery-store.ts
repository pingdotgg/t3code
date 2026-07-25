import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { Dimensions, PixelRatio } from "react-native";

import { stableIndex } from "./alpine-theme";
import type { SceneryStorage } from "./scenery-storage";
import { expoSceneryStorage } from "./scenery-storage";
import type { SceneryPhoto, UnsplashClient } from "./unsplash";
import { makeUnsplashClient, sizedImageURL } from "./unsplash";
import { appAtomRegistry } from "../../state/atom-registry";

/**
 * Owns the app's scenery identity photos, the mobile port of the mac app's
 * SceneryStore: a small pool of photographs of curated world locations (one
 * iconic place per country) fetched once from Unsplash (metadata cached on
 * disk; image bytes live in expo-image's disk cache, keyed by the URLs
 * persisted verbatim in the pool), a stable thread → photo assignment, and
 * the curated "Location, Country" names used as thread titles. Never machine
 * captions (description/alt text).
 *
 * Everything degrades gracefully without a key or network: `photoFor`
 * returns null and views fall back to `washGradientStyle(seed)`.
 */

export type SceneryVariant = "hero" | "wallpaper" | "frost" | "thumb";

export interface SceneryState {
  /** True once the initial disk load (and refresh, if any) settled. */
  readonly ready: boolean;
  readonly pool: ReadonlyArray<SceneryPhoto>;
  /** threadKey -> photoId */
  readonly assignments: Readonly<Record<string, string>>;
  /** Empty-state hero: rotates daily through the pool. */
  readonly featuredPhotoId: string | null;
}

const INITIAL_STATE: SceneryState = {
  ready: false,
  pool: [],
  assignments: {},
  featuredPhotoId: null,
};

export const sceneryStateAtom = Atom.make<SceneryState>(INITIAL_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:scenery:state"),
);

/**
 * Curated world locations the pool is built from — one iconic place per
 * country. `name` is stored verbatim on the photo and surfaces as the thread
 * title; `query` is the Unsplash search text used to fetch it.
 */
export const WORLD_LOCATIONS: ReadonlyArray<{ readonly name: string; readonly query: string }> = [
  { name: "Santorini, Greece", query: "santorini greece caldera" },
  { name: "Kyoto, Japan", query: "kyoto japan temple" },
  { name: "Moraine Lake, Canada", query: "moraine lake banff canada" },
  { name: "Tre Cime, Italy", query: "tre cime dolomites italy" },
  { name: "Lofoten, Norway", query: "lofoten islands norway" },
  { name: "Milford Sound, New Zealand", query: "milford sound new zealand" },
  { name: "Zermatt, Switzerland", query: "matterhorn zermatt switzerland" },
  { name: "Torres del Paine, Chile", query: "torres del paine patagonia chile" },
  { name: "Skógafoss, Iceland", query: "skogafoss waterfall iceland" },
  { name: "Cappadocia, Türkiye", query: "cappadocia turkey balloons" },
  { name: "Petra, Jordan", query: "petra jordan treasury" },
  { name: "Sossusvlei, Namibia", query: "sossusvlei namibia dunes" },
  { name: "Zhangjiajie, China", query: "zhangjiajie china mountains" },
  { name: "Ha Long Bay, Vietnam", query: "ha long bay vietnam" },
  { name: "El Nido, Philippines", query: "el nido palawan philippines" },
  { name: "Ubud, Indonesia", query: "tegalalang rice terrace bali indonesia" },
  { name: "Machu Picchu, Peru", query: "machu picchu peru" },
  { name: "Iguazu Falls, Argentina", query: "iguazu falls argentina" },
  { name: "Merzouga, Morocco", query: "merzouga sahara morocco dunes" },
  { name: "Plitvice Lakes, Croatia", query: "plitvice lakes croatia" },
  { name: "Isle of Skye, United Kingdom", query: "isle of skye scotland" },
  { name: "Lake Bled, Slovenia", query: "lake bled slovenia" },
  { name: "Sete Cidades, Portugal", query: "sete cidades azores portugal" },
  { name: "Arenal, Costa Rica", query: "arenal volcano costa rica" },
];
const POOL_CAP = 24;
const POOL_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

/**
 * Pure resolution of a thread key's stable scene name from published
 * `SceneryState`, mirroring `SceneryStore.sceneName` below but without an
 * instance — duplicated here (rather than reusing `photoFromState` in
 * use-scenery.ts) because it is also needed by `displayNamesFromState`.
 */
function sceneNameFromState(state: SceneryState, threadKey: string): string | null {
  if (state.pool.length === 0) return null;
  const assignedId = state.assignments[threadKey];
  const assigned =
    assignedId !== undefined ? state.pool.find((photo) => photo.id === assignedId) : undefined;
  const photo = assigned ?? state.pool[stableIndex(threadKey, state.pool.length)];
  return photo ? photo.name : null;
}

/**
 * Two-line naming for a thread computed directly from published
 * `SceneryState`, for reactive hooks (`useThreadDisplayNames` in
 * use-scenery.ts) that only subscribe to `sceneryStateAtom` rather than
 * holding a `SceneryStore` instance. Same semantics as
 * `SceneryStore.displayNames` below — keep the two in sync.
 */
export function displayNamesFromState(
  state: SceneryState,
  threadKey: string,
  title: string,
): { readonly primary: string; readonly description: string | null } {
  const trimmedTitle = title.trim();
  const scene = sceneNameFromState(state, threadKey);
  if (scene === null) return { primary: trimmedTitle, description: null };
  if (trimmedTitle.length === 0 || trimmedTitle === scene) {
    return { primary: scene, description: null };
  }
  return { primary: scene, description: trimmedTitle };
}

export interface SceneryStoreOptions {
  readonly registry?: AtomRegistry.AtomRegistry;
  readonly storage?: SceneryStorage;
  readonly client?: UnsplashClient | null;
  readonly now?: () => Date;
  /** Pixel width heroes are requested at; defaults to the screen width. */
  readonly heroPixelWidth?: number;
}

function defaultHeroPixelWidth(): number {
  const { width, height } = Dimensions.get("screen");
  // Landscape photos on a portrait phone: the longer edge is what a future
  // rotation or iPad split would need. Cap keeps download + decode sane.
  const longest = Math.max(width, height) * PixelRatio.get();
  return Math.min(Math.round(longest), 2048);
}

export class SceneryStore {
  private readonly registry: AtomRegistry.AtomRegistry;
  private readonly storage: SceneryStorage;
  private readonly client: UnsplashClient | null;
  private readonly now: () => Date;
  private readonly heroPixelWidth: number;

  private pool: ReadonlyArray<SceneryPhoto> = [];
  private assignments: Record<string, string> = {};
  private registeredDownloads = new Set<string>();
  private poolFetchedAt: Date | null = null;
  private startPromise: Promise<void> | null = null;
  private diskLoadPromise: Promise<void> | null = null;
  /** Random scene sampled by `peekNextScene`, held until `assign` commits it. */
  private pendingPickId: string | null = null;

  constructor(options: SceneryStoreOptions = {}) {
    this.registry = options.registry ?? appAtomRegistry;
    this.storage = options.storage ?? expoSceneryStorage;
    this.client = options.client === undefined ? makeUnsplashClient() : options.client;
    this.now = options.now ?? (() => new Date());
    this.heroPixelWidth = options.heroPixelWidth ?? defaultHeroPixelWidth();
  }

  /**
   * Load the cached pool, then refresh from the API when empty or stale.
   * Idempotent: concurrent callers share one load. Flows that must not
   * stall on the network (thread creation) await `whenCachedPoolLoaded`
   * instead.
   */
  start(): Promise<void> {
    this.startPromise ??= (async () => {
      await this.ensureDiskLoaded();
      const age = this.poolFetchedAt
        ? this.now().getTime() - this.poolFetchedAt.getTime()
        : Number.POSITIVE_INFINITY;
      if (this.pool.length === 0 || age > POOL_MAX_AGE_MS) {
        await this.refreshPool();
      }
      this.publish(true);
    })();
    return this.startPromise;
  }

  /**
   * Cached-pool readiness: resolves once the disk snapshot is loaded, while
   * the full start (Unsplash refresh) continues in the background. Thread
   * creation awaits this instead of start() so an unreachable image API can
   * never delay startTurn — a fresh install just gets the prompt-derived
   * title fallback.
   */
  async whenCachedPoolLoaded(): Promise<void> {
    void this.start();
    await this.ensureDiskLoaded();
  }

  private ensureDiskLoaded(): Promise<void> {
    this.diskLoadPromise ??= this.loadFromDisk().then(() => {
      this.publish();
    });
    return this.diskLoadPromise;
  }

  /**
   * The scene bound to a thread key. Explicit assignment first (threads
   * created in-app); stable hash fallback for threads created elsewhere.
   */
  photoFor(threadKey: string): SceneryPhoto | null {
    if (this.pool.length === 0) return null;
    const assignedId = this.assignments[threadKey];
    if (assignedId !== undefined) {
      const assigned = this.pool.find((photo) => photo.id === assignedId);
      if (assigned) return assigned;
    }
    return this.pool[stableIndex(threadKey, this.pool.length)] ?? null;
  }

  /**
   * The scene the next created thread will get: a uniformly random pool
   * photo, skipping photos already bound to the given (open/unsettled)
   * thread keys so two active threads don't share a location. Duplicates
   * are allowed only once every pool photo is in use. Preview/commit
   * consistency matters — mobile queues drafts and peeks before committing —
   * so the first pick is remembered as a pending pick and returned by every
   * subsequent peek until `assign` commits it, a pool refresh drops it, or an
   * exclusion now covers it (in which case a new pick is sampled).
   */
  peekNextScene(options?: {
    readonly excludingThreadKeys?: ReadonlySet<string>;
  }): SceneryPhoto | null {
    if (this.pool.length === 0) return null;
    const occupied = new Set<string>();
    for (const threadKey of options?.excludingThreadKeys ?? []) {
      const photo = this.photoFor(threadKey);
      if (photo !== null) occupied.add(photo.id);
    }
    if (this.pendingPickId !== null) {
      const pending = this.pool.find((photo) => photo.id === this.pendingPickId);
      if (pending !== undefined && !occupied.has(pending.id)) return pending;
      this.pendingPickId = null;
    }
    const available = this.pool.filter((photo) => !occupied.has(photo.id));
    const candidates = available.length > 0 ? available : this.pool;
    const pick = candidates[Math.floor(Math.random() * candidates.length)] ?? null;
    this.pendingPickId = pick?.id ?? null;
    return pick;
  }

  /**
   * Thread title for a scene: the curated "Location, Country" name verbatim,
   * even when reused — duplicate primary titles across threads are expected;
   * `displayNames` differentiates them with the server-generated description
   * once one exists. Mirrors `SceneryStore.threadTitle(for:)` on mac.
   */
  threadTitle(photo: SceneryPhoto): string {
    return photo.name;
  }

  /**
   * Stable scene name for a thread key ("Kyoto, Japan"), or null when the
   * thread has no resolvable scene (empty pool). Mirrors
   * `SceneryStore.sceneName` on mac; unlike mac, mobile keeps no separate
   * assignment-time name map (a photo's `name` is set once at pool build and
   * carried over verbatim by `refreshPool`'s "kept" path).
   */
  sceneName(threadKey: string): string | null {
    const photo = this.photoFor(threadKey);
    return photo ? photo.name : null;
  }

  /**
   * Two-line naming for a thread: the stable scene place name as the
   * primary line, plus the server-generated title as the secondary
   * (description) line once first-turn titling has replaced the scene seed.
   * Mirrors `SceneryStore.displayNames(for:)` on mac.
   */
  displayNames(
    threadKey: string,
    title: string,
  ): { readonly primary: string; readonly description: string | null } {
    const trimmedTitle = title.trim();
    const scene = this.sceneName(threadKey);
    if (scene === null) return { primary: trimmedTitle, description: null };
    if (trimmedTitle.length === 0 || trimmedTitle === scene) {
      return { primary: scene, description: null };
    }
    return { primary: scene, description: trimmedTitle };
  }

  /**
   * Commit a thread → photo binding (after the create was dispatched).
   * Committing the pending pick clears it, so the next `peekNextScene`
   * samples a fresh random scene for the following thread.
   */
  assign(photoId: string, threadKey: string): void {
    if (this.pendingPickId === photoId) {
      this.pendingPickId = null;
    }
    this.assignments = { ...this.assignments, [threadKey]: photoId };
    void this.storage.saveAssignments(this.assignments);
    this.publish();
  }

  /**
   * Drop a reservation whose thread never materialized (a deleted pending
   * task). Delivered threads keep their assignment.
   */
  unassign(threadKey: string): void {
    if (!(threadKey in this.assignments)) return;
    const { [threadKey]: _removed, ...rest } = this.assignments;
    this.assignments = rest;
    void this.storage.saveAssignments(this.assignments);
    this.publish();
  }

  /** Photo for the daily-featured empty-state hero. */
  dailyFeatured(): SceneryPhoto | null {
    const state = this.registry.get(sceneryStateAtom);
    if (state.featuredPhotoId === null) return null;
    return this.pool.find((photo) => photo.id === state.featuredPhotoId) ?? null;
  }

  /**
   * Recompute the daily-featured photo. Called at start and again when the
   * app returns to the foreground on a new day (never during render).
   */
  refreshDailyFeatured(): void {
    this.publish();
  }

  /** CDN URL for a photo variant. Image bytes cache in expo-image by URL. */
  variantURL(photo: SceneryPhoto, variant: SceneryVariant): string {
    const base = photo.rawURL ?? photo.heroURL;
    switch (variant) {
      case "thumb":
        return photo.thumbURL;
      case "hero":
        return sizedImageURL(base, { width: this.heroPixelWidth });
      case "wallpaper":
        // Pre-blurred + lightly saturated on the CDN: replaces the mac chat
        // wallpaper's runtime `.blur(4).saturation(1.05)` at zero on-device
        // cost and renders identically on Android.
        return sizedImageURL(base, { width: this.heroPixelWidth, blur: 50, saturation: 5 });
      case "frost":
        return sizedImageURL(base, { width: 800, blur: 90 });
    }
  }

  /**
   * Unsplash guideline: ping `links.download_location` once per photo when
   * it is first actually displayed (SceneryImage onLoad calls this).
   */
  registerDownloadIfNeeded(photoId: string): void {
    if (this.client === null || this.registeredDownloads.has(photoId)) return;
    const photo = this.pool.find((entry) => entry.id === photoId);
    if (!photo?.downloadLocationURL) return;
    this.registeredDownloads.add(photoId);
    void this.storage.saveRegisteredDownloads([...this.registeredDownloads]);
    void this.client.registerDownload(photo.downloadLocationURL);
  }

  private async loadFromDisk(): Promise<void> {
    const [poolFile, assignments, registered] = await Promise.all([
      this.storage.loadPool(),
      this.storage.loadAssignments(),
      this.storage.loadRegisteredDownloads(),
    ]);
    // Ignore a pool cached by an earlier keyed build when this build has no
    // client: keyless means washes only — we can neither refresh the pool
    // nor honor the download-registration guideline for those photos.
    // Assignments are kept so a future keyed build restores each thread's
    // scene.
    if (poolFile !== null && this.client !== null) {
      this.pool = poolFile.photos;
      const fetchedAt = new Date(poolFile.fetchedAt);
      this.poolFetchedAt = Number.isNaN(fetchedAt.getTime()) ? null : fetchedAt;
    }
    this.assignments = assignments;
    this.registeredDownloads = new Set(registered);
  }

  private async refreshPool(): Promise<void> {
    if (this.client === null) return;
    // One search per curated location; two results requested so a duplicate
    // of an earlier location's photo can be skipped in favor of the runner-up,
    // then one photo kept per location, named with the curated name verbatim.
    const fetched: SceneryPhoto[] = [];
    const seen = new Set<string>();
    for (const location of WORLD_LOCATIONS) {
      if (fetched.length >= POOL_CAP) break;
      try {
        const results = await this.client.searchPhotos(location.query, 2);
        const pick = results.find((photo) => !seen.has(photo.id));
        if (pick !== undefined) {
          seen.add(pick.id);
          fetched.push({ ...pick, name: location.name });
        }
      } catch {
        // A location that fails to search just drops out of this refresh;
        // partial pools are fine and retry next launch.
      }
    }
    if (fetched.length === 0) return;

    const assignedIds = new Set(Object.values(this.assignments));
    const priorById = new Map(this.pool.map((photo) => [photo.id, photo]));
    const refreshed = fetched.map((photo) => {
      const prior = priorById.get(photo.id);
      // A photo still assigned to a thread that reappears in the refreshed
      // results keeps its prior name — it could resurface under a different
      // location's query, and recomputing the name would silently rename
      // that thread's scene out from under it. Other metadata (URLs, ...)
      // still refreshes.
      const name = prior && assignedIds.has(photo.id) ? prior.name : photo.name;
      return { ...photo, name };
    });
    // Carry over photos still assigned to threads but missing from the new
    // results, so a refresh never swaps an existing thread's scene out from
    // under its scene-derived title.
    const refreshedIds = new Set(refreshed.map((photo) => photo.id));
    const kept = this.pool.filter(
      (photo) => assignedIds.has(photo.id) && !refreshedIds.has(photo.id),
    );
    this.pool = [...refreshed, ...kept];
    this.poolFetchedAt = this.now();
    await this.storage.savePool({
      fetchedAt: this.poolFetchedAt.toISOString(),
      photos: this.pool,
    });
  }

  private publish(ready?: boolean): void {
    const previous = this.registry.get(sceneryStateAtom);
    this.registry.set(sceneryStateAtom, {
      ready: ready ?? previous.ready,
      pool: this.pool,
      assignments: this.assignments,
      featuredPhotoId: this.featuredPhotoIdFor(this.now()),
    });
  }

  private featuredPhotoIdFor(date: Date): string | null {
    if (this.pool.length === 0) return null;
    const startOfYear = new Date(date.getFullYear(), 0, 0);
    const dayOfYear = Math.floor((date.getTime() - startOfYear.getTime()) / 86_400_000);
    return this.pool[dayOfYear % this.pool.length]?.id ?? null;
  }
}

export const appSceneryStore = new SceneryStore();
