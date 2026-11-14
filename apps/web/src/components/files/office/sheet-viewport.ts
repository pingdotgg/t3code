import type { SheetViewport } from "./sheet-protocol";

export function cachedViewport(frame: SheetViewport, viewport: SheetViewport) {
  return {
    x: Math.max(frame.x, Math.min(viewport.x, frame.x + Math.max(0, frame.width - viewport.width))),
    y: Math.max(
      frame.y,
      Math.min(viewport.y, frame.y + Math.max(0, frame.height - viewport.height)),
    ),
  };
}

export function bufferedViewport(viewport: SheetViewport): SheetViewport {
  const marginX = Math.min(128, viewport.width / 4);
  const marginY = Math.min(256, viewport.height / 3);
  const x = Math.max(0, viewport.x - marginX);
  const y = Math.max(0, viewport.y - marginY);
  return {
    x,
    y,
    width: viewport.width + viewport.x - x + marginX,
    height: viewport.height + viewport.y - y + marginY,
  };
}

export function retainCachedViewport(
  cached: SheetViewport,
  incoming: SheetViewport,
  current: SheetViewport,
) {
  const covers = (frame: SheetViewport) =>
    frame.x <= current.x &&
    frame.y <= current.y &&
    frame.x + frame.width >= current.x + current.width &&
    frame.y + frame.height >= current.y + current.height;
  return covers(cached) && !covers(incoming);
}
