import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as Json from "./originPullRequestJson.ts";

const decodePull = Schema.decodeUnknownSync(Json.OriginPull);

const pull = {
  id: "pr_one",
  number: "17",
  state: "open",
  draft: true,
  merged: false,
  title: "Change",
  body: "Body",
  head: { ref: "refs/heads/feature", sha: "abcdef" },
  base: { ref: "main", sha: "123456" },
  author: { user: { id: "user_1", email: "alice@example.com", handle: "alice" } },
  createdAt: "2026-09-12T12:00:00Z",
  updatedAt: "2026-09-12T12:00:00Z",
  additions: 3,
  deletions: 1,
  changedFiles: 2,
  labels: [{ id: "lbl_1", name: "bug", color: "d73a4a" }],
  webUrl: "https://cursor.com/codebase/owner/repo/pull/17",
};

describe("Origin pull number and state", () => {
  it("parses string pull numbers", () => {
    const row = decodePull(pull);
    assert.strictEqual(row.number, 17);
  });

  it.each([
    [{ state: "open", merged: false }, "open"],
    [{ state: "closed", merged: false }, "closed"],
    [{ state: "closed", merged: true }, "merged"],
    [{ state: "open", merged: true }, "merged"],
  ] as const)("maps %j to %s", (flags, state) => {
    assert.strictEqual(Json.pullState(flags), state);
  });

  it("builds a change request with short branch names and labels", () => {
    const row = Json.toChangeRequest(decodePull(pull), "owner/repo");
    assert.strictEqual(row.state, "open");
    assert.isTrue(row.isDraft);
    assert.strictEqual(row.headBranch, "feature");
    assert.strictEqual(row.baseBranch, "main");
    assert.strictEqual(row.url, "https://cursor.com/codebase/owner/repo/pull/17");
    assert.deepStrictEqual(row.author, {
      login: "alice",
      name: null,
      avatarUrl: null,
    });
    assert.deepStrictEqual(row.labels, [{ name: "bug", color: "#d73a4a" }]);
  });
});

describe("toDiff", () => {
  it("concatenates file patches with git headers", () => {
    const { patch, nextCursor } = Json.toDiff({
      files: [
        {
          filename: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1,1 +1,1 @@\n-old\n+new\n",
        },
        {
          filename: "src/b.ts",
          status: "added",
          additions: 1,
          deletions: 0,
          patch: "@@ -0,0 +1,1 @@\n+hello\n",
        },
      ],
      nextPageToken: "cursor-2",
    });
    assert.include(patch, "diff --git a/src/a.ts b/src/a.ts\n");
    assert.include(patch, "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n");
    assert.include(patch, "new file mode 100644\n");
    assert.strictEqual(nextCursor, "cursor-2");
  });
});
