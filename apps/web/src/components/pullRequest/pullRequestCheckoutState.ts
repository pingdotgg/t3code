import { create } from "zustand";
import type { DraftId } from "~/composerDraftStore";

export const usePullRequestCheckoutState = create(() => ({ draftIds: new Set<DraftId>() }));

export function setPullRequestCheckoutPending(draftId: DraftId, pending: boolean) {
  usePullRequestCheckoutState.setState((state) => {
    const draftIds = new Set(state.draftIds);
    if (pending) draftIds.add(draftId);
    else draftIds.delete(draftId);
    return { draftIds };
  });
}
