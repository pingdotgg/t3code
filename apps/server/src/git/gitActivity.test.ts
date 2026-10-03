import { describe, expect, it } from "vitest";

import { isGitMutatingInvocation } from "./gitActivity.ts";

describe("Git activity mutation classification", () => {
  it("identifies read-only invocations, including after Git global options", () => {
    for (const args of [
      ["status", "--short"],
      ["rev-parse", "--show-toplevel"],
      ["-C", "/repo", "status", "--short"],
    ]) {
      expect(isGitMutatingInvocation(args)).toBe(false);
    }
  });

  it("records mutating commands, including after Git global options", () => {
    expect(isGitMutatingInvocation(["commit", "-m", "message"])).toBe(true);
    expect(isGitMutatingInvocation(["push", "origin", "HEAD"])).toBe(true);
    expect(isGitMutatingInvocation(["-c", "http.extraheader=Authorization: token", "push"])).toBe(
      true,
    );
    expect(isGitMutatingInvocation(["branch", "feature"])).toBe(true);
  });

  it("does not treat query variants of mixed Git commands as mutations", () => {
    expect(isGitMutatingInvocation(["branch", "--show-current"])).toBe(false);
    expect(isGitMutatingInvocation(["branch", "-l", "feature*"])).toBe(false);
    expect(isGitMutatingInvocation(["tag", "-n"])).toBe(false);
    expect(isGitMutatingInvocation(["remote", "-v"])).toBe(false);
    expect(isGitMutatingInvocation(["config", "--get", "user.name"])).toBe(false);
  });
});
