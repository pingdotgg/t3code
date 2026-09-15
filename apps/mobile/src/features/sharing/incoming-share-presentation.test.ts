import { describe, expect, it } from "@effect/vitest";

import {
  EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
  incomingShareIdOfSheetRoute,
  transitionIncomingSharePresentation,
  type IncomingSharePresentationState,
} from "./incoming-share-presentation";

const closed = { isSheetPresented: false, sheetShareId: null };
const sheetWith = (shareId: string | null) => ({ isSheetPresented: true, sheetShareId: shareId });

function present(shareId: string, state = EMPTY_INCOMING_SHARE_PRESENTATION_STATE) {
  const transition = transitionIncomingSharePresentation(state, {
    ...closed,
    pendingShareId: shareId,
  });
  expect(transition.shareIdToPresent).toBe(shareId);
  return transition.state;
}

function seen(shareId: string, state: IncomingSharePresentationState) {
  const transition = transitionIncomingSharePresentation(state, {
    ...sheetWith(shareId),
    pendingShareId: shareId,
  });
  expect(transition.shareIdToPresent).toBeNull();
  expect(transition.state.sheetSeen).toBe(true);
  return transition.state;
}

describe("transitionIncomingSharePresentation", () => {
  it("re-requests the sheet when the first navigation never landed", () => {
    const requested = present("share-1");
    const retry = transitionIncomingSharePresentation(requested, {
      ...closed,
      pendingShareId: "share-1",
    });
    expect(retry.shareIdToPresent).toBe("share-1");
    expect(retry.shareIdToDiscard).toBeNull();
  });

  it("does not count a sheet that carries no share id as the share being seen", () => {
    const requested = present("share-1");
    const manualSheet = transitionIncomingSharePresentation(requested, {
      ...sheetWith(null),
      pendingShareId: "share-1",
    });
    expect(manualSheet.state.sheetSeen).toBe(false);
    const closedAgain = transitionIncomingSharePresentation(manualSheet.state, {
      ...closed,
      pendingShareId: "share-1",
    });
    expect(closedAgain.shareIdToPresent).toBe("share-1");
    expect(closedAgain.shareIdToDiscard).toBeNull();
  });

  it("discards the share once its sheet was seen and then closed", () => {
    const state = seen("share-1", present("share-1"));
    const dismissed = transitionIncomingSharePresentation(state, {
      ...closed,
      pendingShareId: "share-1",
    });
    expect(dismissed.shareIdToDiscard).toBe("share-1");
    expect(dismissed.shareIdToPresent).toBeNull();

    // The inbox still reports it until the discard lands; hold, do not reopen.
    const held = transitionIncomingSharePresentation(dismissed.state, {
      ...closed,
      pendingShareId: "share-1",
    });
    expect(held).toEqual({
      state: dismissed.state,
      shareIdToPresent: null,
      shareIdToDiscard: null,
    });

    // Once dropped, the same id (re-sharing identical content) is a fresh handoff.
    const empty = transitionIncomingSharePresentation(held.state, {
      ...closed,
      pendingShareId: null,
    });
    expect(empty.state).toEqual(EMPTY_INCOMING_SHARE_PRESENTATION_STATE);
    expect(present("share-1", empty.state).presentedShareId).toBe("share-1");
  });

  it("keeps tracking the open sheet's share when a newer share arrives, then discards it on close", () => {
    const state = seen("share-1", present("share-1"));
    const newerWhileOpen = transitionIncomingSharePresentation(state, {
      ...sheetWith("share-1"),
      pendingShareId: "share-2",
    });
    expect(newerWhileOpen).toEqual({ state, shareIdToPresent: null, shareIdToDiscard: null });

    const next = transitionIncomingSharePresentation(newerWhileOpen.state, {
      ...closed,
      pendingShareId: "share-2",
    });
    expect(next.shareIdToDiscard).toBe("share-1");
    expect(next.shareIdToPresent).toBe("share-2");
    expect(next.state).toEqual({
      presentedShareId: "share-2",
      sheetSeen: false,
      discardedShareId: "share-1",
    });
  });

  it("presents a newer share directly when the earlier request never landed", () => {
    const requested = present("share-1");
    const next = transitionIncomingSharePresentation(requested, {
      ...closed,
      pendingShareId: "share-2",
    });
    expect(next.shareIdToPresent).toBe("share-2");
    expect(next.shareIdToDiscard).toBeNull();
  });

  it("holds while another route is pushed above the seen sheet", () => {
    const state = seen("share-1", present("share-1"));
    // Add environment / a notification tap push a root route over the sheet
    // without closing it. incomingShareIdOfSheetRoute still reports the sheet.
    const covered = transitionIncomingSharePresentation(state, {
      ...sheetWith("share-1"),
      pendingShareId: "share-1",
    });
    expect(covered).toEqual({ state, shareIdToPresent: null, shareIdToDiscard: null });
  });

  it("clears everything when the inbox empties", () => {
    const state = seen("share-1", present("share-1"));
    expect(
      transitionIncomingSharePresentation(state, { ...sheetWith("share-1"), pendingShareId: null })
        .state,
    ).toEqual(EMPTY_INCOMING_SHARE_PRESENTATION_STATE);
  });
});

describe("incomingShareIdOfSheetRoute", () => {
  it("reads the id from the navigate payload before the nested navigator mounts", () => {
    expect(
      incomingShareIdOfSheetRoute(
        {
          routes: [
            { name: "Home" },
            {
              name: "NewTaskSheet",
              params: { screen: "NewTask", params: { incomingShareId: "share-1" } },
            },
          ],
        },
        "NewTaskSheet",
      ),
    ).toEqual({ isSheetPresented: true, shareId: "share-1" });
  });

  it("reads the id from the nested route once mounted, including the draft screen", () => {
    expect(
      incomingShareIdOfSheetRoute(
        {
          routes: [
            { name: "Home" },
            {
              name: "NewTaskSheet",
              state: {
                routes: [
                  { name: "NewTask", params: {} },
                  { name: "NewTaskDraft", params: { incomingShareId: "share-1" } },
                ],
              },
            },
          ],
        },
        "NewTaskSheet",
      ),
    ).toEqual({ isSheetPresented: true, shareId: "share-1" });
  });

  it("reports a manual new task sheet without a share id", () => {
    expect(
      incomingShareIdOfSheetRoute(
        {
          routes: [
            { name: "Home" },
            { name: "NewTaskSheet", state: { routes: [{ name: "NewTask", params: {} }] } },
          ],
        },
        "NewTaskSheet",
      ),
    ).toEqual({ isSheetPresented: true, shareId: null });
  });

  it("still reports the sheet when a root route is pushed above it", () => {
    expect(
      incomingShareIdOfSheetRoute(
        {
          routes: [
            { name: "Home" },
            {
              name: "NewTaskSheet",
              state: { routes: [{ name: "NewTask", params: { incomingShareId: "share-1" } }] },
            },
            { name: "ConnectionsNew" },
          ],
        },
        "NewTaskSheet",
      ),
    ).toEqual({ isSheetPresented: true, shareId: "share-1" });
  });

  it("reports the sheet as gone once it leaves the stack", () => {
    expect(
      incomingShareIdOfSheetRoute(
        { routes: [{ name: "Home" }, { name: "SettingsSheet" }] },
        "NewTaskSheet",
      ),
    ).toEqual({ isSheetPresented: false, shareId: null });
  });
});
