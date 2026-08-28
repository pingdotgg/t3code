import { describe, expect, it } from "vite-plus/test";

import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  buildProposedPlanMarkdownFilename,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
  stripDisplayedPlanMarkdown,
} from "./proposedPlan";

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

describe("buildCollapsedProposedPlanPreviewMarkdown", () => {
  it("drops the redundant title heading and preserves the following markdown lines", () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown(
        "# Integrate RPC\n\n## Summary\n\n- step 1\n- step 2",
        {
          maxLines: 4,
        },
      ),
    ).toBe("- step 1\n- step 2");
  });

  it("appends an overflow marker when the preview truncates remaining content", () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown("# Integrate RPC\n\n- step 1\n- step 2\n- step 3", {
        maxLines: 2,
      }),
    ).toBe("- step 1\n- step 2\n\n...");
  });

  it("finishes a mermaid fence instead of truncating it mid-block", () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown(
        [
          "# Kataar",
          "",
          "Two audiences, two surfaces, one queue:",
          "",
          "```mermaid",
          "flowchart LR",
          "  Guest[Guest] --> Form[Join form]",
          "  Form --> Queue[Host queue]",
          "  Queue --> Host[Host app]",
          "```",
          "",
          "- more work",
        ].join("\n"),
        { maxLines: 4 },
      ),
    ).toBe(
      [
        "Two audiences, two surfaces, one queue:",
        "",
        "```mermaid",
        "flowchart LR",
        "  Guest[Guest] --> Form[Join form]",
        "  Form --> Queue[Host queue]",
        "  Queue --> Host[Host app]",
        "```",
        "",
        "...",
      ].join("\n"),
    );
  });

  it("keeps a leading mermaid flowchart in the collapsed preview", () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown(
        [
          "# Kataar",
          "",
          "```mermaid",
          "flowchart LR",
          "  Guest[Guest] --> Form[Join form]",
          "  Form --> Queue[Host queue]",
          "  Queue --> Host[Host app]",
          "```",
          "",
          "Then we build the host console.",
        ].join("\n"),
        { maxLines: 2 },
      ),
    ).toBe(
      [
        "```mermaid",
        "flowchart LR",
        "  Guest[Guest] --> Form[Join form]",
        "  Form --> Queue[Host queue]",
        "  Queue --> Host[Host app]",
        "```",
        "",
        "...",
      ].join("\n"),
    );
  });

  it("keeps a mermaid fence that fits entirely in the preview", () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown(
        [
          "# Kataar",
          "",
          "```mermaid",
          "flowchart LR",
          "  A --> B",
          "```",
          "",
          "- more work",
          "- even more",
          "- still more",
        ].join("\n"),
        { maxLines: 5 },
      ),
    ).toBe("```mermaid\nflowchart LR\n  A --> B\n```\n\n- more work\n\n...");
  });

  it("tracks mermaid fences nested in a blockquote", () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown(
        [
          "# Kataar",
          "",
          "Intro",
          "",
          "> ```mermaid",
          "> flowchart LR",
          ">   A --> B",
          ">   B --> C",
          "> ```",
          "",
          "- more work",
        ].join("\n"),
        { maxLines: 2 },
      ),
    ).toBe(
      [
        "Intro",
        "",
        "> ```mermaid",
        "> flowchart LR",
        ">   A --> B",
        ">   B --> C",
        "> ```",
        "",
        "...",
      ].join("\n"),
    );
  });

  it("does not treat a backtick info string as an opening fence", () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown(
        ["# Title", "", "```mermaid`nope", "- one", "- two", "- three"].join("\n"),
        { maxLines: 2 },
      ),
    ).toBe("```mermaid`nope\n- one\n\n...");
  });

  it("drops an unclosed fence instead of swallowing the rest of the plan", () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown(
        [
          "# Kataar",
          "",
          "Intro",
          "",
          "```mermaid",
          "flowchart LR",
          "  A --> B",
          "- later work that is not a closing fence",
          "- still more",
        ].join("\n"),
        { maxLines: 2 },
      ),
    ).toBe("Intro\n\n...");
  });
});

describe("stripDisplayedPlanMarkdown", () => {
  it("drops the leading title heading from displayed plan markdown", () => {
    expect(stripDisplayedPlanMarkdown("# Integrate RPC\n\n## Summary\n\n- step 1\n")).toBe(
      "- step 1",
    );
  });

  it("preserves non-summary headings after dropping the title heading", () => {
    expect(stripDisplayedPlanMarkdown("# Integrate RPC\n\n## Scope\n\n- step 1\n")).toBe(
      "## Scope\n\n- step 1",
    );
  });
});

describe("resolvePlanFollowUpSubmission", () => {
  it("switches to default mode when implementing the ready plan without extra text", () => {
    expect(
      resolvePlanFollowUpSubmission({
        draftText: "   ",
        planMarkdown: "## Ship it\n\n- step 1\n",
      }),
    ).toEqual({
      text: "PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1",
      interactionMode: "default",
    });
  });

  it("stays in plan mode when the user adds a follow-up prompt", () => {
    expect(
      resolvePlanFollowUpSubmission({
        draftText: "Refine step 2 first",
        planMarkdown: "## Ship it\n\n- step 1\n",
      }),
    ).toEqual({
      text: "Refine step 2 first",
      interactionMode: "plan",
    });
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
