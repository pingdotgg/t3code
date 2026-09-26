import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  COMMENT_EXCERPT_MAX_CHARS,
  buildCommentExcerpt,
  commentUnavailableReason,
  formatCommentRangeLabel,
  lineAtOffset,
  normalizeCommentRange,
  selectionLineRange,
} from "./fileComments.ts";

const sixtyLineFile = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n");

NodeTest.describe("file comments", () => {
  NodeTest.describe("normalizeCommentRange", () => {
    NodeTest.it("orders a backwards selection and clamps to line 1", () => {
      NodeAssert.deepEqual(normalizeCommentRange(9, 5), { startLine: 5, endLine: 9 });
      NodeAssert.deepEqual(normalizeCommentRange(0, -3), { startLine: 1, endLine: 1 });
      NodeAssert.deepEqual(normalizeCommentRange(4, 4), { startLine: 4, endLine: 4 });
    });
  });

  NodeTest.describe("formatCommentRangeLabel", () => {
    NodeTest.it("matches the native label shapes", () => {
      NodeAssert.equal(formatCommentRangeLabel(5, 5), "L5");
      NodeAssert.equal(formatCommentRangeLabel(5, 9), "L5 to L9");
      NodeAssert.equal(formatCommentRangeLabel(9, 5), "L5 to L9");
      NodeAssert.equal(formatCommentRangeLabel(40, 42), "L40 to L42");
    });
  });

  NodeTest.describe("lineAtOffset", () => {
    NodeTest.it("counts newlines before the offset and clamps", () => {
      NodeAssert.equal(lineAtOffset("a\nb\nc", 0), 1);
      NodeAssert.equal(lineAtOffset("a\nb\nc", 1), 1);
      NodeAssert.equal(lineAtOffset("a\nb\nc", 2), 2);
      NodeAssert.equal(lineAtOffset("a\nb\nc", 4), 3);
      NodeAssert.equal(lineAtOffset("a\nb\nc", 99), 3);
      NodeAssert.equal(lineAtOffset("", 0), 1);
    });
  });

  NodeTest.describe("selectionLineRange", () => {
    NodeTest.it("returns null for an empty selection", () => {
      NodeAssert.equal(selectionLineRange(sixtyLineFile, 10, 10), null);
      NodeAssert.equal(selectionLineRange(sixtyLineFile, 0, 0), null);
    });

    NodeTest.it("expands a partial selection to the full lines it touches", () => {
      // Select from the middle of line 40 to the middle of line 42.
      const lines = sixtyLineFile.split("\n");
      const start = lines.slice(0, 39).join("\n").length + 1 + 2;
      const end = lines.slice(0, 41).join("\n").length + 1 + 3;
      NodeAssert.deepEqual(selectionLineRange(sixtyLineFile, start, end), {
        startLine: 40,
        endLine: 42,
      });
      // Backwards selections normalize the same way.
      NodeAssert.deepEqual(selectionLineRange(sixtyLineFile, end, start), {
        startLine: 40,
        endLine: 42,
      });
    });

    NodeTest.it("a selection ending at a line boundary belongs to the previous line", () => {
      const text = "one\ntwo\nthree";
      // "one\n" selected: end sits at the start of line 2.
      NodeAssert.deepEqual(selectionLineRange(text, 0, 4), { startLine: 1, endLine: 1 });
      // "one\ntwo\n" selected.
      NodeAssert.deepEqual(selectionLineRange(text, 0, 8), { startLine: 1, endLine: 2 });
    });

    NodeTest.it("clamps into the text", () => {
      NodeAssert.deepEqual(selectionLineRange("abc", -5, 99), { startLine: 1, endLine: 1 });
    });
  });

  NodeTest.describe("buildCommentExcerpt", () => {
    NodeTest.it("quotes exactly the selected full lines", () => {
      const result = buildCommentExcerpt(sixtyLineFile, { startLine: 40, endLine: 42 });
      NodeAssert.equal(result.excerpt, "line 40\nline 41\nline 42");
      NodeAssert.equal(result.truncated, false);
    });

    NodeTest.it("normalizes a backwards range", () => {
      const result = buildCommentExcerpt(sixtyLineFile, { startLine: 42, endLine: 40 });
      NodeAssert.equal(result.excerpt, "line 40\nline 41\nline 42");
    });

    NodeTest.it("caps at the excerpt bound on a character boundary and discloses it", () => {
      const wide = Array.from({ length: 10 }, (_, index) => `row ${index} ${"x".repeat(90)}`).join(
        "\n",
      );
      const result = buildCommentExcerpt(wide, { startLine: 1, endLine: 10 });
      NodeAssert.equal(result.truncated, true);
      NodeAssert.equal(result.excerpt.length, COMMENT_EXCERPT_MAX_CHARS);
      NodeAssert.equal(wide.startsWith(result.excerpt), true);
      // A custom bound honors the same rule.
      const smaller = buildCommentExcerpt(wide, { startLine: 1, endLine: 10 }, 100);
      NodeAssert.equal(smaller.excerpt.length, 100);
      NodeAssert.equal(smaller.truncated, true);
    });

    NodeTest.it("never splits a surrogate pair at the cut", () => {
      const text = "a".repeat(COMMENT_EXCERPT_MAX_CHARS - 1) + "😀tail";
      const result = buildCommentExcerpt(text, { startLine: 1, endLine: 1 });
      NodeAssert.equal(result.truncated, true);
      NodeAssert.equal(result.excerpt.length, COMMENT_EXCERPT_MAX_CHARS - 1);
      NodeAssert.equal(result.excerpt.endsWith("a"), true);
    });

    NodeTest.it("quotes through the end of the file without a trailing newline", () => {
      NodeAssert.deepEqual(buildCommentExcerpt("one\ntwo", { startLine: 1, endLine: 2 }), {
        excerpt: "one\ntwo",
        truncated: false,
      });
    });
  });

  NodeTest.describe("commentUnavailableReason", () => {
    const ready = {
      transport: "client",
      detail: null,
      operations: { attachAnnotation: true },
    };

    NodeTest.it("allows the action on a client transport with thread scope", () => {
      NodeAssert.equal(commentUnavailableReason(ready, "thread-a"), null);
    });

    NodeTest.it("names a client-less host with the returned detail", () => {
      const down = {
        transport: "unavailable",
        detail:
          "Composer draft state is client-local; no connected client hosts the composer provider.",
        operations: { attachAnnotation: false },
      };
      NodeAssert.equal(commentUnavailableReason(down, "thread-a"), down.detail);
    });

    NodeTest.it("falls back to a named reason when detail is null", () => {
      const odd = { transport: "server", detail: null, operations: { attachAnnotation: false } };
      NodeAssert.equal(
        commentUnavailableReason(odd, "thread-a"),
        "Commenting needs a connected client hosting the composer provider.",
      );
    });

    NodeTest.it("names the missing thread scope", () => {
      NodeAssert.equal(
        commentUnavailableReason(ready, undefined),
        "This panel has no thread scope, so there is no draft to comment into.",
      );
    });
  });
});
