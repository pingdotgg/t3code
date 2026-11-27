import {
  makeSourceControlDefinitionRegistry,
  recognizeRemoteWith,
} from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("Bitbucket change request URLs", () => {
  it("reads a pull request on Bitbucket hosts", () => {
    expect(
      definition.isChangeRequestReference(
        "https://bitbucket.org/workspace/repo/pull-requests/5/diff",
      ),
    ).toBe(true);
    expect(parse("https://bitbucket.org/workspace/repo/pull-requests/5/diff")).toEqual({
      host: "bitbucket.org",
      repository: "workspace/repo",
      number: 5,
      repositoryUrl: "https://bitbucket.org/workspace/repo",
    });
    expect(parse("https://code.bitbucket.example.test/team/repo/pull-requests/6")).toMatchObject({
      host: "code.bitbucket.example.test",
      number: 6,
    });
  });

  it("leaves other hosts alone", () => {
    expect(parse("https://scm.example.test/workspace/repo/pull-requests/5")).toBeNull();
    expect(
      definition.isChangeRequestReference(
        "https://scm.example.test/workspace/repo/pull-requests/5",
      ),
    ).toBe(false);
    expect(
      definition.isChangeRequestReference("https://bitbucket.org/workspace/repo/src/main"),
    ).toBe(false);
  });

  it("builds pull request URLs below the repository", () => {
    expect(
      definition.changeRequestUrl({ host: "bitbucket.org", repository: "w/repo", number: 5 }),
    ).toBe("https://bitbucket.org/w/repo/pull-requests/5");
    expect(
      definition.changeRequestUrl({
        host: "bitbucket.org",
        repository: "w/repo",
        number: 5,
        webUrl: "https://bitbucket.org/w/repo",
      }),
    ).toBe("https://bitbucket.org/w/repo/pull-requests/5");
  });
});

describe("Bitbucket repository pages", () => {
  it("reads the repository from a source view on Bitbucket hosts only", () => {
    const repositoryUrl = (url: string) => definition.repositoryUrlFromPage?.(new URL(url));
    expect(repositoryUrl("https://bitbucket.org/workspace/repo/src/main/")).toBe(
      "https://bitbucket.org/workspace/repo",
    );
    expect(repositoryUrl("https://bitbucket.org/workspace/repo")).toBeNull();
    expect(repositoryUrl("https://scm.example.test/workspace/repo/src/main/")).toBeNull();
  });
});

describe("Bitbucket remotes", () => {
  const recognize = (url: string) => recognizeRemoteWith(definition, url);

  it("recognises bitbucket.org and hosts with a bitbucket label", () => {
    expect(recognize("git@bitbucket.org:workspace/repo.git")).toEqual({
      kind: "bitbucket",
      name: "Bitbucket",
      baseUrl: "https://bitbucket.org",
    });
    expect(recognize("https://bitbucket.example.com/workspace/repo.git")?.name).toBe(
      "Bitbucket Self-Hosted",
    );
    expect(recognize("https://notbitbucket.example.com/workspace/repo.git")).toBeNull();
  });

  it.each([
    "git@ssh.bitbucket.org:workspace/repo.git",
    "ssh://git@altssh.bitbucket.org:443/workspace/repo.git",
  ])("recognises Bitbucket Cloud's SSH host in %s", (url) => {
    expect(recognize(url)).toEqual({
      kind: "bitbucket",
      name: "Bitbucket",
      baseUrl: "https://bitbucket.org",
    });
  });
});

describe("Bitbucket repository keys", () => {
  const registry = makeSourceControlDefinitionRegistry([definition]);

  it.each([
    "git@bitbucket.org:Workspace/Repo.git",
    "git@ssh.bitbucket.org:Workspace/Repo.git",
    "ssh://git@altssh.bitbucket.org:443/Workspace/Repo.git",
    "https://bitbucket.org/Workspace/Repo.git",
  ])("names %s on bitbucket.org, where its pull requests live", (remoteUrl) => {
    const canonicalKey = registry.repositoryKeyFromRemote(remoteUrl);
    expect(canonicalKey).toBe("bitbucket.org/workspace/repo");
    const link = parse("https://bitbucket.org/workspace/repo/pull-requests/5")!;
    expect(
      definition.isChangeRequestInRepository(
        {
          canonicalKey,
          displayName: "workspace/repo",
          locator: { source: "git-remote", remoteName: "origin", remoteUrl },
        },
        link,
      ),
    ).toBe(true);
  });

  it.each(["ssh.bitbucket.org", "altssh.bitbucket.org"])(
    "matches pull requests for a key saved under %s",
    (host) => {
      const canonicalKey = `${host}/workspace/repo`;
      expect(registry.canonicalRepositoryKey(canonicalKey)).toBe("bitbucket.org/workspace/repo");
      const identity = {
        canonicalKey,
        displayName: "workspace/repo",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: `git@${host}:workspace/repo.git`,
        },
      };
      const link = parse("https://bitbucket.org/workspace/repo/pull-requests/5")!;
      expect(definition.isChangeRequestInRepository(identity, link)).toBe(true);
      expect(definition.canReadChangeRequestOnHost(identity, link)).toBe(true);
    },
  );

  it("leaves self-hosted keys alone", () => {
    expect(registry.repositoryKeyFromRemote("git@bitbucket.example.com:team/repo.git")).toBe(
      "bitbucket.example.com/team/repo",
    );
  });
});
