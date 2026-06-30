import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { GithubIssuesProvider as GithubIssuesProviderTag } from "../Services/WorkSourceProvider.ts";
import { WorkSourceConnectionStore } from "../Services/WorkSourceConnectionStore.ts";
import { GithubIssuesProviderLive } from "./GithubIssuesProvider.ts";

// ---------------------------------------------------------------------------
// Canned GitHub API responses
// ---------------------------------------------------------------------------

/** Issue-1: open issue (should be included) */
const issueOpen = {
  number: 1,
  state: "open",
  title: "Bug: something broken",
  body: "Describe the bug",
  html_url: "https://github.com/o/r/issues/1",
  updated_at: "2024-01-01T00:00:00Z",
  assignees: [{ login: "alice" }],
  labels: [{ name: "bug" }],
};

/** Issue-2: pull request — should be FILTERED OUT */
const pullRequest = {
  number: 2,
  state: "open",
  title: "PR: add feature",
  body: null,
  html_url: "https://github.com/o/r/pull/2",
  updated_at: "2024-01-02T00:00:00Z",
  assignees: [],
  labels: [],
  pull_request: { url: "https://api.github.com/repos/o/r/pulls/2" },
};

/** Issue-3: closed issue (should be included, lifecycle=closed) */
const issueClosed = {
  number: 3,
  state: "closed",
  title: "Fixed: something",
  body: null,
  html_url: "https://github.com/o/r/issues/3",
  updated_at: "2024-01-03T00:00:00Z",
  assignees: [],
  labels: [{ name: "fixed" }],
};

// ---------------------------------------------------------------------------
// Helper: build a test layer with mocked HttpClient + connection store
// ---------------------------------------------------------------------------

