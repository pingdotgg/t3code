import { ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestSyncKey } from "./pullRequestSyncKey.ts";

describe("pullRequestSyncKey", () => {
  const reference = { projectId: ProjectId.make("project"), repository: "web", number: 7 };
  // Every spelling of the key reaches dev.azure.com through the definition's canonical key,
  // which the Azure DevOps package tests.
  it("resolves hostless and checkout-host references named by the bare repository", () => {
    const canonicalKey = "ssh.dev.azure.com/v3/org/project/web";
    const identity = {
      canonicalKey,
      provider: SourceControlProviderKind.make("azure-devops"),
      name: "web",
      displayName: canonicalKey.split("/").slice(1).join("/"),
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: `https://${canonicalKey}`,
      },
    };
    const expected = { host: "dev.azure.com", repository: "org/project/_git/web", number: 7 };
    expect(pullRequestSyncKey(reference, identity)).toEqual(expected);
    expect(
      pullRequestSyncKey({ ...reference, host: canonicalKey.split("/")[0]! }, identity),
    ).toEqual(expected);
    expect(pullRequestSyncKey({ ...reference, repository: "other" }, identity)).toBeNull();
    expect(pullRequestSyncKey({ ...reference, host: "unrelated.test" }, identity)).toBeNull();
  });
  it("keys a port-qualified link to an SSH checkout's host, which names no web port", () => {
    for (const [provider, repository] of [
      ["gitlab", "g/r"],
      ["github", "o/r"],
    ] as const) {
      const identity = (remoteUrl: string) => ({
        canonicalKey: `code.example/${repository}`,
        provider: SourceControlProviderKind.make(provider),
        displayName: repository,
        locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl },
      });
      const link = { ...reference, host: "code.example:8443", repository };
      expect(pullRequestSyncKey(link, identity(`git@code.example:${repository}.git`))).toEqual({
        host: "code.example",
        repository,
        number: 7,
      });
      expect(
        pullRequestSyncKey(link, identity(`https://code.example:9443/${repository}.git`))?.host,
      ).toBe("code.example:8443");
    }
  });
  it("normalizes complete hosted aliases without requiring a checkout", () => {
    expect(
      pullRequestSyncKey({
        ...reference,
        host: "org.visualstudio.com",
        repository: "project/_git/web",
      }),
    ).toEqual({ host: "dev.azure.com", repository: "org/project/_git/web", number: 7 });
    expect(
      pullRequestSyncKey({ ...reference, host: "github.com", repository: "acme/web" }),
    ).toEqual({ host: "github.com", repository: "acme/web", number: 7 });
    expect(pullRequestSyncKey(reference)).toBeNull();
  });
});
