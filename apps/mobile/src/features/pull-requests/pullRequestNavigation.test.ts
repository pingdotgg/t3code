import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { nativePullRequestDestination } from "../../lib/pullRequestNavigation";

const context = { environmentId: "remote", projectId: "project" };
const project = (id: string, canonicalKey: string, provider: string, remoteUrl: string) => ({
  id: ProjectId.make(id),
  environmentId: EnvironmentId.make("remote"),
  repositoryIdentity: {
    canonicalKey,
    locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl },
    displayName: canonicalKey.split("/").slice(1).join("/"),
    provider,
  },
});
const projects = [
  project("project", "github.com/org/repo", "github", "git@github.com:org/repo.git"),
  project("gitlab", "git.example/group/sub/repo", "gitlab", "git@git.example:group/sub/repo.git"),
  project("forgejo", "forgejo.test/org/repo", "forgejo", "http://forgejo.test:3000/org/repo.git"),
];

describe("native PR entry points", () => {
  it("keeps a thread link in its own environment and handles renamed host path shapes", () => {
    expect(
      nativePullRequestDestination(
        "https://github.com/org/repo/pull/12/files#diff",
        context,
        projects,
      ),
    ).toEqual({ ...context, host: "github.com", repository: "org/repo", number: 12 });
    expect(
      nativePullRequestDestination(
        "https://git.example/group/sub/repo/-/merge_requests/9",
        context,
        projects,
      ),
    ).toMatchObject({ projectId: "gitlab", repository: "group/sub/repo" });
    expect(
      nativePullRequestDestination("http://forgejo.test:3000/org/repo/pulls/3", context, projects)
        ?.host,
    ).toBe("forgejo.test:3000");
  });

  it("leaves pull requests from repositories without a project to the external opener", () => {
    expect(
      nativePullRequestDestination("https://github.com/someone/else/pull/12", context, projects),
    ).toBeNull();
  });

  it("leaves issues, unknown sites, and unscoped links to the external opener", () => {
    expect(
      nativePullRequestDestination("https://github.com/org/repo/issues/12", context, projects),
    ).toBeNull();
    expect(
      nativePullRequestDestination("https://example.com/org/repo/pull/12", context, projects),
    ).toBeNull();
    expect(
      nativePullRequestDestination("https://github.com/org/repo/pull/12", null, projects),
    ).toBeNull();
  });
});
