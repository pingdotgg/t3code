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
 * thread → photo assignment, and scene names used as thread titles — each
 * photo's own Unsplash location metadata when it yields a real place, the
 * curated `SCENE_NAMES` cycle otherwise. Never machine captions
 * (description/alt text).
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

/**
 * Bare pool title, mirroring `ScenerySet.makeBuiltinDolomites().title` on
 * mac. New-thread naming must never surface this literally (it reads as a
 * region, not a place) — see `distinctlyNamedCandidates`.
 */
const SET_TITLE = "Dolomites";
/** Upper bound on pool-index numbering ("Tre Cime 2" … "Tre Cime N"). */
const MAX_POOL_LAP = POOL_CAP;

/**
 * Canonical comparison key for scene names: trimmed, whitespace-collapsed,
 * lowercased. Mirrors `SceneryStore.sceneNameComparisonKey` on mac so
 * case/whitespace variants aren't treated as distinct place names.
 */
function sceneNameComparisonKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Pool-builder labels ("Tre Cime 2" … "Tre Cime N", the curated-name cycling
 * fallback used when a photo has no real Unsplash location). Never a
 * legitimate thread/photo display name. Mirrors
 * `SceneryStore.isPoolNumberedSceneName` on mac.
 */
function isPoolNumberedSceneName(name: string, base: string): boolean {
  if (base.length === 0) return false;
  const prefix = `${base} `;
  if (!name.startsWith(prefix)) return false;
  const suffix = name.slice(prefix.length);
  const index = Number(suffix);
  return Number.isInteger(index) && String(index) === suffix && index >= 1 && index <= MAX_POOL_LAP;
}

/**
 * Legacy lap-numbered thread titles ("Seceda · 2") produced by this store's
 * old reuse-numbering `threadTitle`. Recognizing them lets `displayNames`
 * treat an old, still-numbered title as "no description generated yet", the
 * same as a bare scene name. Mirrors `SceneryStore.isLegacyNumberedSceneTitle`
 * on mac (capped at one digit there to avoid hiding AI titles ending in
 * years/large numbers; mobile never produced laps past `SCENE_NAMES.length`
 * repeats within a pool refresh window, so the same one-digit cap applies).
 */
function isLegacyNumberedSceneTitle(title: string, base: string): boolean {
  const separator = " · ";
  if (!title.startsWith(base + separator)) return false;
  const suffix = title.slice(base.length + separator.length);
  if (suffix.length !== 1) return false;
  const lap = Number(suffix);
  return Number.isInteger(lap) && lap >= 2 && lap <= 9;
}

/**
 * Normalizes a possibly-polluted photo/thread name back to its canonical
 * base place name: the set title (if the name is exactly that or a
 * pool-index label of it) or a curated `SCENE_NAMES` entry (if the name is
 * exactly that entry, that entry's own pool-index lap label — mobile's
 * `refreshPool` cycling fallback, e.g. "Tre Cime 2" — or a legacy
 * " · "-numbered variant of it). A genuine location-derived place name (not
 * in `SCENE_NAMES`) passes through unchanged. Mirrors
 * `SceneryStore.baseSceneName` on mac, extended to also strip mobile's own
 * curated-name-keyed lap pollution (mac's pool builder numbers against the
 * bare set title instead; mobile has no per-photo Unsplash query per curated
 * name, so it cycles the curated list and numbers laps against each name).
 */
function baseSceneName(name: string): string {
  if (name === SET_TITLE || isPoolNumberedSceneName(name, SET_TITLE)) {
    return SET_TITLE;
  }
  // Ignore polluted SCENE_NAMES entries that are themselves pool-index
  // labels of the set title, so an exact match on "Dolomites 5" cannot win
  // (SCENE_NAMES never legitimately contains such entries today, but this
  // keeps the guard future-proof if the curated list changes).
  const authenticBases = SCENE_NAMES.filter(
    (candidate) => !isPoolNumberedSceneName(candidate, SET_TITLE),
  );
  for (const base of [...authenticBases].sort((a, b) => b.length - a.length)) {
    if (
      name === base ||
      isPoolNumberedSceneName(name, base) ||
      isLegacyNumberedSceneTitle(name, base)
    ) {
      return base;
    }
  }
  return name;
}

