import { describe, expect, it } from "vite-plus/test";

import {
  cursorAfterRangeReplacement,
  findPullRequestLinks,
  isPullRequestPage,
  mapCursor,
  mapUntouchedRange,
} from "./pullRequestLinkPaste";

const link = "https://github.com/owner/repo/pull/12";

describe("findPullRequestLinks", () => {
  it.each([
    ["a bare link", link, [[0, link.length]]],
    ["a link in prose, leaving sentence punctuation", `see ${link}.`, [[4, 4 + link.length]]],
    ["an autolink", `<${link}>`, [[0, link.length + 2]]],
    ["a labeled link", `[the fix](${link})`, [[0, link.length + 11]]],
    ["a link in parentheses", `(${link})`, [[1, 1 + link.length]]],
    ["no link in a code span", `\`${link}\``, []],
    ["no link in a fence", `\`\`\`\n${link}\n\`\`\``, []],
    ["no link to one comment", `${link}#issuecomment-1`, []],
    ["no link to the files tab", `${link}/files`, []],
  ])("finds %s", (_name, markdown, expected) => {
    expect(findPullRequestLinks(markdown).map(({ start, end }) => [start, end])).toEqual(expected);
  });

  it("reads each link's URL", () => {
    expect(findPullRequestLinks(`[fix](${link}) and <${link}/>`).map(({ url }) => url)).toEqual([
      link,
      `${link}/`,
    ]);
  });
});

describe("isPullRequestPage", () => {
  it.each([
    [link, true],
    [`${link}/`, true],
    [`${link}/commits/1234567`, false],
    ["https://github.com/owner/repo/pull/12/commits/12", false],
    ["https://gitlab.com/group/repo/-/merge_requests/12", true],
    ["https://dev.azure.com/org/project/_git/repo/pullrequest/12", true],
    [`${link}?w=1`, false],
    ["https://github.com/owner/repo/pull/112", false],
  ])("reads %s as pull request 12's page: %s", (url, expected) => {
    expect(isPullRequestPage(url, 12)).toBe(expected);
  });
});

describe("mapUntouchedRange", () => {
  const before = `see ${link} now`;
  const range = { start: 4, end: 4 + link.length };
  it.each([
    ["unchanged", before, range],
    ["after typing after it", `see ${link} now, thanks`, range],
    ["after typing before it", `please see ${link} now`, { start: 11, end: 11 + link.length }],
    ["after an edit inside it", `see ${link.replace("12", "13")} now`, null],
    ["after edits on both sides of it", `I see ${link} right now`, null],
    ["after it was deleted", "see  now", null],
  ])("maps a range %s", (_name, after, expected) => {
    expect(mapUntouchedRange(range, before, after)).toEqual(expected);
  });
});

describe("mapCursor", () => {
  it.each([
    ["before an edit", 2, "abcdef", "abXXcdef", 2],
    ["after an edit", 5, "abcdef", "abXXcdef", 7],
    ["inside a replaced span", 3, "abcdef", "abXYZef", 5],
  ])("maps a caret %s", (_name, cursor, before, after, expected) => {
    expect(mapCursor(cursor, before, after)).toBe(expected);
  });
});

describe("cursorAfterRangeReplacement", () => {
  const range = { start: 4, end: 10 };
  it.each([
    ["before the range", 2, 2],
    ["after the range", 15, 13],
    ["inside the range", 6, 8],
  ])("keeps a caret %s on its text", (_name, cursor, expected) => {
    expect(cursorAfterRangeReplacement(cursor, range, 4)).toEqual(expected);
  });
});
