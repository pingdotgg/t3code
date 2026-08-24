import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decodeGitHubIssueDetail, decodeGitHubIssueList } from "./gitHubIssueJson.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const rawIssue = {
  number: 42,
  title: "Support GitHub issues",
  url: "https://github.com/t3tools/t3code/issues/42",
  author: { login: "octocat", name: "Octo Cat" },
  assignees: [{ login: "maintainer", name: null }],
  labels: [{ name: "feature", color: "1d76db" }],
  state: "OPEN",
  createdAt: "2026-08-20T00:00:00Z",
  updatedAt: "2026-08-21T00:00:00Z",
};

describe("GitHub issue JSON", () => {
  it.effect("normalizes list actors, labels, and state", () =>
    Effect.gen(function* () {
      const [issue] = yield* decodeGitHubIssueList(encodeJson([rawIssue]));

      expect(issue).toMatchObject({
        number: 42,
        state: "open",
        author: { login: "octocat", avatarUrl: null },
        assignees: [{ login: "maintainer", avatarUrl: null }],
        labels: [{ name: "feature", color: "1d76db" }],
      });
    }),
  );

  it.effect("normalizes the body and issue discussion", () =>
    Effect.gen(function* () {
      const issue = yield* decodeGitHubIssueDetail(
        encodeJson({
          ...rawIssue,
          body: "Please make issues visible.",
          closedAt: null,
          comments: [
            {
              id: "comment-1",
              author: { login: "reviewer", name: null },
              body: "This should open an agent thread.",
              createdAt: "2026-08-21T01:00:00Z",
            },
          ],
        }),
      );

      expect(issue.body).toBe("Please make issues visible.");
      expect(issue.comments[0]).toMatchObject({
        id: "comment-1",
        updatedAt: "2026-08-21T01:00:00Z",
        url: rawIssue.url,
      });
    }),
  );
});
