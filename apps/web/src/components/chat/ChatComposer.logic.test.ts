import { describe, expect, it } from "vite-plus/test";

import { composerAgentSelectionKey } from "./ChatComposer.logic";

describe("ChatComposer agent selection context", () => {
  it("changes when the draft target changes even without an active thread", () => {
    const first = composerAgentSelectionKey({
      activeThreadId: null,
      draftId: "draft-a",
      composerDraftTarget: "draft-a",
    });
    const second = composerAgentSelectionKey({
      activeThreadId: null,
      draftId: "draft-b",
      composerDraftTarget: "draft-b",
    });

    expect(first).not.toBe(second);
  });
});
