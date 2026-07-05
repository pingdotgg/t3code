import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { Dimensions, PixelRatio } from "react-native";

import { stableIndex } from "./alpine-theme";
import type { SceneryStorage } from "./scenery-storage";
import { expoSceneryStorage } from "./scenery-storage";
import type { SceneryPhoto, UnsplashClient } from "./unsplash";
import { makeUnsplashClient, sizedImageURL } from "./unsplash";
import { appAtomRegistry } from "../../state/atom-registry";

/**
 * Owns the app's alpine identity photos, the mobile port of the mac app's
 * SceneryStore: a small pool of Dolomites photographs fetched once from
 * Unsplash (metadata cached on disk; image bytes live in expo-image's disk
 * cache, keyed by the URLs persisted verbatim in the pool), a stable
 * thread → photo assignment, and curated scene names used as thread titles.
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

/** Search queries the pool is built from, most-wanted first. */
const POOL_QUERIES: ReadonlyArray<readonly [query: string, take: number]> = [
  ["dolomites italy mountains", 12],
  ["alpine meadow dolomites", 8],
  ["italian alps grass field", 6],
];
const POOL_CAP = 24;
const POOL_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

/**
 * Dolomites place names paired with pool photos in fetch order. Curated
 * because Unsplash alt text ("green grass field near mountain…") makes a
 * poor thread title. Mirrors the mac app's list.
 */
export const SCENE_NAMES: ReadonlyArray<string> = [
  "Tre Cime",
  "Seceda",
  "Alpe di Siusi",
  "Lago di Braies",
  "Marmolada",
  "Sassolungo",
  "Cadini di Misurina",
  "Passo Giau",
  "Cinque Torri",
  "Val Gardena",
  "Croda da Lago",
  "Odle Ridge",
  "Fanes Meadow",
  "Puez Alm",
  "Sciliar",
  "Latemar",
  "Catinaccio",
  "Passo Pordoi",
  "Sella Towers",
  "Passo Falzarego",
  "Val di Funes",
  "Monte Paterno",
  "Croda Rossa",
  "Piz Boè",
  "Sass de Putia",
  "Vajolet Towers",
  "Passo Rolle",
  "Pale di San Martino",
  "Brenta Ridge",
  "Piz Duleda",
];

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
   * The scene the next created thread will get: the least-used pool photo
   * (pool order breaks ties), so scenes spread out before repeating.
   * Pure — safe to call for previews; `assign` commits it.
   */
  peekNextScene(): SceneryPhoto | null {
    if (this.pool.length === 0) return null;
    const useCount = new Map<string, number>();
    for (const photoId of Object.values(this.assignments)) {
      useCount.set(photoId, (useCount.get(photoId) ?? 0) + 1);
    }
    let best: SceneryPhoto | null = null;
    let bestCount = Number.POSITIVE_INFINITY;
    for (const photo of this.pool) {
      const count = useCount.get(photo.id) ?? 0;
      if (count < bestCount) {
        best = photo;
        bestCount = count;
      }
    }
    return best;
  }

  /**
   * Thread title for a scene: the place name, numbered on reuse
   * ("Seceda", then "Seceda · 2").
   */
  threadTitle(photo: SceneryPhoto): string {
    const uses = Object.values(this.assignments).filter((id) => id === photo.id).length;
    return uses === 0 ? photo.name : `${photo.name} · ${uses + 1}`;
  }

  /** Commit a thread → photo binding (after the create was dispatched). */
  assign(photoId: string, threadKey: string): void {
    this.assignments = { ...this.assignments, [threadKey]: photoId };
    void this.storage.saveAssignments(this.assignments);
    this.publish();
  }

  /**
   * Drop a reservation whose thread never materialized (a deleted pending
   * task), so phantom uses stop skewing least-used spread and title
   * numbering. Delivered threads keep their assignment.
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
        // Pre-blurred on the CDN: replaces a runtime gaussian at zero
        // on-device cost and renders identically on Android.
        return sizedImageURL(base, { width: this.heroPixelWidth, blur: 35 });
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
    const fetched: SceneryPhoto[] = [];
    for (const [query, take] of POOL_QUERIES) {
      try {
        fetched.push(...(await this.client.searchPhotos(query, take)));
      } catch {
        // Partial pools are fine; stale/empty pools retry next launch.
      }
    }
    const seen = new Set<string>();
    const unique = fetched.filter((photo) => {
      if (seen.has(photo.id)) return false;
      seen.add(photo.id);
      return true;
    });
    const capped = unique.slice(0, POOL_CAP);
    if (capped.length === 0) return;

    const refreshed = capped.map((photo, index) => {
      const base = SCENE_NAMES[index % SCENE_NAMES.length]!;
      const lap = Math.floor(index / SCENE_NAMES.length);
      return { ...photo, name: lap === 0 ? base : `${base} ${lap + 1}` };
    });
    // Carry over photos still assigned to threads but missing from the new
    // results, so a refresh never swaps an existing thread's scene out from
    // under its scene-derived title.
    const refreshedIds = new Set(refreshed.map((photo) => photo.id));
    const assignedIds = new Set(Object.values(this.assignments));
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
