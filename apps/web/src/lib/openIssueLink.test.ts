import { describe, expect, it, vi } from "vite-plus/test";

const { openExternal, toast } = vi.hoisted(() => ({ openExternal: vi.fn(), toast: vi.fn() }));
vi.mock("../localApi", () => ({ readLocalApi: () => ({ shell: { openExternal } }) }));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: toast },
}));

import { pullRequestSurfaceId } from "../rightPanelStore";
import {
  findProjectForLink,
  linkedPullRequestTarget,
  openLinkInBrowser,
  repositoryForProjectLink,
} from "./openIssueLink";

describe("openLinkInBrowser", () => {
  it.each(["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd", "not a URL"])(
    "rejects unsafe issue links before opening them: %s",
    async (targetUrl) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      openLinkInBrowser(targetUrl);
      await vi.waitFor(() => expect(toast).toHaveBeenCalled());
      expect(openExternal).not.toHaveBeenCalled();
      toast.mockClear();
    },
  );

  it("opens the requested issue URL", () => {
    openExternal.mockResolvedValueOnce(undefined);
    const targetUrl = "https://github.com/pingdotgg/t3code/issues/123";
    openLinkInBrowser(targetUrl);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(targetUrl);
  });
});

describe("findProjectForLink", () => {
  const project = (identity: Record<string, unknown>) =>
    ({ id: "p1", repositoryIdentity: identity }) as never;

  it("matches a nested GitLab group by the whole path below the host", () => {
    // The server identifies a repository by `displayName`, which keeps every group segment; the
    // two-segment owner/name form would look for `t3tools/t3code` and find nothing.
    const projects = [
      project({
        canonicalKey: "gitlab.com/t3tools/platform/t3code",
        provider: "gitlab",
        displayName: "t3tools/platform/t3code",
        owner: "t3tools",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForLink(projects, {
        repository: "t3tools/platform/t3code",
        number: 42,
        url: "https://gitlab.com/t3tools/platform/t3code/issues/42",
      }),
    ).toBe(projects[0]);
  });

  it("keeps two hosts apart, so an Enterprise link does not open the public one", () => {
    const projects = [
      project({
        canonicalKey: "github.com/pingdotgg/t3code",
        provider: "github",
        owner: "pingdotgg",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForLink(projects, {
        repository: "pingdotgg/t3code",
        number: 1,
        url: "https://github.acme.test/pingdotgg/t3code/issues/1",
      }),
    ).toBeUndefined();
  });

  it("claims nothing for a lookalike host, which is what keeps a link a link", () => {
    const projects = [
      project({
        canonicalKey: "github.com/pingdotgg/t3code",
        provider: "github",
        owner: "pingdotgg",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForLink(projects, {
        repository: "pingdotgg/t3code",
        number: 1,
        url: "https://github.com-evil.test/pingdotgg/t3code/issues/1",
      }),
    ).toBeUndefined();
  });

  it("matches an Azure DevOps work item to any repository under its team project", () => {
    // A work item names only `{organisation}/{project}`; the project's identity carries the git
    // repository below it, so the match is a prefix rather than the exact path the other hosts use.
    const projects = [
      project({
        canonicalKey: "dev.azure.com/acme/platform/_git/t3code",
        provider: "azure-devops",
        displayName: "acme/platform/_git/t3code",
        owner: "acme/platform",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForLink(projects, {
        repository: "acme/platform",
        number: 17,
        url: "https://dev.azure.com/acme/platform/issues/17",
      }),
    ).toBe(projects[0]);
  });

  it("does not let a nested GitLab project claim an issue filed on the group above it", () => {
    // Only an Azure DevOps work item names a path above the repository. A GitLab link names the
    // whole project path, so `group/repo` is a different repository from `group/repo/subrepo`.
    const projects = [
      project({
        canonicalKey: "gitlab.com/group/repo/subrepo",
        provider: "gitlab",
        displayName: "group/repo/subrepo",
        owner: "group/repo",
        name: "subrepo",
      }),
    ];
    expect(
      findProjectForLink(projects, {
        repository: "group/repo",
        number: 7,
        url: "https://gitlab.com/group/repo/issues/7",
      }),
    ).toBeUndefined();
  });

  it("does not let one team project's prefix match another with a similar name", () => {
    const projects = [
      project({
        canonicalKey: "dev.azure.com/acme/platformx/_git/t3code",
        provider: "azure-devops",
        displayName: "acme/platformx/_git/t3code",
        owner: "acme/platformx",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForLink(projects, {
        repository: "acme/platform",
        number: 17,
        url: "https://dev.azure.com/acme/platform/issues/17",
      }),
    ).toBeUndefined();
  });
});

describe("repositoryForProjectLink", () => {
  it("keeps the repository identity casing used by the provider", () => {
    const project = {
      repositoryIdentity: { displayName: "Acme/Web" },
    } as never;

    expect(repositoryForProjectLink(project, "acme/web")).toBe("Acme/Web");
  });
});

describe("linkedPullRequestTarget", () => {
  it("opens the same tab as the list row, with the host and the project's repository casing", () => {
    const project = { id: "p1", repositoryIdentity: { displayName: "Acme/Web" } } as never;
    const target = linkedPullRequestTarget(project, {
      repository: "acme/web",
      number: 7,
      url: "https://github.com/acme/web/pull/7",
    });
    expect(pullRequestSurfaceId(target)).toBe(
      pullRequestSurfaceId({
        projectId: "p1",
        host: "github.com",
        repository: "Acme/Web",
        number: 7,
      }),
    );
  });
});
