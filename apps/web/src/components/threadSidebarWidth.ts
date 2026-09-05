export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16;
export const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadSidebarMaximumWidth(viewportWidth: number): number {
  return Math.max(
    THREAD_SIDEBAR_MIN_WIDTH,
    Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH,
  );
}

/**
 * `extraWidth` covers columns that live inside the sidebar but are not the
 * thread list (today: the project rail). It widens both the default and the
 * floor, so a sidebar at its default width keeps the same thread column with
 * the rail on, and one the user has resized keeps at least the thread column's
 * minimum.
 */
export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
  extraWidth = 0,
): number {
  const minimumWidth = THREAD_SIDEBAR_MIN_WIDTH + extraWidth;
  const preferredWidth =
    storedWidth === null
      ? THREAD_SIDEBAR_DEFAULT_WIDTH + extraWidth
      : Math.max(minimumWidth, storedWidth);
  return Math.min(
    preferredWidth,
    Math.max(minimumWidth, resolveThreadSidebarMaximumWidth(viewportWidth)),
  );
}
