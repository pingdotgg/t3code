import type { CodeViewDiffItem, FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewDiffProps } from "@t3tools/extension-sdk/environment";

import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  fnv1a32,
  getRenderablePatch,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
  type RenderablePatch,
} from "~/lib/diffRendering";

/**
 * Parses a plugin patch with the native parser. The theme is part of the
 * cache scope for the same reason as the native Diff panel: Pierre's
 * rendered-AST cache is keyed by it.
 */
export function parseCodeViewPatch(patch: string, theme: "light" | "dark"): RenderablePatch | null {
  return getRenderablePatch(patch, `extension-code-view:${theme}`);
}

export interface CodeViewDiffFile {
  readonly path: string;
  readonly item: CodeViewDiffItem<undefined>;
}

// Parsed files are cached per patch, so each file's content hash is computed
// once rather than on every fold toggle (same as the native Diff panel).
const contentVersions = new WeakMap<FileDiffMetadata, number>();
function contentVersion(fileDiff: FileDiffMetadata): number {
  let version = contentVersions.get(fileDiff);
  if (version === undefined) {
    version = buildFileDiffContentVersion(fileDiff);
    contentVersions.set(fileDiff, version);
  }
  return version;
}

/** CodeView items for the parsed files, folded where the plugin asked. */
export function buildCodeViewDiffFiles(
  files: ReadonlyArray<FileDiffMetadata>,
  collapsedPaths: ReadonlyArray<string> | undefined,
): CodeViewDiffFile[] {
  const collapsed = new Set(collapsedPaths);
  return files.map((fileDiff) => {
    const path = resolveFileDiffPath(fileDiff);
    const folded = collapsed.has(path);
    return {
      path,
      item: {
        id: buildFileDiffIdentityKey(fileDiff),
        type: "diff",
        fileDiff,
        collapsed: folded,
        version: fnv1a32(`${contentVersion(fileDiff)}:${folded ? "1" : "0"}`),
      },
    };
  });
}

/** Adapts the plugin's plain loader to Pierre's context-expansion loader. */
export function createCodeViewContentsLoader(
  loadContents: NonNullable<CodeViewDiffProps["loadContents"]>,
  cacheScope: string,
): FileDiffContentsLoader {
  return async (fileDiff) => {
    const path = resolveFileDiffPath(fileDiff);
    const contents = await loadContents(path);
    const newFile = {
      name: path,
      contents: contents.newContents,
      cacheKey: `${cacheScope}:new:${path}`,
    };
    if (fileDiff.type === "rename-pure") return { oldFile: null, newFile };
    const oldPath = resolveFileDiffPreviousPath(fileDiff);
    return {
      oldFile: {
        name: oldPath,
        contents: contents.oldContents,
        cacheKey: `${cacheScope}:old:${oldPath}`,
      },
      newFile,
    };
  };
}
