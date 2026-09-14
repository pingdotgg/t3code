import type { DevicePlatform, PreviewViewportSetting } from "@t3tools/contracts";

import type { BrowserSurfaceContentPresentation } from "~/browser/browserSurfaceStore";
import {
  resolveFittedBrowserViewport,
  type BrowserViewportResizeDirection,
} from "~/browser/browserViewportLayout";
import type { PreviewMiniPlayerPosition, PreviewMiniPlayerSize } from "~/previewMiniPlayerStore";

import type { DeviceScreenSize } from "../device/deviceStream";

export const PREVIEW_MINI_PLAYER_EDGE_GAP = 12;
export const PREVIEW_MINI_PLAYER_CORNER_RADIUS = 12;
// The mini-player shell straddles this webview at 47 and 49; dialogs begin at 50.
export const PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX = 48;
// A fresh player is the largest box at the source aspect ratio that fits here.
const PREVIEW_MINI_PLAYER_DEFAULT_BOX = { width: 320, height: 320 } as const;
const PREVIEW_MINI_PLAYER_MIN_SIZE = { width: 240, height: 150 } as const;

export interface PreviewMiniPlayerFrame extends PreviewMiniPlayerPosition, PreviewMiniPlayerSize {}

/**
 * The rendered size of what the floating player mirrors: the device viewport
 * when one is set, otherwise the size the webview had when it was floated
 * (`fittedSourceContent`), which the hosted webview keeps as its CSS viewport.
 */
export function resolvePreviewMiniPlayerSourceSize(
  viewport: PreviewViewportSetting,
  fittedSourceContent: BrowserSurfaceContentPresentation | null,
  zoomFactor: number,
): PreviewMiniPlayerSize {
  const normalizedZoomFactor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const fitted = resolveFittedBrowserViewport(viewport, fittedSourceContent, normalizedZoomFactor);
  return {
    width: fitted.width * normalizedZoomFactor,
    height: fitted.height * normalizedZoomFactor,
  };
}

/**
 * The device screen as the user sees it, so a rotated phone floats as a
 * landscape box. Before the stream reports its size the platform's usual phone
 * shape stands in, matching the stream view's own placeholder aspect; the
 * nominal width only keeps the source cap above any sensible player width.
 */
export function resolveDeviceMiniPlayerSourceSize(
  platform: DevicePlatform,
  screen: DeviceScreenSize | null,
): PreviewMiniPlayerSize {
  if (!screen) {
    const width = 1_000;
    return { width, height: width / (platform === "ios" ? 9 / 19.5 : 9 / 20) };
  }
  const landscape =
    screen.orientation === "landscape_left" || screen.orientation === "landscape_right";
  const long = Math.max(screen.width, screen.height);
  const short = Math.min(screen.width, screen.height);
  return landscape ? { width: long, height: short } : { width: short, height: long };
}

/**
 * The Android emulator composites the skin's rounded corners into its
 * framebuffer as black wedges (measured at ~13% of the short side on a
 * Pixel 9), so its player clips at a matching phone-like radius; the sliver
 * lost under the curve is status-bar padding. iOS simulators stream an
 * edge-to-edge rectangle and keep the frame radius, which matters for iPads
 * whose real corners are far tighter than a phone's.
 */
export function resolveDeviceMiniPlayerCornerRadius(
  platform: DevicePlatform,
  player: PreviewMiniPlayerSize,
): number {
  if (platform !== "android") return PREVIEW_MINI_PLAYER_CORNER_RADIUS;
  return Math.max(
    PREVIEW_MINI_PLAYER_CORNER_RADIUS,
    Math.round(Math.min(player.width, player.height) * 0.14),
  );
}

interface HorizontalSpan {
  readonly left: number;
  readonly right: number;
}

/**
 * What the player keeps clear of, in container coordinates. Both are docked
 * to an edge, so each only reserves the columns it covers: the margins beside
 * the composer and the column left of the details card stay open all the way.
 */
export interface PreviewMiniPlayerObstacles {
  /** The composer stack docked to the bottom edge. */
  readonly composer: (HorizontalSpan & { readonly height: number }) | null;
  /** The inline thread-details card docked to the top-right corner. */
  readonly detailsCard: (HorizontalSpan & { readonly bottom: number }) | null;
}

export const NO_PREVIEW_MINI_PLAYER_OBSTACLES: PreviewMiniPlayerObstacles = {
  composer: null,
  detailsCard: null,
};

const spanOf = (x: number, width: number): HorizontalSpan => ({ left: x, right: x + width });

const spansOverlap = (a: HorizontalSpan, b: HorizontalSpan) => a.left < b.right && a.right > b.left;

/** The lowest row (before the edge gap) open to a player covering these columns. */
function floorFor(
  span: HorizontalSpan,
  container: PreviewMiniPlayerSize,
  obstacles: PreviewMiniPlayerObstacles,
): number {
  const { composer } = obstacles;
  return composer && spansOverlap(span, composer)
    ? container.height - Math.max(0, composer.height)
    : container.height;
}

