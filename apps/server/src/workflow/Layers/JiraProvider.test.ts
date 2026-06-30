import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse, UrlParams } from "effect/unstable/http";

import { JiraProvider as JiraProviderTag } from "../Services/WorkSourceProvider.ts";
import { WorkSourceConnectionStore } from "../Services/WorkSourceConnectionStore.ts";
import { JiraProviderLive } from "./JiraProvider.ts";

/** Get the decoded JQL parameter from a captured request. */
function getJql(request: HttpClientRequest.HttpClientRequest): string {
  const qs = UrlParams.toString(request.urlParams);
  return new URLSearchParams(qs).get("jql") ?? "";
}

const issue = (over: Record<string, unknown> = {}) => ({
  key: "ENG-1",
  fields: {
    summary: "Bug: broken",
    description: "Steps to reproduce",
    status: { statusCategory: { key: "indeterminate" } },
    assignee: { displayName: "Alice Smith" },
    labels: ["backend"],
    updated: "2024-01-01T00:00:00.000+0000",
    ...over,
  },
});

function makeTestLayer(input: {
  readonly responseBody: unknown;
  readonly responseStatus?: number;
  readonly responseHeaders?: Record<string, string>;
  readonly auth?: { token: string; authMode: string; baseUrl: string | null; email: string | null };
}) {
  const status = input.responseStatus ?? 200;
  const headers = input.responseHeaders ?? {};
  const auth = input.auth ?? {
    token: "jira-tok",
    authMode: "basic",
    baseUrl: "https://acme.atlassian.net",
    email: "me@acme.test",
  };

  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(input.responseBody), {
          status,
          headers: { "content-type": "application/json", ...headers },
        }),
      ),
    ),
  );

  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => execute(request)),
  );

  const connectionStoreLayer = Layer.succeed(WorkSourceConnectionStore, {
    getToken: (_ref, _p) => Effect.succeed(auth.token),
    getConnectionAuth: (_ref, _p) =>
      Effect.succeed({
        token: auth.token,
        authMode: auth.authMode as "pat" | "basic" | "bearer",
        baseUrl: auth.baseUrl,
        email: auth.email,
      }),
    create: (_input) => Effect.die("not needed in test"),
    list: () => Effect.die("not needed in test"),
    remove: (_ref) => Effect.die("not needed in test"),
  });

  const testLayer = JiraProviderLive.pipe(
    Layer.provide(httpClientLayer),
    Layer.provide(connectionStoreLayer),
  );
  return { execute, testLayer };
}

