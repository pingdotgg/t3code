import type { IncomingShareDraft } from "./incoming-share-model";

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

/**
 * Draft route params for presenting a share. A share reserved by an interrupted
 * import resumes in its reserved project; without it the draft would fall back
 * to another project and the reservation would reject the import.
 */
export function incomingShareDraftParams(share: Pick<IncomingShareDraft, "id" | "destination">): {
  readonly incomingShareId: string;
  readonly environmentId?: string;
  readonly projectId?: string;
} {
  if (!share.destination) return { incomingShareId: share.id };
  return {
    incomingShareId: share.id,
    environmentId: share.destination.environmentId,
    projectId: share.destination.projectId,
  };
}
