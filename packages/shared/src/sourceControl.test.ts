import { describe, expect, it } from "vite-plus/test";

import {
  detectSourceControlProviderFromRemoteUrl,
  getChangeRequestTerminologyForKind,
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
});

describe("forgejo support", () => {
  it("resolves Forgejo presentation", () => {
    const p = resolveChangeRequestPresentation({
      kind: "forgejo",
      name: "Forgejo",
      baseUrl: "https://codeberg.org",
    });
    expect(p.icon).toBe("forgejo");
    expect(p.providerName).toBe("Forgejo");
    expect(p.shortName).toBe("PR");
  });

  it("detects codeberg.org as forgejo", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("git@codeberg.org:owner/repo.git")?.kind,
    ).toBe("forgejo");
  });

  it("detects a host containing 'forgejo' as forgejo", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://forgejo.example.org/owner/repo.git")?.kind,
    ).toBe("forgejo");
  });

  it("leaves an arbitrary self-hosted host as unknown (refined later via fj)", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://git.example.org/owner/repo.git")?.kind,
    ).toBe("unknown");
  });
});
