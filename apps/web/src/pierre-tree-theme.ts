import type { CSSProperties } from "react";

export const PIERRE_TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-focus-ring-color-override: var(--ring);
    --trees-selected-focused-border-color-override: var(--ring);
    --trees-selected-bg-override: light-dark(
      color-mix(in srgb, var(--color-black) 5.1%, transparent),
      color-mix(in srgb, var(--color-white) 5.1%, transparent)
    );
    --trees-bg-muted-override: var(--sidebar-row-hover);
    --trees-fg-muted-override: var(--dim-foreground);
    --trees-git-modified-color-override: var(--diff-modified);
    --trees-git-renamed-color-override: var(--diff-modified);
    --trees-git-added-color-override: var(--diff-addition-foreground);
    --trees-git-untracked-color-override: var(--diff-addition-foreground);
    --trees-git-deleted-color-override: var(--diff-deletion-foreground);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 0.75rem;
  }
  [data-truncate-content='visible'] { overflow: hidden; text-overflow: ellipsis; }
  [data-truncate-marker] { display: none; }
  button[data-type='item'], button[data-type='item']::before { border-radius: 6px; }
  /* Hover and selected rows take the surface style's row fills (index.css --tree-row-*), which
     are gradients; without a style override they paint the flat colors above. */
  button[data-type='item']:is(:hover, [data-item-context-hover='true']) {
    background: var(--tree-row-hover-fill, linear-gradient(var(--trees-bg-muted), var(--trees-bg-muted)));
  }
  button[data-type='item'][data-item-selected='true'] {
    background: var(--tree-row-selected-fill, linear-gradient(var(--trees-selected-bg), var(--trees-selected-bg)));
    box-shadow: inset 0 0 0 1px var(--tree-row-selected-rim, transparent);
  }
  /* A mouse-focused row paints like a plain selection; the ring stays for keyboard focus. */
  button[data-type='item']:focus:not(:focus-visible)::before { outline-color: transparent; }
  /* Narrow columns: rows sit 4px in and indent 12px per level, and the host never widens its
     column to fit a name. */
  :host {
    --trees-padding-inline-override: 4px;
    --trees-level-gap-override: 0px;
    contain: inline-size;
  }
  /* Names end-truncate with a native ellipsis. Pierre's middle truncation collapses the stem
     to nothing in narrow columns, and its marker masks the cut with the tree background, which
     is transparent here, so the ellipsis printed over the glyphs. */
  [data-item-section='content'] > :is(div, span) {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-item-section='content'] > * :is(div, span) { display: inline; direction: ltr; }
  [data-item-section='content'] :is([data-truncate-marker-cell], [data-truncate-content='overflow'], [data-truncate-fill]) {
    display: none;
  }
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
