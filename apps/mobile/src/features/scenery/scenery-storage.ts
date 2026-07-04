import type { SceneryPhoto } from "./unsplash";

/**
 * Disk persistence for the scenery system's metadata. Image bytes are NOT
 * cached here — expo-image's own disk cache holds them, keyed by URL (pool
 * URLs are persisted verbatim, so keys stay stable across launches).
 */

export interface SceneryPoolFile {
  readonly fetchedAt: string;
  readonly photos: ReadonlyArray<SceneryPhoto>;
}

export interface SceneryStorage {
  readonly loadPool: () => Promise<SceneryPoolFile | null>;
  readonly savePool: (file: SceneryPoolFile) => Promise<void>;
  readonly loadAssignments: () => Promise<Record<string, string>>;
  readonly saveAssignments: (assignments: Record<string, string>) => Promise<void>;
  readonly loadRegisteredDownloads: () => Promise<ReadonlyArray<string>>;
  readonly saveRegisteredDownloads: (photoIds: ReadonlyArray<string>) => Promise<void>;
}

const SCENERY_DIRECTORY = "scenery";

async function getSceneryFile(name: string) {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, SCENERY_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, name);
}

async function readJson<A>(name: string): Promise<A | null> {
  try {
    const file = await getSceneryFile(name);
    if (!file.exists) {
      return null;
    }
    return JSON.parse(await file.text()) as A;
  } catch {
    return null;
  }
}

async function writeJson(name: string, value: unknown): Promise<void> {
  try {
    const file = await getSceneryFile(name);
    if (!file.exists) {
      file.create({ intermediates: true, overwrite: true });
    }
    file.write(JSON.stringify(value));
  } catch (cause) {
    console.warn(`[scenery] failed to persist ${name}`, cause);
  }
}

export const expoSceneryStorage: SceneryStorage = {
  loadPool: () => readJson<SceneryPoolFile>("pool.json"),
  savePool: (file) => writeJson("pool.json", file),
  loadAssignments: async () => (await readJson<Record<string, string>>("assignments.json")) ?? {},
  saveAssignments: (assignments) => writeJson("assignments.json", assignments),
  loadRegisteredDownloads: async () =>
    (await readJson<ReadonlyArray<string>>("registered-downloads.json")) ?? [],
  saveRegisteredDownloads: (photoIds) => writeJson("registered-downloads.json", photoIds),
};

/** In-memory storage for tests. */
export function makeMemorySceneryStorage(): SceneryStorage & {
  readonly state: {
    pool: SceneryPoolFile | null;
    assignments: Record<string, string>;
    registeredDownloads: ReadonlyArray<string>;
  };
} {
  const state = {
    pool: null as SceneryPoolFile | null,
    assignments: {} as Record<string, string>,
    registeredDownloads: [] as ReadonlyArray<string>,
  };
  return {
    state,
    loadPool: async () => state.pool,
    savePool: async (file) => {
      state.pool = file;
    },
    loadAssignments: async () => ({ ...state.assignments }),
    saveAssignments: async (assignments) => {
      state.assignments = { ...assignments };
    },
    loadRegisteredDownloads: async () => [...state.registeredDownloads],
    saveRegisteredDownloads: async (photoIds) => {
      state.registeredDownloads = [...photoIds];
    },
  };
}
