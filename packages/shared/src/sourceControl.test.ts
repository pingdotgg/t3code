import { describe, expect, it } from "vite-plus/test";

import {
  sourceControlRepositorySelector,
  detectSourceControlProviderFromRemoteUrl,
  getChangeRequestTerminologyForKind,
  isSshRemoteUrl,
  isProviderRepositoryUrlAllowed,
  resolveChangeRequestPresentation,
} from "./sourceControl.ts";

describe("source control presentation", () => {
  it("uses merge request terminology for GitLab", () => {
    expect(getChangeRequestTerminologyForKind("gitlab")).toEqual({
      shortLabel: "MR",
      singular: "merge request",
    });
  });

  it("uses pull request terminology for GitHub-compatible providers", () => {
    expect(getChangeRequestTerminologyForKind("github")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("azure-devops")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("bitbucket")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
  });

  it("falls back to generic change request copy for unknown providers", () => {
    expect(
      resolveChangeRequestPresentation({ kind: "unknown", name: "forge", baseUrl: "" }),
    ).toEqual(
      expect.objectContaining({
        shortName: "change request",
        longName: "change request",
      }),
    );
  });
});

describe("detectSourceControlProviderFromRemoteUrl", () => {
  it("detects common source control hosts", () => {
    expect(detectSourceControlProviderFromRemoteUrl("git@github.com:owner/repo.git")?.kind).toBe(
      "github",
    );
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.com/group/repo.git")?.kind,
    ).toBe("gitlab");
    expect(
      detectSourceControlProviderFromRemoteUrl("https://dev.azure.com/org/project/_git/repo")?.kind,
    ).toBe("azure-devops");
    expect(
      detectSourceControlProviderFromRemoteUrl("git@bitbucket.org:workspace/repo.git")?.kind,
    ).toBe("bitbucket");
  });

  it("detects Forgejo and Gitea hosts while preserving HTTP origins", () => {
    for (const host of ["codeberg.org", "forgejo.example.test", "gitea.example.test"]) {
      expect(detectSourceControlProviderFromRemoteUrl(`http://${host}:3000/team/repo.git`)).toEqual(
        {
          kind: "forgejo",
          name: "Forgejo",
          baseUrl: `http://${host}:3000`,
        },
      );
    }
    expect(getChangeRequestTerminologyForKind("forgejo")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
  });

  it("detects Azure DevOps SSH remotes", () => {
    // The default Azure DevOps SSH clone URL uses the ssh.dev.azure.com host.
    expect(
      detectSourceControlProviderFromRemoteUrl("git@ssh.dev.azure.com:v3/org/project/repo")?.kind,
    ).toBe("azure-devops");
    expect(
      detectSourceControlProviderFromRemoteUrl("ssh://git@ssh.dev.azure.com:22/v3/org/project/repo")
        ?.kind,
    ).toBe("azure-devops");
    // Legacy visualstudio.com SSH host stays classified too.
    expect(
      detectSourceControlProviderFromRemoteUrl("git@vs-ssh.visualstudio.com:v3/org/project/repo")
        ?.kind,
    ).toBe("azure-devops");
  });

  it("preserves ports while classifying by hostname", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.com:8443/group/repo.git"),
    ).toEqual({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.com:8443",
    });
    expect(
      detectSourceControlProviderFromRemoteUrl(
        "https://self-hosted.example.test:8443/group/repo.git",
      ),
    ).toEqual({
      kind: "unknown",
      name: "self-hosted.example.test:8443",
      baseUrl: "https://self-hosted.example.test:8443",
    });
  });

  it("does not reuse SSH ports for HTTPS provider URLs", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("ssh://git@gitlab.example.test:24/group/repo.git"),
    ).toEqual({
      kind: "gitlab",
      name: "GitLab Self-Hosted",
      baseUrl: "https://gitlab.example.test",
    });
    expect(
      detectSourceControlProviderFromRemoteUrl("ssh://git@code.example.test:24/team/project.git"),
    ).toEqual({
      kind: "unknown",
      name: "code.example.test",
      baseUrl: "https://code.example.test",
    });
  });

  it("matches self-hosted providers by complete DNS labels", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://github.example.com/owner/repo.git")?.kind,
    ).toBe("github");
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.example.com/group/repo.git")?.kind,
    ).toBe("gitlab");
    expect(
      detectSourceControlProviderFromRemoteUrl("https://bitbucket.example.com/workspace/repo.git")
        ?.kind,
    ).toBe("bitbucket");
  });

  it("does not match provider names embedded in unrelated DNS labels", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://notgithub.example.com/owner/repo.git")
        ?.kind,
    ).toBe("unknown");
    expect(
      detectSourceControlProviderFromRemoteUrl("https://notgitlab.example.com/group/repo.git")
        ?.kind,
    ).toBe("unknown");
    expect(
      detectSourceControlProviderFromRemoteUrl(
        "https://notbitbucket.example.com/workspace/repo.git",
      )?.kind,
    ).toBe("unknown");
  });

  it("detects SSH remotes with non-git SSH users (e.g. gitlab@, deploy@)", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("gitlab@gitlab.example.com:group/project.git")?.kind,
    ).toBe("gitlab");
    expect(
      detectSourceControlProviderFromRemoteUrl("gitlab@gitlab.example.com:group/project.git")
        ?.baseUrl,
    ).toBe("https://gitlab.example.com");
    expect(detectSourceControlProviderFromRemoteUrl("deploy@github.com:owner/repo.git")?.kind).toBe(
      "github",
    );
    expect(
      detectSourceControlProviderFromRemoteUrl("git@bitbucket.org:workspace/repo.git")?.kind,
    ).toBe("bitbucket");
  });
});

