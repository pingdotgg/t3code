import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import { GraphQLClient, GraphQLResolver } from "effect/graphql";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubGraphQlClient from "./gitHubGraphQlClient.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import { PullRequestBatchesGraphQLGroup } from "./pullRequestBatches.graphql.ts";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function harness(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  let invalidations = 0;
  const services = Layer.mergeAll(
    Layer.succeed(GitHubCredentials.GitHubCredentials, {
      get: (host) =>
        Effect.succeed({
          host,
          token: Redacted.make("secret"),
          source: "gh" as const,
          fingerprint: `${host}:secret`,
        }),
      invalidate: () =>
        Effect.sync(() => {
          invalidations++;
        }),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request);
        return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)));
      }),
    ),
    GitHubQuota.layer,
    SourceControlRateLimit.layer,
  );
  const layer = GitHubRest.layer.pipe(Layer.provideMerge(services));
  return { layer, requests, invalidations: () => invalidations };
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

const readStats = (host: string, number = 7) =>
  Effect.gen(function* () {
    const client = yield* GraphQLClient.make(
      PullRequestBatchesGraphQLGroup.middleware(GitHubGraphQlClient.GitHubGraphQlAuth),
    ).pipe(Effect.provide(GitHubGraphQlClient.layer));
    return yield* GraphQLResolver.request(
      { owner: "acme", name: "web", number },
      GraphQLResolver.aliased(client.PullRequestStats, {
        batchKey: GitHubGraphQlClient.batchKey,
      }),
    ).pipe(
      Effect.provideService(GitHubGraphQlClient.GitHubGraphQlTarget, {
        host,
        operation: "stats",
      }),
    );
  });

const stats = { additions: 3, deletions: 1 };

