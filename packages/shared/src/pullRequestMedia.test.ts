import { describe, expect, it } from "vite-plus/test";
import { pullRequestMediaUrl } from "./pullRequestMedia.ts";

const base = {
  provider: "gitlab" as const,
  host: "gitlab.example",
  repository: "group/team/repo",
  number: 7,
};
const hash = "a".repeat(32);

describe("pullRequestMediaUrl", () => {
  it("resolves GitLab native Markdown against the selected repository", () => {
    for (const url of [
      `/uploads/${hash}/shot.png`,
      `/group/team/repo/uploads/${hash}/shot.png`,
      `/group/team/repo/-/uploads/${hash}/shot.png`,
      `/-/project/42/uploads/${hash}/shot.png`,
    ]) {
      expect(pullRequestMediaUrl({ ...base, url })).toMatch(/^https:\/\/gitlab.example\//);
    }
  });
  it("rejects unrelated hosts, repository paths, credentials, and unsafe segments", () => {
    for (const url of [
      `https://other.example/group/team/repo/uploads/${hash}/shot.png`,
      `https://user:secret@gitlab.example/group/team/repo/uploads/${hash}/shot.png`,
      `/other/repo/uploads/${hash}/shot.png`,
      `/uploads/${hash}/%2fsecret.png`,
      `/uploads/${hash}/%0ashot.png`,
      `/uploads/${hash}/shot.png?private=1`,
      `http://gitlab.example/uploads/${hash}/shot.png`,
    ]) {
      expect(pullRequestMediaUrl({ ...base, url })).toBeNull();
    }
    expect(
      pullRequestMediaUrl({ ...base, host: undefined, url: `/uploads/${hash}/shot.png` }),
    ).toBeNull();
  });
  it("recognizes each provider attachment route and GitHub media from other repositories", () => {
    for (const [provider, host, repository, url] of [
      [
        "forgejo",
        "forgejo.example",
        "owner/repo",
        "https://forgejo.example/attachments/12345678-1234-1234-1234-123456789012",
      ],
      [
        "bitbucket",
        "bitbucket.org",
        "owner/repo",
        "https://bitbucket.org/owner/repo/downloads/shot.png",
      ],
      [
        "azure-devops",
        "dev.azure.com",
        "org/project/repo",
        "https://dev.azure.com/org/project/_apis/git/repositories/repo/pullRequests/7/attachments/shot.png?api-version=7.1",
      ],
      ["github", "github.com", "owner/repo", "https://github.com/owner/repo/blob/main/shot.png"],
    ] as const)
      expect(pullRequestMediaUrl({ provider, host, repository, number: 7, url })).not.toBeNull();
    expect(
      pullRequestMediaUrl({
        provider: "github",
        host: "github.com",
        repository: "owner/repo",
        number: 7,
        url: "https://raw.githubusercontent.com/other/repo/main/shot.png",
      }),
    ).toBe("https://raw.githubusercontent.com/other/repo/main/shot.png");
  });
});

it("accepts only the selected Azure organization legacy host", () => {
  const input = {
    provider: "azure-devops" as const,
    host: "dev.azure.com",
    repository: "acme/project/repo",
    number: 7,
  };
  const path =
    "/project/_apis/git/repositories/repo/pullRequests/7/attachments/shot.png?api-version=7.1";
  expect(
    pullRequestMediaUrl({ ...input, url: `https://acme.visualstudio.com${path}` }),
  ).not.toBeNull();
  expect(
    pullRequestMediaUrl({ ...input, url: `https://other.visualstudio.com${path}` }),
  ).toBeNull();
});

it("keeps self-hosted Forgejo attachment paths under their mount", () => {
  const input = {
    provider: "forgejo" as const,
    host: "forgejo.example",
    repository: "git/owner/repo",
    number: 7,
  };
  const id = "12345678-1234-1234-1234-123456789012";
  expect(
    pullRequestMediaUrl({ ...input, url: `https://forgejo.example/git/attachments/${id}` }),
  ).not.toBeNull();
  expect(
    pullRequestMediaUrl({
      ...input,
      url: `https://forgejo.example/git/owner/repo/attachments/${id}`,
    }),
  ).not.toBeNull();
  expect(
    pullRequestMediaUrl({ ...input, url: `https://forgejo.example/other/attachments/${id}` }),
  ).toBeNull();
});
