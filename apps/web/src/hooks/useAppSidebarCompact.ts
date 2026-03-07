import { useMediaQuery } from "./useMediaQuery";

export const APP_SIDEBAR_COMPACT_MEDIA_QUERY = "(max-width: 1120px)";

export function useAppSidebarCompact(): boolean {
  return useMediaQuery(APP_SIDEBAR_COMPACT_MEDIA_QUERY);
}
