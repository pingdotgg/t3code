import type { RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  buildGitHubOwnerAvatarUrl,
  buildGitHubProjectImageCandidateUrls,
  buildGitHubRepositoryPageUrl,
  extractGitHubCustomRepositoryImageUrl,
  parseGitHubRepositoryImageGraphqlResponse,
  resolveGitHubRepositoryRef,
} from "./githubProjectImage.ts";

function makeRepositoryIdentity(overrides: Partial<RepositoryIdentity> = {}): RepositoryIdentity {
  return {
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:T3Tools/t3code.git",
    },
    provider: "github",
    owner: "T3Tools",
    name: "t3code",
    ...overrides,
  } as RepositoryIdentity;
}

describe("github project image helpers", () => {
  it("resolves GitHub repository fields from repository identity metadata", () => {
    expect(resolveGitHubRepositoryRef(makeRepositoryIdentity())).toEqual({
      owner: "T3Tools",
      name: "t3code",
    });
  });

  it("falls back to canonical key and remote URL when explicit fields are missing", () => {
    const {
      provider: _provider,
      owner: _owner,
      name: _name,
      ...canonicalIdentity
    } = makeRepositoryIdentity();
    expect(resolveGitHubRepositoryRef(canonicalIdentity)).toEqual({
      owner: "t3tools",
      name: "t3code",
    });

    const {
      provider: _remoteProvider,
      owner: _remoteOwner,
      name: _remoteName,
      ...remoteIdentity
    } = makeRepositoryIdentity({
      canonicalKey: "example.com/t3tools/t3code",
    });
    expect(resolveGitHubRepositoryRef(remoteIdentity)).toEqual({
      owner: "T3Tools",
      name: "t3code",
    });
  });

  it("builds stable GitHub page and owner avatar URLs", () => {
    const repository = { owner: "T3Tools", name: "t3code" };

    expect(buildGitHubRepositoryPageUrl(repository)).toBe("https://github.com/T3Tools/t3code");
    expect(buildGitHubOwnerAvatarUrl(repository)).toBe("https://github.com/T3Tools.png?size=64");
  });

  it("extracts only custom repository images, not GitHub generated OpenGraph cards", () => {
    expect(
      extractGitHubCustomRepositoryImageUrl(
        '<meta property="og:image" content="https://repository-images.githubusercontent.com/123/preview">',
      ),
    ).toBe("https://repository-images.githubusercontent.com/123/preview");

    expect(
      extractGitHubCustomRepositoryImageUrl(
        '<meta property="og:image" content="https://opengraph.githubassets.com/hash/owner/repo">',
      ),
    ).toBeNull();
  });

  it("parses GitHub GraphQL repository image metadata", () => {
    expect(
      parseGitHubRepositoryImageGraphqlResponse(
        JSON.stringify({
          data: {
            repository: {
              openGraphImageUrl: "https://repository-images.githubusercontent.com/70107786/preview",
              owner: {
                avatarUrl: "https://avatars.githubusercontent.com/u/14985020?s=64&v=4",
              },
            },
          },
        }),
      ),
    ).toEqual({
      openGraphImageUrl: "https://repository-images.githubusercontent.com/70107786/preview",
      ownerAvatarUrl: "https://avatars.githubusercontent.com/u/14985020?s=64&v=4",
    });

    expect(parseGitHubRepositoryImageGraphqlResponse("{not-json")).toBeNull();
    expect(parseGitHubRepositoryImageGraphqlResponse(JSON.stringify({ data: {} }))).toBeNull();
  });

  it("uses GitHub API metadata before falling back to public GitHub URLs", () => {
    expect(
      buildGitHubProjectImageCandidateUrls({
        repository: { owner: "vercel", name: "next.js" },
        repositoryImageMetadata: {
          openGraphImageUrl: "https://repository-images.githubusercontent.com/70107786/preview",
          ownerAvatarUrl: "https://avatars.githubusercontent.com/u/14985020?s=64&v=4",
        },
        repositoryHtml: null,
      }),
    ).toEqual([
      "https://repository-images.githubusercontent.com/70107786/preview",
      "https://avatars.githubusercontent.com/u/14985020?s=64&v=4",
      "https://github.com/vercel.png?size=64",
    ]);

    expect(
      buildGitHubProjectImageCandidateUrls({
        repository: { owner: "pingdotgg", name: "t3code" },
        repositoryImageMetadata: {
          openGraphImageUrl: "https://opengraph.githubassets.com/hash/pingdotgg/t3code",
          ownerAvatarUrl: "https://avatars.githubusercontent.com/u/89191727?s=64&v=4",
        },
        repositoryHtml: null,
      }),
    ).toEqual([
      "https://avatars.githubusercontent.com/u/89191727?s=64&v=4",
      "https://github.com/pingdotgg.png?size=64",
    ]);
  });

  it("uses custom repository image before falling back to owner avatar", () => {
    expect(
      buildGitHubProjectImageCandidateUrls({
        repository: { owner: "T3Tools", name: "t3code" },
        repositoryHtml:
          '<meta property="og:image" content="https://repository-images.githubusercontent.com/123/preview">',
      }),
    ).toEqual([
      "https://repository-images.githubusercontent.com/123/preview",
      "https://github.com/T3Tools.png?size=64",
    ]);

    expect(
      buildGitHubProjectImageCandidateUrls({
        repository: { owner: "T3Tools", name: "t3code" },
        repositoryHtml:
          '<meta property="og:image" content="https://opengraph.githubassets.com/hash/owner/repo">',
      }),
    ).toEqual(["https://github.com/T3Tools.png?size=64"]);
  });
});