/** The highest row (before the edge gap) open to a player covering these columns. */
function ceilingFor(span: HorizontalSpan, obstacles: PreviewMiniPlayerObstacles): number {
  const { detailsCard } = obstacles;
  return detailsCard && spansOverlap(span, detailsCard) ? Math.max(0, detailsCard.bottom) : 0;
}

/**
 * The box a stored size is fitted into. A player with a position keeps the
 * rows its own columns have, so a tall frame parked beside the composer
 * survives the next layout pass; without one it takes the rows above the
 * composer, which every column has.
 */
const availableArea = (
  container: PreviewMiniPlayerSize,
  obstacles: PreviewMiniPlayerObstacles,
  span: HorizontalSpan | null,
): PreviewMiniPlayerSize => ({
  width: container.width - PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
  height:
    (span
      ? floorFor(span, container, obstacles) - ceilingFor(span, obstacles)
      : container.height - Math.max(0, obstacles.composer?.height ?? 0)) -
    PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
});

/**
 * Width is the player's only free dimension; height always follows the source
 * aspect ratio so the webview fills the box without letterboxing. The player
 * never grows past the source's own size (the guest keeps its CSS viewport, so
 * going bigger would only upscale), and a tight container wins over the minimum.
 */
function fitPreviewMiniPlayerWidth(
  desiredWidth: number,
  source: PreviewMiniPlayerSize,
  max: PreviewMiniPlayerSize,
): PreviewMiniPlayerSize {
  const aspectRatio = source.width / source.height;
  const width = Math.min(
    Math.max(
      desiredWidth,
      PREVIEW_MINI_PLAYER_MIN_SIZE.width,
      PREVIEW_MINI_PLAYER_MIN_SIZE.height * aspectRatio,
    ),
    source.width,
    Math.max(1, max.width),
    Math.max(1, max.height * aspectRatio),
  );
  return { width: Math.round(width), height: Math.round(width / aspectRatio) };
}

function defaultPreviewMiniPlayerWidth(source: PreviewMiniPlayerSize): number {
  return Math.min(
    PREVIEW_MINI_PLAYER_DEFAULT_BOX.width,
    (PREVIEW_MINI_PLAYER_DEFAULT_BOX.height * source.width) / source.height,
  );
}

const clampToContainer = (
  position: PreviewMiniPlayerPosition,
  container: PreviewMiniPlayerSize,
  player: PreviewMiniPlayerSize,
  bottom = container.height,
): PreviewMiniPlayerPosition => ({
  x: Math.min(
    Math.max(position.x, PREVIEW_MINI_PLAYER_EDGE_GAP),
    Math.max(
      PREVIEW_MINI_PLAYER_EDGE_GAP,
      container.width - player.width - PREVIEW_MINI_PLAYER_EDGE_GAP,
    ),
  ),
  y: Math.min(
    Math.max(position.y, PREVIEW_MINI_PLAYER_EDGE_GAP),
    Math.max(PREVIEW_MINI_PLAYER_EDGE_GAP, bottom - player.height - PREVIEW_MINI_PLAYER_EDGE_GAP),
  ),
});

const overlapsObstacle = (
  position: PreviewMiniPlayerPosition,
  player: PreviewMiniPlayerSize,
  container: PreviewMiniPlayerSize,
  obstacles: PreviewMiniPlayerObstacles,
): boolean => {
  const span = spanOf(position.x, player.width);
  return (
    position.y + player.height > floorFor(span, container, obstacles) ||
    position.y < ceilingFor(span, obstacles)
  );
};

/**
 * Keeps the player inside the container and off the composer and details
 * card. An overlapping player is moved the shortest distance that leaves it
 * clear: vertically into the rows its own columns have open, or sideways to
 * the space beside an obstacle, so a drag slides along the composer into a
 * margin instead of stopping at its edge. When nothing leaves it clear it
 * keeps its columns and sits below the card; the composer is where the user
 * is typing, but a player under the card cannot be reached at all.
 */
