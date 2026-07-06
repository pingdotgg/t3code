import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { VcsProcessExitError } from "./vcs.ts";

const encodeVcsProcessExitError = Schema.encodeSync(VcsProcessExitError);

describe("VcsProcessExitError", () => {
  it("keeps raw stderr readable in-process but off the wire", () => {
    const secret = "x-access-token:ghp_super-secret-token";
    const error = VcsProcessExitError.fromProcessExit(
      { operation: "GitVcsDriver.push", command: "git", cwd: "/repo", argumentCount: 3 },
      {
        exitCode: 128,
        stderr: `fatal: unable to access 'https://${secret}@github.com/o/r.git/': authentication failed`,
        stderrTruncated: false,
      },
      "authentication",
    );

    // In-process consumers (failure classification) can read the raw text.
    expect(error.stderr).toContain("authentication failed");
    expect(error.stderr).toContain(secret);
    expect(error.stderrLength).toBeGreaterThan(0);
    expect(error.stderrTruncated).toBe(false);

    // The wire-encoded payload and naive JSON serialization both drop it:
    // only stderrLength/stderrTruncated cross the boundary.
    const encoded = encodeVcsProcessExitError(error);
    expect(encoded).not.toHaveProperty("stderr");
    expect(JSON.stringify(encoded)).not.toContain("ghp_super-secret-token");
    expect(JSON.stringify(error)).not.toContain("ghp_super-secret-token");
    expect(error.message).not.toContain("ghp_super-secret-token");
  });

  it("caps the retained stderr while reporting the full length", () => {
    const error = VcsProcessExitError.fromProcessExit(
      { operation: "op", command: "git", cwd: "/repo" },
      { exitCode: 1, stderr: "e".repeat(10_000), stderrTruncated: false },
      "command-failed",
    );

    expect(error.stderr?.length).toBe(8_192);
    expect(error.stderrLength).toBe(10_000);
  });
});
