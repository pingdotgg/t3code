import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubIssueTracker from "./GitHubIssueTracker.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function harness(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  let tokens = ["first", "second"];
  let invalidations = 0;
  let credentialReads = 0;
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.sync(() => {
          credentialReads++;
          return {
            host,
            token: Redacted.make(tokens[0]!),
            source: "gh" as const,
            fingerprint: `${host}:${tokens[0]}`,
          };
        }),
      invalidate: () =>
        Effect.sync(() => {
          invalidations++;
          tokens = tokens.slice(1);
        }),
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)));
    }),
  );
  const layer = GitHubRest.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(credentials, http)),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
  return {
    layer,
    requests,
    invalidations: () => invalidations,
    credentialReads: () => credentialReads,
  };
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

describe("GitHub issues over native HTTP", () => {
  it.effect.each([false, true])(
    "loads template metadata and bodies with inherited defaults=%s",
    (inherited) => {
      const bodySelections: boolean[] = [];
      const { layer, requests } = harness((request) => {
        const sent = JSON.parse(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
        );
        expect(sent.operationName).toBe("IssueTemplates");
        const { name, includeBody } = sent.variables;
        if (typeof includeBody !== "boolean") {
          return json({
            errors: [
              { message: "Variable $includeBody of type Boolean! was provided invalid value" },
            ],
          });
        }
        bodySelections.push(includeBody);
        const hasTemplate = !inherited || name === ".github";
        return json({
          data: {
            repository: {
              nameWithOwner: `acme/${name}`,
              isPrivate: false,
              forms: hasTemplate
                ? {
                    __typename: "Tree",
                    oid: "a".repeat(40),
                    entries: [
                      {
                        name: "bug.md",
                        object: {
                          __typename: "Blob",
                          text: "---\nname: Bug report\nabout: Report a bug\n---\nBody",
                        },
                      },
                    ],
                  }
                : null,
              rootForms: null,
              docsForms: null,
              issueTemplates: hasTemplate
                ? [
                    {
                      filename: "bug.md",
                      name: "Bug report",
                      about: null,
                      title: "Bug: ",
                      ...(includeBody ? { body: "Describe the bug" } : {}),
                      assignees: { nodes: [] },
                      labels: { nodes: [] },
                    },
                  ]
                : [],
            },
          },
        });
      });
      return Effect.gen(function* () {
        const driver = yield* GitHubIssueTracker.make;
        const input = { cwd: "/w", host: "github.com", scope: "acme/web" };
        const metadata = yield* driver.listTemplates!({ ...input, metadataOnly: true });
        expect(metadata.templates).toHaveLength(1);
        expect(metadata.templates[0]).toMatchObject({ body: "", contentDeferred: true });
        const templateKey = metadata.templates[0]!.key;
        for (const selection of [{}, { templateKey }]) {
          const result = yield* driver.listTemplates!({ ...input, ...selection });
          expect(result.templates).toMatchObject([{ key: templateKey, body: "Describe the bug" }]);
        }
        expect(bodySelections).toEqual(
          inherited ? [false, false, true, true, true, true] : [false, true, true],
        );
        expect(requests).toHaveLength(inherited ? 6 : 3);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([
    { operation: "comments", order: "desc" },
    { operation: "comments", order: "asc" },
    { operation: "history", order: "desc" },
    { operation: "history", order: "asc" },
  ] as const)(
    "pages true $order $operation across the native connection",
    ({ operation, order }) => {
      const total = 205;
      const { layer, requests } = harness((request) => {
        expect(request.url).toBe("https://api.github.com/graphql");
        const sent = JSON.parse(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
        );
        expect(sent.operationName).toBe(
          operation === "comments" ? "IssueComments" : "IssueHistory",
        );
        const variables = sent.variables;
        expect(variables).toMatchObject({ owner: "acme", name: "web", number: 42 });
        const asc = order === "asc";
        expect(variables[asc ? "last" : "first"] ?? null).toBeNull();
        expect(variables[asc ? "before" : "after"] ?? null).toBeNull();
        const size = variables[asc ? "first" : "last"];
        expect(size).toBe(operation === "comments" ? 100 : 50);
        const boundary = variables[asc ? "after" : "before"];
        const offset = boundary == null ? (asc ? 0 : total) : Number(boundary.slice(7));
        const start = asc ? offset : Math.max(0, offset - size);
        const end = asc ? Math.min(total, offset + size) : offset;
        const nodes = Array.from({ length: end - start }, (_, index) => {
          const number = start + index + 1;
          const common = {
            id: String(number),
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(NOW + number * 1000)),
          };
          return operation === "comments"
            ? {
                ...common,
                author: null,
                body: String(number),
                lastEditedAt: null,
                viewerCanUpdate: false,
                url: `https://github.com/acme/web/issues/42#issuecomment-${number}`,
                reactionGroups: [],
              }
            : { ...common, __typename: "ClosedEvent", actor: null };
        });
        return json({
          data: {
            ...(operation === "comments" ? { viewer: { login: "julius" } } : {}),
            repository: {
              issue: {
                [operation === "comments" ? "comments" : "timelineItems"]: {
                  nodes,
                  pageInfo: {
                    hasPreviousPage: start > 0,
                    hasNextPage: end < total,
                    startCursor: `native-${start}`,
                    endCursor: `native-${end}`,
                  },
                },
              },
            },
          },
        });
      });
      return Effect.gen(function* () {
        const driver = yield* GitHubIssueTracker.make;
        const input = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42", order };
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const target = { ...input, ...(cursor === undefined ? {} : { cursor }) };
          const page = yield* operation === "comments"
            ? driver.getComments(target)
            : driver.getHistory!({ ...target, limit: 50 });
          ids.push(...("comments" in page ? page.comments : page.items).map((row) => row.id));
          cursor = page.nextCursor ?? undefined;
          expect(requests.length).toBeLessThanOrEqual(5);
        } while (cursor !== undefined);
        const expected = Array.from({ length: total }, (_, index) => String(index + 1));
        expect(ids).toEqual(order === "asc" ? expected : expected.toReversed());
        expect(requests).toHaveLength(operation === "comments" ? 3 : 5);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each(["comments", "history"] as const)(
    "rejects foreign and malformed %s cursors before native HTTP",
    (operation) => {
      const { layer, requests } = harness(() =>
        json({
          data: {
            viewer: { login: "julius" },
            repository: {
              issue: {
                comments: {
                  nodes: [
                    {
                      id: "101",
                      author: null,
                      body: "Reply",
                      createdAt: "2026-07-01T00:00:00Z",
                      lastEditedAt: null,
                      viewerCanUpdate: false,
                      url: "https://github.com/acme/web/issues/42#issuecomment-101",
                      reactionGroups: [],
                    },
                  ],
                  pageInfo: {
                    hasPreviousPage: true,
                    hasNextPage: false,
                    startCursor: "native-100",
                    endCursor: "native-101",
                  },
                },
                timelineItems: {
                  nodes: [
                    {
                      __typename: "ClosedEvent",
                      id: "101",
                      actor: null,
                      createdAt: "2026-07-01T00:00:00Z",
                    },
                  ],
                  pageInfo: {
                    hasPreviousPage: true,
                    hasNextPage: false,
                    startCursor: "native-100",
                    endCursor: "native-101",
                  },
                },
              },
            },
          },
        }),
      );
      return Effect.gen(function* () {
        const driver = yield* GitHubIssueTracker.make;
        const input = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
        const read = (
          target: typeof input & { cursor?: string; order?: "asc" | "desc"; connectionId?: string },
        ) =>
          operation === "comments"
            ? driver
                .getComments(target)
                .pipe(Effect.map((page) => ({ nextCursor: page.nextCursor })))
            : driver.getHistory!(target).pipe(
                Effect.map((page) => ({ nextCursor: page.nextCursor })),
              );
        const page = yield* read(input);
        expect(page.nextCursor).toBeTypeOf("string");
        const cursor = page.nextCursor!;
        expect(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))).not.toHaveProperty(
          "viewer",
        );
        for (const changed of [
          { order: "asc" as const },
          { connectionId: "another" },
          { cwd: "/other" },
          { host: "enterprise.example" },
          { scope: "acme/other" },
          { key: "43" },
        ]) {
          expect(yield* read({ ...input, ...changed, cursor }).pipe(Effect.flip)).toMatchObject({
            reason: "failed",
          });
        }
        const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        const tampered = Buffer.from(JSON.stringify({ ...payload, window: "after" })).toString(
          "base64url",
        );
        for (const invalid of [
          "",
          "2",
          "native-100",
          "{}",
          "gh-issue:!",
          "x".repeat(8193),
          tampered,
          ...[
            { version: 2 },
            { provider: "gitlab" },
            { before: "extra" },
            { previous: payload.cursor },
            { cursor: " " },
            { cursor: "x".repeat(2049) },
          ].map((changed) =>
            Buffer.from(JSON.stringify({ ...payload, ...changed })).toString("base64url"),
          ),
        ]) {
          expect(yield* read({ ...input, cursor: invalid }).pipe(Effect.flip)).toMatchObject({
            reason: "failed",
          });
        }
        const other =
          operation === "comments"
            ? driver.getHistory!({ ...input, cursor }).pipe(Effect.asVoid)
            : driver.getComments({ ...input, cursor }).pipe(Effect.asVoid);
        expect(yield* other.pipe(Effect.flip)).toMatchObject({ reason: "failed" });
        expect(requests).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([
    { operation: "comments", invalid: "repeated" },
    { operation: "history", invalid: "repeated" },
    { operation: "comments", invalid: "missing" },
    { operation: "history", invalid: "missing" },
    { operation: "comments", invalid: "empty" },
    { operation: "history", invalid: "empty" },
  ] as const)("refuses $invalid native $operation continuation", ({ operation, invalid }) => {
    let reads = 0;
    const { layer, requests } = harness(() => {
      reads++;
      return json({
        data: {
          viewer: { login: "julius" },
          repository: {
            issue: {
              [operation === "comments" ? "comments" : "timelineItems"]: {
                nodes:
                  invalid === "empty" && reads > 1
                    ? []
                    : operation === "comments"
                      ? [
                          {
                            id: String(reads),
                            author: null,
                            body: "Reply",
                            createdAt: "2026-07-01T00:00:00Z",
                            lastEditedAt: null,
                            viewerCanUpdate: false,
                            url: "https://github.com/acme/web/issues/42#issuecomment-101",
                            reactionGroups: [],
                          },
                        ]
                      : [
                          {
                            __typename: "ClosedEvent",
                            id: String(reads),
                            createdAt: "2026-07-01T00:00:00Z",
                            actor: null,
                          },
                        ],
                pageInfo: {
                  hasPreviousPage: true,
                  hasNextPage: false,
                  startCursor: invalid === "missing" && reads > 1 ? null : "same",
                  endCursor: "end",
                },
              },
            },
          },
        },
      });
    });
    return Effect.gen(function* () {
      const driver = yield* GitHubIssueTracker.make;
      const input = {
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        key: "42",
        connectionId: "selected",
      };
      const read = (cursor?: string) =>
        operation === "comments"
          ? driver
              .getComments({ ...input, ...(cursor === undefined ? {} : { cursor }) })
              .pipe(Effect.map((page) => page.nextCursor))
          : driver.getHistory!({ ...input, ...(cursor === undefined ? {} : { cursor }) }).pipe(
              Effect.map((page) => page.nextCursor),
            );
      const cursor = yield* read();
      const reset = {
        cwd: input.cwd,
        host: input.host,
        scope: input.scope,
        key: input.key,
        cursor: cursor!,
      };
      const foreign =
        operation === "comments"
          ? driver.getComments(reset).pipe(Effect.asVoid)
          : driver.getHistory!(reset).pipe(Effect.asVoid);
      expect(yield* foreign.pipe(Effect.flip)).toMatchObject({ reason: "failed" });
      expect(requests).toHaveLength(1);
      expect(yield* read(cursor!).pipe(Effect.flip)).toMatchObject({ reason: "failed" });
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.url.endsWith("/graphql"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["comments", "history"] as const)(
    "keeps native %s rate-limit delay and pause",
    (operation) => {
      const { layer, requests } = harness(() =>
        json(
          { message: "slow down" },
          {
            status: 429,
            headers: { "retry-after": "60" },
          },
        ),
      );
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const driver = yield* GitHubIssueTracker.make;
        const input = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
        const read =
          operation === "comments"
            ? driver.getComments(input).pipe(Effect.asVoid)
            : driver.getHistory!(input).pipe(Effect.asVoid);
        expect(yield* read.pipe(Effect.flip)).toMatchObject({
          reason: "rate-limited",
          retryAt: NOW + 60_000,
        });
        expect(yield* read.pipe(Effect.flip)).toMatchObject({
          reason: "rate-limited",
          retryAt: NOW + 60_000,
        });
        expect(requests).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([0, -1, 101, 1.5, Number.NaN])(
    "rejects out-of-range history limit %s before HTTP",
    (limit) => {
      const { layer, requests } = harness(() => {
        throw new Error("Unexpected HTTP");
      });
      return Effect.gen(function* () {
        const driver = yield* GitHubIssueTracker.make;
        expect(
          yield* driver.getHistory!({
            cwd: "/w",
            host: "github.com",
            scope: "acme/web",
            key: "42",
            limit,
          }).pipe(Effect.flip),
        ).toMatchObject({ reason: "failed" });
        expect(requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("allows retrying a history page but refuses a native cursor cycle", () => {
    const { layer, requests } = harness((request) => {
      const sent = JSON.parse(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
      );
      const before = sent.variables.before;
      return json({
        data: {
          repository: {
            issue: {
              timelineItems: {
                nodes: [
                  {
                    __typename: "ClosedEvent",
                    id: before ?? "3",
                    createdAt: "2026-07-01T00:00:00Z",
                    actor: null,
                  },
                ],
                pageInfo: {
                  hasPreviousPage: true,
                  hasNextPage: before !== undefined,
                  startCursor: before === "one" ? "two" : "one",
                  endCursor: "end",
                },
              },
            },
          },
        },
      });
    });
    return Effect.gen(function* () {
      const driver = yield* GitHubIssueTracker.make;
      const input = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
      const first = yield* driver.getHistory!(input);
      const second = yield* driver.getHistory!({ ...input, cursor: first.nextCursor! });
      const retry = yield* driver.getHistory!({ ...input, cursor: first.nextCursor! });
      expect(retry).toEqual(second);
      expect(
        yield* driver.getHistory!({ ...input, cursor: second.nextCursor! }).pipe(Effect.flip),
      ).toMatchObject({ reason: "failed" });
      expect(requests).toHaveLength(4);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refreshes a refused GraphQL credential once per native request", () => {
    const { layer, requests, credentialReads, invalidations } = harness((request) =>
      request.headers.authorization === "Bearer first"
        ? new Response(null, { status: 401 })
        : json({ data: { viewer: { login: "julius" } } }),
    );
    return Effect.gen(function* () {
      const driver = yield* GitHubIssueTracker.make;
      const input = { cwd: "/w", host: "github.com", scope: "acme/web" };
      expect(yield* driver.getViewer(input).pipe(Effect.flip)).toMatchObject({
        reason: "unauthenticated",
      });
      expect(credentialReads()).toBe(1);
      expect(invalidations()).toBe(1);
      expect(yield* driver.getViewer(input)).toBe("julius");
      expect(credentialReads()).toBe(2);
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        "Bearer first",
        "Bearer second",
      ]);
      const body = requests[1]!.body;
      const sent = JSON.parse(
        body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "{}",
      );
      expect(sent).toMatchObject({ operationName: "IssueViewer", variables: {} });
      expect(sent.query).toContain("query IssueViewer");
      expect(sent.query).not.toContain("rateLimit");
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([false, true])(
    "keeps future enums and skips malformed rows in search=%s",
    (search) => {
      const { layer, requests } = harness(() => {
        const page = {
          pageInfo: { hasNextPage: true, endCursor: "native-next" },
          nodes: [
            null,
            { number: 7, title: 123 },
            {
              closedAt: null,
              author: null,
              assignees: { nodes: [] },
              labels: null,
              milestone: null,
              comments: { totalCount: 0 },

              number: 42,
              title: "Future reason",
              url: "https://github.com/acme/web/issues/42",
              state: "CLOSED",
              stateReason: "FUTURE_REASON",
              createdAt: "2026-10-05T12:00:00.000Z",
              updatedAt: "2026-10-05T12:00:00.000Z",
            },
          ],
        };
        return json({ data: search ? { search: page } : { repository: { issues: page } } });
      });
      return Effect.gen(function* () {
        const driver = yield* GitHubIssueTracker.make;
        const result = yield* driver.listIssues({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
          state: "all",
          involvement: "all",
          viewer: "julius",
          limit: 50,
          ...(search ? { query: "Future" } : {}),
        });
        expect(result.nextCursor).toBe("native-next");
        expect(result.items).toMatchObject([
          { key: "42", state: { category: "closed", workflowCategory: "completed" } },
        ]);
        expect(result.items[0]?.state).not.toHaveProperty("closeReason");
        expect(requests).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([
    { issue: null, reason: "not-found" },
    { issue: { number: "invalid" }, reason: "failed" },
  ] as const)("keeps a native $reason issue result typed without reading REST labels", (test) => {
    const { layer, requests } = harness(() =>
      json({
        data: {
          viewer: { login: "julius" },
          repository: { viewerPermission: "READ", isArchived: false, issue: test.issue },
        },
      }),
    );
    return Effect.gen(function* () {
      const driver = yield* GitHubIssueTracker.make;
      expect(
        yield* driver
          .getIssue({ cwd: "/w", host: "github.com", scope: "acme/web", key: "42" })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: test.reason });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://api.github.com/graphql");
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    "local",
    "config-only",
    "default",
    "invalid-local",
    "missing",
    "private",
    "forbidden",
    "malformed",
  ] as const)("reads the native %s chooser with a bounded effective source", (kind) => {
    const { layer, requests } = harness((request) => {
      expect(request.url).toBe("https://api.github.com/graphql");
      const body = JSON.parse(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
      );
      expect(body.variables.owner).toBe("acme");
      const defaults = body.variables.name === ".github";
      if (defaults && kind === "missing") return json({ message: "Not found" }, { status: 404 });
      if (defaults && kind === "forbidden") return json({ message: "Forbidden" }, { status: 403 });
      if (defaults && kind === "malformed")
        return new Response("{", { headers: { "content-type": "application/json" } });
      return json({
        data: {
          repository: {
            rootForms: null,
            docsForms: null,
            nameWithOwner: defaults ? "acme/.github" : "acme/web",
            isPrivate: defaults && kind === "private",
            issueTemplates: [],
            forms: {
              __typename: "Tree",
              oid: "a".repeat(40),
              entries: defaults
                ? [
                    {
                      name: "default.yml",
                      object: {
                        __typename: "Blob",
                        text: "name: Default\ndescription: Report an issue\nbody:\n- type: textarea\n  attributes:\n    label: Details\n",
                      },
                    },
                    {
                      name: "config.yml",
                      object: {
                        __typename: "Blob",
                        text: "blank_issues_enabled: false",
                      },
                    },
                  ]
                : kind === "local"
                  ? [
                      {
                        name: "local.yml",
                        object: {
                          __typename: "Blob",
                          text: "name: Local\ndescription: Report an issue\nbody:\n- type: textarea\n  attributes:\n    label: Details\n",
                        },
                      },
                    ]
                  : kind === "config-only"
                    ? [
                        {
                          name: "config.yml",
                          object: {
                            __typename: "Blob",
                            text: "blank_issues_enabled: false",
                          },
                        },
                      ]
                    : kind === "invalid-local"
                      ? [
                          {
                            name: "local.yml",
                            object: {
                              __typename: "Blob",
                              text: "name: [",
                            },
                          },
                        ]
                      : [],
            },
          },
        },
      });
    });
    return Effect.gen(function* () {
      const driver = yield* GitHubIssueTracker.make;
      const result = yield* driver.listTemplates!({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
      });
      const inherited = kind === "default" || kind === "invalid-local";
      expect(result.blankIssuesEnabled).toBe(!inherited && kind !== "config-only");
      expect(result.templates.map((template) => template.name)).toEqual(
        kind === "local" ? ["Local"] : inherited ? ["Default"] : [],
      );
      expect(requests).toHaveLength(kind === "local" || kind === "config-only" ? 1 : 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    ["missing-description", "name: Local\nbody:\n- type: textarea\n  attributes: {label: Details}"],
    [
      "blank-description",
      "name: Local\ndescription: '   '\nbody:\n- type: textarea\n  attributes: {label: Details}",
    ],
    [
      "blank-name",
      "name: ' '\ndescription: Report a bug\nbody:\n- type: textarea\n  attributes: {label: Details}",
    ],
    ["empty-body", "name: Local\ndescription: Report a bug\nbody: []"],
    [
      "duplicate-ids",
      "name: Local\ndescription: Report a bug\nbody:\n- type: textarea\n  id: details\n  attributes: {label: Details}\n- type: input\n  id: details\n  attributes: {label: Other}",
    ],
    [
      "upload-duplicate-ids",
      "name: Local\ndescription: Report a bug\nbody:\n- type: upload\n  id: details\n  attributes: {label: Screenshot}\n- type: input\n  id: details\n  attributes: {label: Other}",
    ],
    [
      "invalid-field",
      "name: Local\ndescription: Report a bug\nbody:\n- type: nonexistent\n  attributes: {label: Details}",
    ],
    [
      "missing-label",
      "name: Local\ndescription: Report a bug\nbody:\n- type: textarea\n  attributes: {}",
    ],
    [
      "markdown-only",
      "name: Local\ndescription: Report a bug\nbody:\n- type: markdown\n  attributes: {value: Hello}",
    ],
    [
      "empty-options",
      "name: Local\ndescription: Report a bug\nbody:\n- type: dropdown\n  attributes: {label: Details, options: []}",
    ],
    [
      "upload-missing-description",
      "name: Local\nbody:\n- type: upload\n  attributes: {label: Screenshot}",
    ],
    [
      "upload-missing-label",
      "name: Local\ndescription: Report a bug\nbody:\n- type: upload\n  attributes: {}",
    ],
    [
      "upload-blank-label",
      "name: Local\ndescription: Report a bug\nbody:\n- type: upload\n  attributes: {label: ' '}",
    ],
    ["invalid-config", "blank_issues_enabled: [false]"],
  ])("invalid local %s does not suppress native public account defaults", ([kind, text]) => {
    const { layer, requests } = harness((request) => {
      const body = JSON.parse(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
      );
      const defaults = body.variables.name === ".github";
      return json({
        data: {
          repository: {
            rootForms: null,
            docsForms: null,
            nameWithOwner: defaults ? "acme/.github" : "acme/web",
            isPrivate: false,
            issueTemplates: [],
            forms: {
              __typename: "Tree",
              oid: "a".repeat(40),
              entries: defaults
                ? [
                    {
                      name: "default.yml",
                      object: {
                        __typename: "Blob",
                        text: "name: Default\ndescription: Report an issue\nbody:\n- type: textarea\n  attributes: {label: Details}",
                      },
                    },
                    {
                      name: "config.yml",
                      object: {
                        __typename: "Blob",
                        text: "blank_issues_enabled: false",
                      },
                    },
                  ]
                : [
                    {
                      name: kind === "invalid-config" ? "config.yml" : "local.yml",
                      object: {
                        __typename: "Blob",
                        text,
                      },
                    },
                  ],
            },
          },
        },
      });
    });
    return Effect.gen(function* () {
      const driver = yield* GitHubIssueTracker.make;
      const result = yield* driver.listTemplates!({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        metadataOnly: true,
      });
      expect(result).toMatchObject({
        blankIssuesEnabled: false,
        templates: [{ name: "Default", about: "Report an issue" }],
      });
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["missing", "rate-limited"] as const)(
    "invalid local forms retain %s default-source behavior",
    (kind) => {
      const { layer, requests } = harness((request) => {
        const body = JSON.parse(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
        );
        if (body.variables.name === ".github")
          return json(
            { message: "Default source unavailable" },
            { status: kind === "missing" ? 404 : 429 },
          );
        return json({
          data: {
            repository: {
              rootForms: null,
              docsForms: null,
              nameWithOwner: "acme/web",
              isPrivate: false,
              issueTemplates: [],
              forms: {
                __typename: "Tree",
                oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                entries: [
                  {
                    name: "invalid.yml",
                    object: {
                      __typename: "Blob",
                      text: "name: Invalid\nbody:\n- type: textarea\n  attributes: {label: Details}",
                    },
                  },
                ],
              },
            },
          },
        });
      });
      return Effect.gen(function* () {
        const driver = yield* GitHubIssueTracker.make;
        const read = driver.listTemplates!({ cwd: "/w", host: "github.com", scope: "acme/web" });
        if (kind === "missing")
          expect(yield* read).toEqual({ templates: [], blankIssuesEnabled: true });
        else expect(yield* read.pipe(Effect.flip)).toMatchObject({ reason: "rate-limited" });
        expect(requests).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each(["local", "mixed", "inherited"] as const)(
    "keeps valid %s upload forms in the native chooser",
    (kind) => {
      const { layer, requests } = harness((request) => {
        const body = JSON.parse(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
        );
        const defaults = body.variables.name === ".github";
        return json({
          data: {
            repository: {
              rootForms: null,
              docsForms: null,
              nameWithOwner: defaults ? "acme/.github" : "acme/web",
              isPrivate: false,
              issueTemplates: [],
              forms:
                kind !== "inherited" || defaults
                  ? {
                      __typename: "Tree",
                      oid: "a".repeat(40),
                      entries: [
                        {
                          name: "upload.yml",
                          object: {
                            __typename: "Blob",
                            text: `name: Upload report\ndescription: Add a file\nbody:\n- type: upload\n  attributes: {label: Screenshot}${kind === "mixed" ? "\n- type: textarea\n  attributes: {label: Details}" : ""}`,
                          },
                        },
                        ...(defaults
                          ? [
                              {
                                name: "config.yml",
                                object: {
                                  __typename: "Blob",
                                  text: "blank_issues_enabled: false",
                                },
                              },
                            ]
                          : []),
                      ],
                    }
                  : null,
            },
          },
        });
      });
      return Effect.gen(function* () {
        const driver = yield* GitHubIssueTracker.make;
        expect(
          yield* driver.listTemplates!({ cwd: "/w", host: "github.com", scope: "acme/web" }),
        ).toEqual({
          templates: [],
          blankIssuesEnabled: kind !== "inherited",
          externalTemplates: [
            {
              name: "Upload report",
              about: "Add a file",
              url: "https://github.com/acme/web/issues/new?template=upload.yml",
            },
          ],
        });
        expect(requests).toHaveLength(kind === "inherited" ? 2 : 1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("shares the REST quota reserve between dependency reads and native writes", () => {
    const { layer, requests } = harness((request) => {
      if (request.url.endsWith("/graphql"))
        return json({
          data: {
            repository: {
              viewerPermission: "TRIAGE",
              isArchived: false,
              issue: {
                locked: false,
                viewerCanUpdate: false,
              },
            },
          },
        });
      const headers = {
        "x-ratelimit-resource": "core",
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "5",
        "x-ratelimit-reset": String((NOW + 60_000) / 1000),
      };
      if (request.url.includes("?per_page=")) return json([], { headers });
      const source = request.url.endsWith("/issues/42");
      return json(
        {
          id: source ? 1042 : 9021,
          number: source ? 42 : 21,
          title: "Issue",
          state: "open",
          html_url: source
            ? "https://github.com/acme/web/issues/42"
            : "https://github.com/other/repo/issues/21",
        },
        { headers },
      );
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const driver = yield* GitHubIssueTracker.make;
      const input = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
      yield* driver.getDependencies!({ ...input, direction: "blocks" });
      expect(
        yield* driver.getDependencies!({ ...input, direction: "blocks" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "rate-limited" });
      expect(requests).toHaveLength(1);
      yield* driver.setDependency!({
        ...input,
        direction: "blocked-by",
        targetScope: "other/repo",
        targetKey: "21",
        linked: true,
      });
      expect(requests).toHaveLength(5);
      expect(requests[4]!.method).toBe("POST");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "uses both native dependency directions and stable IDs for inverse cross-repository writes",
    () => {
      const source = {
        id: 1042,
        number: 42,
        title: "Source",
        state: "open",
        html_url: "https://git.acme.test/acme/web/issues/42",
      };
      const target = {
        id: 9021,
        number: 21,
        title: "Target",
        state: "closed",
        state_reason: "not_planned",
        html_url: "https://git.acme.test/other/repo/issues/21",
      };
      const { layer, requests } = harness((request) => {
        expect(request.headers.authorization).toBe("Bearer selected-B");
        expect(request.headers["x-github-api-version"]).toBe("2022-11-28");
        if (request.url.endsWith("/api/graphql"))
          return json({
            data: {
              repository: {
                viewerPermission: "TRIAGE",
                isArchived: false,
                issue: { viewerCanUpdate: false, locked: false },
              },
            },
          });
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/dependencies/blocked_by"))
          return json([target], {
            headers: {
              link: '<https://git.acme.test/api/v3/repositories/12345/issues/42/dependencies/blocked_by?page=2&per_page=1>; rel="next"',
            },
          });
        if (request.method === "GET" && url.pathname.endsWith("/dependencies/blocking"))
          return json([target]);
        if (request.method === "GET")
          return json(url.pathname.endsWith("/issues/42") ? source : target);
        const body =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined;
        const inverse = url.pathname.includes("/other/repo/");
        const id = inverse ? source.id : target.id;
        if (request.method === "POST") {
          expect(body).toEqual({ issue_id: id });
          expect(url.pathname).toBe(
            `/api/v3/repos/${inverse ? "other/repo/issues/21" : "acme/web/issues/42"}/dependencies/blocked_by`,
          );
        } else {
          expect(request.method).toBe("DELETE");
          expect(url.pathname).toBe(
            `/api/v3/repos/${inverse ? "other/repo/issues/21" : "acme/web/issues/42"}/dependencies/blocked_by/${id}`,
          );
        }
        return json(target);
      });
      return Effect.gen(function* () {
        const driver = yield* GitHubIssueTracker.make;
        const input = { cwd: "/w", host: "git.acme.test", scope: "acme/web", key: "42" };
        const blocked = yield* driver.getDependencies!({
          ...input,
          direction: "blocked-by",
          limit: 1,
        });
        expect(blocked).toMatchObject({
          items: [
            {
              kind: "issue",
              scope: "other/repo",
              key: "21",
              state: { workflowCategory: "canceled" },
            },
          ],
          nextCursor: "2",
        });
        expect(requests).toHaveLength(1);
        const blocking = yield* driver.getDependencies!({
          ...input,
          direction: "blocks",
          cursor: "2",
          limit: 200,
        });
        expect(blocking.nextCursor).toBe(null);
        expect(requests[1]!.url).toBe(
          "https://git.acme.test/api/v3/repos/acme/web/issues/42/dependencies/blocking?per_page=100&page=2",
        );
        let count = 2;
        for (const direction of ["blocked-by", "blocks"] as const) {
          for (const linked of [true, false]) {
            yield* driver.setDependency!({
              ...input,
              direction,
              targetScope: "other/repo",
              targetKey: linked ? "https://git.acme.test/other/repo/issues/21" : "other/repo#21",
              linked,
            });
            count += direction === "blocks" ? 5 : 4;
            expect(requests).toHaveLength(count);
          }
        }
      }).pipe(
        Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
          host: "git.acme.test",
          token: Redacted.make("selected-B"),
          credentialFingerprint: "selected-B",
        }),
        Effect.provide(layer),
      );
    },
  );

  it.effect.each([403, 404, 410, 429])(
    "keeps native dependency HTTP %i as a typed refusal",
    (status) => {
      const { layer, requests } = harness(() =>
        json({ message: "Native endpoint refused" }, { status }),
      );
      return Effect.gen(function* () {
        const driver = yield* GitHubIssueTracker.make;
        expect(
          yield* driver.getDependencies!({
            cwd: "/w",
            host: "git.acme.test",
            scope: "acme/web",
            key: "42",
            direction: "blocks",
          }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "IssueTrackerError",
          operation: "getDependencies",
          reason: status === 429 ? "rate-limited" : status === 404 ? "not-found" : "failed",
        });
        expect(requests).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "uses the pinned native host and credential for the public account issue chooser",
    () => {
      const { layer, requests, credentialReads } = harness((request) => {
        expect(request.url).toBe("https://git.acme.test/api/graphql");
        expect(request.headers.authorization).toBe("Bearer selected-B");
        expect(request.headers["x-github-api-version"]).toBe("2022-11-28");
        const body = JSON.parse(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
        );
        const defaults = body.variables.name === ".github";
        expect(body.variables.owner).toBe("acme");
        return json({
          data: {
            repository: {
              rootForms: null,
              docsForms: null,
              isPrivate: false,
              nameWithOwner: defaults ? "acme/.github" : "acme/web",
              issueTemplates: [],
              forms: defaults
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
                          text: "blank_issues_enabled: false\ncontact_links: [{name: Support, about: Ask, url: 'https://example.com'}]",
                        },
                      },
                    ],
                  }
                : null,
            },
          },
        });
      });
      return Effect.gen(function* () {
        const driver = yield* GitHubIssueTracker.make;
        const result = yield* driver.listTemplates!({
          cwd: "/w",
          host: "git.acme.test",
          scope: "acme/web",
        });
        expect(result).toMatchObject({
          blankIssuesEnabled: false,
          templates: [{ name: "Bug" }],
          contactLinks: [{ name: "Support" }],
        });
        expect(requests).toHaveLength(2);
        expect(credentialReads()).toBe(0);
      }).pipe(
        Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
          host: "git.acme.test",
          token: Redacted.make("selected-B"),
          credentialFingerprint: "selected-B",
        }),
        Effect.provide(layer),
      );
    },
  );

  it.effect("propagates native default-template rate limits and shares the host pause", () => {
    const { layer, requests } = harness((request) => {
      const body = JSON.parse(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
      );
      return body.variables.name === ".github"
        ? json(
            { message: "API rate limit exceeded" },
            { status: 429, headers: { "retry-after": "60" } },
          )
        : json({
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
    });
    return Effect.gen(function* () {
      const driver = yield* GitHubIssueTracker.make;
      const input = { cwd: "/w", host: "github.com", scope: "acme/web" };
      expect(yield* driver.listTemplates!(input).pipe(Effect.flip)).toMatchObject({
        reason: "rate-limited",
      });
      expect(requests).toHaveLength(2);
      expect(yield* driver.listTemplates!(input).pipe(Effect.flip)).toMatchObject({
        reason: "rate-limited",
      });
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("pages all 1050 ordinary issues through the native repository connection", () => {
    const { layer, requests, credentialReads } = harness((request) => {
      expect(request.url).toBe("https://git.acme.test/api/graphql");
      expect(request.headers.authorization).toBe("Bearer first");
      const sent = request.body;
      const body = JSON.parse(
        sent._tag === "Uint8Array" ? new TextDecoder().decode(sent.body) : "{}",
      );
      const search = body.query.includes("search(");
      const start =
        body.variables.cursor === undefined ? 0 : Number(body.variables.cursor.slice(7));
      const total = search ? 1000 : 1050;
      const nodes = Array.from({ length: Math.min(50, total - start) }, (_, index) => ({
        stateReason: null,
        closedAt: null,
        author: null,
        assignees: { nodes: [] },
        labels: null,
        milestone: null,
        comments: { totalCount: 0 },

        number: start + index + 1,
        title: "Issue",
        url: `https://git.acme.test/acme/web/issues/${start + index + 1}`,
        state: "OPEN",
        createdAt: "2026-10-05T12:00:00.000Z",
        updatedAt: "2026-10-05T12:00:00.000Z",
      }));
      const page = {
        nodes,
        pageInfo: { hasNextPage: start + 50 < total, endCursor: `native-${start + 50}` },
      };
      return json({ data: search ? { search: page } : { repository: { issues: page } } });
    });
    return Effect.gen(function* () {
      const driver = yield* GitHubIssueTracker.make;
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = yield* driver.listIssues({
          cwd: "/w",
          host: "git.acme.test",
          scope: "acme/web",
          state: "all",
          involvement: "all",
          viewer: "julius",
          limit: 50,
          ...(cursor === undefined ? {} : { cursor }),
        });
        keys.push(...page.items.map((item) => item.key));
        cursor = page.nextCursor ?? undefined;
        if (cursor !== undefined) expect(cursor).toBe(`native-${keys.length}`);
      } while (cursor !== undefined);
      expect(keys).toEqual(Array.from({ length: 1050 }, (_, index) => String(index + 1)));
      expect(requests).toHaveLength(21);
      expect(credentialReads()).toBe(21);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    { role: "READ", archived: false, locked: true, status: 403, comment: false },
    { role: "TRIAGE", archived: false, locked: true, status: 403, comment: false },
    { role: "WRITE", archived: false, locked: true, status: 200, comment: true },
    { role: "ADMIN", archived: true, locked: false, status: 403, comment: false },
  ])("R9 keeps native lock/archive permission and write refusal for $role/$archived", (input) => {
    const { layer, requests, credentialReads } = harness((request) => {
      if (request.url.endsWith("/graphql")) {
        const body = request.body;
        const query =
          body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(body.body)).query : "";
        return json({
          data: {
            repository: {
              isArchived: false,
              viewerPermission: input.role ?? null,
              ...(query.includes("isArchived") ? { isArchived: input.archived } : {}),
              issue: {
                locked: false,
                viewerCanUpdate: true,
                ...(query.includes("locked") ? { locked: input.locked } : {}),
              },
            },
          },
        });
      }
      return json(input.status === 200 ? { id: 1 } : { message: "Conversation is read-only" }, {
        status: input.status,
      });
    });
    return Effect.gen(function* () {
      const driver = yield* GitHubIssueTracker.make;
      const target = { cwd: "/w", host: "git.acme.test", scope: "acme/web", key: "42" };
      const permission = yield* driver.getViewerPermissions(target);
      expect(permission.comment).toBe(input.comment);
      if (input.archived)
        expect(permission).toEqual({
          edit: false,
          setState: false,
          comment: false,
          labels: false,
          assignees: false,
          updateDependencies: false,
        });
      expect(requests).toHaveLength(1);
      const write = driver.comment!({ ...target, body: "Reply" });
      if (input.status === 200) yield* write;
      else
        expect(yield* Effect.flip(write)).toMatchObject({ operation: "comment", reason: "failed" });
      expect(requests).toHaveLength(2);
      expect(credentialReads()).toBe(2);
      expect(requests[1]).toMatchObject({
        method: "POST",
        url: "https://git.acme.test/api/v3/repos/acme/web/issues/42/comments",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    { role: null, status: 200 },
    { role: undefined, status: 200 },
    { role: null, status: 403 },
    { role: undefined, status: 403 },
  ])("defers App metadata writes with role $role to native status $status", ({ role, status }) => {
    const { layer, requests, credentialReads } = harness((request) =>
      request.url.endsWith("/graphql")
        ? json({
            data: {
              repository: {
                isArchived: false,
                viewerPermission: role ?? null,
                issue: {
                  locked: false,
                  viewerCanUpdate: true,
                },
              },
            },
          })
        : json(
            status === 200
              ? { labels: [{ name: "bug" }], assignees: [{ login: "theo" }] }
              : { message: "Resource not accessible by integration" },
            { status },
          ),
    );
    return Effect.gen(function* () {
      const driver = yield* GitHubIssueTracker.make;
      const target = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
      expect(yield* driver.getViewerPermissions!(target)).toMatchObject({
        labels: true,
        assignees: true,
      });
      const update = driver.update!({ ...target, labels: ["bug"], assignees: ["theo"] });
      if (status === 200) yield* update;
      else
        expect(yield* Effect.flip(update)).toMatchObject({
          reason: "failed",
          detail: "GitHub returned an error: Resource not accessible by integration",
        });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({
        method: "PATCH",
        url: "https://api.github.com/repos/acme/web/issues/42",
      });
      const body = requests[1]!.body;
      expect(
        body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(body.body)) : null,
      ).toEqual({ labels: ["bug"], assignees: ["theo"] });
      expect(credentialReads()).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    "update",
    "setState",
    "comment",
    "editComment",
    "setReaction",
    "create",
    "setParent",
  ] as const)(
    "keeps permission preflight and %s interactive while background reads pause",
    (operation) => {
      const reset = Math.floor(NOW / 1000) + 600;
      const { layer, requests } = harness((request) => {
        const graphql = request.url.endsWith("/graphql");
        const number = Number(request.url.split("/").at(-1)) || 43;
        const headers = {
          "x-ratelimit-resource": graphql ? "graphql" : "core",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "499",
          "x-ratelimit-reset": String(reset),
        };
        return json(
          graphql
            ? {
                data: {
                  viewer: { login: "julius" },
                  updateIssueComment: { issueComment: { id: "IC_1" } },
                  addReaction: { reaction: { content: "THUMBS_UP" } },
                  repository: {
                    isArchived: false,
                    viewerPermission: "WRITE",
                    issue: {
                      locked: false,
                      id: "I_42",
                      viewerCanUpdate: true,
                    },
                  },
                  node: {
                    __typename: "IssueComment",
                    issue: { id: "I_42" },
                    viewerCanUpdate: true,
                  },
                },
              }
            : {
                id: 143,
                number,
                title: "Issue",
                html_url: `https://github.com/acme/web/issues/${number}`,
                state: "open",
                labels: [],
                assignees: [],
              },
          { headers },
        );
      });
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const api = yield* GitHubRest.GitHubRest;
        yield* api.rest({ host: "github.com", operation: "seed", path: "rate_limit" });
        const driver = yield* GitHubIssueTracker.make;
        yield* driver.getViewer({ cwd: "/w", host: "github.com", scope: "acme/web" });
        const target = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
        expect((yield* driver.getViewerPermissions!(target)).edit).toBe(true);
        if (operation === "update") yield* driver.update!({ ...target, title: "Changed" });
        else if (operation === "setState") yield* driver.setState!({ ...target, state: "closed" });
        else if (operation === "comment") yield* driver.comment!({ ...target, body: "New" });
        else if (operation === "editComment")
          yield* driver.editComment!({ ...target, commentId: "IC_1", body: "Changed" });
        else if (operation === "setReaction")
          yield* driver.setReaction!({ ...target, content: "thumbs-up", reacted: true });
        else if (operation === "create")
          yield* driver.create!({
            ...target,
            title: "New",
            body: "",
            labels: [],
            assignees: [],
            parentKey: "7",
          });
        else yield* driver.setParent!({ ...target, parentKey: "7" });
        const writes = requests.slice(3);
        expect(writes).toHaveLength(
          operation === "create" || operation === "setParent"
            ? 3
            : operation === "editComment" || operation === "setReaction"
              ? 2
              : 1,
        );
        expect(writes.some((request) => request.method !== "GET")).toBe(true);
        const count = requests.length;
        expect(
          (yield* Effect.flip(
            driver.listIssues({
              ...target,
              state: "all",
              involvement: "all",
              viewer: "julius",
              limit: 10,
            }),
          )).reason,
        ).toBe("rate-limited");
        expect((yield* Effect.flip(driver.getIssue(target))).reason).toBe("rate-limited");
        expect(requests).toHaveLength(count);
        expect(yield* SourceControlRateLimit.Interactive).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps native rate refusals typed during interactive issue writes", () => {
    const reset = Math.floor(NOW / 1000) + 600;
    const { layer, requests } = harness((request) =>
      request.url.endsWith("/graphql")
        ? json({
            data: {
              repository: {
                isArchived: false,
                viewerPermission: "WRITE",
                issue: {
                  locked: false,
                  viewerCanUpdate: true,
                },
              },
            },
          })
        : json(
            { message: "API rate limit exceeded" },
            {
              status: 429,
              headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
            },
          ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const driver = yield* GitHubIssueTracker.make;
      const target = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
      expect((yield* driver.getViewerPermissions!(target)).edit).toBe(true);
      const refused = yield* Effect.flip(driver.update!({ ...target, title: "Changed" }));
      expect(refused).toMatchObject({ reason: "rate-limited", retryAt: reset * 1000 });
      expect(requests[1]?.method).toBe("PATCH");
      expect((yield* Effect.flip(driver.getIssue(target))).reason).toBe("rate-limited");
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });
});
