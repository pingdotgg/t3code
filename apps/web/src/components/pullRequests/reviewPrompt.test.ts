import { assert, describe, it } from "vite-plus/test";

import type { ChangeRequest, SourceControlProviderKind } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { buildCodeReviewPrompt, buildCodeReviewThreadTitle, diffCommandFor } from "./reviewPrompt";

function makeChangeRequest(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    provider: "github",
    number: 42,
    title: "Add board view",
    url: "https://github.com/octocat/t3code/pull/42",
    baseRefName: "main",
    headRefName: "feat/board",
    state: "open",
    updatedAt: Option.none(),
    ...overrides,
  };
}

describe("diffCommandFor", () => {
  it("names the right CLI per provider", () => {
    const changeRequest = makeChangeRequest();
    assert.strictEqual(diffCommandFor("github", changeRequest), "gh pr diff 42");
    assert.strictEqual(diffCommandFor("gitlab", changeRequest), "glab mr diff 42");
    assert.include(diffCommandFor("azure-devops", changeRequest) ?? "", "az repos pr show --id 42");
  });

  it("falls back to git ranges for bitbucket, which has no first-party CLI here", () => {
    const command = diffCommandFor("bitbucket", makeChangeRequest()) ?? "";
    assert.include(command, "origin/main...origin/feat/board");
  });

  it("returns null for an unknown provider", () => {
    assert.strictEqual(diffCommandFor("unknown", makeChangeRequest()), null);
  });
});

describe("buildCodeReviewPrompt", () => {
  it("embeds the change request metadata", () => {
    const prompt = buildCodeReviewPrompt({
      changeRequest: makeChangeRequest({ author: "grace" }),
      instructions: "Look for race conditions.",
    });
    assert.include(prompt, "#42");
    assert.include(prompt, "Add board view");
    assert.include(prompt, "feat/board -> main");
    assert.include(prompt, "- Author: grace");
    assert.include(prompt, "https://github.com/octocat/t3code/pull/42");
  });

  it("tells the agent to fetch the diff with the provider's command", () => {
    const prompt = buildCodeReviewPrompt({
      changeRequest: makeChangeRequest(),
      instructions: "",
    });
    assert.include(prompt, "`gh pr diff 42`");
  });

  it("omits the author line when the provider did not report one", () => {
    const prompt = buildCodeReviewPrompt({
      changeRequest: makeChangeRequest(),
      instructions: "",
    });
    assert.notInclude(prompt, "- Author:");
  });

  it("appends the configured instructions", () => {
    const prompt = buildCodeReviewPrompt({
      changeRequest: makeChangeRequest(),
      instructions: "  Only report confirmed bugs.  ",
    });
    assert.include(prompt, "Only report confirmed bugs.");
    assert.notInclude(prompt, "  Only report confirmed bugs.  ");
  });

  it("still produces a usable prompt when instructions are blank", () => {
    const prompt = buildCodeReviewPrompt({
      changeRequest: makeChangeRequest(),
      instructions: "   ",
    });
    assert.include(prompt, "Review pull request #42");
    assert.isFalse(prompt.endsWith("\n"));
  });

  it("routes an unknown provider through the URL instead of naming a CLI", () => {
    const prompt = buildCodeReviewPrompt({
      changeRequest: makeChangeRequest({ provider: "unknown" as SourceControlProviderKind }),
      instructions: "",
    });
    assert.include(prompt, "whichever source control tool");
    assert.notInclude(prompt, "gh pr diff");
  });

  it("warns that the checkout is not the pull request's branch", () => {
    const prompt = buildCodeReviewPrompt({
      changeRequest: makeChangeRequest(),
      instructions: "",
    });
    assert.include(prompt, "current checkout");
  });
});

describe("buildCodeReviewThreadTitle", () => {
  it("leads with the number so review threads sort and scan by PR", () => {
    assert.strictEqual(
      buildCodeReviewThreadTitle(makeChangeRequest()),
      "Review #42 · Add board view",
    );
  });
});
