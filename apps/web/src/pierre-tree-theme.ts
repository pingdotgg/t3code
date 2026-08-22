import type { CSSProperties } from "react";

interface PierreTreeStyle extends CSSProperties {
  readonly "--trees-fg-override": string;
}

/** Shared shadow-root theme overrides for Pierre file-tree surfaces. */
export const PIERRE_TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

/** Resolves the host styles that keep a Pierre tree aligned with the active app theme. */
export function pierreTreeStyle(colorScheme: CSSProperties["colorScheme"]): PierreTreeStyle {
  return {
    colorScheme,
    "--trees-fg-override": "var(--foreground)",
  };
}
