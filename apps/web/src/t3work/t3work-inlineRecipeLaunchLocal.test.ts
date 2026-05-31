import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPersistStoredSidecarPersonalization } = vi.hoisted(() => ({
  mockPersistStoredSidecarPersonalization: vi.fn(),
}));

vi.mock("~/t3work/hooks/t3work-sidecarCompositionPersistence", () => ({
  persistStoredSidecarPersonalization: mockPersistStoredSidecarPersonalization,
}));

import type { SidecarComposition, SidecarPersonalization } from "@t3tools/project-recipes";

import { createPendingT3workInlineWorkflowPrompt } from "~/t3work/t3work-inlineRecipeLaunchLocal";
import { buildT3workSidecarSectionResetLaunch } from "~/t3work/t3work-sidecarPersonalizationReset";

const DEFAULT_COMPOSITION: SidecarComposition = {
  sections: [
    { sectionId: "quick-starts", visible: true, collapsed: false },
    { sectionId: "recent-conversations", visible: true, collapsed: false },
  ],
};

describe("t3work-inlineRecipeLaunchLocal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not persist reset changes until the approval action is submitted", async () => {
    const personalization: SidecarPersonalization = {
      composition: {
        sections: [
          { sectionId: "recent-conversations", visible: true, collapsed: false },
          { sectionId: "quick-starts", visible: true, collapsed: true },
        ],
      },
      itemPins: { "quick-starts": ["recipe-a"] },
    };
    const launch = buildT3workSidecarSectionResetLaunch({
      surface: "project.dashboard.backlog",
      sectionId: "quick-starts",
      sectionTitle: "Quick Starts",
      defaultComposition: DEFAULT_COMPOSITION,
      personalization,
    });

    const prompt = launch ? createPendingT3workInlineWorkflowPrompt(launch) : null;

    expect(prompt?.workflowCard.awaitingActionId).toBe("approve");
    expect(mockPersistStoredSidecarPersonalization).not.toHaveBeenCalled();

    const outcome = await prompt?.submitApprovedAction();

    expect(mockPersistStoredSidecarPersonalization).toHaveBeenCalledWith({});
    expect(outcome).toEqual({
      applied: true,
      promptText: "Restored 3 customizations in Quick Starts.",
    });
  });
});
