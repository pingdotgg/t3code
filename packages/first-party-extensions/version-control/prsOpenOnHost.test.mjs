import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  prsBranchUrl,
  prsCommitUrl,
  prsHeadRepositoryUrl,
  prsOpenOnHostLabel,
  prsOpenRefusedLabel,
  prsRepositoryUrl,
} from "./prsViewModel.ts";

NodeTest.describe("open on host", () => {
  NodeTest.it("names the host the link lands on, as native does", () => {
    NodeAssert.equal(prsOpenOnHostLabel("github"), "Open on GitHub");
    NodeAssert.equal(prsOpenOnHostLabel("gitlab"), "Open on GitLab");
    NodeAssert.equal(prsOpenOnHostLabel("forgejo"), "Open on Forgejo");
    NodeAssert.equal(prsOpenOnHostLabel("bitbucket"), "Open on Bitbucket");
    NodeAssert.equal(prsOpenOnHostLabel("azure-devops"), "Open on Azure DevOps");
    NodeAssert.equal(prsOpenOnHostLabel("unknown"), "Open on host");
  });

  NodeTest.it("derives the repository root from a change-request URL", () => {
    NodeAssert.equal(prsRepositoryUrl("https://github.com/o/r/pull/12"), "https://github.com/o/r");
    NodeAssert.equal(
      prsRepositoryUrl("https://gitlab.com/g/sub/r/-/merge_requests/3?tab=diffs"),
      "https://gitlab.com/g/sub/r",
    );
    NodeAssert.equal(
      prsRepositoryUrl("https://bitbucket.org/w/r/pull-requests/4/overview"),
      "https://bitbucket.org/w/r",
    );
    NodeAssert.equal(
      prsRepositoryUrl("https://dev.azure.com/org/p/_git/r/pullrequest/5"),
      "https://dev.azure.com/org/p/_git/r",
    );
    NodeAssert.equal(
      prsRepositoryUrl("https://codeberg.org/o/r/pulls/6"),
      "https://codeberg.org/o/r",
    );
    NodeAssert.equal(prsRepositoryUrl("https://github.com/o/r"), null);
    NodeAssert.equal(prsRepositoryUrl("not a url"), null);
  });

  NodeTest.it("links a branch per host, keeping slashes and escaping the rest", () => {
    const repo = "https://github.com/o/r";
    NodeAssert.equal(prsBranchUrl("github", repo, "feat/a b"), `${repo}/tree/feat/a%20b`);
    NodeAssert.equal(prsBranchUrl("forgejo", repo, "x"), `${repo}/src/branch/x`);
    NodeAssert.equal(prsBranchUrl("gitlab", repo, "x/y"), `${repo}/-/tree/x/y`);
    NodeAssert.equal(prsBranchUrl("bitbucket", repo, "x/y"), `${repo}/branch/x/y`);
    NodeAssert.equal(prsBranchUrl("azure-devops", repo, "x/y"), `${repo}?version=GBx%2Fy`);
    NodeAssert.equal(prsBranchUrl("unknown", repo, "x"), null);
    NodeAssert.equal(prsBranchUrl("github", null, "x"), null);
  });

  NodeTest.it("finds a fork's head branch in the fork's repository", () => {
    const repo = "https://github.com/o/r";
    NodeAssert.equal(prsHeadRepositoryUrl(repo, "o/r", null), repo);
    NodeAssert.equal(prsHeadRepositoryUrl(repo, "o/r", "o/r"), repo);
    NodeAssert.equal(prsHeadRepositoryUrl(repo, "o/r", "me/r"), "https://github.com/me/r");
    NodeAssert.equal(prsHeadRepositoryUrl("https://x.test/other", "o/r", "me/r"), null);
    NodeAssert.equal(prsHeadRepositoryUrl(null, "o/r", "me/r"), null);
  });

  NodeTest.it("links a commit per host", () => {
    const repo = "https://example.test/o/r";
    NodeAssert.equal(prsCommitUrl("github", repo, "abc123"), `${repo}/commit/abc123`);
    NodeAssert.equal(prsCommitUrl("forgejo", repo, "abc123"), `${repo}/commit/abc123`);
    NodeAssert.equal(prsCommitUrl("azure-devops", repo, "abc123"), `${repo}/commit/abc123`);
    NodeAssert.equal(prsCommitUrl("gitlab", repo, "abc123"), `${repo}/-/commit/abc123`);
    NodeAssert.equal(prsCommitUrl("bitbucket", repo, "abc123"), `${repo}/commits/abc123`);
    NodeAssert.equal(prsCommitUrl("unknown", repo, "abc123"), null);
    NodeAssert.equal(prsCommitUrl("github", null, "abc123"), null);
  });

  NodeTest.it("names a refused open by its closed reason", () => {
    NodeAssert.equal(
      prsOpenRefusedLabel("opener-refused"),
      "Could not open the link — the system refused it.",
    );
    NodeAssert.equal(
      prsOpenRefusedLabel("scheme-not-allowed"),
      "Could not open the link — only http and https links open.",
    );
    NodeAssert.equal(
      prsOpenRefusedLabel("invalid-url"),
      "Could not open the link — the host sent an invalid address.",
    );
  });
});
