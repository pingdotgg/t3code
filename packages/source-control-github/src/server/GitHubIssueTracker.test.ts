import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubIssueTracker from "./GitHubIssueTracker.ts";

/** A detail answer as GitHub's GraphQL API shapes it, with every section populated once. */
const DETAIL_RESPONSE = JSON.stringify({
  data: {
    viewer: { login: "julius" },
    repository: {
      viewerPermission: "TRIAGE",
      issue: {
        number: 42,
        title: "Composer loses focus",
        url: "https://github.com/acme/web/issues/42",
        author: { login: "octocat", avatarUrl: "https://avatars/octocat", name: "Octo Cat" },
        state: "CLOSED",
        stateReason: "NOT_PLANNED",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-03T00:00:00Z",
        closedAt: "2026-07-03T00:00:00Z",
        comments: {
          totalCount: 3,
          pageInfo: { hasPreviousPage: true, startCursor: "Y3Vyc29y" },
          nodes: [
            {
              id: "IC_1",
              author: { login: "julius", avatarUrl: null },
              body: "Repro attached.",
              createdAt: "2026-07-02T00:00:00Z",
              url: "https://github.com/acme/web/issues/42#issuecomment-1",
              reactionGroups: [
                {
                  content: "THUMBS_UP",
                  viewerHasReacted: true,
                  reactors: { totalCount: 2, nodes: [{ login: "julius" }, { login: "theo" }] },
                },
                {
                  content: "EYES",
                  viewerHasReacted: false,
                  reactors: { totalCount: 0, nodes: [] },
                },
              ],
            },
          ],
        },
        assignees: { nodes: [{ login: "theo", name: null, avatarUrl: null }] },
        labels: { nodes: [{ name: "bug", color: "d73a4a" }, null] },
        body: "Typing in the composer drops focus after a paste.",
        viewerCanUpdate: false,
        reactionGroups: [],
        closedByPullRequestsReferences: {
          nodes: [
            {
              number: 50,
              title: "fix(web): keep composer focus",
              url: "https://github.com/acme/web/pull/50",
              state: "MERGED",
              isDraft: false,
              repository: { nameWithOwner: "acme/web" },
            },
          ],
        },
        timelineItems: {
          nodes: [
            {
              __typename: "LabeledEvent",
              id: "LE_1",
              createdAt: "2026-07-01T01:00:00Z",
              actor: { login: "theo" },
              label: { name: "bug" },
            },
            {
              __typename: "CrossReferencedEvent",
              id: "CRE_1",
              createdAt: "2026-07-02T01:00:00Z",
              actor: { login: "julius" },
              source: {
                __typename: "PullRequest",
                number: 50,
                title: "fix(web): keep composer focus",
                url: "https://github.com/acme/web/pull/50",
                state: "MERGED",
                isDraft: false,
                repository: { nameWithOwner: "acme/web" },
              },
            },
            { __typename: "MentionedEvent", id: "ME_1", createdAt: "2026-07-02T02:00:00Z" },
            {
              __typename: "ClosedEvent",
              id: "CE_1",
              createdAt: "2026-07-03T00:00:00Z",
              actor: null,
            },
          ],
        },
      },
    },
  },
});

function tracker(graphql: (query: string, variables: unknown) => string) {
  return GitHubIssueTracker.make.pipe(
    Effect.provide(
      Layer.mock(GitHubApi.GitHubApi)({
        graphql: ({ query, variables }) => Effect.succeed(graphql(query, variables)),
      }),
    ),
  );
}

describe("GitHubIssueTracker", () => {
  it.effect("maps a detail read to the neutral issue shape", () =>
    Effect.gen(function* () {
      let seen: unknown;
      let sentQuery = "";
      const api = yield* tracker((query, variables) => {
        seen = variables;
        sentQuery = query;
        return DETAIL_RESPONSE;
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        key: "42",
      });
      expect(seen).toEqual({ owner: "acme", name: "web", number: 42 });
      // GitHub rejects a query that selects one field twice with different arguments.
      expect(sentQuery.match(/\bcomments\b/g)).toHaveLength(1);
      expect(issue).toMatchObject({
        key: "42",
        displayKey: "#42",
        title: "Composer loses focus",
        state: { category: "closed", name: "closed", closeReason: "not-planned" },
        author: { login: "octocat", name: "Octo Cat", avatarUrl: "https://avatars/octocat" },
        assignees: [{ login: "theo" }],
        labels: [{ name: "bug", color: "d73a4a" }],
        commentCount: 3,
        viewer: "julius",
        // Triage may label and assign; `viewerCanUpdate: false` withholds state and edits.
        viewerPermissions: {
          setState: false,
          edit: false,
          labels: true,
          assignees: true,
          comment: true,
        },
        commentsCursor: "Y3Vyc29y",
      });
      // The viewer is left out of `actors` and shown as "You"; an empty group is dropped.
      expect(issue.comments[0]?.reactions).toEqual([
        { content: "thumbs-up", count: 2, actors: ["theo"], viewerHasReacted: true },
      ]);
      // The closing reference wins over the cross-reference sighting of the same pull request.
      expect(issue.linkedPullRequests).toEqual([
        {
          repository: "acme/web",
          number: 50,
          title: "fix(web): keep composer focus",
          url: "https://github.com/acme/web/pull/50",
          state: "merged",
          isDraft: false,
          closesIssue: true,
        },
      ]);
      // An event kind this page has no vocabulary for is dropped rather than guessed at.
      expect(issue.events.map((event) => [event.kind, event.detail])).toEqual([
        ["labeled", "bug"],
        ["referenced", "acme/web#50"],
        ["closed", null],
      ]);
    }),
  );

  it.effect("refuses a key that names no GitHub issue number without a request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(() => {
        requests += 1;
        return DETAIL_RESPONSE;
      });
      const error = yield* Effect.flip(
        api.getIssue({ cwd: "/w", host: "github.com", scope: "acme/web", key: "ENG-42" }),
      );
      expect(error.reason).toBe("not-found");
      expect(requests).toBe(0);
    }),
  );
});
