import type { ChangeRequestProjectIdentity } from "@t3tools/source-control-core/shared/definition";
import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url))!;

const identity = (
  remoteUrl: string,
  fields: Partial<ChangeRequestProjectIdentity> = {},
): ChangeRequestProjectIdentity => ({
  canonicalKey: "forge.example/git/team/repo",
  displayName: "git/team/repo",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl },
  ...fields,
});

const onHost = (project: ChangeRequestProjectIdentity, link: ReturnType<typeof parse>) =>
  definition.isChangeRequestInRepository(project, link) ||
  definition.canReadChangeRequestOnHost(project, link);

describe("Forgejo change request URLs", () => {
  it("reads nested paths and keeps the server's port as the authority", () => {
    expect(parse("http://git.example.test:3000/Team/Repo/pulls/42/files")).toEqual({
      host: "git.example.test",
      authority: "git.example.test:3000",
      repository: "team/repo",
      number: 42,
      repositoryUrl: "http://git.example.test:3000/Team/Repo",
    });
    expect(parse("https://github.internal/team/repo/pulls/7")).toMatchObject({
      host: "github.internal",
      authority: "github.internal",
    });
  });

  it("claims only its own route", () => {
    for (const url of [
      "https://forge.example/team/repo/pull/7",
      "https://forge.example/repo/pulls/7",
      "https://forge.example/team/repo/pulls/abc",
    ]) {
      expect(definition.parseChangeRequestUrl(new URL(url)), url).toBeNull();
    }
  });

  it.each([
    ["http://forge.example:3000/git/owner/repo.git", "http://forge.example:3000"],
    ["git@forge.example:git/owner/repo.git", "https://forge.example"],
    ["http://other.example:3000/git/owner/repo.git", "https://forge.example"],
  ])("keeps the matching web origin from %s", (remoteUrl, origin) => {
    expect(
      definition.changeRequestUrl({
        host: "forge.example",
        repository: "git/owner/repo",
        number: 42,
        remoteUrl,
      }),
    ).toBe(`${origin}/git/owner/repo/pulls/42`);
  });

  it("keeps the origin when the host already carries its port", () => {
    expect(
      definition.changeRequestUrl({
        host: "forge.example:3000",
        repository: "team/repo",
        number: 42,
        remoteUrl: "http://forge.example:3000/team/repo.git",
      }),
    ).toBe("http://forge.example:3000/team/repo/pulls/42");
  });

  it("matches projects by HTTP port at repository and host level", () => {
    const [atThree, atFour] = [3000, 4000].map((port) =>
      identity(`http://forge.example:${port}/git/team/repo.git`),
    );
    const link = parse("http://forge.example:4000/git/team/repo/pulls/42");
    expect(definition.isChangeRequestInRepository(atFour!, link)).toBe(true);
    expect(onHost(atFour!, { ...link, repository: "git/team/other" })).toBe(true);
    expect(definition.isChangeRequestInRepository(atThree!, link)).toBe(false);
    expect(onHost(atThree!, link)).toBe(false);
  });

  it("lets tea resolve the web port for SSH remotes, and honours a resolved web URL", () => {
    const link = parse("http://forge.example:4000/git/team/repo/pulls/42");
    expect(
      definition.isChangeRequestInRepository(identity("git@forge.example:git/team/repo.git"), link),
    ).toBe(true);
    const aliased = identity("git@ssh.forge.example:team/repo.git", {
      canonicalKey: "ssh.forge.example/team/repo",
      displayName: "team/repo",
      webUrl: "http://forge.example:4000/git/team/repo",
    });
    expect(definition.isChangeRequestInRepository(aliased, link)).toBe(true);
    expect(onHost(aliased, { ...link, repository: "git/team/other" })).toBe(true);
    for (const url of [
      "http://other.example:4000/git/team/repo/pulls/42",
      "http://forge.example:3000/git/team/repo/pulls/42",
      "http://forge.example:4000/other/team/repo/pulls/42",
    ]) {
      expect(onHost(aliased, parse(url)), url).toBe(false);
    }
  });
});

describe("Forgejo remotes", () => {
  it("recognises Codeberg and Forgejo or Gitea hosts, keeping an HTTP remote's origin", () => {
    for (const host of ["codeberg.org", "forgejo.example.test", "gitea.example.test"]) {
      expect(recognizeRemoteWith(definition, `http://${host}:3000/team/repo.git`)).toEqual({
        kind: "forgejo",
        name: "Forgejo",
        baseUrl: `http://${host}:3000`,
      });
    }
    expect(
      recognizeRemoteWith(definition, "ssh://git@forgejo.example.test:2222/team/repo.git")?.baseUrl,
    ).toBe("https://forgejo.example.test");
    expect(recognizeRemoteWith(definition, "https://git.example.test/team/repo")).toBeNull();
  });
});

describe("Forgejo change request host", () => {
  it("keeps an HTTP remote's port, because a server's identity includes it", () => {
    const project = identity("http://forge.example:3000/git/team/repo.git");
    expect(definition.changeRequestHost?.(project)).toBe("forge.example:3000");
    expect(
      definition.changeRequestHost?.(identity("ssh://git@forge.example:2222/git/team/repo.git")),
    ).toBe("forge.example");
  });
});

describe("Forgejo uploads", () => {
  const uuid = "8e603325-bb2b-4e32-a9bc-f1fa20b6c40b";
  const media = (url: string) => definition.mediaUrl(new URL(url));
  const resolve = (url: string, changeRequestUrl: string) =>
    definition.resolveRelativeUrl(url, changeRequestUrl);

  it("fetches an upload from the server that serves it, under its mount or a repository", () => {
    expect(media(`https://git.example.test:3000/attachments/${uuid}?download=1#top`)).toEqual({
      fetchUrl: `https://git.example.test:3000/attachments/${uuid}`,
      fileName: uuid,
    });
    for (const path of [`/git/attachments/${uuid}`, `/team/repo/attachments/${uuid}`]) {
      expect(media(`https://git.example.test${path}`)?.fetchUrl).toBe(
        `https://git.example.test${path}`,
      );
    }
  });

  it("claims no upload another host owns or a token could not reach", () => {
    for (const url of [
      `http://git.example.test/attachments/${uuid}`,
      "https://git.example.test/attachments/not-an-upload",
      `https://git.example.test/attachments/${uuid}/extra`,
      `https://dev.azure.com/org/_apis/wit/attachments/${uuid}`,
    ]) {
      expect(media(url), url).toBeNull();
    }
  });

  it("links a pasted upload on the server of its change request, below the server's mount", () => {
    expect(resolve(`/attachments/${uuid}`, "https://git.example.test/git/team/repo/pulls/7")).toBe(
      `https://git.example.test/git/attachments/${uuid}`,
    );
    expect(resolve(`attachments/${uuid}`, "https://codeberg.org/team/repo/issues/7")).toBe(
      `https://codeberg.org/attachments/${uuid}`,
    );
    for (const url of [
      `https://cdn.example.test/attachments/${uuid}`,
      `/attachments/${uuid}/extra`,
      "/team/repo/pulls/8",
    ]) {
      expect(resolve(url, "https://git.example.test/team/repo/pulls/7"), url).toBeNull();
    }
    expect(resolve(`/attachments/${uuid}`, "not a url")).toBeNull();
  });
});
