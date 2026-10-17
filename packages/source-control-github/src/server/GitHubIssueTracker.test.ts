import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { IssueDetail } from "@t3tools/contracts";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubIssueTracker from "./GitHubIssueTracker.ts";

const decodeDetailWire = Schema.decodeEffect(IssueDetail);

/** A detail answer as GitHub's GraphQL API shapes it, with every section populated once. */
const DETAIL_FIXTURE = {
  data: {
    viewer: { login: "julius" },
    repository: {
      isArchived: false,
      viewerPermission: "TRIAGE",
      issue: {
        milestone: null,
        locked: false,
        number: 42,
        title: "Composer loses focus",
        url: "https://github.com/acme/web/issues/42",
        author: {
          __typename: "User",
          login: "octocat",
          avatarUrl: "https://avatars/octocat",
          name: "Octo Cat",
        },
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
              __typename: "IssueComment",
              lastEditedAt: null,
              viewerCanUpdate: false,
              id: "IC_1",
              author: {
                __typename: "User",
                name: null,
                login: "julius",
                avatarUrl: "https://avatars.example/user",
              },
              body: "Repro attached.",
              createdAt: "2026-07-02T00:00:00Z",
              url: "https://github.com/acme/web/issues/42#issuecomment-1",
              reactionGroups: [
                {
                  content: "THUMBS_UP",
                  viewerHasReacted: true,
                  reactors: {
                    totalCount: 2,
                    nodes: [
                      {
                        __typename: "User",
                        login: "julius",
                      },
                      {
                        __typename: "User",
                        login: "theo",
                      },
                    ],
                  },
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
        assignees: {
          nodes: [{ login: "theo", name: null, avatarUrl: "https://avatars.example/user" }],
        },
        labels: {
          pageInfo: { hasNextPage: false },
          nodes: [{ name: "bug", color: "d73a4a" }, null],
        },
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
          pageInfo: {
            startCursor: null,
            hasPreviousPage: false,
          },
          nodes: [
            {
              __typename: "LabeledEvent",
              id: "LE_1",
              createdAt: "2026-07-01T01:00:00Z",
              actor: {
                __typename: "User",
                avatarUrl: "https://avatars.example/user",
                login: "theo",
              },
              label: { name: "bug" },
            },
            {
              __typename: "CrossReferencedEvent",
              id: "CRE_1",
              url: "https://github.com/acme/web/pull/50#ref-event-1",
              createdAt: "2026-07-02T01:00:00Z",
              actor: {
                __typename: "User",
                avatarUrl: "https://avatars.example/user",
                login: "julius",
              },
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
            {
              actor: null,
              __typename: "MentionedEvent",
              id: "ME_1",
              createdAt: "2026-07-02T02:00:00Z",
            },
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
  graphql: (query: string, variables: Readonly<Record<string, unknown>>) => string | Response,
  rest: (input: GitHubRest.GitHubRestInput) => GitHubRest.GitHubRestResponse = () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ labels: [{ name: "bug", color: "d73a4a" }] }),
    truncated: false,
    invalidUtf8: false,
  }),
) {
  const services = Layer.mergeAll(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const body = JSON.parse(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
        );
        const response = graphql(body.query, body.variables);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            typeof response === "string"
              ? new Response(response, { headers: { "content-type": "application/json" } })
              : response,
          ),
        );
      }),
    ),
    Layer.succeed(GitHubCredentials.GitHubCredentials, {
      get: (host) =>
        Effect.succeed({
          host,
          token: Redacted.make("fixture"),
          source: "env" as const,
          fingerprint: "fixture",
        }),
      invalidate: () => Effect.void,
    }),
    GitHubQuota.layer,
    SourceControlRateLimit.layer,
  );
  return GitHubIssueTracker.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitHubRest.GitHubRest)({ rest: (input) => Effect.succeed(rest(input)) }),
        GitHubRequestPolicy.layer,
      ).pipe(Layer.provideMerge(services)),
    ),
  );
}

