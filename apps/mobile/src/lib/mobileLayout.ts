function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export type MobileLayoutVariant = "compact" | "split";

export interface MobileLayout {
  readonly variant: MobileLayoutVariant;
  readonly usesSplitView: boolean;
  readonly listPaneWidth: number | null;
  readonly shellPadding: number;
}

export function deriveMobileLayout(input: {
  readonly width: number;
  readonly height: number;
}): MobileLayout {
  const { width, height } = input;
  const shortestEdge = Math.min(width, height);
  const wideEnoughForSplit = width >= 900 || (width >= 700 && shortestEdge >= 700);

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
    listPaneWidth: clamp(Math.round(width * 0.34), 320, 420),
    shellPadding: width >= 1180 ? 20 : 14,
  };
}
