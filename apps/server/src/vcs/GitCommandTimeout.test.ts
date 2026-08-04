import { assert, describe, it } from "@effect/vitest";

import { resolveGitCommandTimeoutMs } from "./GitCommandTimeout.ts";

describe("resolveGitCommandTimeoutMs", () => {
  it("gives fetch, push, and pull commands a five-minute timeout", () => {
    for (const command of ["fetch", "push", "pull"]) {
      assert.strictEqual(resolveGitCommandTimeoutMs([command]), 300_000);
    }
  });

  it("recognizes network commands after Git global options", () => {
    assert.strictEqual(
      resolveGitCommandTimeoutMs(["--git-dir", "/repo/.git", "fetch", "--all"]),
      300_000,
    );
    assert.strictEqual(
      resolveGitCommandTimeoutMs(["-c", "credential.helper=", "push", "origin", "main"]),
      300_000,
    );
  });

  it("keeps local commands at thirty seconds", () => {
    assert.strictEqual(resolveGitCommandTimeoutMs(["status", "--short"]), 30_000);
    assert.strictEqual(resolveGitCommandTimeoutMs(["checkout", "push"]), 30_000);
  });

  it("preserves an explicit operation timeout", () => {
    assert.strictEqual(resolveGitCommandTimeoutMs(["fetch", "origin"], 5_000), 5_000);
  });
});
