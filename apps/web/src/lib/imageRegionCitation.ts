/**
 * Geometry for citing part of an image. Points and regions are fractions (0 to 1) of the image's
 * natural size, so a region keeps its place while the viewer zooms and pans.
 */
export interface ImagePoint {
  readonly x: number;
  readonly y: number;
}

export interface ImageRegion extends ImagePoint {
  readonly width: number;
  readonly height: number;
}

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ClientBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A drag must cover this many screen pixels in both directions to become a region. */
const MIN_REGION_SCREEN_PX = 6;
/** Providers downscale larger images before the model sees them; bigger crops only cost upload. */
const MAX_CROP_EDGE_PX = 2048;
/** Enough room for the outline and its halo when the region sits away from the image edge. */
const MIN_CROP_PADDING_PX = 6;
/** Keeps floating-point noise, as in 0.4 + 0.2, from growing a region by a pixel. */
const PIXEL_EPSILON = 1e-6;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Where a pointer sits over the displayed image, clamped to the image edges. */
export function imagePointFromClient(
  client: { readonly x: number; readonly y: number },
  bounds: ClientBounds,
): ImagePoint {
  return {
    x: bounds.width > 0 ? clamp01((client.x - bounds.left) / bounds.width) : 0,
    y: bounds.height > 0 ? clamp01((client.y - bounds.top) / bounds.height) : 0,
  };
}

/** The rectangle between two points, whichever way the drag went. */
export function imageRegionBetween(a: ImagePoint, b: ImagePoint): ImageRegion {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** Tiny drags are stray clicks. Size is measured on screen, at the zoom the user drew them. */
export function isCitableImageRegion(region: ImageRegion, bounds: ClientBounds): boolean {
  return (
    region.width * bounds.width >= MIN_REGION_SCREEN_PX &&
    region.height * bounds.height >= MIN_REGION_SCREEN_PX
  );
}

export interface ImageRegionCrop {
  /** Source pixels copied into the crop. */
  readonly source: PixelRect;
  /** Crop size in output pixels. */
  readonly width: number;
  readonly height: number;
  /** The cited region in output pixels. Outlines are stroked outside it. */
  readonly region: PixelRect;
  readonly lineWidth: number;
}

/**
 * The crop sent for a cited region. Padding keeps what the region sits beside: a quarter of the
 * region's longer side, and at least 2% of the image's longer side.
 */
export function imageRegionCrop(
  region: ImageRegion,
  image: { readonly width: number; readonly height: number },
): ImageRegionCrop {
  const start = (value: number, size: number) =>
    Math.min(size - 1, Math.floor(clamp01(value) * size + PIXEL_EPSILON));
  const end = (value: number, size: number) => Math.ceil(clamp01(value) * size - PIXEL_EPSILON);
  const left = start(region.x, image.width);
  const top = start(region.y, image.height);
  const right = Math.max(left + 1, end(region.x + region.width, image.width));
  const bottom = Math.max(top + 1, end(region.y + region.height, image.height));
  const padding = Math.round(
    Math.max(
      Math.max(right - left, bottom - top) * 0.25,
      Math.max(image.width, image.height) * 0.02,
      MIN_CROP_PADDING_PX,
    ),
  );
  const sourceX = Math.max(0, left - padding);
  const sourceY = Math.max(0, top - padding);
  const sourceWidth = Math.min(image.width, right + padding) - sourceX;
  const sourceHeight = Math.min(image.height, bottom + padding) - sourceY;
  const scale = Math.min(1, MAX_CROP_EDGE_PX / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  return {
    source: { x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight },
    width,
    height,
    region: {
      x: (left - sourceX) * scale,
      y: (top - sourceY) * scale,
      width: (right - left) * scale,
      height: (bottom - top) * scale,
    },
    lineWidth: Math.max(2, Math.round(Math.max(width, height) / 400)),
  };
}

/** Names the crop after its source, so the chip and the agent can tell where it came from. */
export function imageRegionCitationName(sourceName: string): string {
  const base = sourceName.split(/[\\/]/).pop() ?? "";
  const stem = base
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .trim()
    .slice(0, 80)
    .trim();
  return `${stem || "image"} region.png`;
}
