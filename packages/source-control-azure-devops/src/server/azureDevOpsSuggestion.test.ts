import { expect, it } from "vite-plus/test";
import { applyAzureDevOpsSuggestion } from "./azureDevOpsSuggestion.ts";
it("replaces the selected lines and preserves CRLF and the final newline", () => {
  expect(
    applyAzureDevOpsSuggestion({
      body: "Test\n```suggestion\nnew line\nsecond line\n```",
      content: "first\r\nold\r\nlast\r\n",
      startLine: 2,
      endLine: 2,
    }),
  ).toBe("first\r\nnew line\r\nsecond line\r\nlast\r\n");
});
it("leaves every other line's own ending in a mixed-ending file", () => {
  const apply = (body: string, content: string, line: number) =>
    applyAzureDevOpsSuggestion({ body, content, startLine: line, endLine: line });
  expect(apply("```suggestion\nB\n```", "a\nb\nc\r\nd\n", 2)).toBe("a\nB\nc\r\nd\n");
  expect(apply("```suggestion\nC\n```", "a\nb\nc\r\nd\n", 3)).toBe("a\nb\nC\r\nd\n");
  // The last line has no ending of its own, so new lines take the one before it.
  expect(apply("```suggestion\nx\ny\n```", "a\r\nb", 2)).toBe("a\r\nx\r\ny");
});
it("deletes the selected lines for an empty suggestion", () => {
  expect(
    applyAzureDevOpsSuggestion({
      body: "Remove these\n```suggestion\n```",
      content: "a\r\nb\nc\nd\r\n",
      startLine: 2,
      endLine: 3,
    }),
  ).toBe("a\r\nd\r\n");
  expect(
    applyAzureDevOpsSuggestion({
      body: "```suggestion\r\n```",
      content: "a\nb\n",
      startLine: 2,
      endLine: 2,
    }),
  ).toBe("a\n");
});
it("refuses an invalid range or ambiguous suggestions", () => {
  for (const body of [
    "no suggestion",
    "```suggestion\na\n```\n```suggestion\nb\n```",
    "```suggestion\n```\n```suggestion\nb\n```",
    "```suggestion\na\n```extra",
  ])
    expect(() =>
      applyAzureDevOpsSuggestion({ body, content: "first\n", startLine: 1, endLine: 1 }),
    ).toThrow();
  expect(() =>
    applyAzureDevOpsSuggestion({
      body: "```suggestion\na\n```",
      content: "first\n",
      startLine: 2,
      endLine: 2,
    }),
  ).toThrow();
});
