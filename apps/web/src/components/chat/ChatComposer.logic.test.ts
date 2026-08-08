import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { composerAgentSelectionKey } from "./ChatComposer.logic";

describe("ChatComposer agent selection context", () => {
  it("changes when the draft target changes even without an active thread", () => {
    const first = composerAgentSelectionKey({
      activeThreadId: null,
      activeEnvironmentId: "environment-a",
      activeProjectId: null,
      draftId: "draft-a",
      composerDraftTarget: "draft-a",
    });
    const second = composerAgentSelectionKey({
      activeThreadId: null,
      activeEnvironmentId: "environment-a",
      activeProjectId: null,
      draftId: "draft-b",
      composerDraftTarget: "draft-b",
    });

    expect(first).not.toBe(second);
  });

  it("does not collide across delimited ids or differently tagged targets", () => {
    const delimitedEnvironment = composerAgentSelectionKey({
      activeEnvironmentId: "a:b",
      activeProjectId: null,
      activeThreadId: null,
      draftId: "draft",
      composerDraftTarget: "x:y",
    });
    const delimitedProject = composerAgentSelectionKey({
      activeEnvironmentId: "a",
      activeProjectId: "b",
      activeThreadId: null,
      draftId: "draft",
      composerDraftTarget: {
        environmentId: EnvironmentId.make("x"),
        threadId: ThreadId.make("y"),
      },
    });

    expect(delimitedEnvironment).not.toBe(delimitedProject);
  });
});
