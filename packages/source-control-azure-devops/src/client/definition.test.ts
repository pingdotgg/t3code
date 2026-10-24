import { SourceControlProviderKind } from "@t3tools/contracts";
import type { ChangeRequestProjectIdentity } from "@t3tools/source-control-core/client/definition";
import {
  makeSourceControlClientRegistry,
  recognizeRemoteWith,
} from "@t3tools/source-control-core/client/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("Azure DevOps change request URLs", () => {
  it("reads both hosted URL forms", () => {
    expect(parse("https://dev.azure.com/acme/platform/_git/t3code/pullrequest/17")).toEqual({
      host: "dev.azure.com",
      repository: "acme/platform/_git/t3code",
      number: 17,
      repositoryUrl: "https://dev.azure.com/acme/platform/_git/t3code",
    });
    expect(
      parse("https://acme.visualstudio.com/platform/_git/t3code/pullrequest/17"),
    ).toMatchObject({
      host: "acme.visualstudio.com",
      repository: "platform/_git/t3code",
      number: 17,
    });
  });

  it("keeps Azure DevOps Server ports in the authority, on any hostname", () => {
    expect(
      parse("https://GIT.CAFE:8443/tfs/Collection/Project/_git/Repo/pullrequest/123?view=files"),
    ).toEqual({
      host: "git.cafe",
      authority: "git.cafe:8443",
      repository: "tfs/collection/project/_git/repo",
      number: 123,
      repositoryUrl: "https://git.cafe:8443/tfs/Collection/Project/_git/Repo",
    });
    expect(parse("https://scm.example.test/tfs/c/p/_git/r/pullrequest/1")).not.toHaveProperty(
      "authority",
    );
  });

  it("claims nothing without the _git route or a valid number", () => {
    for (const url of [
      "https://scm.example.test/tfs/Collection/Project/_git/Repo",
      "https://scm.example.test/tfs/Collection/Project/pullrequest/123",
      "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/abc",
      "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/0",
      "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/9007199254740992",
    ]) {
      expect(parse(url), url).toBeNull();
    }
  });

  it.each([
    ["ssh.dev.azure.com", "v3/org/project/web"],
    ["org.visualstudio.com", "defaultcollection/project/_git/web"],
    ["dev.azure.com", "org/project/_git/web"],
  ])("builds a canonical browser URL from the remote %s/%s", (host, repository) => {
    expect(definition.changeRequestUrl({ host, repository, number: 42 })).toBe(
      "https://dev.azure.com/org/project/_git/web/pullrequest/42",
    );
  });

  it("keeps an Azure DevOps Server's HTTP origin and builds below a web URL", () => {
    expect(
      definition.changeRequestUrl({
        host: "scm.example.test",
        repository: "tfs/collection/project/_git/repo",
        number: 124,
        remoteUrl: "http://dummy:secret@scm.example.test:8080/tfs/Collection/Project/_git/Repo",
      }),
    ).toBe("http://scm.example.test:8080/tfs/collection/project/_git/repo/pullrequest/124");
    expect(
      definition.changeRequestUrl({
        host: "dev.azure.com",
        repository: "acme/project/_git/web",
        number: 43,
        webUrl: "https://dev.azure.com/acme/project/_git/web",
      }),
    ).toBe("https://dev.azure.com/acme/project/_git/web/pullrequest/43");
  });

  it.each([
    ["ssh.dev.azure.com/v3/org-a/project/web", "git@ssh.dev.azure.com:v3/org-a/project/web"],
    [
      "vs-ssh.visualstudio.com/v3/org-a/project/web",
      "git@vs-ssh.visualstudio.com:v3/org-a/project/web",
    ],
    [
      "org-a.visualstudio.com/defaultcollection/project/_git/web",
      "https://org-a.visualstudio.com/DefaultCollection/Project/_git/Web",
    ],
    ["dev.azure.com/org-a/project/_git/web", "https://org-a@dev.azure.com/org-a/Project/_git/Web"],
  ])("matches browser references against the checkout %s", (canonicalKey, remoteUrl) => {
    const identity: ChangeRequestProjectIdentity = {
      canonicalKey,
      displayName: canonicalKey.split("/").slice(1).join("/"),
      locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    };
    const link = parse("https://dev.azure.com/org-a/project/_git/web/pullrequest/42")!;
    expect(definition.isChangeRequestInRepository(identity, link)).toBe(true);
    for (const repository of ["org-b/project/_git/web", "org-a/other-project/_git/web"]) {
      expect(definition.isChangeRequestInRepository(identity, { ...link, repository })).toBe(false);
    }
  });
});

