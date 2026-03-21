export const NOTES_SIDEBAR_DEFAULT_WIDTH_PX = 340;
export const NOTES_SIDEBAR_MIN_WIDTH_PX = 280;
export const NOTES_SIDEBAR_MAX_WIDTH_PX = 640;
const NOTES_SIDEBAR_VIEWPORT_RATIO = 0.55;

export function resolveNotesSidebarMaxWidth(viewportWidth: number): number {
  return Math.max(
    NOTES_SIDEBAR_MIN_WIDTH_PX,
    Math.min(NOTES_SIDEBAR_MAX_WIDTH_PX, Math.floor(viewportWidth * NOTES_SIDEBAR_VIEWPORT_RATIO)),
  );
}

export function clampNotesSidebarWidth(width: number, viewportWidth: number): number {
  const normalizedWidth = Math.round(width);
  return Math.min(
    resolveNotesSidebarMaxWidth(viewportWidth),
    Math.max(NOTES_SIDEBAR_MIN_WIDTH_PX, normalizedWidth),
  );
}

export function resizeNotesSidebarWidth(params: {
  startWidth: number;
  startClientX: number;
  currentClientX: number;
  viewportWidth: number;
}): number {
  return clampNotesSidebarWidth(
    params.startWidth + (params.startClientX - params.currentClientX),
    params.viewportWidth,
  );
}
