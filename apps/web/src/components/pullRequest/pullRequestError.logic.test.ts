import { describe, expect, it } from "vite-plus/test";
import { pullRequestErrorHint } from "./pullRequestError.logic";

describe("pull request error guidance", () => {
  it.each([
    ["HTTP 429: API rate limit exceeded", "Wait for the limit"],
    ["HTTP 403: API rate limit exceeded", "Wait for the limit"],
    ["invalid_credential", "Sign in"],
    ["HTTP 403 Forbidden", "signed-in account"],
    ["HTTP 404 Not Found", "repository access"],
    ["fetch failed: ECONNRESET", "connection"],
  ])("explains recovery for %s", (message, hint) => {
    expect(pullRequestErrorHint(message)).toContain(hint);
  });
  it("does not guess a cause for an unknown host error", () => {
    expect(pullRequestErrorHint("The host could not complete this action")).toBeNull();
  });
});
