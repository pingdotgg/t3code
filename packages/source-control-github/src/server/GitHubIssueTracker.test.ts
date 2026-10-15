import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { IssueTrackerKind } from "@t3tools/contracts";
import { SourceControlRateLimitPausedError } from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubIssueTracker from "./GitHubIssueTracker.ts";

/** A detail answer as GitHub's GraphQL API shapes it, with every section populated once. */
const DETAIL_FIXTURE = {
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
};
const DETAIL_RESPONSE = JSON.stringify(DETAIL_FIXTURE);

function tracker(
  graphql: (query: string, variables: unknown) => string,
  rest: (input: GitHubApi.GitHubRestInput) => GitHubApi.GitHubRestResponse = () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ labels: [{ name: "bug", color: "d73a4a" }] }),
    truncated: false,
    invalidUtf8: false,
  }),
) {
  return GitHubIssueTracker.make.pipe(
    Effect.provide(
      Layer.mock(GitHubApi.GitHubApi)({
        graphql: ({ query, variables }) => Effect.succeed(graphql(query, variables)),
        rest: (input) => Effect.succeed(rest(input)),
      }),
    ),
  );
}

describe("GitHubIssueTracker", () => {
  it.effect.each(["create", "update"] as const)(
    "enforces 10 assignees before %s native work",
    (operation) =>
      Effect.gen(function* () {
        const requests: GitHubApi.GitHubRestInput[] = [];
        let graphqlReads = 0;
        const api = yield* tracker(
          () => {
            graphqlReads++;
            return "{}";
          },
          (input) => {
            requests.push(input);
            return {
              status: 200,
              headers: {},
              body: JSON.stringify({
                number: 43,
                html_url: "https://github.com/acme/web/issues/43",
                labels: [],
                assignees: (input.body as { assignees: string[] }).assignees.map((login) => ({
                  login,
                })),
              }),
              truncated: false,
              invalidUtf8: false,
            };
          },
        );
        const target = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
        const assignees = Array.from({ length: 11 }, (_, index) => `user-${index}`);
        const write =
          operation === "create"
            ? api.create!({
                ...target,
                title: "New",
                body: "",
                labels: [],
                assignees,
              })
            : api.update!({ ...target, assignees });
        const refused = yield* write.pipe(Effect.result);
        expect(requests).toHaveLength(0);
        expect(graphqlReads).toBe(0);
        expect(refused).toMatchObject({
          _tag: "Failure",
          failure: {
            operation,
            reason: "failed",
            detail: "GitHub issues support at most 10 assignees.",
          },
        });
        expect(api.capabilities.maxAssignees).toBe(10);
        if (operation === "create")
          yield* api.create!({
            ...target,
            title: "New",
            body: "",
            labels: [],
            assignees: assignees.slice(0, 10),
          });
        else yield* api.update!({ ...target, assignees: assignees.slice(0, 10) });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.method).toBe(operation === "create" ? "POST" : "PATCH");
        expect(requests[0]?.body).toMatchObject({ assignees: assignees.slice(0, 10) });
        expect(graphqlReads).toBe(0);
      }),
  );

  it.effect.each([
    ["github.com", "https://github.com/acme/web", []],
    ["ghe.internal:8080", "http://ghe.internal:8080/source/acme/web", []],
    [
      "github.com",
      "https://github.com/acme/web",
      [{ filename: "bug.md", name: "Bug report", body: "Describe the bug." }],
    ],
  ] as const)("offers the native issue chooser on %s when blank issues are disabled", (testCase) =>
    Effect.gen(function* () {
      const [host, repositoryUrl, issueTemplates] = testCase;
      let graphqlRequests = 0;
      let restRequests = 0;
      const api = yield* GitHubIssueTracker.make.pipe(
        Effect.provide(
          Layer.mock(GitHubApi.GitHubApi)({
            graphql: (input) => {
              graphqlRequests += 1;
              expect(input.host).toBe(host);
              expect(input.variables).toEqual({ owner: "acme", name: "web" });
              return Effect.succeed(
                JSON.stringify({ data: { repository: { url: repositoryUrl, issueTemplates } } }),
              );
            },
            rest: (input) => {
              restRequests += 1;
              expect(input.host).toBe(host);
              return Effect.succeed({
                status: 200,
                headers: {},
                body: "blank_issues_enabled: false\n",
                truncated: false,
                invalidUtf8: false,
              });
            },
          }),
        ),
      );
      const result = yield* api.listTemplates!({ cwd: "/w", host, scope: "acme/web" });
      expect(result.blankIssuesEnabled).toBe(false);
      expect(result.externalTemplates).toEqual([
        {
          name: "GitHub issue templates",
          about: "Choose a template or form on GitHub.",
          url: `${repositoryUrl}/issues/new/choose`,
        },
      ]);
      expect(result.templates.map(({ key, body }) => ({ key, body }))).toEqual(
        issueTemplates.map(({ filename, body }) => ({ key: filename, body })),
      );
      expect([graphqlRequests, restRequests]).toEqual([1, 1]);
    }),
  );

  it.effect.each([
    { state: "all", states: ["OPEN", "CLOSED"] },
    { state: "open", states: ["OPEN"] },
    { state: "closed", states: ["CLOSED"] },
  ] as const)("uses native repository states for $state browsing", (input) =>
    Effect.gen(function* () {
      const api = yield* tracker((query, variables) => {
        expect(query).not.toContain("search(");
        expect(query).toContain("issues(first: 100");
        expect(variables).toEqual({
          owner: "acme",
          name: "web",
          states: input.states,
          orderBy: { field: "UPDATED_AT", direction: "DESC" },
          cursor: "raw-native",
        });
        return JSON.stringify({
          data: {
            repository: {
              issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "native-next" } },
            },
          },
        });
      });
      expect(
        yield* api.listIssues({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
          state: input.state,
          involvement: "all",
          viewer: "julius",
          query: "  ",
          limit: 200,
          cursor: "raw-native",
        }),
      ).toEqual({ items: [], nextCursor: "native-next" });
    }),
  );

  it.effect("keeps repository misses typed and refuses malformed scopes before reading", () =>
    Effect.gen(function* () {
      let reads = 0;
      const api = yield* tracker(() => {
        reads++;
        return JSON.stringify({ data: { repository: null } });
      });
      const input = {
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        state: "all" as const,
        involvement: "all" as const,
        viewer: "julius",
        limit: 50,
      };
      expect((yield* Effect.flip(api.listIssues(input))).reason).toBe("not-found");
      expect(reads).toBe(1);
      expect(
        (yield* Effect.flip(api.listIssues({ ...input, scope: "acme/web repo:foreign/web" })))
          .reason,
      ).toBe("failed");
      expect(reads).toBe(1);
    }),
  );

  it.effect.each([
    { involvement: "all", query: "focus", qualifier: '"focus"' },
    { involvement: "assigned", qualifier: "assignee:julius" },
    { involvement: "authored", qualifier: "author:julius" },
    { involvement: "mentioned", qualifier: "mentions:julius" },
  ] as const)("keeps native search for $qualifier without reading a viewer", (input) =>
    Effect.gen(function* () {
      let reads = 0;
      const api = yield* tracker((query, variables) => {
        reads++;
        expect(query).toContain("search(");
        expect(variables).toMatchObject({
          q: expect.stringContaining(input.qualifier),
          cursor: "raw-search",
        });
        return JSON.stringify({
          data: {
            search: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "next-search" } },
          },
        });
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        state: "all",
        viewer: "julius",
        limit: 50,
        cursor: "raw-search",
        involvement: input.involvement,
        ...("query" in input ? { query: input.query } : {}),
      });
      expect(page).toEqual({ items: [], nextCursor: "next-search" });
      expect(reads).toBe(1);
    }),
  );

  it.effect(
    "marks a listed label subset and clears the flag after authoritative detail hydration",
    () =>
      Effect.gen(function* () {
        const labels = Array.from({ length: 21 }, (_, index) => ({
          name: `label-${index + 1}`,
          color: "abcdef",
        }));
        const native = {
          ...DETAIL_FIXTURE.data.repository.issue,
          labels: { nodes: labels.slice(0, 20), pageInfo: { hasNextPage: true } },
        };
        const queries: string[] = [];
        let restReads = 0;
        const api = yield* tracker(
          (query) => {
            queries.push(query);
            return JSON.stringify(
              query.includes("search(")
                ? { data: { search: { nodes: [native], pageInfo: { hasNextPage: false } } } }
                : {
                    data: {
                      ...DETAIL_FIXTURE.data,
                      repository: { ...DETAIL_FIXTURE.data.repository, issue: native },
                    },
                  },
            );
          },
          () => {
            restReads++;
            return {
              status: 200,
              headers: {},
              body: JSON.stringify({ labels }),
              truncated: false,
              invalidUtf8: false,
            };
          },
        );
        const target = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
        const page = yield* api.listIssues({
          ...target,
          query: "focus",
          state: "all",
          involvement: "all",
          viewer: "julius",
          limit: 50,
        });
        expect(page.items[0]?.labels).toHaveLength(20);
        expect(page.items[0]?.labelsTruncated).toBe(true);
        expect(restReads).toBe(0);
        const detail = yield* api.getIssue(target);
        expect(detail.labels).toHaveLength(21);
        expect(detail.labels[20]?.name).toBe("label-21");
        expect(detail.labelsTruncated).toBe(false);
        expect(detail.viewerPermissions.labels).toBe(true);
        expect(queries).toHaveLength(2);
        expect(
          queries.every(
            (query) =>
              query.includes("pageInfo { hasNextPage }") && query.includes("labels(first: 20)"),
          ),
        ).toBe(true);
        expect(restReads).toBe(1);
      }),
  );

  it.effect.each(["labels", "assignees"] as const)(
    "refuses success when GitHub omits the requested %s update",
    (field) =>
      Effect.gen(function* () {
        const requests: GitHubApi.GitHubRestInput[] = [];
        const api = yield* tracker(
          () => DETAIL_RESPONSE,
          (input) => {
            requests.push(input);
            return {
              status: 200,
              headers: {},
              body: JSON.stringify({ labels: [], assignees: [] }),
              truncated: false,
              invalidUtf8: false,
            };
          },
        );
        const error = yield* api.update!({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
          key: "42",
          [field]: ["expected"],
        }).pipe(Effect.flip);
        expect(error.detail).toBe(`GitHub did not save the requested ${field}.`);
        expect(requests).toHaveLength(1);
      }),
  );

  it.effect("keeps a created issue and warns when GitHub skips metadata", () =>
    Effect.gen(function* () {
      const api = yield* tracker(
        () => DETAIL_RESPONSE,
        () => ({
          status: 201,
          headers: {},
          body: JSON.stringify({
            number: 43,
            html_url: "https://github.com/acme/web/issues/43",
            labels: [],
            assignees: [],
          }),
          truncated: false,
          invalidUtf8: false,
        }),
      );
      const result = yield* api.create!({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        title: "Created issue",
        body: "",
        labels: ["bug"],
        assignees: ["alice"],
      });
      expect(result.key).toBe("43");
      expect(result.warnings).toEqual([
        "The issue was created, but GitHub did not save the requested labels.",
        "The issue was created, but GitHub did not save the requested assignees.",
      ]);
    }),
  );

  it.effect.each([
    ["disables blank issues with a plain false value", "blank_issues_enabled: false\n", false],
    [
      "disables blank issues with a false value and a comment",
      "blank_issues_enabled: false # require a template\n",
      false,
    ],
    [
      "enables blank issues with a true value and a comment",
      "blank_issues_enabled: true # allow blank issues\n",
      true,
    ],
    ["enables blank issues when the config has no setting", "contact_links: []\n", true],
    ["ignores a nested blank issue setting", "other:\n  blank_issues_enabled: false\n", true],
    ["enables blank issues when the config is invalid", "blank_issues_enabled: [\n", true],
  ] as const)("%s", ([, config, blankIssuesEnabled]) =>
    Effect.gen(function* () {
      const api = yield* tracker(
        () =>
          JSON.stringify({
            data: { repository: { url: "https://github.com/acme/web", issueTemplates: [] } },
          }),
        (input) => {
          expect(input.path).toBe("repos/acme/web/contents/.github/ISSUE_TEMPLATE/config.yml");
          expect(input.accept).toBe("application/vnd.github.raw");
          return {
            status: 200,
            headers: {},
            body: config,
            truncated: false,
            invalidUtf8: false,
          };
        },
      );
      const result = yield* api.listTemplates!({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
      });
      expect(result).toMatchObject({ templates: [], blankIssuesEnabled });
      expect(result.externalTemplates).toHaveLength(blankIssuesEnabled ? 0 : 1);
    }),
  );

  it.effect.each([
    [
      new GitHubApi.GitHubApiNotFoundError({ host: "github.com", operation: "listTemplateConfig" }),
      false,
    ],
    [
      new GitHubApi.GitHubApiAuthenticationError({
        host: "github.com",
        operation: "listTemplateConfig",
      }),
      false,
    ],
    [
      new GitHubApi.GitHubApiRateLimitError({
        host: "github.com",
        operation: "listTemplateConfig",
      }),
      true,
    ],
    [
      new SourceControlRateLimitPausedError({
        provider: IssueTrackerKind.make("github"),
        host: "github.com",
        retryAt: 1000,
      }),
      true,
    ],
  ] as const)(
    "preserves the blank issue policy after a config read error: %s",
    ([error, rateLimited]) =>
      Effect.gen(function* () {
        const api = yield* GitHubIssueTracker.make.pipe(
          Effect.provide(
            Layer.mock(GitHubApi.GitHubApi)({
              graphql: () =>
                Effect.succeed(
                  JSON.stringify({
                    data: {
                      repository: { url: "https://github.com/acme/web", issueTemplates: [] },
                    },
                  }),
                ),
              rest: () => Effect.fail(error),
            }),
          ),
        );
        const request = api.listTemplates!({ cwd: "/w", host: "github.com", scope: "acme/web" });
        if (rateLimited) {
          const result = yield* Effect.flip(request);
          expect(result.reason).toBe("rate-limited");
          expect(result.operation).toBe("listTemplateConfig");
        } else {
          expect(yield* request).toEqual({
            templates: [],
            externalTemplates: [],
            blankIssuesEnabled: true,
          });
        }
      }),
  );

  it.effect("refuses reactions on a comment outside the selected issue", () =>
    Effect.gen(function* () {
      for (const reacted of [true, false]) {
        const queries: string[] = [];
        const api = yield* tracker((query, variables) => {
          queries.push(query);
          expect(variables).toEqual({
            owner: "acme",
            name: "web",
            number: 42,
            commentId: "IC_foreign",
          });
          return JSON.stringify({
            data: {
              repository: { issue: { id: "I_selected" } },
              node: { issue: { id: "I_foreign" } },
            },
          });
        });
        const error = yield* Effect.flip(
          api.setReaction!({
            cwd: "/w",
            host: "github.com",
            scope: "acme/web",
            key: "42",
            subjectId: "IC_foreign",
            content: "thumbs-up",
            reacted,
          }),
        );
        expect(error.detail).toBe("The comment does not belong to the selected issue.");
        expect(queries).toHaveLength(1);
        expect(queries[0]).not.toContain("mutation");
      }
    }),
  );

  it.effect("keeps every native issue label when an edit replaces the label set", () =>
    Effect.gen(function* () {
      const labels = Array.from({ length: 121 }, (_, index) => ({
        name: `label-${index}`,
        color: "abc123",
      }));
      const requests: GitHubApi.GitHubRestInput[] = [];
      const api = yield* tracker(
        () => DETAIL_RESPONSE,
        (input) => {
          requests.push(input);
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ labels }),
            truncated: false,
            invalidUtf8: false,
          };
        },
      );
      const context = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
      const issue = yield* api.getIssue(context);
      expect(issue.labels).toEqual(labels);
      yield* api.getViewerPermissions(context);
      yield* api.update!({ ...context, labels: issue.labels.map((label) => label.name) });
      expect(requests.map((request) => [request.method ?? "GET", request.path])).toEqual([
        ["GET", "repos/acme/web/issues/42"],
        ["PATCH", "repos/acme/web/issues/42"],
      ]);
      expect(requests[1]?.body).toEqual({ labels: labels.map((label) => label.name) });
    }),
  );

  it.effect("refuses an incomplete native label response", () =>
    Effect.gen(function* () {
      const api = yield* tracker(
        () => DETAIL_RESPONSE,
        () => ({
          status: 200,
          headers: {},
          body: '{"labels":[]}',
          truncated: true,
          invalidUtf8: false,
        }),
      );
      const error = yield* Effect.flip(
        api.getIssue({ cwd: "/w", host: "github.com", scope: "acme/web", key: "42" }),
      );
      expect(error.reason).toBe("failed");
    }),
  );

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
        historyTruncated: false,
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

  it.effect("reports whether a capped timeline has older events", () =>
    Effect.gen(function* () {
      for (const hasPreviousPage of [true, false]) {
        const queries: string[] = [];
        const api = yield* tracker((query) => {
          queries.push(query);
          return JSON.stringify({
            data: {
              ...DETAIL_FIXTURE.data,
              repository: {
                ...DETAIL_FIXTURE.data.repository,
                issue: {
                  ...DETAIL_FIXTURE.data.repository.issue,
                  timelineItems: {
                    pageInfo: { hasPreviousPage },
                    nodes: Array.from({ length: 100 }, (_, index) => ({
                      __typename: "ClosedEvent",
                      id: `CE_${index}`,
                      createdAt: "2026-07-03T00:00:00Z",
                      actor: null,
                    })),
                  },
                },
              },
            },
          });
        });
        const issue = yield* api.getIssue({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
          key: "42",
        });
        expect(issue.historyTruncated).toBe(hasPreviousPage);
        expect(issue.events).toHaveLength(100);
        expect(queries).toHaveLength(1);
        expect(queries[0]).toMatch(
          /timelineItems\(last: 100,[^)]*\)\s*\{\s*pageInfo\s*\{\s*hasPreviousPage\s*\}/,
        );
      }
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
