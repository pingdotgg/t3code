import { expect, it } from "vite-plus/test";

import { hardBreakAssistantFieldLines } from "./markdownFieldLines.ts";

it("hard-breaks only paragraphs made entirely of label/value lines", () => {
  const text = [
    "Name: Acme Ltd",
    "**Bank:** Example Bank",
    "",
    "Wrapped prose: split by",
    "a newline in the source.",
    "",
    "```text",
    "Name: Acme Ltd",
    "Bank: Example Bank",
    "```",
  ].join("\n");
  expect(hardBreakAssistantFieldLines(text)).toBe(
    text.replace("Name: Acme Ltd\n**Bank:**", "Name: Acme Ltd  \n**Bank:**"),
  );
});

it("leaves existing hard breaks and newlines inside inline code as written", () => {
  for (const text of [
    "Name: Acme\\\nBank: Example",
    "Name: Acme  \nBank: Example",
    "Name: `one\nBank: two`",
  ]) {
    expect(hardBreakAssistantFieldLines(text)).toBe(text);
  }
});
