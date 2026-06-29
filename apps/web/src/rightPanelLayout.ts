export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";
export const THREAD_PANEL_INLINE_MIN_WIDTH = 960;
export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";

export type ThreadPanelPresentation = "inline" | "popover";

export function resolveThreadPanelPresentation(
  workspaceWidth: number | null,
  occupiedRightPanelWidth: number,
  rightPanelMaximized: boolean,
): ThreadPanelPresentation {
  if (workspaceWidth === null) return "inline";

  const chatPaneWidth = rightPanelMaximized ? 0 : workspaceWidth - occupiedRightPanelWidth;
  return chatPaneWidth < THREAD_PANEL_INLINE_MIN_WIDTH ? "popover" : "inline";
}
