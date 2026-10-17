import type { PullRequestCheck } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { markRequiredForgejoChecks } from "./forgejoRequiredChecks.ts";

const check = (name: string): PullRequestCheck => ({
  name,
  status: "success",
  description: null,
  url: null,
});
const requiredNames = (
  names: ReadonlyArray<string>,
  contexts: ReadonlyArray<string> | null,
  enabled = true,
) =>
  markRequiredForgejoChecks(names.map(check), {
    enable_status_check: enabled,
    status_check_contexts: contexts,
  }).flatMap((marked) => (marked.required ? [marked.name] : []));

describe("markRequiredForgejoChecks", () => {
  it("marks exact contexts", () => {
    assert.deepStrictEqual(requiredNames(["build", "build-docs", "lint"], ["build"]), ["build"]);
  });

  it("lets * and ** match across slashes, as Forgejo compiles contexts without separators", () => {
    const names = ["ci/test (push)", "ci/nightly/test (push)", "lint (push)"];
    assert.deepStrictEqual(requiredNames(names, ["ci/*"]), names.slice(0, 2));
    assert.deepStrictEqual(requiredNames(names, ["ci/**"]), names.slice(0, 2));
    assert.deepStrictEqual(requiredNames(names, ["*(push)"]), names);
  });

  it("matches one character with ? and treats regex characters literally", () => {
    const names = ["node 20", "node 22", "node 2", "a.b", "axb"];
    assert.deepStrictEqual(requiredNames(names, ["node 2?"]), ["node 20", "node 22"]);
    assert.deepStrictEqual(requiredNames(names, ["a.b"]), ["a.b"]);
  });

  it("leaves checks unmarked when status checks are off or list no contexts", () => {
    assert.deepStrictEqual(requiredNames(["build"], ["build"], false), []);
    assert.deepStrictEqual(requiredNames(["build"], []), []);
    assert.deepStrictEqual(requiredNames(["build"], null), []);
    assert.deepStrictEqual(
      markRequiredForgejoChecks([check("build")], {}).map((marked) => marked.required),
      [undefined],
    );
  });

  it("adds an exact context with no status yet as a pending required check", () => {
    const contexts = { enable_status_check: true, status_check_contexts: ["build", "test"] };
    assert.deepStrictEqual(markRequiredForgejoChecks([check("build")], contexts), [
      { ...check("build"), required: true },
      { name: "test", status: "pending", description: null, url: null, required: true },
    ]);
  });

  it("adds nothing for a glob context that matches no status", () => {
    const contexts = { enable_status_check: true, status_check_contexts: ["ci/*"] };
    assert.deepStrictEqual(markRequiredForgejoChecks([check("lint")], contexts), [check("lint")]);
  });

  it("keeps every check gating when a context uses glob syntax it cannot match", () => {
    assert.deepStrictEqual(requiredNames(["build", "test-a"], ["build", "test-[ab]"]), []);
    assert.deepStrictEqual(requiredNames(["build", "test-a"], ["{build,lint}"]), []);
  });
});
