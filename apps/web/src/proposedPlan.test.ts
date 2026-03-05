import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  buildProposedPlanMarkdownFilename,
  findLatestProposedPlanMessage,
  parseProposedPlanMessage,
  proposedPlanTitle,
} from "./proposedPlan";

describe("parseProposedPlanMessage", () => {
  it("extracts the proposed plan block and surrounding assistant text", () => {
    expect(
      parseProposedPlanMessage(
        "First I checked the repo.\n\n<proposed_plan>\n# Ship plan\n\n- step 1\n</proposed_plan>\n\nImplement this plan?",
      ),
    ).toEqual({
      beforeText: "First I checked the repo.",
      planMarkdown: "# Ship plan\n\n- step 1",
      afterText: "Implement this plan?",
    });
  });

  it("returns null when the assistant message has no plan block", () => {
    expect(parseProposedPlanMessage("Plain assistant text")).toBeNull();
  });
});

describe("findLatestProposedPlanMessage", () => {
  it("prefers the latest turn assistant message id when it contains a proposed plan", () => {
    const match = findLatestProposedPlanMessage(
      [
        {
          id: MessageId.makeUnsafe("assistant:older-plan"),
          role: "assistant",
          text: "<proposed_plan>\n# Older plan\n</proposed_plan>",
          createdAt: "2026-03-05T00:00:00.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant:latest-plan"),
          role: "assistant",
          text: "<proposed_plan>\n# Latest plan\n</proposed_plan>",
          createdAt: "2026-03-05T00:01:00.000Z",
          streaming: false,
        },
      ],
      "assistant:latest-plan",
    );

    expect(match?.message.id).toBe("assistant:latest-plan");
    expect(match?.plan.planMarkdown).toBe("# Latest plan");
  });

  it("falls back to the latest assistant proposed plan when no latest-turn message id is available", () => {
    const match = findLatestProposedPlanMessage(
      [
        {
          id: MessageId.makeUnsafe("assistant:plain"),
          role: "assistant",
          text: "No plan here",
          createdAt: "2026-03-05T00:00:00.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant:plan"),
          role: "assistant",
          text: "<proposed_plan>\n# Fallback plan\n</proposed_plan>",
          createdAt: "2026-03-05T00:01:00.000Z",
          streaming: false,
        },
      ],
      null,
    );

    expect(match?.message.id).toBe("assistant:plan");
    expect(match?.plan.planMarkdown).toBe("# Fallback plan");
  });
});

describe("proposedPlanTitle", () => {
  it("reads the first markdown heading as the plan title", () => {
    expect(proposedPlanTitle("# Integrate RPC\n\nBody")).toBe("Integrate RPC");
  });

  it("returns null when the plan has no heading", () => {
    expect(proposedPlanTitle("- step 1")).toBeNull();
  });
});

describe("buildPlanImplementationPrompt", () => {
  it("formats the plan exactly like the Codex follow-up handoff prompt", () => {
    expect(buildPlanImplementationPrompt("## Ship it\n\n- step 1\n")).toBe(
      "PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1",
    );
  });
});

describe("buildPlanImplementationThreadTitle", () => {
  it("uses the plan heading when building the implementation thread title", () => {
    expect(buildPlanImplementationThreadTitle("# Integrate RPC\n\nBody")).toBe(
      "Implement Integrate RPC",
    );
  });

  it("falls back when the plan has no markdown heading", () => {
    expect(buildPlanImplementationThreadTitle("- step 1")).toBe("Implement plan");
  });
});

describe("buildProposedPlanMarkdownFilename", () => {
  it("derives a stable markdown filename from the plan heading", () => {
    expect(buildProposedPlanMarkdownFilename("# Integrate Effect RPC Into Server App")).toBe(
      "integrate-effect-rpc-into-server-app.md",
    );
  });

  it("falls back to a generic filename when the plan has no heading", () => {
    expect(buildProposedPlanMarkdownFilename("- step 1")).toBe("plan.md");
  });
});
