import { isDraftThreadRoute } from "../threads/thread-route-state";

export interface IncomingSharePresentationState {
  readonly presentedShareId: string | null;
  readonly sheetSeen: boolean;
  readonly discardedShareId: string | null;
}

export interface IncomingSharePresentationTransition {
  readonly state: IncomingSharePresentationState;
  readonly shareIdToPresent: string | null;
  readonly shareIdToDiscard: string | null;
}

export const EMPTY_INCOMING_SHARE_PRESENTATION_STATE: IncomingSharePresentationState = {
  presentedShareId: null,
  sheetSeen: false,
  discardedShareId: null,
};

interface RouteLike {
  readonly name: string;
  readonly params?: object;
}

function shareIdOf(params: { readonly incomingShareId?: unknown } | undefined): string[] {
  const value = params?.incomingShareId;
  const id = Array.isArray(value) ? value[0] : value;
  return typeof id === "string" ? [id] : [];
}

/**
 * New-task routes anywhere in the root stack: a route pushed above one leaves it
 * open, and a draft without a project hands its share to the picker it is replaced by.
 */
export function incomingShareDraftRoutes(routes: ReadonlyArray<RouteLike>): {
  readonly isDraftPresented: boolean;
  readonly shareIds: ReadonlyArray<string>;
} {
  const flows = routes.filter(
    (route) => isDraftThreadRoute(route) || route.name === "NewTaskProject",
  );
  const shareIds = flows.flatMap((route) =>
    route.name === "NewTaskProject"
      ? shareIdOf(route.params)
      : shareIdOf((route.params as { draft: { incomingShareId?: unknown } }).draft),
  );
  return { isDraftPresented: flows.length > 0, shareIds };
}

export function transitionIncomingSharePresentation(
  state: IncomingSharePresentationState,
  input: {
    readonly isDraftPresented: boolean;
    readonly draftShareIds: ReadonlyArray<string>;
    readonly pendingShareId: string | null;
  },
): IncomingSharePresentationTransition {
  const hold = { state, shareIdToPresent: null, shareIdToDiscard: null };
  const { pendingShareId } = input;

  if (pendingShareId === null) {
    return { ...hold, state: EMPTY_INCOMING_SHARE_PRESENTATION_STATE };
  }

  if (state.discardedShareId === pendingShareId) {
    // The inbox has not caught up with the discard yet.
    return hold;
  }

  const tracked = state.presentedShareId;
  if (input.isDraftPresented) {
    if (tracked !== null && !state.sheetSeen && input.draftShareIds.includes(tracked)) {
      return { ...hold, state: { ...state, sheetSeen: true } };
    }
    return hold;
  }

  // A missing draft is a dismissal only after it carried this entry's id; until
  // then the navigation may not have landed and the request is retried.
  const shareIdToDiscard = tracked !== null && state.sheetSeen ? tracked : null;
  const shareIdToPresent = shareIdToDiscard === pendingShareId ? null : pendingShareId;
  return {
    state: {
      presentedShareId: shareIdToPresent,
      sheetSeen: false,
      discardedShareId: shareIdToDiscard,
    },
    shareIdToPresent,
    shareIdToDiscard,
  };
}
