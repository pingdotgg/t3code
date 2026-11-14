import { describe, expect, it } from "vite-plus/test";

import { stashEntrySnippet } from "./ComposerStashMenu";

const entry = (prompt: string) => ({
  id: "stash-1",
  createdAt: "2026-10-01T00:00:00.000Z",
  prompt,
  attachments: [],
  droppedImageNames: [],
});

describe("stashEntrySnippet", () => {
  it("cuts a long prompt on a whole character", () => {
    expect(stashEntrySnippet(entry(`${"a".repeat(89)}😀 and more`))).toBe(`${"a".repeat(89)}…`);
    expect(stashEntrySnippet(entry(`${"a".repeat(88)}😀 and more`))).toBe(`${"a".repeat(88)}😀…`);
  });
});
