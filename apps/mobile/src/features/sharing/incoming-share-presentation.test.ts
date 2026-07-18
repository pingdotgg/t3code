import { describe, expect, it } from "@effect/vitest";

import {
  EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
  transitionIncomingSharePresentation,
} from "./incoming-share-presentation";

describe("incoming share presentation", () => {
  it("does not reopen a dismissed share when refresh returns a new object for the same id", () => {
    const presented = transitionIncomingSharePresentation(EMPTY_INCOMING_SHARE_PRESENTATION_STATE, {
      isShareSheetPresented: false,
      pendingShareId: "share-1",
    });
    expect(presented.shareIdToPresent).toBe("share-1");

    const whilePresented = transitionIncomingSharePresentation(presented.state, {
      isShareSheetPresented: true,
      pendingShareId: "share-1",
    });
    expect(whilePresented).toEqual({ state: presented.state, shareIdToPresent: null });

    const dismissed = transitionIncomingSharePresentation(whilePresented.state, {
      isShareSheetPresented: false,
      pendingShareId: "share-1",
    });
    expect(dismissed.state.dismissedShareId).toBe("share-1");

    expect(
      transitionIncomingSharePresentation(dismissed.state, {
        isShareSheetPresented: false,
        pendingShareId: "share-1",
      }),
    ).toEqual({ state: dismissed.state, shareIdToPresent: null });
  });

  it("presents the next queued share immediately after the previous sheet closes", () => {
    const first = transitionIncomingSharePresentation(EMPTY_INCOMING_SHARE_PRESENTATION_STATE, {
      isShareSheetPresented: false,
      pendingShareId: "share-1",
    });

    const next = transitionIncomingSharePresentation(first.state, {
      isShareSheetPresented: false,
      pendingShareId: "share-2",
    });
    expect(next.shareIdToPresent).toBe("share-2");
    expect(next.state).toEqual({ presentedShareId: "share-2", dismissedShareId: null });
  });

  it("forgets dismissal after consumption so a later handoff may reuse the id", () => {
    const dismissed = {
      presentedShareId: null,
      dismissedShareId: "share-1",
    };
    const consumed = transitionIncomingSharePresentation(dismissed, {
      isShareSheetPresented: false,
      pendingShareId: null,
    });
    expect(consumed.state).toEqual(EMPTY_INCOMING_SHARE_PRESENTATION_STATE);

    expect(
      transitionIncomingSharePresentation(consumed.state, {
        isShareSheetPresented: false,
        pendingShareId: "share-1",
      }).shareIdToPresent,
    ).toBe("share-1");
  });

  it("forgets a consumed presentation while its sheet is still mounted", () => {
    const presented = {
      presentedShareId: "share-1",
      dismissedShareId: null,
    };
    const consumed = transitionIncomingSharePresentation(presented, {
      isShareSheetPresented: true,
      pendingShareId: null,
    });
    expect(consumed.state).toEqual(EMPTY_INCOMING_SHARE_PRESENTATION_STATE);

    const replacementWhileOpen = transitionIncomingSharePresentation(consumed.state, {
      isShareSheetPresented: true,
      pendingShareId: "share-1",
    });
    expect(replacementWhileOpen.shareIdToPresent).toBeNull();
    expect(
      transitionIncomingSharePresentation(replacementWhileOpen.state, {
        isShareSheetPresented: false,
        pendingShareId: "share-1",
      }).shareIdToPresent,
    ).toBe("share-1");
  });
});
