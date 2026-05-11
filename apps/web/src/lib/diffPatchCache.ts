import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { buildPatchCacheKey } from "./diffRendering";

export type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

const MAX_RENDERABLE_PATCH_CACHE_ENTRIES = 24;
const renderablePatchCache = new Map<string, RenderablePatch>();

function normalizePatch(patch: string | undefined): string | null {
  if (!patch) {
    return null;
  }
  const normalizedPatch = patch.trim();
  return normalizedPatch.length > 0 ? normalizedPatch : null;
}

function touchRenderablePatchCacheEntry(key: string, value: RenderablePatch): RenderablePatch {
  renderablePatchCache.delete(key);
  renderablePatchCache.set(key, value);

  while (renderablePatchCache.size > MAX_RENDERABLE_PATCH_CACHE_ENTRIES) {
    const oldestKey = renderablePatchCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    renderablePatchCache.delete(oldestKey);
  }

  return value;
}

function createRenderablePatch(normalizedPatch: string, cacheScope: string): RenderablePatch {
  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

export function readRenderablePatchCache(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | undefined {
  const normalizedPatch = normalizePatch(patch);
  if (!normalizedPatch) {
    return undefined;
  }

  const cacheKey = buildPatchCacheKey(normalizedPatch, cacheScope);
  const cached = renderablePatchCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  return touchRenderablePatchCacheEntry(cacheKey, cached);
}

export function getOrCreateRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  const normalizedPatch = normalizePatch(patch);
  if (!normalizedPatch) {
    return null;
  }

  const cacheKey = buildPatchCacheKey(normalizedPatch, cacheScope);
  const cached = renderablePatchCache.get(cacheKey);
  if (cached) {
    return touchRenderablePatchCacheEntry(cacheKey, cached);
  }

  return touchRenderablePatchCacheEntry(
    cacheKey,
    createRenderablePatch(normalizedPatch, cacheScope),
  );
}

export function primeRenderablePatchCache(
  patch: string | undefined,
  cacheScope = "diff-panel",
): void {
  void getOrCreateRenderablePatch(patch, cacheScope);
}

export function resetRenderablePatchCacheForTests(): void {
  renderablePatchCache.clear();
}

export function getRenderablePatchCacheEntryCountForTests(): number {
  return renderablePatchCache.size;
}
