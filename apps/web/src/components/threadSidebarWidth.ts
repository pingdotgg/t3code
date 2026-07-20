export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
export const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16;
export const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;

export function resolveInitialThreadSidebarWidth(storedWidth: number | null): number {
  return storedWidth === null
    ? THREAD_SIDEBAR_DEFAULT_WIDTH
    : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
}
