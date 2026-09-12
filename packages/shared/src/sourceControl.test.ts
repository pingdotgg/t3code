import { describe, expect, it } from "vite-plus/test";

import {
  sourceControlRepositorySelector,
  detectSourceControlProviderFromRemoteUrl,
  getChangeRequestTerminologyForKind,
  isSshRemoteUrl,
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

  it("presents github-enterprise with GitHub PR terminology and icon", () => {
    const presentation = resolveChangeRequestPresentation({
      kind: "github-enterprise",
      name: "git.corp.com",
      baseUrl: "https://git.corp.com",
    });

    expect(presentation.icon).toBe("github");
    expect(presentation.shortName).toBe("PR");
    expect(presentation.longName).toBe("pull request");
    expect(presentation.providerName).toBe("GitHub Enterprise");
    expect(presentation.checkoutCommandExample).toBe("gh pr checkout 123");
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

  it("classifies github.com as github", () => {
    expect(detectSourceControlProviderFromRemoteUrl("https://github.com/owner/repo.git")).toEqual({
      kind: "github",
      name: "GitHub",
      baseUrl: "https://github.com",
    });
  });

  it("classifies a github.com endpoint served from a subdomain as github", () => {
    // `ssh.github.com:443` is dotcom's own SSH endpoint for networks that block port 22, not an
    // Enterprise install that happens to have `github` in its name.
    expect(
      detectSourceControlProviderFromRemoteUrl("git@ssh.github.com:443/owner/repo.git"),
    ).toEqual({
      kind: "github",
      name: "GitHub",
      baseUrl: "https://ssh.github.com",
    });
  });

  it("classifies a ghe.com tenant as github-enterprise", () => {
    expect(detectSourceControlProviderFromRemoteUrl("https://acme.ghe.com/owner/repo.git")).toEqual(
      {
        kind: "github-enterprise",
        name: "acme.ghe.com",
        baseUrl: "https://acme.ghe.com",
      },
    );
  });

  // Previously classified as kind "github" / name "GitHub Self-Hosted".
  // Reclassification is intended; nothing persists the kind.
  it("classifies a github-prefixed corporate host as github-enterprise", () => {
    expect(detectSourceControlProviderFromRemoteUrl("git@github.acme.com:owner/repo.git")).toEqual({
      kind: "github-enterprise",
      name: "github.acme.com",
      baseUrl: "https://github.acme.com",
    });
  });

  it("leaves an arbitrary GHES hostname unknown for CLI refinement", () => {
    expect(detectSourceControlProviderFromRemoteUrl("https://git.corp.com/owner/repo.git")).toEqual(
      {
        kind: "unknown",
        name: "git.corp.com",
        baseUrl: "https://git.corp.com",
      },
    );
  });

  it("still classifies gitlab hosts as gitlab", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.acme.com/group/project.git")?.kind,
    ).toBe("gitlab");
  });

  it("matches self-hosted providers by complete DNS labels", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://github.example.com/owner/repo.git")?.kind,
    ).toBe("github-enterprise");
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
