import { expect, it } from "vite-plus/test";
import { searchableMessageSegments } from "./threadFindText.ts";

it("searches review comment prose, not its transport attributes or attached diff", () => {
  const text = [
    "Before **review**",
    '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="hidden.ts" startIndex="3" endIndex="14" rangeLabel="L4">',
    "Keep **this literal** comment.",
    "```diff",
    "+ hidden patch content",
    "```",
    "</review_comment>",
    "After review",
  ].join("\n");
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual([
    "Before review",
    "Keep **this literal** comment.",
    "After review",
  ]);
});

it("keeps malformed review tags visible, matching the message renderer", () => {
  const text = "<review_comment>not a valid attachment</review_comment>";
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual([text]);
});
