export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
/** Default sidebar width as a fraction of viewport width (~20%). */
export const THREAD_SIDEBAR_DEFAULT_WIDTH_RATIO = 0.2;
export const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadSidebarMaximumWidth(viewportWidth: number): number {
  return Math.max(
    THREAD_SIDEBAR_MIN_WIDTH,
    Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH,
  );
}

export function resolveThreadSidebarDefaultWidth(viewportWidth: number): number {
  const preferredWidth = Math.floor(viewportWidth * THREAD_SIDEBAR_DEFAULT_WIDTH_RATIO);
  return Math.min(
    Math.max(preferredWidth, THREAD_SIDEBAR_MIN_WIDTH),
    resolveThreadSidebarMaximumWidth(viewportWidth),
  );
}

export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
): number {
  const preferredWidth =
    storedWidth === null
      ? resolveThreadSidebarDefaultWidth(viewportWidth)
      : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
  return Math.min(preferredWidth, resolveThreadSidebarMaximumWidth(viewportWidth));
}