describe("isSshRemoteUrl", () => {
  it("recognises SCP-like SSH URLs with any SSH user prefix", () => {
    expect(isSshRemoteUrl("git@github.com:owner/repo.git")).toBe(true);
    expect(isSshRemoteUrl("gitlab@gitlab.example.com:group/project.git")).toBe(true);
    expect(isSshRemoteUrl("deploy@bitbucket.org:workspace/repo.git")).toBe(true);
  });

  it("recognises ssh:// URLs with any case", () => {
    expect(isSshRemoteUrl("ssh://git@gitlab.example.com/group/project.git")).toBe(true);
    expect(isSshRemoteUrl("ssh://git@gitlab.example.com:22/group/project.git")).toBe(true);
    expect(isSshRemoteUrl("SSH://git@gitlab.example.com/group/project.git")).toBe(true);
    expect(isSshRemoteUrl("SsH://git@gitlab.example.com/group/project.git")).toBe(true);
  });

  it("returns false for HTTPS, local paths, and SCP-like paths without a colon", () => {
    expect(isSshRemoteUrl("https://gitlab.example.com/group/project.git")).toBe(false);
    expect(isSshRemoteUrl("/home/user/repos/project")).toBe(false);
    expect(isSshRemoteUrl("")).toBe(false);
    expect(isSshRemoteUrl("deploy@github.com/project/repo")).toBe(false);
  });
});

it("names an Azure DevOps repository by its own name, not its project path", () => {
  // `az repos pr list --repository` takes a name and detects the organisation and project from
  // the checkout; the recorded `org/project/_git/repo` path is refused, and the repository then
  // reads as unavailable on the page.
  const selector = sourceControlRepositorySelector({
    provider: "azure-devops",
    displayName: "contoso/payments/_git/checkout",
    owner: "contoso",
    name: "checkout",
  });
  expect(selector).toBe("checkout");
});

it("falls back to the path's last segment where an Azure identity has no name", () => {
  const selector = sourceControlRepositorySelector({
    provider: "azure-devops",
    displayName: "contoso/payments/_git/checkout",
  });
  expect(selector).toBe("checkout");
});

it("keeps a GitLab identity's whole path, because a nested group is part of the name", () => {
  const selector = sourceControlRepositorySelector({
    provider: "gitlab",
    displayName: "group/subgroup/service",
    owner: "group",
    name: "service",
  });
  expect(selector).toBe("group/subgroup/service");
});

it("puts owner and name back together for an identity recorded before displayName", () => {
  const selector = sourceControlRepositorySelector({
    provider: "github",
    owner: "t3tools",
    name: "t3code",
  });
  expect(selector).toBe("t3tools/t3code");
});

it("names nothing for a project with no remote to name it by", () => {
  expect(sourceControlRepositorySelector(null)).toBeNull();
  expect(sourceControlRepositorySelector({ provider: "github" })).toBeNull();
});

describe("provider repository URL policy", () => {
  it.each([
    "https://forge.test/team/project.git",
    "https://user:password@forge.test/team/project.git",
    "git@forge.test:team/project.git",
    "ssh://git@forge.test:22/team/project.git",
    "ssh://git@forge.test:2222/team/project.git",
  ])("permits hosted repository %s", (url) => {
    expect(isProviderRepositoryUrlAllowed(url)).toBe(true);
  });

  it.each([
    "ext::echo blocked",
    "file:///tmp/repo",
    "/tmp/repo",
    "../repo",
    "--upload-pack=echo",
    "git://forge.test/team/project",
    "https://forge.test/team/white space.git",
  ])("rejects provider repository %s", (url) => {
    expect(isProviderRepositoryUrlAllowed(url)).toBe(false);
  });

  it("limits plain HTTP to the configured origin's hostname", () => {
    expect(
      isProviderRepositoryUrlAllowed(
        "http://forge.test:3000/team/fork",
        "http://forge.test:3000/team/base",
      ),
    ).toBe(true);
    expect(
      isProviderRepositoryUrlAllowed(
        "http://forge.test/team/fork",
        "http://forge.test:80/team/base",
      ),
    ).toBe(true);
    expect(
      isProviderRepositoryUrlAllowed(
        "http://forge.test:80/team/fork",
        "http://forge.test/team/base",
      ),
    ).toBe(true);
    expect(
      isProviderRepositoryUrlAllowed(
        "http://forge.test:3001/team/fork",
        "http://forge.test:3000/team/base",
      ),
    ).toBe(true);
    expect(
      isProviderRepositoryUrlAllowed(
        "http://other.test:3000/team/fork",
        "http://forge.test:3000/team/base",
      ),
    ).toBe(false);
    expect(
      isProviderRepositoryUrlAllowed("http://forge.test/team/fork", "https://forge.test/team/base"),
    ).toBe(true);
    for (const origin of [
      "git@forge.test:team/base.git",
      "ssh://git@forge.test:2222/team/base.git",
    ]) {
      expect(isProviderRepositoryUrlAllowed("http://forge.test:3000/team/fork", origin)).toBe(true);
      expect(isProviderRepositoryUrlAllowed("http://other.test/team/fork", origin)).toBe(false);
    }
    expect(isProviderRepositoryUrlAllowed("http://forge.test/team/fork")).toBe(false);
  });
});
