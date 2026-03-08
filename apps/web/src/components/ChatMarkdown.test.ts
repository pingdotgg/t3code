import { describe, expect, it } from "vitest";

import { extractRunnableCommandFromCodeBlock } from "../lib/runnableMarkdownCommand";

describe("extractRunnableCommandFromCodeBlock", () => {
  it("returns shell commands for runnable shell fences", () => {
    expect(
      extractRunnableCommandFromCodeBlock("language-bash", "bun lint\nbun typecheck"),
    ).toBe("bun lint\nbun typecheck");
  });

  it("strips prompt prefixes from console-style snippets", () => {
    expect(
      extractRunnableCommandFromCodeBlock("language-console", "$ bun lint\n$ bun typecheck"),
    ).toBe("bun lint\nbun typecheck");
  });

  it("allows prompt-style text fences but not arbitrary text fences", () => {
    expect(extractRunnableCommandFromCodeBlock(undefined, "$ git status\n$ git diff --stat")).toBe(
      "git status\ngit diff --stat",
    );
    expect(extractRunnableCommandFromCodeBlock(undefined, "const answer = 42;")).toBeNull();
  });

  it("does not expose run for console transcripts that include output", () => {
    expect(
      extractRunnableCommandFromCodeBlock("language-console", "$ bun lint\nChecked 218 files"),
    ).toBeNull();
  });

  it("does not expose run for non-shell languages", () => {
    expect(extractRunnableCommandFromCodeBlock("language-ts", "console.log('hi')")).toBeNull();
  });
});
