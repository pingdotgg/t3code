import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { GitHubIssueDetail, GitHubIssueListInput } from "./githubIssue.ts";

describe("GitHub issue contracts", () => {
  it("bounds and trims host search text", () => {
    const decode = Schema.decodeUnknownSync(GitHubIssueListInput);
    expect(decode({ state: "open", query: "  websocket  " }).query).toBe("websocket");
    expect(() => decode({ state: "open", query: "x".repeat(201) })).toThrow();
  });

  it("round-trips issue detail through the RPC JSON codec", () => {
    const codec = Schema.toCodecJson(GitHubIssueDetail);
    const detail: GitHubIssueDetail = {
      projectId: "project-1" as GitHubIssueDetail["projectId"],
      projectTitle: "t3code",
      workspaceRoot: "/repo",
      repository: "t3tools/t3code",
      number: 42,
      title: "Support GitHub issues",
      url: "https://github.com/t3tools/t3code/issues/42",
      author: { login: "octocat", name: "Octo Cat", avatarUrl: null },
      assignees: [],
      labels: [{ name: "feature", color: "1d76db" }],
      state: "open",
      createdAt: "2026-08-20T00:00:00Z",
      updatedAt: "2026-08-21T00:00:00Z",
      body: "Issue body",
      comments: [],
      commentCount: 0,
      closedAt: null,
    };

    expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(detail))).toStrictEqual(
      detail,
    );
  });
});