/**
 * New threads should be named after a distinct place, not the bare pool
 * title ("Dolomites"). Filters `pool` down to photos whose resolved name
 * differs from the set title, falling back to the full pool when no
 * distinctly-named candidate exists. Never returns an empty array when
 * `pool` is non-empty. Mirrors `SceneryStore.distinctlyNamedCandidates` on
 * mac.
 */
function distinctlyNamedCandidates(pool: ReadonlyArray<SceneryPhoto>): ReadonlyArray<SceneryPhoto> {
  const titleKey = sceneNameComparisonKey(SET_TITLE);
  const named = pool.filter(
    (candidate) => sceneNameComparisonKey(baseSceneName(candidate.name)) !== titleKey,
  );
  return named.length === 0 ? pool : named;
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
   * The scene the next created thread will get: the least-used photo among
   * the distinctly-named candidates (pool order breaks ties), so scenes
   * spread out before repeating and new threads prefer a photo with a real
   * place name over one still carrying the bare "Dolomites" label. Pure —
   * safe to call for previews; `assign` commits it.
   */
  peekNextScene(): SceneryPhoto | null {
    if (this.pool.length === 0) return null;
    const candidates = distinctlyNamedCandidates(this.pool);
    const useCount = new Map<string, number>();
    for (const photoId of Object.values(this.assignments)) {
      useCount.set(photoId, (useCount.get(photoId) ?? 0) + 1);
    }
    let best: SceneryPhoto | null = null;
    let bestCount = Number.POSITIVE_INFINITY;
    for (const photo of candidates) {
      const count = useCount.get(photo.id) ?? 0;
      if (count < bestCount) {
        best = photo;
        bestCount = count;
      }
    }
    return best;
  }

  /**
   * Thread title for a scene: the plain place name, even when reused —
   * duplicate primary titles across threads are expected; `displayNames`
   * differentiates them with the server-generated description once one
   * exists. Mirrors `SceneryStore.threadTitle(for:)` on mac.
   */
  threadTitle(photo: SceneryPhoto): string {
    return baseSceneName(photo.name);
  }

  /**
   * Stable scene name for a thread key ("Seceda"), or null when the thread
   * has no resolvable scene (empty pool). Mirrors `SceneryStore.sceneName`
   * on mac; unlike mac, mobile keeps no separate assignment-time name map
   * (a photo's `name` is set once at pool build and carried over verbatim by
   * `refreshPool`'s "kept" path), so this just normalizes the current photo's
   * name.
   */
  sceneName(threadKey: string): string | null {
    const photo = this.photoFor(threadKey);
    return photo ? baseSceneName(photo.name) : null;
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
    if (trimmedTitle.length === 0) return { primary: scene, description: null };
    if (trimmedTitle === scene || isLegacyNumberedSceneTitle(trimmedTitle, scene)) {
      return { primary: scene, description: null };
    }
    return { primary: scene, description: trimmedTitle };
  }

  /** Commit a thread → photo binding (after the create was dispatched). */
  assign(photoId: string, threadKey: string): void {
    this.assignments = { ...this.assignments, [threadKey]: photoId };
    void this.storage.saveAssignments(this.assignments);
    this.publish();
  }

  /**
   * Drop a reservation whose thread never materialized (a deleted pending
   * task), so phantom uses stop skewing least-used spread. Delivered threads
   * keep their assignment.
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
        return sizedImageURL(base, { width: this.heroPixelWidth, blur: 35, saturation: 5 });
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

    const titleKey = sceneNameComparisonKey(SET_TITLE);
    const refreshed = capped.map((photo, index) => {
      const base = SCENE_NAMES[index % SCENE_NAMES.length]!;
      const lap = Math.floor(index / SCENE_NAMES.length);
      const fallbackName = lap === 0 ? base : `${base} ${lap + 1}`;
      // Prefer the photo's own real Unsplash location name over the curated
      // cycling fallback — never the generic set title itself ("Dolomites"
      // reads as a region, not a place). Mirrors mac's preference for
      // location-derived names over the built-in `sceneNames` list.
      const placeName = photo.placeName;
      const name =
        placeName !== null && sceneNameComparisonKey(placeName) !== titleKey
          ? placeName
          : fallbackName;
      return { ...photo, name };
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