describe("JiraProvider", () => {
  describe("listPage", () => {
    it.effect("maps an issue, builds Basic auth, and assembles JQL", () => {
      const { execute, testLayer } = makeTestLayer({
        responseBody: { issues: [issue()], startAt: 0, maxResults: 50, total: 1 },
      });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        const page = yield* provider.listPage({
          connectionRef: "conn",
          selector: { projectKey: "ENG" },
          pageSize: 50,
        });

        expect(page.items).toHaveLength(1);
        const item = page.items[0]!;
        expect(item.provider).toBe("jira");
        expect(item.externalId).toBe("ENG-1");
        expect(item.url).toBe("https://acme.atlassian.net/browse/ENG-1");
        expect(item.lifecycle).toBe("open");
        expect(item.version.updatedAt).toBe("2024-01-01T00:00:00.000+0000");
        expect(item.fields.title).toBe("Bug: broken");
        expect(item.fields.description).toBe("Steps to reproduce");
        expect(item.fields.assignees).toEqual(["Alice Smith"]);
        expect(item.fields.labels).toEqual(["backend"]);
        // no next page (startAt 0 + 1 item >= total 1)
        expect(page.nextPageToken).toBeUndefined();

        // Basic auth header = base64("me@acme.test:jira-tok")
        const request = execute.mock.calls[0]?.[0];
        const expected = `Basic ${Buffer.from("me@acme.test:jira-tok").toString("base64")}`;
        expect(request!.headers["authorization"]).toBe(expected);
        // JQL contains project clause + ORDER BY (urlParams carry the query string)
        const jql = getJql(request!);
        expect(jql).toContain('project = "ENG"');
        expect(jql).toContain("ORDER BY updated ASC");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("uses Bearer auth for Server/DC (authMode=bearer)", () => {
      const { execute, testLayer } = makeTestLayer({
        responseBody: { issues: [], startAt: 0, maxResults: 50, total: 0 },
        auth: { token: "pat-123", authMode: "bearer", baseUrl: "https://jira.corp", email: null },
      });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        yield* provider.listPage({ connectionRef: "c", selector: { projectKey: "OPS" }, pageSize: 50 });
        const request = execute.mock.calls[0]?.[0];
        expect(request!.headers["authorization"]).toBe("Bearer pat-123");
        expect(request!.url).toContain("https://jira.corp/rest/api/2/search");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("AND-combines user JQL and emits a next page token when more remain", () => {
      const { execute, testLayer } = makeTestLayer({
        responseBody: { issues: [issue(), issue({ summary: "x" })], startAt: 0, maxResults: 2, total: 5 },
      });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        const page = yield* provider.listPage({
          connectionRef: "c",
          selector: { projectKey: "ENG", jql: "labels = backend" },
          pageSize: 2,
        });
        expect(page.nextPageToken).toBe("2");
        const jql = getJql(execute.mock.calls[0]![0]);
        expect(jql).toContain('project = "ENG" AND (labels = backend)');
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("includes a 'since' clause with the T→space date format", () => {
      const { execute, testLayer } = makeTestLayer({
        responseBody: { issues: [], startAt: 0, maxResults: 50, total: 0 },
      });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        yield* provider.listPage({
          connectionRef: "c",
          selector: { projectKey: "ENG" },
          since: "2024-01-01T00:00:00Z",
          pageSize: 50,
        });
        const jql = getJql(execute.mock.calls[0]![0]);
        expect(jql).toContain('updated >= "2024-01-01 00:00"');
        expect(jql).toContain("ORDER BY updated ASC");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("maps statusCategory 'done' to lifecycle closed", () => {
      const { testLayer } = makeTestLayer({
        responseBody: {
          issues: [issue({ status: { statusCategory: { key: "done" } } })],
          startAt: 0,
          maxResults: 50,
          total: 1,
        },
      });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        const page = yield* provider.listPage({ connectionRef: "c", selector: { projectKey: "ENG" }, pageSize: 50 });
        expect(page.items[0]!.lifecycle).toBe("closed");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("maps 401 to WorkSourceAuthError", () => {
      const { testLayer } = makeTestLayer({ responseBody: { message: "no" }, responseStatus: 401 });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({ connectionRef: "my-conn", selector: { projectKey: "ENG" }, pageSize: 10 }),
        );
        expect(failure._tag).toBe("WorkSourceAuthError");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("maps 429 with retry-after to WorkSourceRateLimitError", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { message: "slow down" },
        responseStatus: 429,
        responseHeaders: { "retry-after": "30" },
      });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({ connectionRef: "c", selector: { projectKey: "ENG" }, pageSize: 10 }),
        );
        expect(failure._tag).toBe("WorkSourceRateLimitError");
        expect((failure as { retryAfterMs?: number }).retryAfterMs).toBe(30_000);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("treats a 302 redirect as a typed error (manual-redirect SSRF guard)", () => {
      // With redirect:"manual" the runtime client surfaces a redirect as a 3xx
      // status (or opaqueredirect status 0). The provider's non-2xx handling
      // rejects it, so a redirect from an allowed host can never auto-pivot the
      // request to the (internal) Location target — no items are returned.
      const { testLayer } = makeTestLayer({
        responseBody: { message: "moved" },
        responseStatus: 302,
        responseHeaders: { location: "http://169.254.169.254/" },
      });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({ connectionRef: "c", selector: { projectKey: "ENG" }, pageSize: 10 }),
        );
        expect(failure._tag).toBe("WorkSourceTransientError");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("fails with WorkSourceConfigError for an invalid selector", () => {
      const { testLayer } = makeTestLayer({ responseBody: { issues: [] } });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({ connectionRef: "c", selector: { projectKey: "" }, pageSize: 10 }),
        );
        expect(failure._tag).toBe("WorkSourceConfigError");
      }).pipe(Effect.provide(testLayer));
    });
  });

  describe("getItem", () => {
    it.effect("404 → null", () => {
      const { testLayer } = makeTestLayer({ responseBody: { message: "Not Found" }, responseStatus: 404 });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        const result = yield* provider.getItem({
          connectionRef: "c",
          selector: { projectKey: "ENG" },
          externalId: "ENG-9",
        });
        expect(result).toBeNull();
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("200 → the mapped item (still exists)", () => {
      const { testLayer } = makeTestLayer({ responseBody: issue({}), responseStatus: 200 });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        const result = yield* provider.getItem({
          connectionRef: "c",
          selector: { projectKey: "ENG" },
          externalId: "ENG-1",
        });
        expect(result).not.toBeNull();
        expect(result!.externalId).toBe("ENG-1");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("500 → WorkSourceTransientError (NOT null)", () => {
      const { testLayer } = makeTestLayer({ responseBody: { message: "boom" }, responseStatus: 500 });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        const failure = yield* provider
          .getItem({ connectionRef: "c", selector: { projectKey: "ENG" }, externalId: "ENG-1" })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("WorkSourceTransientError");
      }).pipe(Effect.provide(testLayer));
    });
  });

  describe("import methods", () => {
    it.effect("toImportableView uses the key as displayRef and projectKey as container", () => {
      const { testLayer } = makeTestLayer({ responseBody: { issues: [] } });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        const parts = provider.toImportableView({
          selector: { projectKey: "ENG" },
          item: {
            provider: "jira",
            externalId: "ENG-42",
            url: "https://acme.atlassian.net/browse/ENG-42",
            lifecycle: "open",
            version: {},
            fields: { title: "x" },
          },
        });
        assert.equal(parts.displayRef, "ENG-42");
        assert.equal(parts.container, "ENG");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("viewer returns accountId as id with displayName among aliases", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { accountId: "acc-1", displayName: "Alice Smith", emailAddress: "alice@acme.test" },
      });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        const v = yield* provider.viewer({ connectionRef: "c" });
        expect(v!.id).toBe("acc-1");
        expect(v!.aliases).toContain("Alice Smith");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("viewer returns null on non-200", () => {
      const { testLayer } = makeTestLayer({ responseBody: {}, responseStatus: 403 });
      return Effect.gen(function* () {
        const provider = yield* JiraProviderTag;
        const v = yield* provider.viewer({ connectionRef: "c" });
        assert.equal(v, null);
      }).pipe(Effect.provide(testLayer));
    });
  });
});
