import { describe, expect, it } from "vite-plus/test";

import {
  buildAssistantResponseQuoteInsertion,
  formatAssistantResponseQuote,
} from "./assistantResponseQuote";

describe("assistant response quotes", () => {
  it("formats multiline markdown as a reply quote", () => {
    expect(formatAssistantResponseQuote("  First line\n\n- second line  ")).toBe(
      [
        "> **Replying to an assistant response:**",
        ">",
        "> First line",
        "> ",
        "> - second line",
      ].join("\n"),
    );
  });

  it("inserts after existing composer text without adding excess blank lines", () => {
    expect(buildAssistantResponseQuoteInsertion("My note\n", "quoted text")).toBe(
      ["", "> **Replying to an assistant response:**", ">", "> quoted text", "", ""].join("\n"),
    );
    expect(buildAssistantResponseQuoteInsertion("", "   ")).toBeNull();
  });
});
