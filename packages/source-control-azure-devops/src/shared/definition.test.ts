import { SourceControlProviderKind } from "@t3tools/contracts";
import type { ChangeRequestProjectIdentity } from "@t3tools/source-control-core/shared/definition";
import {
  makeSourceControlDefinitionRegistry,
  recognizeRemoteWith,
} from "@t3tools/source-control-core/shared/definition";
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

  it("takes a pull request URL that leaves the project out as a checkout reference", () => {
    for (const url of [
      "https://dev.azure.com/acme/_git/web/pullrequest/17",
      "https://acme.visualstudio.com/_git/web/pullrequest/17",
    ]) {
      expect(definition.isChangeRequestReference(url), url).toBe(true);
    }
    expect(
      definition.isChangeRequestReference("https://dev.azure.com/_git/web/pullrequest/17"),
    ).toBe(false);
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
      "ssh.dev.azure.com:v3/Org/My Project/My Repo",
      "git@vs-ssh.visualstudio.com:v3/org/project/repo",
      "https://org@dev.azure.com/org/project/_git/repo",
    ]) {
      expect(recognizeRemoteWith(definition, remote)?.kind, remote).toBe("azure-devops");
    }
    expect(recognizeRemoteWith(definition, "https://azure.example/o/p/_git/r")).toBeNull();
  });
});

describe("Azure DevOps repository keys", () => {
  const registry = makeSourceControlDefinitionRegistry([definition]);

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

  it("gives a project with spaces in its name the same key over SSH as over HTTPS", () => {
    for (const remote of [
      "git@ssh.dev.azure.com:v3/Org/My Project/My Repo",
      "ssh.dev.azure.com:v3/Org/My Project/My Repo",
      "https://dev.azure.com/Org/My%20Project/_git/My%20Repo",
    ]) {
      expect(registry.repositoryKeyFromRemote(remote), remote).toBe(
        "dev.azure.com/org/my%20project/_git/my%20repo",
      );
    }
  });

  it.each([
    "git@ssh.dev.azure.com:v3/acme/platform/tool.git",
    "https://dev.azure.com/acme/platform/_git/tool.git",
  ])("preserves a literal .git in an Azure repository name: %s", (remoteUrl) => {
    const canonicalKey = registry.repositoryKeyFromRemote(remoteUrl);
    expect(canonicalKey).toBe("dev.azure.com/acme/platform/_git/tool.git");
    const identity: ChangeRequestProjectIdentity = {
      canonicalKey,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    };
    const link = parse("https://dev.azure.com/acme/platform/_git/tool.git/pullrequest/7")!;
    expect(definition.isChangeRequestInRepository(identity, link)).toBe(true);
    expect(
      definition.isChangeRequestInRepository(identity, {
        ...link,
        repository: "acme/platform/_git/tool",
      }),
    ).toBe(false);
  });

  it("matches a repository however its name is percent-encoded", () => {
    const remoteUrl = "https://example@dev.azure.com/example/Sample%20(Beta)/_git/Sample%20(Beta)";
    const canonicalKey = registry.repositoryKeyFromRemote(remoteUrl);
    const identity: ChangeRequestProjectIdentity = {
      canonicalKey,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    };
    for (const url of [
      "https://dev.azure.com/example/Sample%20%28Beta%29/_git/Sample%20%28Beta%29/pullrequest/7",
      "https://dev.azure.com/example/Sample (Beta)/_git/Sample (Beta)/pullrequest/7",
    ]) {
      const link = parse(url)!;
      expect(link.repository, url).toBe("example/sample%20(beta)/_git/sample%20(beta)");
      expect(definition.isChangeRequestInRepository(identity, link), url).toBe(true);
      expect(
        definition.isChangeRequestInRepository(
          {
            ...identity,
            canonicalKey: "dev.azure.com/example/sample%20%28beta%29/_git/sample%20%28beta%29",
          },
          link,
        ),
        url,
      ).toBe(true);
    }
    // Links stored before keys had one spelling still resolve to their project.
    expect(
      registry.canonicalRepositoryKey(
        "dev.azure.com/example/sample%20%28beta%29/_git/sample%20%28beta%29",
      ),
    ).toBe(canonicalKey);
  });

  it("still drops .git from other hosts' repository keys", () => {
    expect(registry.repositoryKeyFromRemote("git@github.com:acme/tool.git")).toBe(
      "github.com/acme/tool",
    );
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
    // A repository named like its project may leave the project out of its URL.
    for (const key of [
      "dev.azure.com/org/_git/repo",
      "dev.azure.com/org/defaultcollection/_git/repo",
      "org.visualstudio.com/_git/repo",
      "org.visualstudio.com/defaultcollection/_git/repo",
    ]) {
      expect(registry.canonicalRepositoryKey(key), key).toBe("dev.azure.com/org/repo/_git/repo");
    }
    expect(registry.findByRepositoryKey("tfs/foo.visualstudio.com/_git/repo")).toBeUndefined();
    expect(registry.canonicalRepositoryKey("tfs.example/c/p/_git/r")).toBe(
      "tfs.example/c/p/_git/r",
    );
    expect(registry.findByRepositoryKey("tfs.example/c/p/_git/r")).toBeUndefined();
  });

  it("matches a shorthand pull request URL against an SSH checkout and builds its canonical URL", () => {
    const remoteUrl = "git@ssh.dev.azure.com:v3/org/repo/repo";
    const identity: ChangeRequestProjectIdentity = {
      canonicalKey: registry.repositoryKeyFromRemote(remoteUrl),
      locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    };
    const link = parse("https://org.visualstudio.com/DefaultCollection/_git/repo/pullrequest/7")!;
    expect(definition.isChangeRequestInRepository(identity, link)).toBe(true);
    expect(
      definition.changeRequestUrl({
        host: "org.visualstudio.com",
        repository: "defaultcollection/_git/repo",
        number: 7,
      }),
    ).toBe("https://dev.azure.com/org/repo/_git/repo/pullrequest/7");
  });
});

