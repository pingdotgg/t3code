export interface CollapsedComposerActionsInput {
  readonly canStopThread: boolean;
  readonly hasContent: boolean;
  readonly activeThreadBusy: boolean;
}

export interface CollapsedComposerActions {
  readonly showStopPrimary: boolean;
  readonly showStopSecondary: boolean;
}

export function collapsedComposerActions(
  input: CollapsedComposerActionsInput,
): CollapsedComposerActions {
  const showStopPrimary = input.canStopThread && (!input.hasContent || input.activeThreadBusy);
  return {
    showStopPrimary,
    showStopSecondary: input.canStopThread && input.hasContent && !input.activeThreadBusy,
  };
}
