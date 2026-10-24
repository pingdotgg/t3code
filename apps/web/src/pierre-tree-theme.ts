import type { CSSProperties } from "react";

export const PIERRE_TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-bg-muted-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-focus-ring-color-override: var(--ring);
    --trees-selected-focused-border-color-override: var(--ring);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 0.75rem;
  }
  [data-truncate-content='visible'] { overflow: hidden; text-overflow: ellipsis; }
  [data-truncate-marker] { display: none; }
  button[data-type='item'], button[data-type='item']::before { border-radius: var(--radius-md); }
  /* Deep indentation must leave room for a readable, ellipsized name. */
  [data-item-section='spacing'] { max-width: max(0px, calc(100% - 180px)); flex-shrink: 0; overflow: hidden; }
  /* Keep path labels in one text lane; Pierre's segment truncation overlaps at narrow widths. */
  [data-item-section='content'] { flex: 1 1 0; white-space: nowrap; text-overflow: ellipsis; }
  [data-item-section='content'] div, [data-item-section='content'] span {
    display: inline;
    direction: ltr;
  }
  [data-item-section='content'] [data-truncate-content='overflow'],
  [data-item-section='content'] [data-truncate-marker-cell],
  [data-item-section='content'] [data-truncate-fill] { display: none; }
  [data-item-section='decoration'] { flex: 0 0 auto; }
  svg[data-icon-name='t3-tree-icon-loading'] { opacity: 0.6; }
  @media (prefers-reduced-motion: no-preference) {
    svg[data-icon-name='t3-tree-icon-loading'] { animation: t3-tree-spin 1s linear infinite; }
  }
  @keyframes t3-tree-spin { to { transform: rotate(360deg); } }
`;

export function pierreTreeStyle(colorScheme: "light" | "dark"): CSSProperties {
  return {
    colorScheme,
    ["--trees-fg-override" as string]: "var(--contrast-foreground)",
  };
}