describe("Azure DevOps repository selector", () => {
  const registry = makeSourceControlDefinitionRegistry([definition]);

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

describe("Azure DevOps issue scope", () => {
  it("places work items in the project rather than the repository", () => {
    const kind = SourceControlProviderKind.make("azure-devops");
    expect(
      definition.issueScope?.({ provider: kind, displayName: "acme/Web%20App/_git/web" }),
    ).toBe("acme/Web App");
    expect(definition.issueScope?.({ provider: kind, displayName: "web" })).toBeNull();
    // One segment before `_git` is a different thing on each kind of host, so it needs the host.
    expect(definition.issueScope?.({ provider: kind, displayName: "acme/_git/web" })).toBeNull();
    const scopeOn = (canonicalKey: string, displayName: string) =>
      definition.issueScope?.({ provider: kind, canonicalKey, displayName });
    expect(scopeOn("dev.azure.com/acme/_git/web", "acme/_git/Web")).toBe("acme/Web");
    expect(scopeOn("acme.visualstudio.com/web/_git/web", "Web%20App/_git/web")).toBe("Web App");
    expect(scopeOn("acme.visualstudio.com/_git/web", "_git/Web")).toBe("Web");
    // Its work items are at `acme.visualstudio.com/Web/_workitems/...`, without the collection.
    expect(
      scopeOn("acme.visualstudio.com/defaultcollection/_git/web", "DefaultCollection/_git/Web"),
    ).toBe("Web");
    expect(scopeOn("dev.azure.com/_git/web", "_git/web")).toBeNull();
    // A legacy host keeps the organization in its name, and so does its work item URL.
    expect(
      definition.parseIssueUrl?.(
        new URL("https://acme.visualstudio.com/Web%20App/_workitems/edit/9"),
      ),
    ).toEqual({
      host: "acme.visualstudio.com",
      scope: "web app",
      scopeAlias: "defaultcollection/web app",
      key: "9",
    });
    expect(
      definition.parseIssueUrl?.(
        new URL("https://acme.visualstudio.com/DefaultCollection/Web%20App/_workitems/edit/9"),
      ),
    ).toEqual({
      host: "acme.visualstudio.com",
      scope: "defaultcollection/web app",
      scopeAlias: "web app",
      key: "9",
    });
    expect(
      definition.parseIssueUrl?.(new URL("https://dev.azure.com/acme/_workitems/edit/9")),
    ).toBeNull();
  });
});

describe("Azure DevOps avatars", () => {
  const media = (url: string) => definition.mediaUrl?.(new URL(url)) ?? null;
  const id = "045e40d6-c17e-66c1-9649-dc1f0141a3a3";
  const fetchUrl = `https://dev.azure.com/acme/_apis/GraphProfile/MemberAvatars/${id}`;

  it("fetches every spelling of an identity's picture through the REST route", () => {
    for (const url of [
      `https://dev.azure.com/Acme/_api/_common/identityImage?id=${id.toUpperCase()}`,
      `https://acme.visualstudio.com/_api/_common/identityImage?id=${id}`,
      fetchUrl,
    ]) {
      expect(media(url)).toEqual({ fetchUrl, fileName: `${id}.png`, kind: "image" });
    }
  });

  it("keeps the subject descriptor work item identities carry, case and all", () => {
    const descriptor = "aad.MDQ1ZTQwZDYtYzE3ZS03NmMxLTk2NDktZGMxZjAxNDFhM2Ez";
    expect(
      media(`https://dev.azure.com/Acme/_apis/GraphProfile/MemberAvatars/${descriptor}`),
    ).toEqual({
      fetchUrl: `https://dev.azure.com/acme/_apis/GraphProfile/MemberAvatars/${descriptor}`,
      fileName: `${descriptor}.png`,
      kind: "image",
    });
  });

  it("claims nothing else", () => {
    for (const url of [
      `https://dev.azure.com/acme/_api/_common/identityImage?id=not-a-guid`,
      `https://dev.azure.com/acme/project/_api/_common/identityImage?id=${id}`,
      `https://tfs.acme.dev/tfs/DefaultCollection/_api/_common/identityImage?id=${id}`,
      `http://dev.azure.com/acme/_api/_common/identityImage?id=${id}`,
      "https://dev.azure.com/acme/project/_git/web/pullrequest/1",
      "https://dev.azure.com/acme/_apis/GraphProfile/MemberAvatars/aad.bad%2Fslash",
      "https://dev.azure.com/acme/_api/_common/identityImage?id=aad.MDQ1ZTQwZDY",
    ]) {
      expect(media(url)).toBeNull();
    }
  });
});
