import { describe, expect, it } from "vite-plus/test";

import { threadTitleTextFromPrompt } from "./threadTitle.ts";

describe("threadTitleTextFromPrompt", () => {
  it("names a mentioned model by its slug, without the reference syntax", () => {
    expect(threadTitleTextFromPrompt("Delegate to model:codex/gpt-6.1-sol and report back")).toBe(
      "Delegate to gpt-6.1-sol and report back",
    );
    expect(
      threadTitleTextFromPrompt("model:opencode/anthropic/opus, then model:codex/gpt-5.4."),
    ).toBe("anthropic/opus, then gpt-5.4.");
  });

  it("composes NFD macOS paths mentioned in the prompt", () => {
    expect(threadTitleTextFromPrompt("Read @\u1109\u1175\u110b\u1161\u11ab/a.txt")).toBe(
      "Read @\uc2dc\uc548/a.txt",
    );
  });
});
