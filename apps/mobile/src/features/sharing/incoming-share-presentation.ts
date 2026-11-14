export interface IncomingSharePresentationState {
  readonly presentedShareId: string | null;
  readonly dismissedShareId: string | null;
}

export interface IncomingSharePresentationTransition {
  readonly state: IncomingSharePresentationState;
  readonly shareIdToPresent: string | null;
}

export const EMPTY_INCOMING_SHARE_PRESENTATION_STATE: IncomingSharePresentationState = {
  presentedShareId: null,
  dismissedShareId: null,
};

export function transitionIncomingSharePresentation(
  state: IncomingSharePresentationState,
  input: {
    readonly isShareSheetPresented: boolean;
    readonly pendingShareId: string | null;
  },
): IncomingSharePresentationTransition {
  if (input.isShareSheetPresented) {
    if (state.presentedShareId !== null && input.pendingShareId !== state.presentedShareId) {
      // Forget consumed presentations immediately so later handoffs can reuse their ids.
      return {
        state: EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
        shareIdToPresent: null,
      };
    }
    return { state, shareIdToPresent: null };
  }

  let nextState = state;
  if (state.presentedShareId !== null) {
    if (input.pendingShareId === state.presentedShareId) {
      return {
        state: {
          presentedShareId: null,
          dismissedShareId: state.presentedShareId,
        },
        shareIdToPresent: null,
      };
    }
    nextState = { ...state, presentedShareId: null };
  }

  if (input.pendingShareId === null) {
    return {
      state: EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
      shareIdToPresent: null,
    };
  }

  if (nextState.dismissedShareId === input.pendingShareId) {
    return { state: nextState, shareIdToPresent: null };
  }

  return {
    state: {
      presentedShareId: input.pendingShareId,
      dismissedShareId: null,
    },
    shareIdToPresent: input.pendingShareId,
  };
}
