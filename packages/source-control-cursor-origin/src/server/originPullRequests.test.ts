import { assert, describe, it } from "@effect/vitest";

import { checksState, originCheck, originFilesPatch, pullReference } from "./originPullRequests.ts";

const run = (status: string, conclusion?: string) =>
  originCheck({ name: `${status}-${conclusion ?? ""}`, status, conclusion });

describe("checksState", () => {
  it("rolls up Origin check runs", () => {
    assert.strictEqual(checksState([]), null);
    assert.strictEqual(
      checksState([run("completed", "success"), run("completed", "skipped")]),
      "passing",
    );
    assert.strictEqual(checksState([run("completed", "success"), run("in_progress")]), "pending");
    assert.strictEqual(
      checksState([run("completed", "success"), run("completed", "cancelled")]),
      "failing",
    );
    assert.strictEqual(
      checksState([run("in_progress"), run("completed", "action_required")]),
      "failing",
    );
  });
});

describe("originFilesPatch", () => {
  const header = (file: Parameters<typeof originFilesPatch>[0][number]) =>
    originFilesPatch([file]).split("\n").slice(0, 4);

  it("keeps rename and copy metadata", () => {
    assert.deepStrictEqual(
      header({ filename: "b.ts", previousFilename: "a.ts", status: "renamed" }),
      ["diff --git a/a.ts b/b.ts", "similarity index 100%", "rename from a.ts", "rename to b.ts"],
    );
    // Origin leaves out the hunks of large files, which must not read as a pure rename.
    assert.strictEqual(
      header({ filename: "b.ts", previousFilename: "a.ts", status: "renamed", changes: 4 })[1],
      "similarity index 0%",
    );
    assert.deepStrictEqual(
      header({
        filename: "b.ts",
        previousFilename: "a.ts",
        status: "copied",
        patch: "@@ -1 +1 @@\n-a\n+b",
      }).slice(1),
      ["similarity index 0%", "copy from a.ts", "copy to b.ts"],
    );
  });
});

describe("pullReference", () => {
  it("separates pull request numbers, Origin links, and branches", () => {
    assert.deepStrictEqual(pullReference("42"), { repository: null, number: 42 });
    assert.deepStrictEqual(pullReference(" #42 "), { repository: null, number: 42 });
    assert.deepStrictEqual(pullReference("https://cursor.com/codebase/Acme/Web/pull/7"), {
      repository: "acme/web",
      number: 7,
    });
    for (const branch of ["123/fix", "feature/pull/42", "https://github.com/acme/web/pull/7"])
      assert.deepStrictEqual(pullReference(branch), { repository: null, number: null });
  });
});
