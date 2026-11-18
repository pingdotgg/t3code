import type { CSSProperties, PointerEvent } from "react";

export const PIERRE_TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 0.75rem;
  }
  [data-truncate-content='visible'] { overflow: hidden; text-overflow: ellipsis; }
  [data-truncate-marker] { display: none; }
  button[data-type='item'], button[data-type='item']::before { border-radius: var(--radius-md); }
  [data-item-section='content'] { direction: ltr; unicode-bidi: isolate; }
  button:dir(rtl)[data-item-type='folder'][aria-expanded='false']
    > [data-item-section='icon'] > [data-icon-name='file-tree-icon-chevron'] { scale: -1 1; }
  [data-item-section='spacing']:dir(rtl) {
    padding-left: 0;
    padding-inline-start: calc(var(--trees-icon-width) / 2 - .5px);
  }
  [data-item-section='spacing-item']:dir(rtl) {
    border-left: 0;
    border-inline-start: 1px solid var(--trees-indent-guide-bg);
    margin: 0;
    margin-inline-end: calc(var(--trees-level-gap) - 1px);
    transform: translateX(.25px);
    & + & {
      margin-left: 0;
      margin-inline-start: calc(var(--trees-item-row-gap) + var(--trees-icon-width) / 2 - .5px);
    }
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
    ["--trees-fg-muted-override" as string]: "var(--contrast-muted-foreground)",
    ["--trees-status-ignored-override" as string]: "var(--contrast-muted-foreground)",
  };
}

// Clipped labels are unreadable and the tree cannot scroll sideways, so a clipped row gets its full name as a native tooltip.
export function titleClippedPierreTreeRow(event: PointerEvent<HTMLElement>) {
  const row = event.nativeEvent
    .composedPath()
    .find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.matches("button[data-type='item']"),
    );
  if (!row) return;
  const label = row.getAttribute("aria-label");
  const clipped = Array.from(
    row.querySelectorAll<HTMLElement>("[data-truncate-content='visible']"),
  ).some((element) => element.scrollWidth > element.clientWidth);
  if (label && clipped) row.title = label;
  else row.removeAttribute("title");
}
