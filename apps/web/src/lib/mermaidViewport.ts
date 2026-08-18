export const MIN_MERMAID_OVERLAY_ZOOM = 0.25;
export const MAX_MERMAID_OVERLAY_ZOOM = 8;
export const MERMAID_OVERLAY_ZOOM_STEP = 1.25;
export const MERMAID_OVERLAY_FIT_PADDING = 32;

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

export function clampMermaidZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_MERMAID_OVERLAY_ZOOM, Math.max(MIN_MERMAID_OVERLAY_ZOOM, zoom));
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
): MermaidViewport {
  const zoom = clampMermaidZoom(nextZoom);
  if (zoom === viewport.zoom) return viewport;
  const scale = zoom / viewport.zoom;
  return {
    x: point.x - (point.x - viewport.x) * scale,
    y: point.y - (point.y - viewport.y) * scale,
    zoom,
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
  const zoom = clampMermaidZoom(
    Math.min(availableWidth / content.width, availableHeight / content.height),
  );
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
