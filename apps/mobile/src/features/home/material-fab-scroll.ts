export interface MaterialFabScrollState {
  readonly anchor: number;
  readonly expanded: boolean;
}

/** Ignore small direction changes and overscroll; always show the label at the top. */
export function updateMaterialFabScroll(
  state: MaterialFabScrollState,
  offset: number,
  maxOffset: number,
): MaterialFabScrollState {
  const y = Math.max(0, Math.min(offset, Math.max(0, maxOffset)));
  if (y <= 8) return { anchor: y, expanded: true };
  const anchor = state.expanded ? Math.min(state.anchor, y) : Math.max(state.anchor, y);
  if (Math.abs(y - anchor) >= 12) return { anchor: y, expanded: !state.expanded };
  return { anchor, expanded: state.expanded };
}