describe("GitHubIssueTracker", () => {
  it.effect("inherits one public account template folder with its chooser config", () =>
    Effect.gen(function* () {
      const reads: unknown[] = [];
      const api = yield* tracker((_query, variables) => {
        reads.push(variables);
        const inherited = (variables as { name: string }).name === ".github";
        return JSON.stringify({
          data: {
            repository: {
              rootForms: null,
              docsForms: null,
              nameWithOwner: inherited ? "acme/.github" : "acme/web",
              isPrivate: false,
              forms: inherited
                ? {
                    __typename: "Tree",
                    oid: "a".repeat(40),
                    entries: [
                      {
                        name: "bug.yml",
                        object: {
                          __typename: "Blob",
                          text: "name: Bug\ndescription: Report an issue\nbody:\n- type: textarea\n  attributes:\n    label: Details\n",
                        },
                      },
                      {
                        name: "config.yml",
                        object: {
                          __typename: "Blob",
                          text: "blank_issues_enabled: false\ncontact_links: [{name: Help, about: Ask us, url: 'https://example.com/help'}]\n",
                        },
                      },
                    ],
                  }
                : null,
              issueTemplates: [],
            },
          },
        });
      });
      const result = yield* api.listTemplates!({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
      });
      expect(result.templates).toMatchObject([
        { name: "Bug", fields: [{ kind: "textarea", label: "Details" }] },
      ]);
      expect(result.blankIssuesEnabled).toBe(false);
      expect(result.contactLinks).toEqual([
        { name: "Help", about: "Ask us", url: "https://example.com/help" },
      ]);
      expect(reads).toEqual([
        { owner: "acme", name: "web", includeBody: true },
        { owner: "acme", name: ".github", includeBody: true },
      ]);
    }),
  );

  it.effect.each(["inherited", "invalid-local", "root", "docs"] as const)(
    "keeps %s native Markdown ownership separate from account defaults",
    (kind) =>
      Effect.gen(function* () {
        const reads: unknown[] = [];
        const markdown = {
          filename: "bug.md",
          name: "Native Markdown",
          about: "Report a bug",
          title: null,
          body: "Native body",
          assignees: { nodes: [] },
          labels: null,
        };
        const valid = {
          name: "bug.md",
          object: {
            __typename: "Blob",
            text: "---\nname: Native Markdown\nabout: Report a bug\n---\nNative body",
          },
        };
        const api = yield* tracker((_query, variables) => {
          reads.push(variables);
          const defaults = (variables as { name: string }).name === ".github";
          return JSON.stringify({
            data: {
              repository: {
                nameWithOwner: defaults ? "acme/.github" : "acme/web",
                isPrivate: false,
                issueTemplates: [markdown],
                rootForms:
                  !defaults && kind === "root"
                    ? {
                        __typename: "Tree",
                        oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        entries: [valid],
                      }
                    : null,
                docsForms:
                  !defaults && kind === "docs"
                    ? {
                        __typename: "Tree",
                        oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        entries: [valid],
                      }
                    : null,
                forms: defaults
                  ? {
                      __typename: "Tree",
                      oid: "a".repeat(40),
                      entries: [
                        valid,
                        {
                          name: "form.yml",
                          object: {
                            __typename: "Blob",
                            text: "name: Default form\ndescription: Report an issue\nbody:\n- type: textarea\n  attributes:\n    label: Details\n",
                          },
                        },
                        {
                          name: "config.yml",
                          object: {
                            __typename: "Blob",
                            text: "blank_issues_enabled: false",
                          },
                        },
                      ],
                    }
                  : kind === "invalid-local"
                    ? {
                        __typename: "Tree",
                        oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        entries: [
                          {
                            name: "bug.md",
                            object: {
                              __typename: "Blob",
                              text: "Missing native front matter",
                            },
                          },
                        ],
                      }
                    : null,
              },
            },
          });
        });
        const result = yield* api.listTemplates!({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
        });
        const local = kind === "root" || kind === "docs";
        expect(reads).toHaveLength(local ? 1 : 2);
        expect(result.blankIssuesEnabled).toBe(local);
        expect(result.templates.map((template) => template.name)).toEqual(
          local ? ["Native Markdown"] : ["Native Markdown", "Default form"],
        );
        expect(result.templates[0]?.body).toBe("Native body");
      }),
  );

  it.effect.each(["form", "markdown", "config"] as const)(
    "local %s suppresses the whole default folder",
    (kind) =>
      Effect.gen(function* () {
        let reads = 0;
        const api = yield* tracker(() => {
          reads++;
          return JSON.stringify({
            data: {
              repository: {
                nameWithOwner: "acme/web",
                isPrivate: false,
                rootForms: null,
                docsForms: null,
                issueTemplates:
                  kind === "markdown"
                    ? [
                        {
                          about: null,
                          title: null,
                          assignees: { nodes: [] },
                          labels: null,
                          filename: "bug.md",
                          name: "Local bug",
                          body: "Local body",
                        },
                      ]
                    : [],
                forms: {
                  __typename: "Tree",
                  oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  entries: [
                    {
                      name:
                        kind === "form" ? "bug.yml" : kind === "markdown" ? "bug.md" : "config.yml",
                      object: {
                        __typename: "Blob",
                        text:
                          kind === "form"
                            ? "name: Local bug\ndescription: Report an issue\nbody:\n- type: textarea\n  attributes:\n    label: Details\n"
                            : kind === "config"
                              ? "blank_issues_enabled: false"
                              : "---\nname: Local bug\nabout: Local bug\n---\nLocal body",
                      },
                    },
                  ],
                },
              },
            },
          });
        });
        const result = yield* api.listTemplates!({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
        });
        expect(reads).toBe(1);
        expect(result.blankIssuesEnabled).toBe(kind !== "config");
        expect(result.templates).toHaveLength(kind === "config" ? 0 : 1);
        expect(result.templates[0]?.name).toBe(kind === "config" ? undefined : "Local bug");
      }),
  );

  it.effect.each([
    "private",
    "wrong-owner",
    "malformed",
    "missing",
    "forbidden",
    "rate-limited",
  ] as const)("handles %s defaults without changing native ownership", (kind) =>
    Effect.gen(function* () {
      let reads = 0;
      const api = yield* tracker((_query, variables) => {
        reads++;
        if (variables?.name === "web")
          return JSON.stringify({
            data: {
              repository: {
                nameWithOwner: "acme/web",
                isPrivate: false,
                rootForms: null,
                docsForms: null,
                issueTemplates: [],
                forms: null,
              },
            },
          });
        if (kind === "missing") return new Response("{}", { status: 404 });
        if (kind === "forbidden") return new Response("{}", { status: 403 });
        if (kind === "rate-limited")
          return new Response("{}", {
            status: 429,
            headers: { "x-ratelimit-reset": "2000000000" },
          });
        return kind === "malformed"
          ? "{"
          : JSON.stringify({
              data: {
                repository: {
                  rootForms: null,
                  docsForms: null,
                  nameWithOwner: kind === "wrong-owner" ? "other/.github" : "acme/.github",
                  isPrivate: kind === "private",
                  forms: {
                    __typename: "Tree",
                    oid: "a".repeat(40),
                    entries: [
                      {
                        name: "config.yml",
                        object: {
                          __typename: "Blob",
                          text: "blank_issues_enabled: false",
                        },
                      },
                    ],
                  },
                  issueTemplates: [],
                },
              },
            });
      });
      const input = { cwd: "/w", host: "github.com", scope: "acme/web" };
      if (kind === "rate-limited")
        expect(yield* api.listTemplates!(input).pipe(Effect.flip)).toMatchObject({
          reason: "rate-limited",
          retryAt: 2_000_000_000_000,
        });
      else
        expect(yield* api.listTemplates!(input)).toEqual({
          templates: [],
          blankIssuesEnabled: true,
        });
      expect(reads).toBe(2);
    }),
  );

  it.effect("binds deferred default Markdown bodies to the public source tree", () =>
    Effect.gen(function* () {
      const reads: unknown[] = [];
      let oid = "a".repeat(40);
      const api = yield* tracker((_query, variables) => {
        reads.push(variables);
        const defaults = (variables as { name: string }).name === ".github";
        return JSON.stringify({
          data: {
            repository: {
              rootForms: null,
              docsForms: null,
              nameWithOwner: defaults ? "acme/.github" : "acme/web",
              isPrivate: false,
              forms: defaults
                ? {
                    __typename: "Tree",
                    oid,
                    entries: [
                      {
                        name: "bug.md",
                        object: {
                          __typename: "Blob",
                          text: "Markdown",
                        },
                      },
                    ],
                  }
                : null,
              issueTemplates: defaults
                ? [
                    {
                      about: null,
                      title: null,
                      filename: "bug.md",
                      name: "Bug",
                      body: "Native Markdown",
                      labels: {
                        pageInfo: { hasNextPage: false },
                        nodes: [
                          {
                            color: "000000",
                            name: "bug",
                          },
                        ],
                      },
                      assignees: {
                        nodes: [
                          {
                            name: null,
                            avatarUrl: "https://avatars.example/user",
                            login: "alice",
                          },
                        ],
                      },
                    },
                  ]
                : [],
            },
          },
        });
      });
      const input = { cwd: "/w", host: "github.com", scope: "acme/web" };
      const metadata = yield* api.listTemplates!({ ...input, metadataOnly: true });
      const key = metadata.templates[0]!.key;
      expect(key).toBe(`github-default:acme/.github:${oid}:bug.md`);
      expect(metadata.templates[0]).toMatchObject({
        body: "",
        contentDeferred: true,
        labels: ["bug"],
        assignees: ["alice"],
      });
      expect(reads).toHaveLength(2);
      expect(reads).toEqual([
        { owner: "acme", name: "web", includeBody: false },
        { owner: "acme", name: ".github", includeBody: false },
      ]);
      expect(
        (yield* api.listTemplates!({ ...input, templateKey: key })).templates[0],
      ).toMatchObject({ key, body: "Native Markdown" });
      oid = "b".repeat(40);
      expect(
        yield* api.listTemplates!({ ...input, templateKey: key }).pipe(Effect.flip),
      ).toMatchObject({ reason: "failed" });
      const count = reads.length;
      expect(
        yield* api.listTemplates!({
          ...input,
          templateKey: `github-default:evil/.github:${oid}:bug.md`,
        }).pipe(Effect.flip),
      ).toMatchObject({ reason: "failed" });
      expect(reads).toHaveLength(count);
    }),
  );

  it.effect("reads and changes GitHub dependencies by native stable issue IDs", () =>
    Effect.gen(function* () {
      const requests: GitHubRest.GitHubRestInput[] = [];
      const source = {
        id: 1042,
        number: 42,
        title: "Source",
        state: "open",
        html_url: "https://github.com/acme/web/issues/42",
      };
      const other = {
        id: 9021,
        number: 21,
        title: "Target",
        state: "closed",
        html_url: "https://github.com/other/repo/issues/21",
      };
      const api = yield* tracker(
        () => DETAIL_RESPONSE,
        (input) => {
          requests.push(input);
          return {
            status: 200,
            headers: input.path.includes("?per_page")
              ? {
                  link: '<https://api.github.com/repos/acme/web/issues/42/dependencies/blocked_by?per_page=1&page=2>; rel="next"',
                }
              : {},
            body: JSON.stringify(
              input.path.includes("?per_page")
                ? [other]
                : input.path === "repos/acme/web/issues/42"
                  ? source
                  : other,
            ),
            truncated: false,
            invalidUtf8: false,
          };
        },
      );
      const target = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
      expect(api.capabilities.dependencies).toBe(true);
      const page = yield* api.getDependencies!({ ...target, direction: "blocked-by", limit: 1 });
      expect(page.items).toMatchObject([{ scope: "other/repo", key: "21", kind: "issue" }]);
      expect(page.nextCursor).toBe("2");
      yield* api.setDependency!({
        ...target,
        direction: "blocks",
        targetScope: "other/repo",
        targetKey: "21",
        linked: true,
      });
      expect(requests.filter((request) => request.method === "POST")).toMatchObject([
        { path: "repos/other/repo/issues/21/dependencies/blocked_by", body: { issue_id: 1042 } },
      ]);
    }),
  );

  it.effect.each([
    {
      role: "TRIAGE",
      archived: false,
      inverse: false,
      targetRole: "READ",
      targetArchived: false,
      allowed: true,
      writes: 1,
    },
    {
      role: "READ",
      archived: false,
      inverse: false,
      targetRole: "TRIAGE",
      targetArchived: false,
      allowed: false,
      writes: 0,
    },
    {
      role: "ADMIN",
      archived: true,
      inverse: false,
      targetRole: "TRIAGE",
      targetArchived: false,
      allowed: false,
      writes: 0,
    },
    {
      role: "TRIAGE",
      archived: false,
      inverse: true,
      targetRole: "READ",
      targetArchived: false,
      allowed: false,
      writes: 0,
    },
    {
      role: "TRIAGE",
      archived: false,
      inverse: true,
      targetRole: "ADMIN",
      targetArchived: true,
      allowed: false,
      writes: 0,
    },
    {
      role: "TRIAGE",
      archived: false,
      inverse: true,
      targetRole: "TRIAGE",
      targetArchived: false,
      allowed: true,
      writes: 1,
    },
  ])(
    "uses native dependency triage/archive permissions for $role/$archived/$inverse/$targetRole/$targetArchived",
    (scenario) =>
      Effect.gen(function* () {
        const writes: GitHubRest.GitHubRestInput[] = [];
        const api = yield* tracker(
          (_query, variables) => {
            const source = (variables as { number: number }).number === 42;
            return JSON.stringify({
              data: {
                repository: {
                  viewerPermission: source ? scenario.role : scenario.targetRole,
                  isArchived: source ? scenario.archived : scenario.targetArchived,
                  issue: { viewerCanUpdate: false, locked: false },
                },
              },
            });
          },
          (input) => {
            if (input.method) writes.push(input);
            const source = input.path === "repos/acme/web/issues/42";
            return {
              status: 200,
              headers: {},
              body: JSON.stringify({
                id: source ? 1042 : 9021,
                number: source ? 42 : 21,
                title: "Issue",
                state: "open",
                html_url: source
                  ? "https://github.com/acme/web/issues/42"
                  : "https://github.com/other/repo/issues/21",
              }),
              truncated: false,
              invalidUtf8: false,
            };
          },
        );
        const input = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
        expect(yield* api.getViewerPermissions(input)).toMatchObject({
          edit: false,
          updateDependencies: !scenario.archived && scenario.role !== "READ",
        });
        const operation = api.setDependency!({
          ...input,
          direction: scenario.inverse ? "blocks" : "blocked-by",
          targetScope: "other/repo",
          targetKey: "21",
          linked: true,
        });
        if (scenario.allowed) yield* operation;
        else
          expect(yield* operation.pipe(Effect.flip)).toMatchObject({
            operation: "setDependency",
            reason: "failed",
          });
        expect(writes).toHaveLength(scenario.writes);
      }),
  );

  it.effect.each([
    { targetScope: "acme/web", targetKey: "42" },
    { targetScope: "../web", targetKey: "21" },
    { targetScope: "acme/web/extra", targetKey: "21" },
    { targetScope: "other/repo", targetKey: "9007199254740993" },
    { targetScope: "other/repo", targetKey: "https://evil.test/other/repo/issues/21" },
    { targetScope: "other/repo", targetKey: "https://user@github.com/other/repo/issues/21" },
    { targetScope: "other/repo", targetKey: "https://github.com/other/repo/issues/21?x=1" },
    { targetScope: "other/repo", targetKey: "https://github.com/other/repo/pull/21" },
    { targetScope: "other/repo", targetKey: "https://github.com/wrong/repo/issues/21" },
    { targetScope: "other/repo", targetKey: "wrong/repo#21" },
  ])("refuses invalid dependency target $targetScope/$targetKey before native requests", (target) =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(
        () => {
          requests++;
          return DETAIL_RESPONSE;
        },
        () => {
          requests++;
          throw new Error("Unexpected REST request");
        },
      );
      expect(
        yield* api.setDependency!({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
          key: "42",
          direction: "blocks",
          linked: true,
          ...target,
        }).pipe(Effect.flip),
      ).toMatchObject({ reason: "failed" });
      expect(requests).toBe(0);
    }),
  );

  it.effect.each([
    "wrong-host",
    "wrong-repository",
    "wrong-number",
    "pull-request",
    "invalid-id",
    "unsafe-id",
    "malformed",
  ] as const)("refuses %s native dependency IDs before a write", (kind) =>
    Effect.gen(function* () {
      let writes = 0;
      const api = yield* tracker(
        () => DETAIL_RESPONSE,
        (input) => {
          if (input.method) writes++;
          const source = input.path === "repos/acme/web/issues/42";
          const row = {
            id: source
              ? 1042
              : kind === "invalid-id"
                ? -1
                : kind === "unsafe-id"
                  ? 9007199254740992
                  : 9021,
            number: source ? 42 : kind === "wrong-number" ? 22 : 21,
            title: "Issue",
            state: "open",
            html_url: source
              ? "https://github.com/acme/web/issues/42"
              : kind === "wrong-host"
                ? "https://evil.test/other/repo/issues/21"
                : kind === "wrong-repository"
                  ? "https://github.com/wrong/repo/issues/21"
                  : "https://github.com/other/repo/issues/21",
            ...(!source && kind === "pull-request" ? { pull_request: {} } : {}),
          };
          return {
            status: 200,
            headers: {},
            body: !source && kind === "malformed" ? "{" : JSON.stringify(row),
            truncated: false,
            invalidUtf8: false,
          };
        },
      );
      expect(
        yield* api.setDependency!({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
          key: "42",
          targetScope: "other/repo",
          targetKey: "21",
          direction: "blocked-by",
          linked: true,
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "IssueTrackerError" });
      expect(writes).toBe(0);
    }),
  );

  it.effect.each(["0", "-1", "10000000", "abc", "https://evil.test/", "1:1"])(
    "rejects dependency cursor %s before requests",
    (cursor) =>
      Effect.gen(function* () {
        let requests = 0;
        const api = yield* tracker(
          () => DETAIL_RESPONSE,
          () => {
            requests++;
            throw new Error("Unexpected request");
          },
        );
        expect(
          yield* api.getDependencies!({
            cwd: "/w",
            host: "github.com",
            scope: "acme/web",
            key: "42",
            direction: "blocks",
            cursor,
          }).pipe(Effect.flip),
        ).toMatchObject({ reason: "failed" });
        expect(requests).toBe(0);
      }),
  );

  it.effect.each([
    "foreign-host",
    "foreign-issue",
    "same-page",
    "extra-query",
    "duplicate-next",
    "malformed-body",
    "truncated",
    "foreign-row",
  ] as const)("refuses %s dependency pages without following foreign data", (kind) =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(
        () => DETAIL_RESPONSE,
        () => {
          requests++;
          const base = `https://${kind === "foreign-host" ? "evil.test" : "api.github.com"}/repos/acme/web/issues/${kind === "foreign-issue" ? 99 : 42}/dependencies/blocked_by?per_page=1&page=${kind === "same-page" ? 1 : 2}${kind === "extra-query" ? "&x=1" : ""}`;
          const link = `<${base}>; rel="next"`;
          return {
            status: 200,
            headers: { link: kind === "duplicate-next" ? `${link}, ${link}` : link },
            body:
              kind === "malformed-body"
                ? "{"
                : JSON.stringify([
                    {
                      id: 9021,
                      number: 21,
                      title: "Issue",
                      state: "open",
                      html_url: `https://${kind === "foreign-row" ? "evil.test" : "github.com"}/other/repo/issues/21`,
                    },
                  ]),
            truncated: kind === "truncated",
            invalidUtf8: false,
          };
        },
      );
      expect(
        yield* api.getDependencies!({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
          key: "42",
          direction: "blocked-by",
          limit: 1,
        }).pipe(Effect.flip),
      ).toMatchObject({ reason: "failed" });
      expect(requests).toBe(1);
    }),
  );

  it.effect.each([
    { role: "READ", locked: true, archived: false, comment: false, metadata: false },
    { role: "READ", locked: false, archived: false, comment: true, metadata: false },
    { role: "TRIAGE", locked: false, archived: false, comment: true, metadata: true },
    { role: "TRIAGE", locked: true, archived: false, comment: false, metadata: true },
    { role: "WRITE", locked: true, archived: false, comment: true, metadata: true },
    { role: "ADMIN", locked: false, archived: true, comment: false, metadata: false },
    { role: null, locked: false, archived: true, comment: false, metadata: false },
    { role: null, locked: true, archived: false, comment: true, metadata: true },
  ])("R9 uses native archive and lock fields for $role/$locked/$archived", (input) =>
    Effect.gen(function* () {
      const queries: string[] = [];
      let labelReads = 0;
      const api = yield* tracker(
        (query) => {
          queries.push(query);
          return JSON.stringify({
            data: {
              ...DETAIL_FIXTURE.data,
              repository: {
                ...DETAIL_FIXTURE.data.repository,
                viewerPermission: input.role ?? null,
                ...(query.includes("isArchived") ? { isArchived: input.archived } : {}),
                issue: {
                  ...DETAIL_FIXTURE.data.repository.issue,
                  viewerCanUpdate: true,
                  ...(query.includes("locked") ? { locked: input.locked } : {}),
                },
              },
            },
          });
        },
        () => {
          labelReads++;
          return {
            status: 200,
            headers: {},
            body: '{"labels":[]}',
            truncated: false,
            invalidUtf8: false,
          };
        },
      );
      const target = { cwd: "/w", host: "git.acme.test", scope: "acme/web", key: "42" };
      const permission = yield* api.getViewerPermissions(target);
      expect(permission).toEqual({
        edit: !input.archived,
        updateDependencies: input.metadata && input.role !== null,
        setState: !input.archived,
        comment: input.comment,
        labels: input.metadata,
        assignees: input.metadata,
      });
      expect(queries).toHaveLength(1);
      expect(labelReads).toBe(0);
      expect((yield* api.getIssue(target)).viewerPermissions).toEqual(permission);
      expect(queries).toHaveLength(2);
      expect(labelReads).toBe(1);
    }),
  );

  it.effect.each(["create", "update"] as const)(
    "enforces 10 assignees before %s native work",
    (operation) =>
      Effect.gen(function* () {
        const requests: GitHubRest.GitHubRestInput[] = [];
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
        expect(api.capabilities.maxAssignees).toBe(10);
        const target = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
        const assignees = Array.from({ length: 11 }, (_, index) => `user-${index}`);
        const refused =
          operation === "create"
            ? Effect.flip(
                api.create!({
                  ...target,
                  title: "New",
                  body: "",
                  labels: [],
                  assignees,
                  parentKey: "21",
                }),
              )
            : Effect.flip(api.update!({ ...target, assignees }));
        expect(yield* refused).toMatchObject({
          operation,
          reason: "failed",
          detail: "GitHub issues support at most 10 assignees.",
        });
        expect(requests).toHaveLength(0);
        expect(graphqlReads).toBe(0);
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
    { state: "all", states: ["OPEN", "CLOSED"] },
    { state: "open", states: ["OPEN"] },
    { state: "closed", states: ["CLOSED"] },
  ] as const)("uses native repository states for $state browsing", (input) =>
    Effect.gen(function* () {
      const api = yield* tracker((query, variables) => {
        expect(query).not.toContain("search(");
        expect(variables).toMatchObject({ states: input.states });
        return JSON.stringify({
          data: {
            repository: {
              issues: {
                nodes: [],
                pageInfo: {
                  endCursor: null,
                  hasNextPage: false,
                },
              },
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
          limit: 50,
        }),
      ).toEqual({ items: [], nextCursor: null });
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

  it.effect.each([
    { categories: ["canceled"] as const, keys: ["8"], states: ["CLOSED"] },
    { categories: ["completed"] as const, keys: ["9"], states: ["CLOSED"] },
    { categories: ["completed", "canceled"] as const, keys: ["8", "9"], states: ["CLOSED"] },
    {
      categories: ["unstarted", "completed"] as const,
      keys: ["7", "9"],
      states: ["OPEN", "CLOSED"],
    },
    {
      categories: ["unstarted", "canceled"] as const,
      keys: ["7", "8"],
      states: ["OPEN", "CLOSED"],
    },
  ])("filters repository workflow categories $categories after the native page", (input) =>
    Effect.gen(function* () {
      let reads = 0;
      const api = yield* tracker((query, variables) => {
        reads++;
        expect(query).not.toContain("search(");
        expect(variables).toMatchObject({ states: input.states });
        return JSON.stringify({
          data: {
            repository: {
              issues: {
                nodes: [
                  { ...DETAIL_FIXTURE.data.repository.issue, number: 7, state: "OPEN" },
                  { ...DETAIL_FIXTURE.data.repository.issue, number: 8 },
                  { ...DETAIL_FIXTURE.data.repository.issue, number: 9, stateReason: "COMPLETED" },
                ],
                pageInfo: { hasNextPage: true, endCursor: "raw-next" },
              },
            },
          },
        });
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        state: "all",
        stateCategories: input.categories,
        involvement: "all",
        viewer: "julius",
        limit: 50,
      });
      expect(page.items.map((item) => item.key)).toEqual(input.keys);
      expect(page.nextCursor).toBe("raw-next");
      expect(reads).toBe(1);
    }),
  );

  it.effect.each([
    { sort: "created", order: "asc", field: "CREATED_AT", direction: "ASC" },
    { sort: "created", order: "desc", field: "CREATED_AT", direction: "DESC" },
    { sort: "updated", order: "asc", field: "UPDATED_AT", direction: "ASC" },
    { sort: "updated", order: "desc", field: "UPDATED_AT", direction: "DESC" },
    { sort: "comments", order: "asc", field: "COMMENTS", direction: "ASC" },
    { sort: "comments", order: "desc", field: "COMMENTS", direction: "DESC" },
  ] as const)("uses native repository $sort $order ordering and raw continuation", (order) =>
    Effect.gen(function* () {
      let reads = 0;
      const api = yield* tracker((query, variables) => {
        reads++;
        expect(query).not.toContain("search(");
        expect(query).toContain("issues(first:$first");
        expect(variables).toEqual({
          owner: "acme",
          name: "web",
          states: ["OPEN", "CLOSED"],
          orderBy: { field: order.field, direction: order.direction },
          cursor: "raw-native",
          first: 100,
        });
        return JSON.stringify({
          data: {
            repository: {
              issues: {
                nodes: [DETAIL_FIXTURE.data.repository.issue],
                pageInfo: { hasNextPage: true, endCursor: "raw-next" },
              },
            },
          },
        });
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        state: "all",
        involvement: "all",
        viewer: "julius",
        limit: 200,
        cursor: "raw-native",
        sort: order.sort,
        order: order.order,
      });
      expect(page.items[0]?.key).toBe("42");
      expect(page.nextCursor).toBe("raw-next");
      expect(reads).toBe(1);
    }),
  );

  it.effect("keeps a filtered-empty repository page cursor without scanning", () =>
    Effect.gen(function* () {
      let reads = 0;
      const api = yield* tracker((query, variables) => {
        reads++;
        expect(query).not.toContain("search(");
        expect(variables).toMatchObject({ states: ["CLOSED"] });
        return JSON.stringify({
          data: {
            repository: {
              issues: {
                nodes: [{ ...DETAIL_FIXTURE.data.repository.issue, stateReason: "COMPLETED" }],
                pageInfo: { hasNextPage: true, endCursor: "raw-next" },
              },
            },
          },
        });
      });
      expect(
        yield* api.listIssues({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
          state: "all",
          stateCategories: ["canceled"],
          involvement: "all",
          viewer: "julius",
          limit: 50,
        }),
      ).toEqual({ items: [], nextCursor: "raw-next" });
      expect(reads).toBe(1);
    }),
  );

  it.effect(
    "marks a listed label subset and clears the flag after authoritative detail hydration",
    () =>
      Effect.gen(function* () {
        const labels = Array.from({ length: 121 }, (_, index) => ({
          name: `label-${index + 1}`,
          color: "abcdef",
        }));
        const native = {
          ...DETAIL_FIXTURE.data.repository.issue,
          labels: {
            nodes: labels.slice(0, 20),
            pageInfo: {
              endCursor: null,
              hasNextPage: true,
            },
          },
        };
        const queries: string[] = [];
        let restReads = 0;
        const api = yield* tracker(
          (query) => {
            queries.push(query);
            return JSON.stringify(
              query.includes("search(")
                ? {
                    data: {
                      search: {
                        nodes: [native],
                        pageInfo: {
                          endCursor: null,
                          hasNextPage: false,
                        },
                      },
                    },
                  }
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
        expect(detail.labels).toHaveLength(121);
        expect(detail.labels[120]?.name).toBe("label-121");
        expect(detail.labelsTruncated).toBe(false);
        expect(queries).toHaveLength(2);
        expect(
          queries.every(
            (query) =>
              query.includes("pageInfo{hasNextPage}") && query.includes("labels(first:20)"),
          ),
        ).toBe(true);
        expect(restReads).toBe(1);
      }),
  );

  it.effect.each([
    { name: "populated", milestone: { title: "Release 1" } },
    { name: "native-null", milestone: null },
    { name: "absent", milestone: undefined },
  ])("carries $name milestone through detail and the wire", ({ milestone }) =>
    Effect.gen(function* () {
      const queries: string[] = [];
      let restReads = 0;
      const api = yield* tracker(
        (query) => {
          queries.push(query);
          return JSON.stringify({
            data: {
              ...DETAIL_FIXTURE.data,
              repository: {
                ...DETAIL_FIXTURE.data.repository,
                issue: {
                  ...DETAIL_FIXTURE.data.repository.issue,
                  milestone: milestone ?? null,
                },
              },
            },
          });
        },
        () => {
          restReads++;
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ labels: [] }),
            truncated: false,
            invalidUtf8: false,
          };
        },
      );
      const context = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
      const issue = yield* api.getIssue(context);
      expect(issue).toHaveProperty("milestone", milestone?.title ?? null);
      expect(
        yield* decodeDetailWire({
          ...issue,
          ...context,
          tracker: "github",
          projectId: "p1",
          projectTitle: "Web",
          writable: true,
          capabilities: api.capabilities,
        }),
      ).toHaveProperty("milestone", milestone?.title ?? null);
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain("milestone{title}");
      expect(restReads).toBe(1);
    }),
  );

  it.effect.each([
    { role: null, allowed: true },
    { role: undefined, allowed: true },
    { role: "READ", allowed: false },
    { role: "TRIAGE", allowed: true },
    { role: "WRITE", allowed: true },
    { role: "MAINTAIN", allowed: true },
    { role: "ADMIN", allowed: true },
    { role: "UNRECOGNIZED", allowed: false },
  ])("keeps native metadata permission for role $role", ({ role, allowed }) =>
    Effect.gen(function* () {
      const context = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
      let reads = 0;
      const api = yield* tracker(() => {
        reads++;
        return JSON.stringify({
          data: {
            ...DETAIL_FIXTURE.data,
            repository: {
              ...DETAIL_FIXTURE.data.repository,
              viewerPermission: role ?? null,
            },
          },
        });
      });
      for (const permissions of [
        yield* api.getViewerPermissions(context),
        (yield* api.getIssue(context)).viewerPermissions,
      ]) {
        expect(permissions).toMatchObject({
          labels: allowed,
          assignees: allowed,
          edit: false,
          setState: false,
        });
      }
      expect(reads).toBe(2);
    }),
  );

  it.effect.each([true, false])(
    "keeps native comment edit permission %s without a viewer",
    (canEdit) =>
      Effect.gen(function* () {
        let reads = 0;
        const api = yield* tracker(
          (query) => {
            reads += 1;
            expect(query).toContain("viewerCanUpdate");
            return JSON.stringify({
              data: {
                viewer: { login: "julius" },
                repository: {
                  issue: {
                    comments: {
                      totalCount: 0,
                      pageInfo: {
                        hasPreviousPage: false,
                        hasNextPage: false,
                        startCursor: null,
                        endCursor: null,
                      },
                      nodes: [
                        {
                          ...DETAIL_FIXTURE.data.repository.issue.comments.nodes[0],
                          viewerCanUpdate: canEdit,
                        },
                      ],
                    },
                  },
                },
              },
            });
          },
          () => {
            throw new Error("Unexpected extra REST read");
          },
        );
        const page = yield* api.getComments({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
          key: "42",
        });
        expect(page.comments[0]?.canEdit).toBe(canEdit);
        expect(reads).toBe(1);
      }),
  );

  it.effect.each([
    { categories: ["canceled"] as const, keys: ["8"], reason: 'reason:"not planned"' },
    { categories: ["completed"] as const, keys: ["9"], reason: "reason:completed" },
    { categories: ["completed", "canceled"] as const, keys: ["8", "9"], reason: null },
    { categories: ["unstarted", "completed"] as const, keys: ["7", "9"], reason: null },
    { categories: ["unstarted", "canceled"] as const, keys: ["7", "8"], reason: null },
  ])("filters native workflow categories $categories and keeps the native cursor", (selection) =>
    Effect.gen(function* () {
      let searches = 0;
      const api = yield* tracker((_query, variables) => {
        searches += 1;
        const query = (variables as { q: string }).q;
        if (selection.reason === null) expect(query).not.toContain("reason:");
        else expect(query).toContain(selection.reason);
        if (selection.categories.some((category) => category === "unstarted")) {
          expect(query).not.toContain("is:open");
          expect(query).not.toContain("is:closed");
        } else expect(query).toContain("is:closed");
        return JSON.stringify({
          data: {
            search: {
              nodes: [
                { ...DETAIL_FIXTURE.data.repository.issue, number: 7, state: "OPEN" },
                { ...DETAIL_FIXTURE.data.repository.issue, number: 8 },
                { ...DETAIL_FIXTURE.data.repository.issue, number: 9, stateReason: "COMPLETED" },
              ],
              pageInfo: { hasNextPage: true, endCursor: "native-next" },
            },
          },
        });
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        state: "all",
        involvement: "all",
        viewer: "julius",
        stateCategories: selection.categories,
        query: "focus",
        limit: 3,
      });
      expect(page.items.map((item) => item.key)).toEqual(selection.keys);
      expect(page.nextCursor).toBe("native-next");
      expect(searches).toBe(1);
    }),
  );

  it.effect.each([true, false])(
    "keeps a created issue when attaching its parent succeeds %s",
    (linked) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker(
          () => "{}",
          (input) => {
            paths.push(input.path);
            const body = input.path.endsWith("sub_issues")
              ? linked
                ? "{}"
                : "invalid"
              : JSON.stringify({
                  id: input.method ? 1043 : 1021,
                  number: input.method ? 43 : 21,
                  title: "Issue",
                  html_url: `https://github.com/acme/web/issues/${input.method ? 43 : 21}`,
                  state: "open",
                });
            return { status: 200, headers: {}, body, truncated: false, invalidUtf8: false };
          },
        );
        expect(
          yield* api.create!({
            cwd: "/w",
            host: "github.com",
            scope: "acme/web",
            title: "Created",
            body: "",
            labels: [],
            assignees: [],
            parentKey: "21",
          }),
        ).toMatchObject({ key: "43", parentLinked: linked });
        expect(paths).toEqual([
          "repos/acme/web/issues/21",
          "repos/acme/web/issues",
          "repos/acme/web/issues/21/sub_issues",
        ]);
      }),
  );

  it.effect.each([true, false])(
    "edits a scoped comment only when its native permission is %s",
    (canEdit) =>
      Effect.gen(function* () {
        const queries: string[] = [];
        const api = yield* tracker((query) => {
          queries.push(query);
          if (query.includes("updateIssueComment"))
            return JSON.stringify({
              data: { updateIssueComment: { issueComment: { id: "IC_1" } } },
            });
          return JSON.stringify({
            data: {
              repository: { issue: { id: "I_42" } },
              node: {
                __typename: "IssueComment",
                viewerCanUpdate: canEdit,
                issue: { id: "I_42" },
              },
            },
          });
        });
        const result = yield* Effect.result(
          api.editComment!({
            cwd: "/w",
            host: "github.com",
            scope: "acme/web",
            key: "42",
            commentId: "IC_1",
            body: "Updated",
          }),
        );
        expect(Result.isSuccess(result)).toBe(canEdit);
        expect(queries.some((query) => query.includes("updateIssueComment"))).toBe(canEdit);
      }),
  );

  it.effect("reads cross-repository hierarchy pages and attaches and removes a parent", () =>
    Effect.gen(function* () {
      const writes: GitHubRest.GitHubRestInput[] = [];
      const raw = (number: number, scope = "acme/web") => ({
        id: number + 1000,
        number,
        title: `Issue ${number}`,
        html_url: `https://github.com/${scope}/issues/${number}`,
        state: "open",
      });
      const api = yield* tracker(
        () => "{}",
        (input) => {
          if (input.method) writes.push(input);
          const body = input.path.includes("sub_issues?")
            ? [raw(42, "acme/other")]
            : input.path.endsWith("/parent")
              ? raw(21, "acme/other")
              : input.path.endsWith("/21")
                ? raw(21)
                : raw(42);
          return {
            status: 200,
            headers: input.path.includes("sub_issues?")
              ? { link: '<https://github.com/next>; rel="next"' }
              : {},
            body: JSON.stringify(body),
            truncated: false,
            invalidUtf8: false,
          };
        },
      );
      const target = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
      const hierarchy = yield* api.getHierarchy!({ ...target, limit: 1 });
      expect(hierarchy.parent).toMatchObject({ scope: "acme/other", key: "21" });
      expect(hierarchy.children).toMatchObject({
        items: [{ scope: "acme/other", key: "42" }],
        nextCursor: "2",
      });
      yield* api.setParent!({ ...target, parentKey: "21" });
      yield* api.setParent!({ ...target, parentKey: null });
      expect(writes.map((input) => [input.path, input.method, input.body])).toEqual([
        [
          "repos/acme/web/issues/21/sub_issues",
          "POST",
          { sub_issue_id: 1042, replace_parent: true },
        ],
        ["repos/acme/other/issues/21/sub_issue", "DELETE", { sub_issue_id: 1042 }],
      ]);
    }),
  );

  it.effect("keeps native history continuation after comment rows and other event kinds", () =>
    Effect.gen(function* () {
      let reads = 0;
      const api = yield* tracker(
        (query, variables) => {
          expect(query).toContain("query IssueHistory");
          expect(variables).toMatchObject({ last: 3 });
          reads++;
          return JSON.stringify({
            data: {
              repository: {
                issue: {
                  timelineItems: {
                    pageInfo: {
                      hasPreviousPage: reads === 1,
                      hasNextPage: false,
                      startCursor: "older",
                      endCursor: "last",
                    },
                    nodes:
                      reads === 1
                        ? [
                            { __typename: "IssueComment" },
                            {
                              __typename: "MilestonedEvent",
                              id: "2",
                              createdAt: "2026-07-01T00:00:00Z",
                              actor: null,
                            },
                            { __typename: "FutureEvent" },
                          ]
                        : [
                            {
                              __typename: "ClosedEvent",
                              id: "1",
                              createdAt: "2026-06-01T00:00:00Z",
                              actor: null,
                            },
                          ],
                  },
                },
              },
            },
          });
        },
        () => {
          throw new Error("Unexpected REST history read");
        },
      );
      const input = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42", limit: 3 };
      const first = yield* api.getHistory!(input);
      expect(first).toMatchObject({
        items: [{ id: "2", kind: "updated", detail: "milestoned" }],
        nextCursor: expect.any(String),
      });
      const second = yield* api.getHistory!({ ...input, cursor: first.nextCursor! });
      expect(second).toMatchObject({ items: [{ id: "1", kind: "closed" }], nextCursor: null });
      expect(reads).toBe(2);
    }),
  );

  it.effect("pages closing and related pull requests separately", () =>
    Effect.gen(function* () {
      const api = yield* tracker((query, variables) => {
        expect(variables).toMatchObject({
          owner: "acme",
          name: "web",
          number: 42,
          first: 1,
          after: null,
        });
        const closing = query.includes("closedByPullRequestsReferences");
        const pr = {
          isDraft: false,

          __typename: "PullRequest",
          number: 50,
          title: "Fix",
          url: "https://github.com/acme/other/pull/50",
          state: "MERGED",
          repository: { nameWithOwner: "acme/other" },
        };
        return JSON.stringify({
          data: {
            repository: {
              issue: {
                [closing ? "closedByPullRequestsReferences" : "timelineItems"]: {
                  nodes: closing ? [pr] : [{ __typename: "CrossReferencedEvent", source: pr }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      });
      const target = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42", limit: 1 };
      const closing = yield* api.getLinkedPullRequests!(target);
      expect(closing).toMatchObject({
        items: [{ repository: "acme/other", closesIssue: true }],
        nextCursor: "related:",
      });
      expect(
        yield* api.getLinkedPullRequests!({ ...target, cursor: closing.nextCursor! }),
      ).toMatchObject({ items: [{ closesIssue: false }], nextCursor: null });
    }),
  );

  it.effect.each(["labels", "assignees"] as const)(
    "refuses success when GitHub omits the requested %s update",
    (field) =>
      Effect.gen(function* () {
        const requests: GitHubRest.GitHubRestInput[] = [];
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
      const api = yield* tracker(() =>
        JSON.stringify({
          data: {
            repository: {
              nameWithOwner: "acme/web",
              isPrivate: false,
              rootForms: null,
              docsForms: null,
              issueTemplates: [],
              forms: {
                __typename: "Tree",
                oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                entries: [
                  {
                    name: "config.yml",
                    object: {
                      __typename: "Blob",
                      text: config,
                    },
                  },
                ],
              },
            },
          },
        }),
      );
      expect(
        yield* api.listTemplates!({ cwd: "/w", host: "github.com", scope: "acme/web" }),
      ).toEqual({ templates: [], blankIssuesEnabled });
    }),
  );

  it.effect("enables blank issues when the template config is missing", () =>
    Effect.gen(function* () {
      const api = yield* tracker(() =>
        JSON.stringify({
          data: {
            repository: {
              nameWithOwner: "acme/web",
              isPrivate: false,
              forms: null,
              rootForms: null,
              docsForms: null,
              issueTemplates: [],
            },
          },
        }),
      );
      expect(
        yield* api.listTemplates!({ cwd: "/w", host: "github.com", scope: "acme/web" }),
      ).toEqual({ templates: [], blankIssuesEnabled: true });
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
              node: {
                __typename: "IssueComment",
                viewerCanUpdate: false,
                issue: { id: "I_foreign" },
              },
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
      const requests: GitHubRest.GitHubRestInput[] = [];
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
        commentsCursor: expect.any(String),
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
        ["closed", null],
        ["referenced", "acme/web#50"],
        ["labeled", "bug"],
      ]);
    }),
  );

  it.effect("refuses detail with a missing native comment boundary before the labels read", () =>
    Effect.gen(function* () {
      const api = yield* tracker(
        () =>
          JSON.stringify({
            data: {
              ...DETAIL_FIXTURE.data,
              repository: {
                ...DETAIL_FIXTURE.data.repository,
                issue: {
                  ...DETAIL_FIXTURE.data.repository.issue,
                  comments: {
                    ...DETAIL_FIXTURE.data.repository.issue.comments,
                    pageInfo: { hasPreviousPage: true, startCursor: null },
                  },
                },
              },
            },
          }),
        () => {
          throw new Error("Unexpected REST metadata read");
        },
      );
      expect(
        yield* api
          .getIssue({ cwd: "/w", host: "github.com", scope: "acme/web", key: "42" })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "failed" });
    }),
  );

  it.effect("starts detail at the true newest page and continues without gaps", () =>
    Effect.gen(function* () {
      const comment = (number: number) => ({
        ...DETAIL_FIXTURE.data.repository.issue.comments.nodes[0],
        id: String(number),
      });
      const events = Array.from({ length: 100 }, (_, index) => ({
        __typename: "ClosedEvent",
        id: String(106 + index),
        createdAt: "2026-07-03T00:00:00Z",
        actor: null,
      }));
      let reads = 0;
      const api = yield* tracker((query, variables) => {
        reads++;
        if (query.includes("query IssueDetail"))
          return JSON.stringify({
            data: {
              ...DETAIL_FIXTURE.data,
              repository: {
                ...DETAIL_FIXTURE.data.repository,
                issue: {
                  ...DETAIL_FIXTURE.data.repository.issue,
                  comments: {
                    totalCount: 205,
                    nodes: Array.from({ length: 100 }, (_, i) => comment(106 + i)),
                    pageInfo: { hasPreviousPage: true, startCursor: "native-105" },
                  },
                  timelineItems: { nodes: events, pageInfo: { hasPreviousPage: true } },
                },
              },
            },
          });
        const asc = variables.first === 100;
        const end = asc ? 100 : variables.before === "native-105" ? 105 : 5;
        const start = Math.max(0, end - 100);
        return JSON.stringify({
          data: {
            viewer: { login: "julius" },
            repository: {
              issue: {
                comments: {
                  nodes: Array.from({ length: end - start }, (_, i) => comment(start + i + 1)),
                  pageInfo: {
                    hasPreviousPage: start > 0,
                    hasNextPage: end < 205,
                    startCursor: `native-${start}`,
                    endCursor: `native-${end}`,
                  },
                },
              },
            },
          },
        });
      });
      const input = {
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        key: "42",
        connectionId: "selected",
      };
      const detail = yield* api.getIssue(input);
      expect(detail.events.map((event) => event.id)).toEqual(
        Array.from({ length: 100 }, (_, i) => String(205 - i)),
      );
      expect(detail.historyTruncated).toBe(true);
      const ids = detail.comments.map((row) => row.id);
      let cursor = detail.commentsCursor;
      while (cursor !== null) {
        const page = yield* api.getComments({ ...input, cursor });
        ids.push(...page.comments.map((row) => row.id));
        cursor = page.nextCursor;
      }
      expect(ids).toEqual(Array.from({ length: 205 }, (_, i) => String(205 - i)));
      const oldest = yield* api.getComments({ ...input, order: "asc" });
      expect(oldest.comments.map((row) => row.id)).toEqual(
        Array.from({ length: 100 }, (_, i) => String(i + 1)),
      );
      expect(reads).toBe(4);
    }),
  );

  it.effect.each(["Issue", "PullRequest"] as const)(
    "keeps the native %s reference and event URLs separate",
    (type) =>
      Effect.gen(function* () {
        const eventUrl = "https://github.com/acme/web/issues/42#ref-event-7";
        const sourceUrl = `https://github.com/acme/other/${type === "Issue" ? "issues" : "pull"}/7`;
        const event = {
          __typename: "CrossReferencedEvent",
          id: "ref-7",
          createdAt: "2026-07-02T01:00:00Z",
          actor: null,
          url: eventUrl,
          source: {
            __typename: type,
            number: 7,
            title: "Source title",
            url: sourceUrl,
            state: "OPEN",
            isDraft: false,
            repository: { nameWithOwner: "acme/other" },
          },
        };
        const api = yield* tracker(() =>
          JSON.stringify({
            data: {
              ...DETAIL_FIXTURE.data,
              repository: {
                ...DETAIL_FIXTURE.data.repository,
                issue: {
                  ...DETAIL_FIXTURE.data.repository.issue,
                  timelineItems: {
                    nodes: [event],
                    pageInfo: {
                      hasPreviousPage: false,
                      hasNextPage: false,
                      startCursor: null,
                      endCursor: null,
                    },
                  },
                },
              },
            },
          }),
        );
        const input = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
        const detail = yield* api.getIssue(input);
        const history = yield* api.getHistory!(input);
        const expected = {
          url: eventUrl,
          reference: {
            url: sourceUrl,
            title: "Source title",
            identifier: "acme/other#7",
          },
        };
        expect(detail.events[0]).toMatchObject(expected);
        expect(history.items[0]).toMatchObject(expected);
        const wire = yield* decodeDetailWire({
          ...detail,
          ...input,
          tracker: "github",
          projectId: "p1",
          projectTitle: "Web",
          writable: true,
          capabilities: api.capabilities,
        });
        expect(wire.events[0]).toMatchObject(expected);
      }),
  );

  it.effect.each([
    "javascript:alert(1)",
    "data:text/plain,unsafe",
    "/relative",
    "https://user:pass@github.com/path",
  ])("omits unsafe native reference URLs %s", (url) =>
    Effect.gen(function* () {
      const api = yield* tracker(() =>
        JSON.stringify({
          data: {
            repository: {
              issue: {
                timelineItems: {
                  nodes: [
                    {
                      __typename: "CrossReferencedEvent",
                      id: "ref-7",
                      createdAt: "2026-07-02T01:00:00Z",
                      actor: null,
                      url,
                      source: {
                        __typename: "Issue",
                        number: 7,
                        title: "Source",
                        url,
                        repository: { nameWithOwner: "acme/web" },
                      },
                    },
                  ],
                  pageInfo: {
                    hasPreviousPage: false,
                    hasNextPage: false,
                    startCursor: null,
                    endCursor: null,
                  },
                },
              },
            },
          },
        }),
      );
      const page = yield* api.getHistory!({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        key: "42",
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).not.toHaveProperty("url");
      expect(page.items[0]).not.toHaveProperty("reference");
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
                    pageInfo: {
                      startCursor: null,
                      hasPreviousPage,
                    },
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
        expect(queries[0]).toMatch(/timelineItems\(last:100[^)]*\)\{pageInfo\{hasPreviousPage\}/);
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
