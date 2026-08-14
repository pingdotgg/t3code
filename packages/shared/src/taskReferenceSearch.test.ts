import { describe, expect, it } from "vite-plus/test";

import { buildTaskReferenceSearchIndex, searchTaskReferences } from "./taskReferenceSearch.ts";

const task = (id: string, title: string, updatedAt: string, branch: string | null = null) => ({
  id,
  title,
  updatedAt,
  branch,
});

describe("task reference search", () => {
  it("shows the most recently active tasks for an empty query", () => {
    const index = buildTaskReferenceSearchIndex([
      task("one", "Older", "2026-01-01T00:00:00.000Z"),
      task("two", "Newer", "2026-02-01T00:00:00.000Z"),
    ]);

    expect(searchTaskReferences(index, "").map(({ id }) => id)).toEqual(["two", "one"]);
  });

  it("ranks rare title terms ahead of branch-only matches", () => {
    const index = buildTaskReferenceSearchIndex([
      task("one", "Authentication follow-up", "2026-01-01T00:00:00.000Z"),
      task("two", "Unrelated", "2026-02-01T00:00:00.000Z", "feat/auth-flow"),
      task("three", "Unrelated again", "2026-03-01T00:00:00.000Z"),
    ]);

    expect(searchTaskReferences(index, "auth").map(({ id }) => id)).toEqual(["one", "two"]);
  });

  it("supports compact fuzzy subsequences", () => {
    const index = buildTaskReferenceSearchIndex([
      task("one", "Provider retry policy", "2026-01-01T00:00:00.000Z"),
      task("two", "Project cleanup", "2026-02-01T00:00:00.000Z"),
    ]);

    expect(searchTaskReferences(index, "prrp").map(({ id }) => id)).toEqual(["one"]);
  });

  it("keeps only the requested top-k results", () => {
    const index = buildTaskReferenceSearchIndex(
      Array.from({ length: 100 }, (_, index) =>
        task(String(index), `Task ${index}`, "2026-01-01T00:00:00.000Z"),
      ),
    );

    expect(searchTaskReferences(index, "", 5)).toHaveLength(5);
  });

  it("ranks the expected result in a large task index", () => {
    const index = buildTaskReferenceSearchIndex(
      Array.from({ length: 10_000 }, (_, index) =>
        task(
          `thread-${index}`,
          index === 9_999 ? "Authentication migration" : `Unrelated task ${index}`,
          "2026-01-01T00:00:00.000Z",
          `feat/branch-${index}`,
        ),
      ),
    );
    const result = searchTaskReferences(index, "auth");

    expect(result[0]?.id).toBe("thread-9999");
  });
});
