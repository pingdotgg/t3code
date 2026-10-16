import { expect, it } from "vite-plus/test";
import { pullRequestSuggestion } from "./pullRequestSuggestion.ts";

it("recognizes replacement and deletion suggestions with either line ending", () => {
  expect(pullRequestSuggestion("Replace this\n```suggestion\nnew line\n``` ")).toBe("new line\n");
  expect(pullRequestSuggestion("```suggestion\r\nnew line\r\n```\r\n")).toBe("new line\r\n");
  expect(pullRequestSuggestion("Delete this\n```suggestion\n```")).toBe("");
  expect(pullRequestSuggestion("```suggestion\r\n```")).toBe("");
});

it("refuses missing, incomplete, or multiple suggestions", () => {
  for (const body of [
    "No suggestion",
    "```suggestion\nunfinished",
    "```suggestion\nline\n```extra",
    "```suggestion\na\n```\n```suggestion\nb\n```",
    "```suggestion\n```\n```suggestion\nb\n```",
  ])
    expect(pullRequestSuggestion(body)).toBeNull();
});
