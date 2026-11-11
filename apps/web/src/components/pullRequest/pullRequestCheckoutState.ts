import { create } from "zustand";
import type { DraftId } from "~/composerDraftStore";

export const usePullRequestCheckoutState = create(() => ({ draftIds: new Map<DraftId, symbol>() }));

export function setPullRequestCheckoutPending(draftId: DraftId, pending: boolean, owner: symbol) {
  usePullRequestCheckoutState.setState((state) => {
    if (!pending && state.draftIds.get(draftId) !== owner) return state;
    const draftIds = new Map(state.draftIds);
    if (pending) draftIds.set(draftId, owner);
    else draftIds.delete(draftId);
    return { draftIds };
  });
}
