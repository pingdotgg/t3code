import { describe, expect, it } from "vite-plus/test";

import { searchThreadReferences } from "./threadReferenceSearch";

const thread = (id: string, title: string, updatedAt: string, branch: string | null = null) =>
  ({ id, title, updatedAt, branch }) as never;

describe("searchThreadReferences", () => {
  it("shows recently updated threads when the query is empty", () => {
    const result = searchThreadReferences(
      [
        thread("one", "Older", "2026-01-01T00:00:00.000Z"),
        thread("two", "Newer", "2026-02-01T00:00:00.000Z"),
      ],
      "",
    );

    expect(result.map(({ id }) => id)).toEqual(["two", "one"]);
  });

  it("ranks title, branch, and id matches", () => {
    const threads = [
      thread("thread-auth", "Authentication follow-up", "2026-01-01T00:00:00.000Z"),
      thread("thread-two", "Unrelated", "2026-01-02T00:00:00.000Z", "feat/auth-flow"),
    ];

    expect(searchThreadReferences(threads, "auth").map(({ id }) => id)).toEqual([
      "thread-auth",
      "thread-two",
    ]);
  });
});
