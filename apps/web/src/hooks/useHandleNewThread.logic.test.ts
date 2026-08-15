import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "../composerDraftStore.ts";
import { resolveNewThreadPresentation } from "./useHandleNewThread.logic.ts";

const draftId = DraftId.make("draft-a");

describe("resolveNewThreadPresentation", () => {
  it("opens board-created drafts in the expanded surface", () => {
    expect(
      resolveNewThreadPresentation({
        sourcePathname: "/board",
        currentPathname: "/board",
        draftId,
        replace: false,
      }),
    ).toEqual({ kind: "expanded-draft", draftId });
  });

  it("preserves classic draft routes outside the board", () => {
    expect(
      resolveNewThreadPresentation({
        sourcePathname: "/environment-a/thread-a",
        currentPathname: "/environment-a/thread-a",
        draftId,
        replace: true,
      }),
    ).toEqual({ kind: "draft-route", draftId, replace: true });
  });

  it("does not arm a stale board sheet after the user navigates away", () => {
    expect(
      resolveNewThreadPresentation({
        sourcePathname: "/board",
        currentPathname: "/environment-a/thread-a",
        draftId,
        replace: false,
      }),
    ).toEqual({ kind: "none" });
  });
});
