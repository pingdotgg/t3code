import { describe, expect, it } from "vite-plus/test";

import { canLinkChangeRequest } from "./usePullRequestLinking";
import { parseChangeRequestUrl } from "~/lib/openPullRequestLink";

describe("canLinkChangeRequest (#9435 / #9440)", () => {
  // A non-Git parent workspace (a folder of several child repositories that is not itself a
  // checkout) registers as a project with no `repositoryIdentity` at all.
  const nonGitProject = { id: "scratch-project" } as never;
  const link = parseChangeRequestUrl("https://github.com/pingdotgg/t3code/pull/15111")!;

  it("links a pasted pull request URL when the server tracks links on the thread, even with no matching project", () => {
    // `multiple` mode (the `threadPullRequests` capability) stores a link's host, repository
    // and number on the thread directly, so no project needs to match for the link itself.
    expect(canLinkChangeRequest("multiple", [nonGitProject], link)).toBe(true);
    expect(canLinkChangeRequest("multiple", [], link)).toBe(true);
  });

  it("still requires a matching project in single-link mode, where the link needs a projectId", () => {
    expect(canLinkChangeRequest("single", [nonGitProject], link)).toBe(false);
    expect(canLinkChangeRequest("single", [], link)).toBe(false);
  });

  it("never links when the environment does not support pull request linking", () => {
    expect(canLinkChangeRequest("unsupported", [nonGitProject], link)).toBe(false);
  });
});
