import { assert, describe, it } from "@effect/vitest";

import { GIT_COMMAND_TIMEOUT_MS, resolveGitCommandTimeoutMs } from "./GitCommandTimeout.ts";

describe("resolveGitCommandTimeoutMs", () => {
  it("gives fetch, push, and pull commands a five-minute timeout", () => {
    for (const command of ["fetch", "push", "pull"]) {
      assert.strictEqual(resolveGitCommandTimeoutMs([command]), GIT_COMMAND_TIMEOUT_MS.network);
    }
  });

  it("gives commits enough time to run repository hooks", () => {
    assert.strictEqual(resolveGitCommandTimeoutMs(["commit", "-m", "message"]), 600_000);
  });

  it("recognizes network commands after Git global options", () => {
    assert.strictEqual(
      resolveGitCommandTimeoutMs(["--git-dir", "/repo/.git", "fetch", "--all"]),
      GIT_COMMAND_TIMEOUT_MS.network,
    );
    assert.strictEqual(
      resolveGitCommandTimeoutMs(["-c", "credential.helper=", "push", "origin", "main"]),
      GIT_COMMAND_TIMEOUT_MS.network,
    );
  });

  it("keeps local commands at thirty seconds", () => {
    assert.strictEqual(
      resolveGitCommandTimeoutMs(["status", "--short"]),
      GIT_COMMAND_TIMEOUT_MS.local,
    );
    assert.strictEqual(
      resolveGitCommandTimeoutMs(["checkout", "push"]),
      GIT_COMMAND_TIMEOUT_MS.local,
    );
  });

  it("preserves an explicit operation timeout", () => {
    assert.strictEqual(resolveGitCommandTimeoutMs(["fetch", "origin"], 5_000), 5_000);
  });
});
