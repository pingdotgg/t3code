import {
  ProviderDriverKind,
  ProviderInstanceId,
  type RepositoryIdentity,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findPromptLinkProject,
  findPromptLinkPullRequestThread,
  resolvePromptLinkModelSelection,
} from "./promptLinks.ts";

const identity = (canonicalKey: string, origin?: string): RepositoryIdentity => ({
  canonicalKey,
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${canonicalKey}` },
  ...(origin ? { origin: { canonicalKey: origin } } : {}),
});

describe("findPromptLinkProject", () => {
  it("takes the first exact match and never a fork of the repository", () => {
    const projects = [
      {
        id: "fork",
        repositoryIdentity: identity("github.com/pingdotgg/t3code", "github.com/me/t3code"),
      },
      { id: "none", repositoryIdentity: null },
      { id: "recent", repositoryIdentity: identity("github.com/PingDotGG/T3Code") },
      { id: "older", repositoryIdentity: identity("github.com/pingdotgg/t3code") },
    ];
    expect(findPromptLinkProject(projects, { owner: "pingdotgg", name: "t3code" })?.id).toBe(
      "recent",
    );
    expect(findPromptLinkProject(projects, { owner: "me", name: "t3code" })?.id).toBe("fork");
    expect(findPromptLinkProject(projects, { owner: "gitlab", name: "x" })).toBeUndefined();
  });
});

describe("findPromptLinkPullRequestThread", () => {
  const link = (number: number, source: ThreadPullRequestLink["source"] = "created") =>
    ({
      host: "github.com",
      repository: "pingdotgg/t3code",
      number,
      url: `https://github.com/pingdotgg/t3code/pull/${number}`,
      source,
      linkedAt: "2026-01-01T00:00:00.000Z",
      snapshot: null,
      stack: null,
    }) satisfies ThreadPullRequestLink;

  it("finds the most recently updated thread linked to the pull request", () => {
    const threads = [
      { id: "old", updatedAt: "2026-01-01T00:00:00.000Z", pullRequests: [link(7)] },
      { id: "new", updatedAt: "2026-02-01T00:00:00.000Z", pullRequests: [link(7)] },
      { id: "other", updatedAt: "2026-03-01T00:00:00.000Z", pullRequests: [link(8)] },
      {
        id: "dismissed",
        updatedAt: "2026-04-01T00:00:00.000Z",
        pullRequests: [link(7, "stack-dismissed")],
      },
    ];
    const pullRequest = { owner: "PingDotGG", name: "t3code", number: 7 };
    expect(findPromptLinkPullRequestThread(threads, pullRequest)?.id).toBe("new");
    expect(findPromptLinkPullRequestThread(threads, { ...pullRequest, number: 9 })).toBeUndefined();
  });
});

describe("resolvePromptLinkModelSelection", () => {
  const provider = (
    instanceId: string,
    driver: string,
    status: "ready" | "warning" | "error" | "disabled" = "ready",
  ) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    status,
    models: [
      { slug: "small", name: "Small" },
      { slug: "big", name: "Big", aliases: ["opus"], isDefault: true },
    ],
  });

  it("maps the requested provider and model onto a usable instance", () => {
    const providers = [provider("broken", "claudeAgent", "error"), provider("work", "claudeAgent")];
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "claude", model: "small" }),
    ).toEqual({
      selection: { instanceId: "work", model: "small" },
      exact: true,
    });
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "claudeagent", model: "opus" }),
    ).toEqual({
      selection: { instanceId: "work", model: "big" },
      exact: true,
    });
  });

  it("uses the instance default for an unknown model, and nothing for a missing provider", () => {
    const providers = [provider("codex", "codex")];
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "codex", model: "nope" }),
    ).toEqual({
      selection: { instanceId: "codex", model: "big" },
      exact: false,
    });
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "cursor", model: null }),
    ).toBeNull();
  });
});
