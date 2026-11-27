import { describe, expect, it } from "vite-plus/test";

import { folderTagChanges } from "./threadTags.ts";

describe("folderTagChanges", () => {
  it.each([
    {
      name: "moves into a new folder before leaving the others",
      tags: ["a", "b"],
      folder: "c",
      expected: [
        { tag: "c", tagged: true },
        { tag: "a", tagged: false },
        { tag: "b", tagged: false },
      ],
    },
    {
      name: "keeps the target and drops the rest",
      tags: ["a", "b"],
      folder: "b",
      expected: [{ tag: "a", tagged: false }],
    },
    { name: "is a no-op when already only in the folder", tags: ["a"], folder: "a", expected: [] },
    {
      name: "moves back to the project by removing every tag",
      tags: ["a", "b"],
      folder: null,
      expected: [
        { tag: "a", tagged: false },
        { tag: "b", tagged: false },
      ],
    },
    { name: "is a no-op back in the project", tags: [], folder: null, expected: [] },
  ])("$name", ({ tags, folder, expected }) => {
    expect(folderTagChanges(tags, folder)).toEqual(expected);
  });
});
