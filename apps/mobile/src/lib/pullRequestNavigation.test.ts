import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestCandidateForIssueLink } from "./pullRequestNavigation";

const ref = { projectId: ProjectId.make("project-1"), host: "github.com", scope: "acme/app" };

describe("pullRequestCandidateForIssueLink", () => {
  it("offers a pull request only where the host numbers issues and pull requests together", () => {
    expect(
      pullRequestCandidateForIssueLink("https://github.com/acme/app/issues/12", {
        ...ref,
        key: "12",
      }),
    ).toEqual({
      target: { projectId: "project-1", host: "github.com", repository: "acme/app", number: 12 },
      navigationUrl: undefined,
    });
    expect(
      pullRequestCandidateForIssueLink("https://gitlab.com/acme/app/-/issues/12", {
        ...ref,
        host: "gitlab.com",
        key: "12",
      }),
    ).toBeNull();
    expect(
      pullRequestCandidateForIssueLink("https://dev.azure.com/acme/app/_workitems/edit/12", {
        ...ref,
        host: "dev.azure.com",
        key: "12",
      }),
    ).toBeNull();
  });

  it("keeps a comment anchor for the pull request screen to scroll to", () => {
    expect(
      pullRequestCandidateForIssueLink("https://github.com/acme/app/issues/12#issuecomment-345", {
        ...ref,
        key: "12",
      })?.navigationUrl,
    ).toBe("https://github.com/acme/app/pull/12#issuecomment-345");
  });
});
