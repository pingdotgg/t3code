import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { parseDiffFromFile } from "@pierre/diffs";
import type {
  CodeViewItemScrollTarget,
  CodeViewLineScrollTarget,
  FileDiffMetadata,
} from "@pierre/diffs/types";
import type { VirtualizedFileDiff } from "@pierre/diffs";
import { READABLE_LIGHT_THEME_NAME } from "./readableSyntaxTheme";

export const DIFF_HEADER_HEIGHT = 32;

export type DiffScrollAnchor = (CodeViewItemScrollTarget | CodeViewLineScrollTarget) & {
  align: "start";
  offset: number;
};

interface DiffScrollViewer {
  getScrollTop(): number;
  getHeight(): number;
  getTopForItem(id: string): number | undefined;
  getItem(id: string): { type: "diff"; fileDiff: FileDiffMetadata } | { type: "file" } | undefined;
  getRenderedItems(): ReadonlyArray<{
    id: string;
    instance: Pick<
      VirtualizedFileDiff,
      "getNumericScrollAnchor" | "getVirtualizedHeight" | "getLinePosition"
    >;
  }>;
}

/** The first visible diff line (or file header) and its distance from the viewport top. */
export function captureDiffScrollAnchor(viewer: DiffScrollViewer): DiffScrollAnchor | null {
  const scrollTop = viewer.getScrollTop();
  for (const { id, instance } of viewer.getRenderedItems()) {
    const top = viewer.getTopForItem(id);
    if (top === undefined || top + instance.getVirtualizedHeight() <= scrollTop) continue;
    if (top >= scrollTop + viewer.getHeight()) break;
    if (top < scrollTop) {
      const line = instance.getNumericScrollAnchor(scrollTop + DIFF_HEADER_HEIGHT - top);
      if (line) {
        return {
          type: "line",
          id,
          lineNumber: line.lineNumber,
          ...(line.side ? { side: line.side } : {}),
          align: "start",
          offset: top + line.top - scrollTop - DIFF_HEADER_HEIGHT,
        };
      }
    }
    return { type: "item", id, align: "start", offset: top - scrollTop };
  }
  return null;
}

/**
 * The scroll top that puts `anchor` back where it was: `undefined` while the file is not laid out
 * yet, `null` when the saved line no longer exists in it.
 */
export function resolveDiffScrollAnchorTop(
  viewer: DiffScrollViewer,
  anchor: DiffScrollAnchor,
): number | null | undefined {
  const top = viewer.getTopForItem(anchor.id);
  if (top === undefined) return;
  if (anchor.type === "item") return top - anchor.offset;
  const instance = viewer.getRenderedItems().find(({ id }) => id === anchor.id)?.instance;
  const line = instance?.getLinePosition(anchor.lineNumber, anchor.side);
  if (line) return top + line.top - DIFF_HEADER_HEIGHT - anchor.offset;
  // A rendered file without the line is stale; an unrendered file may still need measuring.
  if (instance) return null;
  const item = viewer.getItem(anchor.id);
  if (item?.type === "diff") {
    const { fileDiff } = item;
    const lastHunk = fileDiff.hunks.at(-1);
    const deletions = anchor.side === "deletions";
    const start = deletions ? lastHunk?.deletionStart : lastHunk?.additionStart;
    const count = deletions ? lastHunk?.deletionCount : lastHunk?.additionCount;
    const lastLine = fileDiff.isPartial
      ? (start ?? 1) + (count ?? 0) - 1
      : (deletions ? fileDiff.deletionLines : fileDiff.additionLines).length;
    if (anchor.lineNumber < 1 || anchor.lineNumber > lastLine) return null;
  }
}

// Light mode uses a darker pierre-light so syntax stays readable on every code surface.
export const DIFF_THEME_NAMES = {
  light: READABLE_LIGHT_THEME_NAME,
  dark: "pierre-dark",
} as const;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return DIFF_THEME_NAMES[theme];
}

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

