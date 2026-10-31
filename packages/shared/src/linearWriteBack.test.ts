import { describe, expect, it } from "@effect/vitest";

import {
  isStateMoveEligible,
  renderChatCommentBody,
  renderPipelineCommentBody,
} from "./linearWriteBack.ts";

describe("isStateMoveEligible", () => {
  it("allows only states before work starts", () => {
    for (const type of ["backlog", "triage", "unstarted"]) {
      expect(isStateMoveEligible(type)).toBe(true);
    }
    for (const type of ["started", "completed", "canceled", "other"]) {
      expect(isStateMoveEligible(type)).toBe(false);
    }
  });
});

describe("renderPipelineCommentBody", () => {
  const base = { pipelineName: "Feature delivery", threadUrl: "https://t3.example/env/thread" };

  it("lists steps with their status and links the run", () => {
    expect(
      renderPipelineCommentBody({
        ...base,
        runStatus: "running",
        steps: [
          { name: "Plan", status: "completed" },
          { name: "Implement", status: "running" },
          { name: "Review", status: "pending" },
        ],
      }),
    ).toBe(
      [
        '**T3 Code pipeline "Feature delivery"** (Running: Implement)',
        "",
        "- ✅ Plan",
        "- ▶️ Implement",
        "- ☐ Review",
        "",
        "[Open in T3 Code](https://t3.example/env/thread)",
      ].join("\n"),
    );
  });

  it("reports final and attention states", () => {
    const steps = [{ name: "Plan", status: "failed" as const }];
    expect(renderPipelineCommentBody({ ...base, runStatus: "paused", steps })).toContain(
      'Needs attention: "Plan" failed',
    );
    expect(renderPipelineCommentBody({ ...base, runStatus: "completed", steps: [] })).toContain(
      "(Completed)",
    );
    expect(renderPipelineCommentBody({ ...base, runStatus: "cancelled", steps: [] })).toContain(
      "(Cancelled)",
    );
  });

  it("is deterministic", () => {
    const input = { ...base, runStatus: "running" as const, steps: [] };
    expect(renderPipelineCommentBody(input)).toBe(renderPipelineCommentBody(input));
  });
});

describe("renderChatCommentBody", () => {
  it("links the thread and keeps bracket characters out of the link text", () => {
    expect(
      renderChatCommentBody({
        viewerName: "Ada",
        threadTitle: "Fix [bug]",
        threadUrl: "https://t3.example/e/t",
      }),
    ).toBe("Ada started a T3 Code chat: [Fix bug](https://t3.example/e/t)");
  });
});
