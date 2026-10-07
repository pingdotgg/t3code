export const MARKDOWN_IMAGE_MAX_WIDTH = 480;
export const MARKDOWN_IMAGE_MAX_HEIGHT = 480;

export interface MarkdownImageDisplaySize {
  readonly width: number;
  readonly height: number;
}

/** SVG percentages need a viewport; use the intrinsic viewBox in that case. */
export function resolveSvgImageSize(props: Readonly<Record<string, unknown>>) {
  const dimension = (value: unknown) => {
    if (typeof value === "number") return value;
    if (typeof value !== "string" || !/^\s*\d+(?:\.\d+)?(?:px)?\s*$/.test(value)) return NaN;
    return Number.parseFloat(value);
  };
  const width = dimension(props.width);
  const height = dimension(props.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)
    return { width, height };
  const viewBox =
    typeof props.viewBox === "string"
      ? props.viewBox
          .trim()
          .split(/[\s,]+/)
          .map(Number)
      : [];
  if (
    viewBox.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    viewBox[2]! <= 0 ||
    viewBox[3]! <= 0
  )
    return null;
  return { width: viewBox[2]!, height: viewBox[3]! };
}

/** Keeps small images intrinsic while fitting larger images inside the chat viewport. */
export function resolveMarkdownImageDisplaySize(input: {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly availableWidth: number;
}): MarkdownImageDisplaySize | null {
  if (
    !Number.isFinite(input.sourceWidth) ||
    !Number.isFinite(input.sourceHeight) ||
    !Number.isFinite(input.availableWidth) ||
    input.sourceWidth <= 0 ||
    input.sourceHeight <= 0 ||
    input.availableWidth <= 0
  ) {
    return null;
  }

  const scale = Math.min(
    1,
    input.availableWidth / input.sourceWidth,
    MARKDOWN_IMAGE_MAX_WIDTH / input.sourceWidth,
    MARKDOWN_IMAGE_MAX_HEIGHT / input.sourceHeight,
  );

  return {
    width: input.sourceWidth * scale,
    height: input.sourceHeight * scale,
  };
}
