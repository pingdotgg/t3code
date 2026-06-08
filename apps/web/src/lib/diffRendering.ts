import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

export const DIFF_THEME_NAMES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

export const DIFF_RENDER_UNSAFE_CSS = `
:host {
  --diffs-font-family: var(
    --font-mono,
    "SF Mono",
    Monaco,
    Consolas,
    "Ubuntu Mono",
    "Liberation Mono",
    "Courier New",
    monospace
  );
  --diffs-font-size: 11px;
  --diffs-line-height: 17px;
}

[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  min-height: 32px !important;
  padding-block: 0 !important;
  padding-inline: 6px !important;
  gap: 6px !important;
  align-items: center !important;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}

[data-diffs-header] [data-header-content] {
  align-items: center !important;
  gap: 6px !important;
}

[data-diffs-header] [data-title] {
  font-size: 12px !important;
}

[data-diffs-header] [data-change-icon] {
  width: 14px !important;
  height: 14px !important;
}

[data-diffs-header] [data-metadata] {
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
}

[data-diffs-header] [data-metadata] > * {
  display: inline-flex !important;
  align-items: center !important;
  height: 16px !important;
  line-height: 16px !important;
}

[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-size: 12px !important;
  font-variant-numeric: tabular-nums;
}

/* "Ghost line" treatment for the collapsed "XX unmodified lines" context
 * separators. The library defaults to a solid full-width grey band (32px tall,
 * 8px margin) that competes visually with the actual diff. We strip the fill,
 * draw a single faint hairline through the row, mute the count text, and only
 * reveal the expand chevrons on hover so unmodified regions recede. */
[data-separator=line-info],
[data-separator=line-info-basic] {
  height: 22px !important;
  margin-block: 1px !important;
  background-color: transparent !important;
}

[data-separator=line-info] [data-separator-wrapper],
[data-separator=line-info-basic] [data-separator-wrapper] {
  background-color: transparent !important;
  background-image: linear-gradient(
    to bottom,
    transparent calc(50% - 0.5px),
    var(--border) calc(50% - 0.5px),
    var(--border) calc(50% + 0.5px),
    transparent calc(50% + 0.5px)
  ) !important;
}

[data-separator=line-info] [data-separator-content],
[data-separator=line-info-basic] [data-separator-content] {
  background-color: transparent !important;
}

/* Mask the hairline behind the count text so the line appears to break around
 * the words rather than strike through them. */
[data-separator=line-info] [data-unmodified-lines],
[data-separator=line-info-basic] [data-unmodified-lines] {
  background-color: var(--diffs-bg) !important;
  padding-inline: 6px !important;
  font-size: 11px !important;
  color: var(--diffs-fg-number) !important;
}

/* Expand chevrons stay invisible until the row is hovered. */
[data-separator=line-info] [data-expand-button],
[data-separator=line-info-basic] [data-expand-button] {
  background-color: transparent !important;
  opacity: 0 !important;
  transition: opacity 120ms ease !important;
}

[data-separator=line-info]:hover [data-expand-button],
[data-separator=line-info-basic]:hover [data-expand-button] {
  opacity: 1 !important;
}
`;

export const INLINE_DIFF_RENDER_UNSAFE_CSS = `
:host {
  --diffs-font-family: var(
    --font-mono,
    "SF Mono",
    Monaco,
    Consolas,
    "Ubuntu Mono",
    "Liberation Mono",
    "Courier New",
    monospace
  );
  --diffs-font-size: 12px;
  --diffs-line-height: 18px;
  --diffs-bg: var(--background) !important;
  --diffs-light-bg: var(--background) !important;
  --diffs-dark-bg: var(--background) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;
}

[data-diffs-header] {
  min-height: 44px;
  padding-inline: 16px !important;
  gap: 8px !important;
  background-color: var(--background) !important;
  border-bottom: 1px solid var(--border) !important;
}

[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  background-color: var(--background) !important;
}

[data-title] {
  color: var(--foreground) !important;
}
`;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return theme === "dark" ? DIFF_THEME_NAMES.dark : DIFF_THEME_NAMES.light;
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

export function buildPatchCacheKey(patch: string, scope = "diff-panel"): string {
  const normalizedPatch = patch.trim();
  const primary = fnv1a32(normalizedPatch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(
    normalizedPatch,
    SECONDARY_HASH_SEED,
    SECONDARY_HASH_MULTIPLIER,
  ).toString(36);
  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`;
}

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

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

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

export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

export function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

export function getDiffCollapseIconClassName(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "text-[var(--diffs-addition-base)]";
    case "deleted":
      return "text-[var(--diffs-deletion-base)]";
    case "change":
    case "rename-pure":
    case "rename-changed":
      return "text-[var(--diffs-modified-base)]";
    default:
      return "text-muted-foreground/80";
  }
}