describe("GitHubGraphQlAuth", () => {
  it.effect(
    "sends each host's lookups to its own endpoint with its token, never in one batch",
    () => {
      const { layer, requests } = harness(() =>
        json({ data: { _0_repository: { pullRequest: stats } } }),
      );
      return Effect.gen(function* () {
        const client = yield* GraphQLClient.make(
          PullRequestBatchesGraphQLGroup.middleware(GitHubGraphQlClient.GitHubGraphQlAuth),
        ).pipe(Effect.provide(GitHubGraphQlClient.layer));
        const resolver = GraphQLResolver.aliased(client.PullRequestStats, {
          batchKey: GitHubGraphQlClient.batchKey,
        });
        const lookup = (host: string) =>
          GraphQLResolver.request({ owner: "acme", name: "web", number: 7 }, resolver).pipe(
            Effect.provideService(GitHubGraphQlClient.GitHubGraphQlTarget, {
              host,
              operation: "stats",
            }),
          );
        yield* Effect.all([lookup("github.com"), lookup("github.acme.test")], {
          concurrency: "unbounded",
        });
        expect(requests.map((request) => request.url).toSorted()).toEqual([
          "https://api.github.com/graphql",
          "https://github.acme.test/api/graphql",
        ]);
        expect(requests[0]?.headers["authorization"]).toBe("Bearer secret");
        expect(requests[0]?.headers["x-github-api-version"]).toBe("2022-11-28");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("pauses the host on a RATE_LIMITED answer sent with HTTP 200", () => {
    const reset = Math.floor(NOW / 1000) + 600;
    const { layer, requests } = harness(() =>
      json(
        { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
        { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } },
      ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const first = yield* Effect.flip(readStats("github.com"));
      expect(first).toMatchObject({ _tag: "GitHubApiRateLimitError", retryAt: reset * 1000 });
      const api = yield* GitHubRest.GitHubRest;
      const rest = yield* Effect.flip(
        api.rest({ host: "github.com", operation: "stack", path: "repos/acme/web/stacks" }),
      );
      expect(rest).toMatchObject({ _tag: "SourceControlRateLimitPausedError" });
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads an untyped exhausted-quota error sent with HTTP 200 as a rate limit", () => {
    const reset = Math.floor(NOW / 1000) + 900;
    const { layer } = harness(() =>
      json(
        { data: null, errors: [{ message: "API rate limit already exceeded for user ID 1." }] },
        { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } },
      ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const error = yield* Effect.flip(readStats("github.com"));
      expect(error).toMatchObject({ _tag: "GitHubApiRateLimitError", retryAt: reset * 1000 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("traces the query hash and quota, never the variables, token or URL", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const { layer } = harness(() =>
      json(
        { data: { _0_repository: { pullRequest: stats } } },
        { headers: { "x-ratelimit-remaining": "4990", "x-ratelimit-resource": "graphql" } },
      ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* readStats("github.com", 4242);
      const execute = spans.find((span) => span.name === "GitHubGraphQlAuth.execute")!;
      const attributes = Object.fromEntries(execute.attributes);
      expect(attributes).toMatchObject({
        "github.kind": "graphql",
        "github.operation": "stats",
        "http.response.status_code": 200,
        "github.ratelimit.remaining": 4990,
        "github.ratelimit.resource": "graphql",
      });
      expect(String(attributes["github.graphql.query_hash"])).toMatch(/^[0-9a-f]{8}$/);
      const everything = spans
        .flatMap((span) => [...span.attributes].map(([key, value]) => `${key}=${String(value)}`))
        .join("\n");
      expect(everything).not.toContain("4242");
      expect(everything).not.toContain("secret");
      expect(spans.some((span) => span.attributes.has("url.full"))).toBe(false);
    }).pipe(Effect.provide(layer), Effect.withTracer(tracer));
  });

  it.effect("reads a 403 secondary limit as a rate limit, and a 401 as a refused token", () => {
    const answers = [
      json({ message: "You have exceeded a secondary rate limit." }, { status: 403 }),
      json({ message: "Bad credentials" }, { status: 401 }),
    ];
    const { layer, invalidations } = harness(() => answers.shift()!);
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      expect((yield* Effect.flip(readStats("github.com")))._tag).toBe("GitHubApiRateLimitError");
      expect((yield* Effect.flip(readStats("github.example")))._tag).toBe(
        "GitHubApiAuthenticationError",
      );
      expect(invalidations()).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the quota reserve for interactive requests", () => {
    const reset = Math.floor(NOW / 1000) + 600;
    const { layer, requests } = harness(() =>
      json(
        { data: { _0_repository: { pullRequest: stats } } },
        {
          headers: {
            "x-ratelimit-resource": "graphql",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "100",
            "x-ratelimit-reset": String(reset),
          },
        },
      ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* readStats("github.com", 1).pipe(
        Effect.provideService(SourceControlRateLimit.Interactive, true),
      );
      const background = yield* Effect.flip(readStats("github.com", 2));
      expect(background._tag).toBe("SourceControlRateLimitPausedError");
      expect(requests).toHaveLength(1);
      const api = yield* GitHubRest.GitHubRest;
      yield* api.rest({ host: "github.com", operation: "user", path: "user" });
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });
});

const callStats = (target: Partial<GitHubGraphQlClient.GitHubGraphQlTarget["Service"]> = {}) =>
  Effect.gen(function* () {
    const client = yield* GraphQLClient.make(
      PullRequestBatchesGraphQLGroup.middleware(GitHubGraphQlClient.GitHubGraphQlAuth),
    ).pipe(Effect.provide(GitHubGraphQlClient.layer));
    return yield* client
      .PullRequestStats({ owner: "acme", name: "web", number: 7 })
      .pipe(GitHubGraphQlClient.call({ host: "github.com", operation: "stats", ...target }));
  });

describe("call", () => {
  it.effect("fails an answer whose errors all say NOT_FOUND as a missing resource", () => {
    const { layer } = harness(() =>
      json({
        data: { repository: null },
        errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
      }),
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(callStats());
      expect(error).toMatchObject({
        _tag: "GitHubApiNotFoundError",
        host: "github.com",
        operation: "stats",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "fails NOT_FOUND alongside another error as a failure carrying GitHub's reasons",
    () => {
      const { layer } = harness(() =>
        json({
          data: null,
          errors: [
            { type: "NOT_FOUND", message: "Could not resolve" },
            { type: "FORBIDDEN", message: "Resource not accessible" },
          ],
        }),
      );
      return Effect.gen(function* () {
        const error = yield* Effect.flip(callStats());
        expect(error).toMatchObject({
          _tag: "GitHubApiResponseError",
          status: 200,
          githubErrors: ["Could not resolve", "Resource not accessible"],
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("fails an answer past the byte cap with its status", () => {
    const { layer } = harness(() =>
      json({ data: { repository: { pullRequest: { ...stats, padding: "x".repeat(200) } } } }),
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(callStats({ maxResponseBytes: 64 }));
      expect(error).toMatchObject({ _tag: "GitHubApiResponseError", status: 200 });
    }).pipe(Effect.provide(layer));
  });
});
