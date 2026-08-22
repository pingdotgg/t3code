export const MIN_MERMAID_OVERLAY_ZOOM = 0.25;
export const MAX_MERMAID_OVERLAY_ZOOM = 8;
export const MERMAID_OVERLAY_ZOOM_STEP = 1.25;
export const MERMAID_OVERLAY_FIT_PADDING = 32;
export const MERMAID_OVERLAY_EDGE_MARGIN = 48;

export interface MermaidViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export function resetMermaidViewport(): MermaidViewport {
  return { x: 0, y: 0, zoom: 1 };
}

export function clampMermaidZoom(zoom: number, fitZoom = 1): number {
  const origin = Number.isFinite(fitZoom) && fitZoom > 0 ? fitZoom : 1;
  if (!Number.isFinite(zoom)) return origin;
  const min = origin * MIN_MERMAID_OVERLAY_ZOOM;
  const max = origin * MAX_MERMAID_OVERLAY_ZOOM;
  return Math.min(max, Math.max(min, zoom));
}

export function mermaidOverlayZoomPercent(zoom: number, fitZoom: number): number {
  if (!(fitZoom > 0)) return 100;
  return Math.round((zoom / fitZoom) * 100);
}

export function panMermaidViewport(
  viewport: MermaidViewport,
  dx: number,
  dy: number,
): MermaidViewport {
  if (dx === 0 && dy === 0) return viewport;
  return { x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom };
}

/**
 * Zoom around a point in the scene's client coordinates.
 * Transform is `translate(x, y) scale(zoom)` with origin at 0,0.
 */
export function zoomMermaidViewportAtPoint(
  viewport: MermaidViewport,
  nextZoom: number,
  point: Point,
  fitZoom = 1,
): MermaidViewport {
  const zoom = clampMermaidZoom(nextZoom, fitZoom);
  if (zoom === viewport.zoom) return viewport;
  const scale = zoom / viewport.zoom;
  return {
    x: point.x - (point.x - viewport.x) * scale,
    y: point.y - (point.y - viewport.y) * scale,
    zoom,
  };
}

export function mermaidViewportContentCenter(viewport: MermaidViewport, content: Size): Point {
  return {
    x: viewport.x + (content.width * viewport.zoom) / 2,
    y: viewport.y + (content.height * viewport.zoom) / 2,
  };
}

/**
 * Keep at least a sliver of the diagram inside the scene so zoom/pan cannot
 * send it into empty space.
 */
export function keepMermaidViewportInScene(
  viewport: MermaidViewport,
  scene: Size,
  content: Size,
  margin = MERMAID_OVERLAY_EDGE_MARGIN,
): MermaidViewport {
  const visWidth = content.width * viewport.zoom;
  const visHeight = content.height * viewport.zoom;
  const minX = margin - visWidth;
  const maxX = scene.width - margin;
  const minY = margin - visHeight;
  const maxY = scene.height - margin;
  return {
    x: minX <= maxX ? Math.min(maxX, Math.max(minX, viewport.x)) : (scene.width - visWidth) / 2,
    y: minY <= maxY ? Math.min(maxY, Math.max(minY, viewport.y)) : (scene.height - visHeight) / 2,
    zoom: viewport.zoom,
  };
}

export function fitMermaidViewport(
  scene: Size,
  content: Size,
  padding = MERMAID_OVERLAY_FIT_PADDING,
): MermaidViewport {
  if (scene.width <= 0 || scene.height <= 0 || content.width <= 0 || content.height <= 0) {
    return resetMermaidViewport();
  }
  const availableWidth = Math.max(1, scene.width - padding * 2);
  const availableHeight = Math.max(1, scene.height - padding * 2);
  const zoom = Math.min(availableWidth / content.width, availableHeight / content.height);
  return {
    x: (scene.width - content.width * zoom) / 2,
    y: (scene.height - content.height * zoom) / 2,
    zoom,
  };
}

export function mermaidSvgContentSize(svg: string): Size | null {
  const viewBox = svg.match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
  const viewBoxValue = viewBox?.[1];
  if (viewBoxValue) {
    const parts = viewBoxValue
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const width = parts[2];
    const height = parts[3];
    if (
      parts.length === 4 &&
      width != null &&
      height != null &&
      parts.every(Number.isFinite) &&
      width > 0 &&
      height > 0
    ) {
      return { width, height };
    }
  }
  const widthMatch = svg.match(/\bwidth\s*=\s*["']([0-9.]+)(?:px)?["']/i);
  const heightMatch = svg.match(/\bheight\s*=\s*["']([0-9.]+)(?:px)?["']/i);
  if (widthMatch?.[1] && heightMatch?.[1]) {
    const width = Number(widthMatch[1]);
    const height = Number(heightMatch[1]);
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}