describe("Azure DevOps remotes", () => {
  it("recognises the SSH clone hosts as well as the web ones", () => {
    for (const remote of [
      "git@ssh.dev.azure.com:v3/org/project/repo",
      "ssh://git@ssh.dev.azure.com:22/v3/org/project/repo",
      "git@vs-ssh.visualstudio.com:v3/org/project/repo",
      "https://org@dev.azure.com/org/project/_git/repo",
    ]) {
      expect(recognizeRemoteWith(definition, remote)?.kind, remote).toBe("azure-devops");
    }
    expect(recognizeRemoteWith(definition, "https://azure.example/o/p/_git/r")).toBeNull();
  });
});

describe("Azure DevOps repository keys", () => {
  const registry = makeSourceControlClientRegistry([definition]);

  it("gives a repository the same key over SSH as over HTTPS", () => {
    for (const remote of [
      "git@ssh.dev.azure.com:v3/T3Tools/Platform/T3Code",
      "ssh://git@ssh.dev.azure.com:22/v3/T3Tools/Platform/T3Code",
      "https://T3Tools@dev.azure.com/T3Tools/Platform/_git/T3Code",
    ]) {
      expect(registry.repositoryKeyFromRemote(remote), remote).toBe(
        "dev.azure.com/t3tools/platform/_git/t3code",
      );
    }
  });

  it("keeps the organization in the host for the legacy visualstudio.com remotes", () => {
    for (const remote of [
      "T3Tools@vs-ssh.visualstudio.com:v3/T3Tools/Platform/T3Code",
      "https://T3Tools.visualstudio.com/Platform/_git/T3Code",
    ]) {
      expect(registry.repositoryKeyFromRemote(remote), remote).toBe(
        "t3tools.visualstudio.com/platform/_git/t3code",
      );
    }
  });

  it("compares every spelling on dev.azure.com", () => {
    for (const key of [
      "ssh.dev.azure.com/v3/org/project/repo",
      "vs-ssh.visualstudio.com/v3/org/project/repo",
      "org.visualstudio.com/project/_git/repo",
      "org.visualstudio.com/defaultcollection/project/_git/repo",
      "dev.azure.com/org/project/_git/repo",
    ]) {
      expect(registry.canonicalRepositoryKey(key), key).toBe("dev.azure.com/org/project/_git/repo");
      expect(registry.findByRepositoryKey(key), key).toBe(definition);
    }
    expect(registry.canonicalRepositoryKey("tfs.example/c/p/_git/r")).toBe(
      "tfs.example/c/p/_git/r",
    );
    expect(registry.findByRepositoryKey("tfs.example/c/p/_git/r")).toBeUndefined();
  });
});

describe("Azure DevOps repository selector", () => {
  const registry = makeSourceControlClientRegistry([definition]);

  it("names a repository by its own name, not its project path", () => {
    // `az repos pr list --repository` takes a name and detects the organisation and project from
    // the checkout; the recorded `org/project/_git/repo` path is refused.
    expect(
      registry.repositorySelector({
        provider: SourceControlProviderKind.make("azure-devops"),
        displayName: "contoso/payments/_git/checkout",
        owner: "contoso",
        name: "checkout",
      }),
    ).toBe("checkout");
  });

  it("decodes a name the remote URL percent-encodes", () => {
    expect(
      registry.repositorySelector({
        provider: SourceControlProviderKind.make("azure-devops"),
        displayName: "contoso/payments%20(eu)/_git/checkout%20(eu)",
        owner: "contoso",
        name: "checkout%20(eu)",
      }),
    ).toBe("checkout (eu)");
  });
});