function makeTestLayer(input: {
  readonly responseBody: unknown;
  readonly responseStatus?: number;
  readonly responseHeaders?: Record<string, string>;
  readonly pat?: string;
}) {
  const pat = input.pat ?? "test-pat-12345";
  const status = input.responseStatus ?? 200;
  const headers = input.responseHeaders ?? {};

  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(input.responseBody), {
          status,
          headers: {
            "content-type": "application/json",
            ...headers,
          },
        }),
      ),
    ),
  );

  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => execute(request)),
  );

  const connectionStoreLayer = Layer.succeed(WorkSourceConnectionStore, {
    getToken: (_connectionRef, _expectedProvider) => Effect.succeed(pat),
    getConnectionAuth: (_connectionRef, _expectedProvider) =>
      Effect.succeed({ token: pat, authMode: "pat", baseUrl: null, email: null }),
    create: (_input) => Effect.die("not needed in test"),
    list: () => Effect.die("not needed in test"),
    remove: (_connectionRef) => Effect.die("not needed in test"),
  });

  const testLayer = GithubIssuesProviderLive.pipe(
    Layer.provide(httpClientLayer),
    Layer.provide(connectionStoreLayer),
  );

  return { execute, testLayer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GithubIssuesProvider", () => {
  describe("listPage", () => {
    it.effect("lists issues, filters PRs, maps lifecycle + pagination", () => {
      const linkHeader =
        '<https://api.github.com/repos/o/r/issues?page=2>; rel="next", <https://api.github.com/repos/o/r/issues?page=5>; rel="last"';

      const { testLayer } = makeTestLayer({
        responseBody: [issueOpen, pullRequest, issueClosed],
        responseHeaders: { link: linkHeader },
      });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const page = yield* provider.listPage({
          connectionRef: "conn",
          selector: { owner: "o", repo: "r", state: "all" },
          pageSize: 50,
        });

        // PR (issue-2) should be filtered
        expect(page.items.map((i) => i.externalId)).toEqual(["1", "3"]);

        // open issue lifecycle
        expect(page.items[0]!.lifecycle).toBe("open");
        // closed issue lifecycle
        expect(page.items[1]!.lifecycle).toBe("closed");

        // version.updatedAt is mapped
        expect(page.items[0]!.version.updatedAt).toBe("2024-01-01T00:00:00Z");
        expect(page.items[1]!.version.updatedAt).toBe("2024-01-03T00:00:00Z");

        // fields are mapped
        expect(page.items[0]!.fields.title).toBe("Bug: something broken");
        expect(page.items[0]!.fields.description).toBe("Describe the bug");
        expect(page.items[0]!.fields.assignees).toEqual(["alice"]);
        expect(page.items[0]!.fields.labels).toEqual(["bug"]);

        // closed issue body=null → description=undefined
        expect(page.items[1]!.fields.description).toBeUndefined();

        // nextPageToken parsed from Link header
        expect(page.nextPageToken).toBe("2");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("returns no nextPageToken when Link header is absent", () => {
      const { testLayer } = makeTestLayer({
        responseBody: [issueOpen],
        responseHeaders: {},
      });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const page = yield* provider.listPage({
          connectionRef: "conn",
          selector: { owner: "o", repo: "r", state: "open" },
          pageSize: 50,
        });

        expect(page.nextPageToken).toBeUndefined();
        expect(page.items).toHaveLength(1);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("applies GithubSelector defaulting (state defaults to 'all')", () => {
      const { execute, testLayer } = makeTestLayer({ responseBody: [] });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        // Omit 'state' — should default to 'all' via GithubSelector
        yield* provider.listPage({
          connectionRef: "conn",
          selector: { owner: "myorg", repo: "myrepo" },
          pageSize: 25,
        });

        const request = execute.mock.calls[0]?.[0];
        expect(request).toBeDefined();
        // URL should contain per_page and state params
        expect(request!.url).toContain("myorg");
        expect(request!.url).toContain("myrepo");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("maps provider field on items", () => {
      const { testLayer } = makeTestLayer({ responseBody: [issueOpen] });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const page = yield* provider.listPage({
          connectionRef: "conn",
          selector: { owner: "o", repo: "r" },
          pageSize: 10,
        });

        expect(page.items[0]!.provider).toBe("github");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("sends Authorization header with PAT", () => {
      const { execute, testLayer } = makeTestLayer({
        responseBody: [],
        pat: "my-secret-pat",
      });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        yield* provider.listPage({
          connectionRef: "conn",
          selector: { owner: "o", repo: "r" },
          pageSize: 10,
        });

        const request = execute.mock.calls[0]?.[0];
        expect(request).toBeDefined();
        expect(request!.headers["authorization"]).toBe("Bearer my-secret-pat");
        expect(request!.headers["accept"]).toBe("application/vnd.github+json");
        expect(request!.headers["x-github-api-version"]).toBe("2022-11-28");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("maps 401 to WorkSourceAuthError", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { message: "Bad credentials" },
        responseStatus: 401,
      });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({
            connectionRef: "my-conn",
            selector: { owner: "o", repo: "r" },
            pageSize: 10,
          }),
        );
        expect(failure._tag).toBe("WorkSourceAuthError");
        expect((failure as { connectionRef?: string }).connectionRef).toBe("my-conn");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("maps 429 with retry-after to WorkSourceRateLimitError", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { message: "rate limited" },
        responseStatus: 429,
        responseHeaders: { "retry-after": "30" },
      });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({
            connectionRef: "conn",
            selector: { owner: "o", repo: "r" },
            pageSize: 10,
          }),
        );
        expect(failure._tag).toBe("WorkSourceRateLimitError");
        expect((failure as { retryAfterMs?: number }).retryAfterMs).toBe(30_000);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("maps 403 with x-ratelimit-remaining:0 to WorkSourceRateLimitError", () => {
      // Use a far-future epoch so the delta is always positive
      const futureResetEpochSec = 9_999_999_999;
      const { testLayer } = makeTestLayer({
        responseBody: { message: "API rate limit exceeded" },
        responseStatus: 403,
        responseHeaders: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(futureResetEpochSec),
        },
      });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({
            connectionRef: "conn",
            selector: { owner: "o", repo: "r" },
            pageSize: 10,
          }),
        );
        expect(failure._tag).toBe("WorkSourceRateLimitError");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("maps 403 without rate-limit headers to WorkSourceAuthError", () => {
      // Common misconfigured-PAT case: 403 with no rate-limit headers at all.
      const { testLayer } = makeTestLayer({
        responseBody: { message: "Resource not accessible by personal access token" },
        responseStatus: 403,
        responseHeaders: {},
      });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({
            connectionRef: "bad-pat-conn",
            selector: { owner: "o", repo: "r" },
            pageSize: 10,
          }),
        );
        expect(failure._tag).toBe("WorkSourceAuthError");
        expect((failure as { connectionRef?: string }).connectionRef).toBe("bad-pat-conn");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect(
      "Fix L6: 403 secondary rate limit (retry-after present, x-ratelimit-remaining > 0) → WorkSourceRateLimitError",
      () => {
        // Secondary/abuse limits return 403 with a retry-after header but keep
        // x-ratelimit-remaining non-zero. Must map to rate-limit (honoring the
        // server's retry-after), NOT a generic transient/auth error.
        const { testLayer } = makeTestLayer({
          responseBody: { message: "You have exceeded a secondary rate limit" },
          responseStatus: 403,
          responseHeaders: {
            "retry-after": "45",
            "x-ratelimit-remaining": "4999",
          },
        });

        return Effect.gen(function* () {
          const provider = yield* GithubIssuesProviderTag;
          const failure = yield* Effect.flip(
            provider.listPage({
              connectionRef: "conn",
              selector: { owner: "o", repo: "r" },
              pageSize: 10,
            }),
          );
          expect(failure._tag).toBe("WorkSourceRateLimitError");
          // retry-after honored verbatim (45s → 45_000ms).
          expect((failure as { retryAfterMs?: number }).retryAfterMs).toBe(45_000);
        }).pipe(Effect.provide(testLayer));
      },
    );

    it.effect("computes retryAfterMs from x-ratelimit-reset epoch math", () => {
      // `it.effect` runs with the default Effect clock at epoch 0, and the
      // provider reads `DateTime.now`. Pin the reset epoch 120s past epoch 0 so
      // the computed delta (resetMs - nowMs) is a deterministic ~120_000ms.
      // A future epoch->ms unit regression (e.g. forgetting the *1000) would
      // collapse this to ~120ms and fail the lower bound.
      const resetEpochSec = 120;
      const { testLayer } = makeTestLayer({
        responseBody: { message: "API rate limit exceeded" },
        responseStatus: 403,
        responseHeaders: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetEpochSec),
        },
      });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({
            connectionRef: "conn",
            selector: { owner: "o", repo: "r" },
            pageSize: 10,
          }),
        );
        expect(failure._tag).toBe("WorkSourceRateLimitError");
        const retryAfterMs = (failure as { retryAfterMs?: number }).retryAfterMs;
        // ~120_000ms (120s * 1000). Wide enough to absorb any small clock slack,
        // tight enough that a missing *1000 (=> ~120ms) fails the lower bound.
        expect(retryAfterMs).toBeGreaterThan(60_000);
        expect(retryAfterMs).toBeLessThanOrEqual(130_000);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("fails with WorkSourceConfigError for invalid selector", () => {
      const { testLayer } = makeTestLayer({ responseBody: [] });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const failure = yield* Effect.flip(
          provider.listPage({
            connectionRef: "conn",
            // missing required 'owner' and 'repo'
            selector: { state: "open" },
            pageSize: 10,
          }),
        );
        expect(failure._tag).toBe("WorkSourceConfigError");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect(
      "Fix 6: 200 body that is not an array → WorkSourceTransientError (not a defect)",
      () => {
        const { testLayer } = makeTestLayer({
          responseBody: { message: "garbage" },
          responseStatus: 200,
        });

        return Effect.gen(function* () {
          const provider = yield* GithubIssuesProviderTag;
          const failure = yield* provider
            .listPage({ connectionRef: "conn", selector: { owner: "o", repo: "r" }, pageSize: 10 })
            .pipe(Effect.flip);
          expect(failure._tag).toBe("WorkSourceTransientError");
        }).pipe(Effect.provide(testLayer));
      },
    );
  });

  describe("getItem", () => {
    const selector = { owner: "o", repo: "r" };

    it.effect("404 → null (genuinely deleted upstream)", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { message: "Not Found" },
        responseStatus: 404,
      });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const result = yield* provider.getItem({
          connectionRef: "conn",
          selector,
          externalId: "42",
        });
        expect(result).toBeNull();
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("200 → the mapped item (still exists; fell out of a filter, NOT deleted)", () => {
      const { testLayer } = makeTestLayer({ responseBody: issueOpen, responseStatus: 200 });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const result = yield* provider.getItem({
          connectionRef: "conn",
          selector,
          externalId: "1",
        });
        expect(result).not.toBeNull();
        expect(result!.externalId).toBe("1");
        expect(result!.fields.title).toBe("Bug: something broken");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("401 → WorkSourceAuthError (typed failure, NOT null)", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { message: "Bad credentials" },
        responseStatus: 401,
      });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const failure = yield* provider
          .getItem({ connectionRef: "conn", selector, externalId: "1" })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("WorkSourceAuthError");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("500 → WorkSourceTransientError (typed failure, NOT null)", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { message: "boom" },
        responseStatus: 500,
      });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const failure = yield* provider
          .getItem({ connectionRef: "conn", selector, externalId: "1" })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("WorkSourceTransientError");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("malformed 200 body (array, not an object) → WorkSourceTransientError", () => {
      const { testLayer } = makeTestLayer({ responseBody: [1, 2, 3], responseStatus: 200 });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const failure = yield* provider
          .getItem({ connectionRef: "conn", selector, externalId: "1" })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("WorkSourceTransientError");
      }).pipe(Effect.provide(testLayer));
    });
  });

  describe("GithubIssuesProvider import methods", () => {
    it.effect("toImportableView formats #<number> and owner/repo from the selector", () => {
      const { testLayer } = makeTestLayer({ responseBody: [] });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const parts = provider.toImportableView({
          selector: { owner: "acme", repo: "app", state: "open" },
          item: {
            provider: "github",
            externalId: "82",
            url: "https://github.com/acme/app/issues/82",
            lifecycle: "open",
            version: {},
            fields: { title: "x" },
          },
        });
        assert.equal(parts.displayRef, "#82");
        assert.equal(parts.container, "acme/app");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("toImportableView falls back to '?' when owner/repo are absent", () => {
      const { testLayer } = makeTestLayer({ responseBody: [] });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const parts = provider.toImportableView({
          selector: {},
          item: {
            provider: "github",
            externalId: "9",
            url: "https://github.com/x/y/issues/9",
            lifecycle: "open",
            version: {},
            fields: { title: "x" },
          },
        });
        assert.equal(parts.displayRef, "#9");
        assert.equal(parts.container, "?/?");
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("viewer returns the login as id + alias", () => {
      const { testLayer } = makeTestLayer({ responseBody: { login: "octocat" } });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const v = yield* provider.viewer({ connectionRef: "c" });
        assert.deepEqual(v, { id: "octocat", aliases: ["octocat"] });
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("viewer returns null on non-200 status", () => {
      const { testLayer } = makeTestLayer({
        responseBody: { message: "Not Found" },
        responseStatus: 404,
      });

      return Effect.gen(function* () {
        const provider = yield* GithubIssuesProviderTag;
        const v = yield* provider.viewer({ connectionRef: "c" });
        assert.equal(v, null);
      }).pipe(Effect.provide(testLayer));
    });
  });
});
