import { describe, expect, it } from "vite-plus/test";

import { codexFileCitationMarkdown, resolveCodexFileCitationLink } from "./codexFileCitations.js";

describe("resolveCodexFileCitationLink", () => {
  it("resolves the attributes emitted by Codex", () => {
    expect(
      resolveCodexFileCitationLink({
        path: "/workspace/outputs/issue-2387-sparse-diagonal.xlsx",
        purpose: "output",
      }),
    ).toEqual({
      path: "/workspace/outputs/issue-2387-sparse-diagonal.xlsx",
      href: "/workspace/outputs/issue-2387-sparse-diagonal.xlsx",
      label: "issue-2387-sparse-diagonal.xlsx",
    });
  });

  it("carries the first cited line into the file href", () => {
    expect(
      resolveCodexFileCitationLink({
        path: "src/main.ts",
        line_range_start: "42",
        line_range_end: "48",
        git_url: "https://example.com/main.ts",
      }),
    ).toEqual({
      path: "src/main.ts",
      href: "src/main.ts#L42",
      label: "main.ts",
      lineRangeStart: 42,
    });
  });

  it("rejects missing paths and invalid line numbers", () => {
    expect(resolveCodexFileCitationLink({ purpose: "output" })).toBeNull();
    expect(
      resolveCodexFileCitationLink({ path: "src/main.ts", line_range_start: "not-a-line" }),
    ).toEqual({
      path: "src/main.ts",
      href: "src/main.ts",
      label: "main.ts",
    });
  });

  it("preserves URL syntax characters in file paths", () => {
    expect(
      resolveCodexFileCitationLink({
        path: "reports/100% #1? draft.md",
        line_range_start: "7",
      }),
    ).toEqual({
      path: "reports/100% #1? draft.md",
      href: "reports/100%25 %231%3F draft.md#L7",
      label: "100% #1? draft.md",
      lineRangeStart: 7,
    });
  });
});

describe("codexFileCitationMarkdown", () => {
  it("produces a portable Markdown link", () => {
    const citation = resolveCodexFileCitationLink({ path: "reports/profit and loss.xlsx" });
    expect(citation && codexFileCitationMarkdown(citation)).toBe(
      "[profit and loss.xlsx](<reports/profit and loss.xlsx>)",
    );
  });

  it("escapes Markdown syntax in the visible filename", () => {
    const citation = resolveCodexFileCitationLink({
      path: "reports/*draft*_[copy]`<&.txt",
    });
    expect(citation && codexFileCitationMarkdown(citation)).toBe(
      "[\\*draft\\*\\_\\[copy\\]\\`\\<\\&.txt](<reports/*draft*_[copy]`%3C&.txt>)",
    );
  });
});
