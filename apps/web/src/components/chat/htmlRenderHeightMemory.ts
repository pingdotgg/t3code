import { createDeferredStorage, type StateStorage } from "~/lib/storage";

const STORAGE_KEY = "t3code:html-render-heights:v1";
const MAX_RENDERS = 200;
// A window drag reports a height at every width it passes; only the latest few are worth keeping.
const MAX_WIDTHS_PER_RENDER = 4;
const SAVE_DELAY_MS = 1000;

type RememberedHeights = ReadonlyArray<readonly [width: number, height: number]>;
type Entries = ReadonlyArray<readonly [attachmentId: string, heights: RememberedHeights]>;

function readEntries(raw: unknown): Entries {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) =>
      Array.isArray(entry) &&
      typeof entry[0] === "string" &&
      Array.isArray(entry[1]) &&
      entry[1].every(
        (pair: unknown) =>
          Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1]),
      )
        ? [[entry[0], entry[1] as RememberedHeights] as const]
        : [],
    );
  } catch {
    return [];
  }
}

/**
 * The heights each render's page reported, by the frame width it reported them at. Client fonts
 * wrap a page differently from the server's measuring fonts, so only the page's own report is
 * exact, and it is kept across a reload for the next time the frame opens at that width.
 */
export function createHtmlRenderHeightMemory(base: Partial<StateStorage> | null | undefined) {
  const storage = createDeferredStorage<Entries>(base, JSON.stringify, SAVE_DELAY_MS);
  const renders = new Map(readEntries(storage.getItem(STORAGE_KEY)));
  return {
    get: (attachmentId: string): RememberedHeights => renders.get(attachmentId) ?? [],
    remember: (attachmentId: string, width: number, height: number) => {
      const others = (renders.get(attachmentId) ?? []).filter(
        ([remembered]) => remembered !== Math.round(width),
      );
      renders.delete(attachmentId);
      renders.set(
        attachmentId,
        [...others, [Math.round(width), height] as const].slice(-MAX_WIDTHS_PER_RENDER),
      );
      if (renders.size > MAX_RENDERS) {
        const oldest = renders.keys().next().value;
        if (oldest !== undefined) renders.delete(oldest);
      }
      storage.setItem(STORAGE_KEY, [...renders]);
    },
    flush: storage.flush,
  };
}

export function rememberedHtmlRenderHeight(heights: RememberedHeights, width: number) {
  return heights.find(([remembered]) => remembered === Math.round(width))?.[1];
}

function browserStorage() {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export const htmlRenderHeightMemory = createHtmlRenderHeightMemory(browserStorage());
// A reload inside the save delay would otherwise drop the heights just reported.
if (typeof window !== "undefined")
  window.addEventListener("pagehide", htmlRenderHeightMemory.flush);
