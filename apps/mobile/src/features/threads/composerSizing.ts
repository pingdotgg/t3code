export const COMPOSER_EDITOR_MIN_HEIGHT = 80;
export const COMPOSER_EDITOR_MAX_HEIGHT = 160;
export const COMPOSER_EDITOR_EXPANDED_CONTENT_INSET_VERTICAL = 4;

export function deriveComposerEditorSizing(contentHeight: number): {
  readonly height: number;
  readonly scrollEnabled: boolean;
} {
  const safeContentHeight = Number.isFinite(contentHeight)
    ? contentHeight
    : COMPOSER_EDITOR_MIN_HEIGHT;

  return {
    height: Math.min(
      Math.max(safeContentHeight, COMPOSER_EDITOR_MIN_HEIGHT),
      COMPOSER_EDITOR_MAX_HEIGHT,
    ),
    scrollEnabled: safeContentHeight > COMPOSER_EDITOR_MAX_HEIGHT,
  };
}
