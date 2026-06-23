function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Use available space, not device or orientation labels, to choose the shell.
 *
 * The height floor deliberately keeps every current iPhone in the compact shell
 * when it rotates to landscape, while still allowing iPad and foldable-sized
 * windows to adopt the persistent sidebar as they resize.
 */
export const SPLIT_LAYOUT_MIN_WIDTH = 720;
export const SPLIT_LAYOUT_MIN_HEIGHT = 600;

const SPLIT_SIDEBAR_MIN_WIDTH = 280;
const SPLIT_SIDEBAR_MAX_WIDTH = 380;

export type LayoutVariant = "compact" | "split";

export interface Layout {
  readonly variant: LayoutVariant;
  readonly usesSplitView: boolean;
  readonly listPaneWidth: number | null;
  readonly shellPadding: number;
}

export function deriveLayout(input: { readonly width: number; readonly height: number }): Layout {
  const { width, height } = input;
  const wideEnoughForSplit = width >= SPLIT_LAYOUT_MIN_WIDTH && height >= SPLIT_LAYOUT_MIN_HEIGHT;

  if (!wideEnoughForSplit) {
    return {
      variant: "compact",
      usesSplitView: false,
      listPaneWidth: null,
      shellPadding: 0,
    };
  }

  return {
    variant: "split",
    usesSplitView: true,
    listPaneWidth: clamp(
      Math.round(width * 0.32),
      SPLIT_SIDEBAR_MIN_WIDTH,
      SPLIT_SIDEBAR_MAX_WIDTH,
    ),
    shellPadding: 0,
  };
}