function buildPatchCacheKey(patch: string, scope = "diff-panel"): string {
  const primary = fnv1a32(patch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(patch, SECONDARY_HASH_SEED, SECONDARY_HASH_MULTIPLIER).toString(36);
  return `${scope}:${patch.length}:${primary}:${secondary}`;
}

export type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
      sourceFiles: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

export interface DiffLineStat {
  additions: number;
  deletions: number;
}

export function getDiffLineStat(files: ReadonlyArray<FileDiffMetadata>): DiffLineStat {
  return files.reduce<DiffLineStat>(
    (total, file) => {
      for (const hunk of file.hunks) {
        total.additions += hunk.additionLines;
        total.deletions += hunk.deletionLines;
      }

      return total;
    },
    { additions: 0, deletions: 0 },
  );
}

interface RenderablePatchOptions {
  ignoreWhitespace?: boolean;
  /** Compact Pierre source offsets for partial-patch rows; retain collapsedBefore for separators. */
  compactPartialHunkOffsets?: boolean;
}

function hideWhitespaceChanges(file: FileDiffMetadata): FileDiffMetadata {
  let splitDelta = 0;
  let unifiedDelta = 0;
  const hunks = file.hunks.map((hunk) => {
    const oldContents = file.deletionLines
      .slice(hunk.deletionLineIndex, hunk.deletionLineIndex + hunk.deletionCount)
      .map((line) => `${line.replace(/\s/g, "")}\n`)
      .join("");
    const newContents = file.additionLines
      .slice(hunk.additionLineIndex, hunk.additionLineIndex + hunk.additionCount)
      .map((line) => `${line.replace(/\s/g, "")}\n`)
      .join("");
    const filtered = parseDiffFromFile(
      { name: file.name, contents: oldContents },
      { name: file.name, contents: newContents },
      { context: Infinity },
    ).hunks[0];
    const next = {
      ...hunk,
      additionLines: filtered?.additionLines ?? 0,
      deletionLines: filtered?.deletionLines ?? 0,
      hunkContent: filtered
        ? filtered.hunkContent.map((content) => ({
            ...content,
            additionLineIndex: content.additionLineIndex + hunk.additionLineIndex,
            deletionLineIndex: content.deletionLineIndex + hunk.deletionLineIndex,
          }))
        : [
            {
              type: "context" as const,
              lines: hunk.additionCount,
              additionLineIndex: hunk.additionLineIndex,
              deletionLineIndex: hunk.deletionLineIndex,
            },
          ],
      splitLineStart: hunk.splitLineStart + splitDelta,
      unifiedLineStart: hunk.unifiedLineStart + unifiedDelta,
      splitLineCount: filtered?.splitLineCount ?? hunk.additionCount,
      unifiedLineCount: filtered?.unifiedLineCount ?? hunk.additionCount,
    };
    splitDelta += next.splitLineCount - hunk.splitLineCount;
    unifiedDelta += next.unifiedLineCount - hunk.unifiedLineCount;
    return next;
  });
  return {
    ...file,
    hunks,
    splitLineCount: file.splitLineCount + splitDelta,
    unifiedLineCount: file.unifiedLineCount + unifiedDelta,
    ...(file.cacheKey ? { cacheKey: `${file.cacheKey}:ignore-whitespace` } : {}),
  };
}

function compactPartialHunkOffsets(file: FileDiffMetadata): FileDiffMetadata {
  if (!file.isPartial) return file;

  let splitLineStart = 0;
  let unifiedLineStart = 0;
  const hunks = file.hunks.map((hunk) => {
    const compactHunk = {
      ...hunk,
      splitLineStart,
      unifiedLineStart,
    };
    splitLineStart += hunk.splitLineCount;
    unifiedLineStart += hunk.unifiedLineCount;
    return compactHunk;
  });

  return {
    ...file,
    hunks,
    splitLineCount: splitLineStart,
    unifiedLineCount: unifiedLineStart,
    ...(file.cacheKey ? { cacheKey: `${file.cacheKey}:compact-partial` } : {}),
  };
}

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
  options: RenderablePatchOptions = {},
): RenderablePatch | null {
  if (!patch?.trim()) return null;

  try {
    const parsedPatches = parsePatchFiles(patch, {
      cacheKeyPrefix: buildPatchCacheKey(patch, cacheScope),
    });
    const sourceFiles = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    const files = sourceFiles.map((file) => {
      const filtered = options.ignoreWhitespace ? hideWhitespaceChanges(file) : file;
      return options.compactPartialHunkOffsets ? compactPartialHunkOffsets(filtered) : filtered;
    });
    if (files.length > 0) {
      return { kind: "files", files, sourceFiles };
    }

    return {
      kind: "raw",
      text: patch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: patch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

/** Uses the parser-decoded filename, including Git's quoted and escaped names. */
export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  return fileDiff.name ?? fileDiff.prevName ?? "";
}

export function resolveFileDiffPreviousPath(fileDiff: FileDiffMetadata): string {
  return fileDiff.prevName ?? fileDiff.name ?? "";
}

/** Includes change type to distinguish deletion/addition pairs for file-to-symlink changes. */
export function buildFileDiffIdentityKey(fileDiff: FileDiffMetadata): string {
  return `${resolveFileDiffPreviousPath(fileDiff)}\u0000${resolveFileDiffPath(fileDiff)}\u0000${fileDiff.type}`;
}

export function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  const cacheKey = fileDiff.cacheKey;
  if (!cacheKey) return `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;

  return cacheKey.endsWith(":hydrated") ? cacheKey.slice(0, -":hydrated".length) : cacheKey;
}

function hashFileDiffPart(hash: number, value: string | number | boolean | undefined): number {
  const serialized = value === undefined ? "undefined" : String(value);
  const withLength = fnv1a32(`${typeof value}:${serialized.length}:`, hash);
  return fnv1a32(serialized, withLength);
}

// Pierre's whole-patch cache key would repaint every file when one changes.
export function buildFileDiffContentVersion(fileDiff: FileDiffMetadata): number {
  let hash = FNV_OFFSET_BASIS_32;
  const append = (value: string | number | boolean | undefined) => {
    hash = hashFileDiffPart(hash, value);
  };

  append(fileDiff.name);
  append(fileDiff.prevName);
  append(fileDiff.lang);
  append(fileDiff.newObjectId);
  append(fileDiff.prevObjectId);
  append(fileDiff.mode);
  append(fileDiff.prevMode);
  append(fileDiff.type);
  append(fileDiff.isPartial);
  append(fileDiff.splitLineCount);
  append(fileDiff.unifiedLineCount);

  for (const line of fileDiff.additionLines) append(line);
  for (const line of fileDiff.deletionLines) append(line);
  for (const hunk of fileDiff.hunks) {
    append(hunk.collapsedBefore);
    append(hunk.additionStart);
    append(hunk.additionCount);
    append(hunk.additionLines);
    append(hunk.additionLineIndex);
    append(hunk.deletionStart);
    append(hunk.deletionCount);
    append(hunk.deletionLines);
    append(hunk.deletionLineIndex);
    append(hunk.hunkContext);
    append(hunk.hunkSpecs);
    append(hunk.splitLineStart);
    append(hunk.splitLineCount);
    append(hunk.unifiedLineStart);
    append(hunk.unifiedLineCount);
    append(hunk.noEOFCRAdditions);
    append(hunk.noEOFCRDeletions);
    for (const content of hunk.hunkContent) {
      append(content.type);
      append(content.additionLineIndex);
      append(content.deletionLineIndex);
      append(content.type === "change" ? content.additions : content.lines);
      append(content.type === "change" ? content.deletions : undefined);
    }
  }

  return hash;
}

export const DIFF_SURFACE_THEME_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: var(--code-background) !important;
  --diffs-light-bg: var(--code-background) !important;
  --diffs-dark-bg: var(--code-background) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  /* Gutter, context, and row tints all derive from the code surface the diff
     body sits on. Mixing from the canvas leaves the gutter looking unthemed
     when a palette separates the two. */
  --diffs-bg-context-override: color-mix(in srgb, var(--code-background) 97%, var(--code-foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--code-background) 94%, var(--code-foreground));
  --diffs-bg-separator-override: color-mix(
    in srgb,
    var(--code-background) 95%,
    var(--code-foreground)
  );
  --diffs-bg-buffer-override: color-mix(in srgb, var(--code-background) 90%, var(--code-foreground));

  --diffs-bg-addition-override: light-dark(
    color-mix(in srgb, var(--code-background) 50%, var(--diff-addition)),
    color-mix(in srgb, var(--code-background) 70%, var(--diff-addition))
  );
  --diffs-bg-addition-number-override: light-dark(
    color-mix(in srgb, var(--code-background) 35%, var(--diff-addition)),
    color-mix(in srgb, var(--code-background) 60%, var(--diff-addition))
  );
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--code-background) 85%, var(--diff-addition));
  --diffs-bg-addition-emphasis-override: color-mix(
    in srgb,
    var(--code-background) 80%,
    var(--diff-addition)
  );

  --diffs-bg-deletion-override: light-dark(
    color-mix(in srgb, var(--code-background) 50%, var(--diff-deletion)),
    color-mix(in srgb, var(--code-background) 70%, var(--diff-deletion))
  );
  --diffs-bg-deletion-number-override: light-dark(
    color-mix(in srgb, var(--code-background) 35%, var(--diff-deletion)),
    color-mix(in srgb, var(--code-background) 60%, var(--diff-deletion))
  );
  --diffs-bg-deletion-hover-override: color-mix(
    in srgb,
    var(--code-background) 85%,
    var(--diff-deletion)
  );
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--code-background) 80%,
    var(--diff-deletion)
  );

  background-color: var(--diffs-bg) !important;
  color: var(--code-foreground) !important;
}

/* The library's change-icon colors are tuned for dark canvases; light mode takes the app's darker tokens. */
[data-change-icon="new"] {
  color: var(
    --diff-added-icon,
    light-dark(var(--diff-addition-foreground), var(--diffs-addition-base))
  ) !important;
}
[data-change-icon="deleted"] {
  color: light-dark(var(--diff-deletion-foreground), var(--diffs-deletion-base)) !important;
}
/* The page sets --diff-modified-icon to a muted T3 blue, so the common case stays quiet. */
[data-change-icon="change"],
[data-change-icon="rename-pure"],
[data-change-icon="rename-changed"] {
  color: var(
    --diff-modified-icon,
    light-dark(var(--info-foreground), var(--diffs-modified-base))
  ) !important;
}
`;
