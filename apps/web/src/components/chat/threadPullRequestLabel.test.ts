import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { threadPullRequestLabel } from "./threadPullRequestLabel";

it("only uses a bare number when the pull request belongs to the thread's repository", () => {
  const project: EnvironmentProject = {
    environmentId: EnvironmentId.make("environment"),
    id: ProjectId.make("project"),
    title: "T3 Code",
    workspaceRoot: "/workspace/t3code",
    repositoryIdentity: {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote",
        remoteName: "upstream",
        remoteUrl: "https://github.com/pingdotgg/t3code.git",
      },
      provider: "github",
      owner: "pingdotgg",
      name: "t3code",
      origin: {
        canonicalKey: "github.com/tannerpolley/t3code",
        displayName: "tannerpolley/t3code",
      },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const own = { host: "github.com", repository: "PingDotGG/t3code", number: 123 };
  const other = { ...own, repository: "vercel/next.js" };

  expect(threadPullRequestLabel(own, project)).toBe("#123");
  expect(threadPullRequestLabel(other, project)).toBe("vercel/next.js#123");
  expect(threadPullRequestLabel({ ...own, repository: "tannerpolley/t3code" }, project)).toBe(
    "tannerpolley/t3code#123",
  );
  expect(threadPullRequestLabel({ ...own, host: "github.example.com" }, project)).toBe(
    "PingDotGG/t3code#123",
  );
  expect(threadPullRequestLabel(own, null)).toBe("PingDotGG/t3code#123");
  expect(threadPullRequestLabel(own, { ...project, repositoryIdentity: null })).toBe(
    "PingDotGG/t3code#123",
  );
});
