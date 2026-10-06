import { describe, expect, it } from "@effect/vitest";

import { splitProposedPlanBlock } from "./ProposedPlanBlock.ts";

describe("splitProposedPlanBlock", () => {
  it("returns plain prose when there is no tag", () => {
    expect(splitProposedPlanBlock("Hello there")).toEqual({
      prose: "Hello there",
      plan: null,
      planComplete: false,
    });
  });

  it("splits a complete block with prose before and after", () => {
    expect(
      splitProposedPlanBlock("Intro\n<proposed_plan>\n# Plan\n- a\n</proposed_plan>\nOutro"),
    ).toEqual({ prose: "Intro\n\nOutro", plan: "# Plan\n- a", planComplete: true });
  });

  it("treats an unclosed block as a streaming plan", () => {
    expect(splitProposedPlanBlock("Intro\n<proposed_plan>\n# Pl")).toEqual({
      prose: "Intro",
      plan: "# Pl",
      planComplete: false,
    });
  });

  it("hides a trailing partial opening tag", () => {
    expect(splitProposedPlanBlock("Intro\n<propo").prose).toBe("Intro");
    expect(splitProposedPlanBlock("<proposed_plan").prose).toBe("");
  });

  it("ignores a tag that is not on its own line", () => {
    const result = splitProposedPlanBlock("Use the <proposed_plan> tag like so");
    expect(result.plan).toBeNull();
    expect(result.prose).toBe("Use the <proposed_plan> tag like so");
  });

  it("only closes on a standalone closing tag", () => {
    const result = splitProposedPlanBlock(
      "<proposed_plan>\nUse `</proposed_plan>` to end it.\n# Rest\n</proposed_plan>\nDone",
    );
    expect(result.plan).toBe("Use `</proposed_plan>` to end it.\n# Rest");
    expect(result.prose).toBe("Done");
  });

  it("keeps text without a plan block untouched", () => {
    expect(splitProposedPlanBlock("    indented code\n").prose).toBe("    indented code\n");
  });
});