export function clampPreviewMiniPlayerPosition(
  position: PreviewMiniPlayerPosition,
  container: PreviewMiniPlayerSize,
  player: PreviewMiniPlayerSize,
  obstacles: PreviewMiniPlayerObstacles = NO_PREVIEW_MINI_PLAYER_OBSTACLES,
): PreviewMiniPlayerPosition {
  const inside = clampToContainer(position, container, player);
  if (!overlapsObstacle(inside, player, container, obstacles)) return inside;
  const gap = PREVIEW_MINI_PLAYER_EDGE_GAP;
  // The rows open to a player at this x, holding y as close to the drag as they allow.
  const fitRows = (x: number): PreviewMiniPlayerPosition => {
    const span = spanOf(x, player.width);
    return {
      x,
      y: Math.max(
        Math.min(inside.y, floorFor(span, container, obstacles) - gap - player.height),
        ceilingFor(span, obstacles) + gap,
        gap,
      ),
    };
  };
  const fallback = fitRows(inside.x);
  const { composer, detailsCard } = obstacles;
  const span = spanOf(inside.x, player.width);
  const beside = [composer, detailsCard]
    .filter(
      (obstacle): obstacle is NonNullable<typeof obstacle> =>
        obstacle !== null && spansOverlap(span, obstacle),
    )
    .flatMap((obstacle) => [obstacle.left - gap - player.width, obstacle.right + gap]);
  let best = fallback;
  let bestDistance = overlapsObstacle(fallback, player, container, obstacles)
    ? Number.POSITIVE_INFINITY
    : Math.abs(fallback.y - inside.y);
  for (const x of beside) {
    const candidate = fitRows(x);
    if (
      clampToContainer(candidate, container, player).x !== x ||
      overlapsObstacle(candidate, player, container, obstacles)
    ) {
      continue;
    }
    const distance = Math.abs(x - inside.x) + Math.abs(candidate.y - inside.y);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Resolves the on-screen frame from the stored width and position. Clamping
 * happens here on every layout pass instead of being written back to the
 * store, so a temporarily narrow container never destroys the user's chosen
 * width. A player without a position sits in the top-right corner, or tucks
 * under the details card with right edges aligned when the card owns it.
 */
export function resolvePreviewMiniPlayerFrame(input: {
  readonly width: number | null;
  readonly position: PreviewMiniPlayerPosition | null;
  readonly source: PreviewMiniPlayerSize;
  readonly container: PreviewMiniPlayerSize;
  readonly obstacles?: PreviewMiniPlayerObstacles;
}): PreviewMiniPlayerFrame {
  const {
    width,
    position,
    source,
    container,
    obstacles = NO_PREVIEW_MINI_PLAYER_OBSTACLES,
  } = input;
  const size = fitPreviewMiniPlayerWidth(
    width ?? defaultPreviewMiniPlayerWidth(source),
    source,
    availableArea(container, obstacles, position && width ? spanOf(position.x, width) : null),
  );
  const { detailsCard } = obstacles;
  const anchored =
    position ??
    (detailsCard
      ? { x: detailsCard.right - size.width, y: detailsCard.bottom + PREVIEW_MINI_PLAYER_EDGE_GAP }
      : {
          x: container.width - PREVIEW_MINI_PLAYER_EDGE_GAP - size.width,
          y: PREVIEW_MINI_PLAYER_EDGE_GAP,
        });
  return { ...clampPreviewMiniPlayerPosition(anchored, container, size, obstacles), ...size };
}

/**
 * Resizes from any edge or corner while holding the aspect ratio. The edge
 * opposite the dragged one stays anchored, so growth stops at the container
 * on that axis and the pointer keeps tracking the grabbed edge. On a plain edge
 * drag the perpendicular axis may use the whole container, and the player
 * shifts as needed to stay inside.
 */
export function resizePreviewMiniPlayer(input: {
  readonly start: PreviewMiniPlayerFrame;
  readonly direction: BrowserViewportResizeDirection;
  readonly delta: PreviewMiniPlayerPosition;
  readonly source: PreviewMiniPlayerSize;
  readonly container: PreviewMiniPlayerSize;
  readonly obstacles?: PreviewMiniPlayerObstacles;
}): PreviewMiniPlayerFrame {
  const {
    start,
    direction,
    delta,
    source,
    container,
    obstacles = NO_PREVIEW_MINI_PLAYER_OBSTACLES,
  } = input;
  const east = direction.includes("east");
  const west = direction.includes("west");
  const north = direction.includes("north");
  const south = direction.includes("south");
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  // Growth stops where the player's current columns meet an obstacle, and a
  // plain edge drag lets the free axis use everything those columns have. A
  // wider player may reach new columns; the clamp below slides it clear.
  const span = spanOf(start.x, start.width);
  const floor = floorFor(span, container, obstacles);
  const ceiling = ceilingFor(span, obstacles);
  const max = {
    width: west
      ? right - PREVIEW_MINI_PLAYER_EDGE_GAP
      : east
        ? container.width - PREVIEW_MINI_PLAYER_EDGE_GAP - start.x
        : container.width - PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
    height: north
      ? bottom - ceiling - PREVIEW_MINI_PLAYER_EDGE_GAP
      : south
        ? floor - PREVIEW_MINI_PLAYER_EDGE_GAP - start.y
        : floor - ceiling - PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
  };
  const desiredWidth = start.width + (east ? delta.x : west ? -delta.x : 0);
  const desiredHeight = start.height + (south ? delta.y : north ? -delta.y : 0);
  const horizontal = east || west;
  const vertical = north || south;
  const widthLeads =
    horizontal && !vertical
      ? true
      : vertical && !horizontal
        ? false
        : Math.abs(desiredWidth - start.width) / start.width >=
          Math.abs(desiredHeight - start.height) / start.height;
  const size = fitPreviewMiniPlayerWidth(
    widthLeads ? desiredWidth : (desiredHeight * source.width) / source.height,
    source,
    max,
  );
  const position = clampPreviewMiniPlayerPosition(
    { x: west ? right - size.width : start.x, y: north ? bottom - size.height : start.y },
    container,
    size,
    obstacles,
  );
  return { ...position, ...size };
}
