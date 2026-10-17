// Material's FAB margin, in dp so it does not grow with the app's text size.
export const ANDROID_HOME_FAB_MARGIN = 16;

/** Bottom offset shared by the New thread FAB and the filter button stacked above it. */
export function androidHomeFabBottom(safeAreaBottom: number, sidebar: boolean | undefined) {
  return sidebar ? Math.max(safeAreaBottom, 12) + 6 : safeAreaBottom + ANDROID_HOME_FAB_MARGIN;
}
