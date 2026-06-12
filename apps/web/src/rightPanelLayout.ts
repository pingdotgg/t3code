export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";
export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-screen max-[760px]:min-w-0 max-[760px]:max-w-none wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";

export interface RightFilePanelVisibilityInput {
  readonly diffOpen: boolean;
  readonly filePanelOpen: boolean;
  readonly hasStoredFilePanelContext: boolean;
  readonly sourceControlOpen: boolean;
  readonly useSheet: boolean;
}

export interface RightFilePanelVisibility {
  readonly open: boolean;
  readonly renderContent: boolean;
  readonly sourceControlHiddenByDiff: boolean;
}

export function resolveRightFilePanelVisibility(
  input: RightFilePanelVisibilityInput,
): RightFilePanelVisibility {
  const sourceControlHiddenByDiff = input.diffOpen && input.sourceControlOpen;
  const open = input.filePanelOpen && !sourceControlHiddenByDiff;
  return {
    open,
    sourceControlHiddenByDiff,
    renderContent:
      open || (!input.useSheet && !sourceControlHiddenByDiff && input.hasStoredFilePanelContext),
  };
}
