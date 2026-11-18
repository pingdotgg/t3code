import type { RightPanelSurface } from "./rightPanelStore";

export function persistentRightPanelSurface(surface: RightPanelSurface): RightPanelSurface | null {
  if (surface.kind === "file" && surface.image) {
    const { name, mimeType, asset } = surface.image;
    if (!asset) return null;
    return {
      ...surface,
      image: { name, src: null, ...(mimeType ? { mimeType } : {}), asset },
    };
  }
  if (surface.kind !== "pull-request" || surface.revealUrl === undefined) return surface;
  const { revealUrl: _pending, ...rest } = surface;
  return rest;
}
