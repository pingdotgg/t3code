import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  buildReviewBody,
  normalizeFindings,
  partitionReviewComments,
  resolveReviewEvent,
} from "./reviewPayload.ts";

describe("reviewPayload", () => {
  it("partitions comments without lines into unanchored", () => {
    const { anchorable, unanchored } = partitionReviewComments([
      {
        path: "a.ts",
        line: 10,
        side: "RIGHT",
        severity: "important",
        body: "fix me",
      },
      {
        path: "b.ts",
        line: null,
        side: null,
        severity: "nit",
        body: "style",
      },
    ]);
    expect(anchorable).toHaveLength(1);
    expect(unanchored).toHaveLength(1);
    expect(anchorable[0]?.line).toBe(10);
  });

  it("maps blocking findings to request_changes regardless of model decision", () => {
    expect(
      resolveReviewEvent({
        summary: "issues",
        decision: "approve",
        comments: [
          {
            path: "a.ts",
            line: 1,
            side: "RIGHT",
            severity: "blocking",
            body: "bad",
          },
        ],
      }),
    ).toBe("request_changes");
  });

  it("includes footer and unanchored section in body", () => {
    const body = buildReviewBody({
      findings: {
        summary: "Needs work",
        decision: "comment",
        comments: [],
      },
      unanchored: [
        {
          path: "loose.ts",
          line: null,
          side: null,
          severity: "important",
          body: "general concern",
        },
      ],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      headSha: "abcdef1234567890",
    });
    expect(body).toContain("Needs work");
    expect(body).toContain("Could not anchor");
    expect(body).toContain("SergeCode auto-review");
    expect(body).toContain("abcdef123456");
  });

  it("normalizes empty paths out of findings", () => {
    const normalized = normalizeFindings({
      summary: "  ok  ",
      decision: "approve",
      comments: [
        { path: "  ", line: 1, side: "RIGHT", severity: "nit", body: "x" },
        { path: "a.ts", line: 2, side: "RIGHT", severity: "nit", body: " y " },
      ],
    });
    expect(normalized.summary).toBe("ok");
    expect(normalized.decision).toBe("comment");
    expect(normalized.comments).toHaveLength(1);
    expect(normalized.comments[0]?.body).toBe("y");
  });
});
