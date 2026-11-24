import { describe, expect, it } from "@effect/vitest";

import {
  EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
  incomingShareDraftRoutes,
  transitionIncomingSharePresentation,
} from "./incoming-share-presentation";

const home = { name: "Home" };
const draftFor = (incomingShareId?: string) => ({
  name: "Thread",
  params: { draft: { incomingShareId } },
});

function presentation() {
  let state = EMPTY_INCOMING_SHARE_PRESENTATION_STATE;
  return (
    pendingShareId: string | null,
    routes: Parameters<typeof incomingShareDraftRoutes>[0],
  ) => {
    const drafts = incomingShareDraftRoutes(routes);
    const result = transitionIncomingSharePresentation(state, {
      pendingShareId,
      isDraftPresented: drafts.isDraftPresented,
      draftShareIds: drafts.shareIds,
    });
    state = result.state;
    return { present: result.shareIdToPresent, discard: result.shareIdToDiscard };
  };
}

describe("incoming share presentation", () => {
  it("retries until its own draft is observed, then discards on dismissal", () => {
    const step = presentation();
    const requested = { present: "share-1", discard: null };
    const held = { present: null, discard: null };

    expect(step("share-1", [home])).toEqual(requested);
    // The navigation did not land: request it again.
    expect(step("share-1", [home])).toEqual(requested);
    // A draft the user opened without the share is not the share's draft.
    expect(step("share-1", [home, draftFor()])).toEqual(held);
    expect(step("share-1", [home])).toEqual(requested);
    expect(step("share-1", [home, draftFor("share-1")])).toEqual(held);
    // The project picker pushed above the draft leaves it open.
    expect(step("share-1", [home, draftFor("share-1"), { name: "NewTaskProject" }])).toEqual(held);
    // A draft without a project is replaced by the picker, which keeps the share.
    expect(
      step("share-1", [home, { name: "NewTaskProject", params: { incomingShareId: "share-1" } }]),
    ).toEqual(held);
    expect(step("share-1", [home])).toEqual({ present: null, discard: "share-1" });
    expect(step("share-1", [home])).toEqual(held);
    expect(step(null, [home])).toEqual(held);
    expect(step("share-1", [home])).toEqual(requested);
  });

  it("hands off to the newer pending share when the open draft is dismissed", () => {
    const step = presentation();

    expect(step("share-1", [home])).toEqual({ present: "share-1", discard: null });
    expect(step("share-1", [home, draftFor("share-1")])).toEqual({ present: null, discard: null });
    expect(step("share-2", [home, draftFor("share-1")])).toEqual({ present: null, discard: null });
    expect(step("share-2", [home])).toEqual({ present: "share-2", discard: "share-1" });
  });
});
