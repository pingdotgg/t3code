import type { DiffFileDelta, DiffSnapshot } from "@t3tools/contracts";

export const DIFF_THEME_NAMES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

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

export function applyDiffFileDelta(snapshot: DiffSnapshot, delta: DiffFileDelta): DiffSnapshot {
  if (
    snapshot.threadId !== delta.threadId ||
    snapshot.fromTurnCount !== delta.fromTurnCount ||
    snapshot.toTurnCount !== delta.toTurnCount ||
    snapshot.scope !== delta.scope
  ) {
    return snapshot;
  }

  const nextFiles = new Map(snapshot.files.map((file) => [file.path, file] as const));
  if (delta.file) {
    nextFiles.set(delta.path, delta.file);
  } else {
    nextFiles.delete(delta.path);
  }

  return {
    ...snapshot,
    metadata: delta.metadata,
    files: [...nextFiles.values()].toSorted((left, right) => left.path.localeCompare(right.path)),
  };
}

/**
 * Maps every diff/file surface the @pierre/diffs renderer paints onto the
 * app's code tokens, so themed palettes reach the code body, gutter, and
 * row tints instead of the renderer's bundled colors. Shared by the diff
 * panel and the file preview.
 */
export const DIFF_SURFACE_THEME_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-line-height: var(--app-file-preview-line-height) !important;
  --diffs-bg: var(--code-background) !important;
  --diffs-light-bg: var(--code-background) !important;
  --diffs-dark-bg: var(--code-background) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  /* Gutter, context, and row tints all derive from the code surface the diff
     body sits on — mixing from the canvas leaves the gutter looking unthemed
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

pre,
[data-code],
[data-line] {
  line-height: var(--app-file-preview-line-height) !important;
}
`;
