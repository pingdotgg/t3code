import type { ChangeRequestProjectIdentity } from "@t3tools/source-control-core/client/definition";
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
