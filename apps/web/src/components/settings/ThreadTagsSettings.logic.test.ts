import { describe, expect, it } from "vite-plus/test";

import { checkTagRename } from "./ThreadTagsSettings.logic";

describe("checkTagRename", () => {
  const existing = ["bug", "Review"];

  it.each([
    ["bug", "  bug ", { kind: "unchanged" }],
    ["bug", "Bug", { kind: "ok", to: "Bug", merges: false }],
    ["bug", "review", { kind: "ok", to: "Review", merges: true }],
    ["bug", "defect", { kind: "ok", to: "defect", merges: false }],
    ["bug", "   ", { kind: "error", message: "Enter a tag." }],
    ["bug", "a\nb", { kind: "error", message: "Tags are one line of text." }],
    ["bug", "x".repeat(65), { kind: "error", message: "Tags are 64 characters at most." }],
  ])("%s -> %j", (tag, input, expected) => {
    expect(checkTagRename(tag, input, existing)).toEqual(expected);
  });
});
