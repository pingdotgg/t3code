import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import { parseDiffAnchors } from "./diffAnchors.ts";
import {
  buildReviewBody,
  normalizeFindings,
  partitionReviewComments,
  resolveReviewEvent,
} from "./reviewPayload.ts";

const ANCHORS = parseDiffAnchors(
  [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -8,2 +8,3 @@",
    " context",
    "-gone",
    "+added",
    "+more",
  ].join("\n"),
);

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

  it("demotes comments whose line is not part of the diff", () => {
    const { anchorable, unanchored } = partitionReviewComments(
      [
        { path: "a.ts", line: 9, side: "RIGHT", severity: "blocking", body: "real" },
        { path: "a.ts", line: 250, side: "RIGHT", severity: "important", body: "off-diff" },
        { path: "untouched.ts", line: 3, side: null, severity: "nit", body: "wrong file" },
      ],
      ANCHORS,
    );
    expect(anchorable).toHaveLength(1);
    expect(anchorable[0]?.body).toContain("real");
    expect(unanchored.map((comment) => comment.body)).toEqual(["off-diff", "wrong file"]);
  });

  it("posts a renamed file under the path GitHub expects for the side", () => {
    const renameAnchors = parseDiffAnchors(
      [
        "diff --git a/old.ts b/new.ts",
        "--- a/old.ts",
        "+++ b/new.ts",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-dropped",
        "+added",
      ].join("\n"),
    );
    const { anchorable } = partitionReviewComments(
      [
        { path: "old.ts", line: 2, side: null, severity: "important", body: "on the new file" },
        { path: "new.ts", line: 2, side: "LEFT", severity: "nit", body: "on the old file" },
      ],
      renameAnchors,
    );
    expect(anchorable.map((comment) => [comment.path, comment.side])).toEqual([
      ["new.ts", "RIGHT"],
      ["old.ts", "LEFT"],
    ]);
  });

  it("resolves the anchorable side when the model omits or mislabels it", () => {
    const { anchorable } = partitionReviewComments(
      [
        { path: "./a.ts", line: 10, side: null, severity: "nit", body: "added line" },
        { path: "a.ts", line: 9, side: "LEFT", severity: "nit", body: "removed line" },
      ],
      ANCHORS,
    );
    expect(anchorable.map((comment) => comment.side)).toEqual(["RIGHT", "LEFT"]);
    expect(anchorable[0]?.path).toBe("a.ts");
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

  it("does not claim findings missed the diff when GitHub refused the batch", () => {
    const body = buildReviewBody({
      findings: { summary: "Needs work", decision: "comment", comments: [] },
      unanchored: [
        { path: "a.ts", line: 9, side: "RIGHT", severity: "blocking", body: "was anchorable" },
      ],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      headSha: "abcdef1234567890",
      unanchoredReason: "inline-rejected",
    });
    expect(body).toContain("Inline comments could not be posted");
    expect(body).not.toContain("Could not anchor");
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
