import { describe, expect, it } from "vite-plus/test";

import { isNextPromptInDraft, toggleNextPromptInDraft } from "./nextPromptDraft";

describe("toggleNextPromptInDraft", () => {
  it.each([
    ["fills an empty box", "", "Ship it", "Ship it"],
    ["treats a blank box as empty", "  \n", "Ship it", "Ship it"],
    ["adds after a blank line", "Fix the bug", "Ship it", "Fix the bug\n\nShip it"],
    ["drops trailing space before adding", "$review \n", "Ship it", "$review\n\nShip it"],
    ["adds a third pick", "A\n\nB", "C", "A\n\nB\n\nC"],
    ["removes the only pick", "Ship it", "Ship it", ""],
    ["removes the last pick", "Fix the bug\n\nShip it", "Ship it", "Fix the bug"],
    ["removes a middle pick", "A\n\nB\n\nC", "B", "A\n\nC"],
    ["removes the first pick", "A\n\nB", "A", "B"],
    ["matches a skill despite its trailing space", "Fix\n\n$review", "$review ", "Fix"],
    ["keeps the person's other breaks", "A\n\n\nmine\nmore\n\nB", "B", "A\n\n\nmine\nmore"],
    [
      "adds when the text is only inside a paragraph",
      "Ship it now",
      "Ship it",
      "Ship it now\n\nShip it",
    ],
    [
      "adds when the text is a line of a paragraph",
      "Ship it\nnow",
      "Ship it",
      "Ship it\nnow\n\nShip it",
    ],
    [
      "keeps the next paragraph's indentation",
      "Ship it\n\n    const x = 1;",
      "Ship it",
      "    const x = 1;",
    ],
    ["removes a skill with its trailing space", "A\n\n$review ", "$review ", "A"],
    ["removes the first pick and its trailing space", "$review \n\nB", "$review ", "B"],
    [
      "removes a pick with its own blank line",
      "Fix\n\nReview\n\nRun checks",
      "Review\n\nRun checks",
      "Fix",
    ],
    ["keeps the person's trailing spaces", "A  \n\nB", "B", "A  "],
    ["removes a pick after Windows line endings", "A\r\n\r\nShip it", "Ship it", "A"],
    ["removes a first pick before Windows line endings", "Ship it\r\n\r\nA", "Ship it", "A"],
    ["removes only the first of two copies", "B\n\nA\n\nB", "B", "A\n\nB"],
  ])("%s", (_name, draft, insertText, expected) => {
    expect(toggleNextPromptInDraft(draft, insertText)).toBe(expected);
  });

  it.each([
    ["fills an empty box", "", "/compact ", "/compact "],
    ["goes before the person's text", "Fix the bug\n", "/compact ", "/compact\n\nFix the bug\n"],
    ["keeps the text's indentation", "\n    code", "/compact ", "/compact\n\n    code"],
    ["comes back out", "/compact\n\nFix the bug", "/compact ", "Fix the bug"],
  ])("a command %s", (_name, draft, insertText, expected) => {
    expect(toggleNextPromptInDraft(draft, insertText, { leading: true })).toBe(expected);
  });
});

describe("isNextPromptInDraft", () => {
  it("finds a pick as its own paragraph only", () => {
    expect(isNextPromptInDraft("Fix\n\nShip it", "Ship it")).toBe(true);
    expect(isNextPromptInDraft("Ship it now", "Ship it")).toBe(false);
    expect(isNextPromptInDraft("", "Ship it")).toBe(false);
    expect(isNextPromptInDraft("Review\n\nRun checks", "Review\n\nRun checks")).toBe(true);
  });
});
