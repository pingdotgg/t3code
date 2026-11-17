import type { CSSProperties } from "react";

export const PIERRE_TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, var(--foreground) 11%, transparent);
    --trees-hover-bg-override: var(--shell-highlight);
    --trees-fg-muted-override: var(--muted-foreground);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 0.8125rem;
  }
  [data-truncate-content='visible'] { overflow: hidden; text-overflow: ellipsis; }
  [data-truncate-marker] { display: none; }
  button[data-type='item'], button[data-type='item']::before { border-radius: 5px; }
  :host { --trees-item-margin-x-override: 2px; --trees-item-padding-x-override: 8px; }
  /* Row backgrounds start 8px (6 padding + 2 margin) from the panel edge, like the search field; icons start 16px (+8 row padding), like its icon. */
  [data-file-tree-virtualized-scroll='true'][data-file-tree-virtualized-scroll='true'] { padding-inline: 6px; }
  [data-icon-name='file-tree-icon-chevron'] { width: 12px; height: 12px; }
  /* The app's inset scrollbar (.scrollbar-inset), which cannot reach into this shadow root:
     a round thumb held 5px off the edge and the ends, plus 4px more at the top and bottom
     so it stays clear of the panel's toolbar and rounded corner. */
  [data-file-tree-virtualized-scroll='true']::-webkit-scrollbar { width: 16px; }
  [data-file-tree-virtualized-scroll='true']::-webkit-scrollbar-track { background: transparent; margin-block: 4px; }
  [data-file-tree-virtualized-scroll='true']::-webkit-scrollbar-thumb {
    background: var(--app-scrollbar-thumb);
    border: 5px solid transparent;
    border-radius: 9999px;
    background-clip: padding-box;
  }
  [data-file-tree-virtualized-scroll='true']::-webkit-scrollbar-thumb:hover { background: var(--app-scrollbar-thumb-hover); background-clip: padding-box; }
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
    ["--trees-fg-muted-override" as string]: "var(--contrast-muted-foreground)",
    ["--trees-status-ignored-override" as string]: "var(--contrast-muted-foreground)",
  };
}
