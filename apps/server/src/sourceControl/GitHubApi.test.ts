import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessSpawnError, VcsProcessTimeoutError } from "@t3tools/contracts";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function harness(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  let tokens = ["first", "second"];
  let invalidations = 0;
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.sync(() => ({
          host,
          token: Redacted.make(tokens[0]!),
          source: "gh" as const,
          fingerprint: `${host}:${tokens[0]}`,
        })),
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
  const layer = GitHubApi.layer.pipe(
    Layer.provide(Layer.mergeAll(credentials, http)),
    Layer.provideMerge(GitHubGraphQlBudget.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
  return { layer, requests, invalidations: () => invalidations };
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

describe("gitHubApiUrls", () => {
  it("maps github.com, GHE.com and GitHub Enterprise Server", () => {
    expect(GitHubApi.gitHubApiUrls("GitHub.com")).toEqual({
      rest: "https://api.github.com",
      graphql: "https://api.github.com/graphql",
    });
    expect(GitHubApi.gitHubApiUrls("acme.ghe.com").graphql).toBe(
      "https://api.acme.ghe.com/graphql",
    );
    expect(GitHubApi.gitHubApiUrls("git.acme.internal")).toEqual({
      rest: "https://git.acme.internal/api/v3",
      graphql: "https://git.acme.internal/api/graphql",
    });
  });
});

describe("environmentToken", () => {
  it("follows gh's precedence per kind of host", () => {
    const env = { GH_TOKEN: "gh", GITHUB_TOKEN: "github", GH_ENTERPRISE_TOKEN: "ghe" };
    expect(GitHubCredentials.environmentToken("github.com", env)).toBe("gh");
    expect(GitHubCredentials.environmentToken("acme.ghe.com", { GITHUB_TOKEN: "github" })).toBe(
      "github",
    );
    // An enterprise token only goes to the host GH_HOST names, never to whatever a remote says.
    expect(GitHubCredentials.environmentToken("git.acme.internal", env)).toBeNull();
    expect(
      GitHubCredentials.environmentToken("git.acme.internal", {
        ...env,
        GH_HOST: "git.acme.internal",
      }),
    ).toBe("ghe");
    expect(GitHubCredentials.environmentToken("git.acme.internal", { GH_TOKEN: "gh" })).toBeNull();
  });
});

describe("GitHubApi", () => {
  it.effect("sends GraphQL with the token and records the reported budget", () => {
    const { layer, requests } = harness(() =>
      json({
        data: {
          viewer: { login: "julius" },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2026-10-05T13:00:00Z" },
        },
      }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const body = yield* api.graphql({
        host: "github.com",
        operation: "viewer",
        query: "query { viewer { login } }",
      });
      expect(body).toContain('"login":"julius"');
      expect(requests[0]!.url).toBe("https://api.github.com/graphql");
      expect(requests[0]!.headers.authorization).toBe("Bearer first");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "traces the operation, path, query and cost, never the query string or variables",
    () => {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const { layer } = harness((request) =>
        request.url.endsWith("/graphql")
          ? json(
              {
                data: {
                  viewer: { login: "julius" },
                  rateLimit: {
                    cost: 3,
                    limit: 5000,
                    remaining: 4990,
                    resetAt: "2026-10-05T13:00:00Z",
                  },
                },
              },
              { headers: { "x-ratelimit-remaining": "4990", "x-ratelimit-resource": "graphql" } },
            )
          : json({ ok: true }, { headers: { "x-ratelimit-remaining": "4800" } }),
      );
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const api = yield* GitHubApi.GitHubApi;
        yield* api.graphql({
          host: "github.com",
          operation: "getPullRequestDetail",
          query: "query($body: String!) { viewer { login } }",
          variables: { body: "secret user text" },
        });
        yield* api.rest({
          host: "github.com",
          operation: "listWorkflowRuns",
          path: "repos/acme/web/actions/runs?head_sha=abc123&branch=feat%2Fx",
        });
        const byName = (name: string) => spans.filter((span) => span.name === name);
        const graphql = Object.fromEntries(byName("GitHubApi.graphql")[0]!.attributes);
        expect(graphql).toMatchObject({
          "github.operation": "getPullRequestDetail",
          "github.graphql.query": "query($body: String!) { viewer { login } }",
          "github.graphql.cost": 3,
          "github.graphql.remaining": 4990,
        });
        expect(String(graphql["github.graphql.query_hash"])).toMatch(/^[0-9a-f]{8}$/);
        const rest = Object.fromEntries(byName("GitHubApi.send")[1]!.attributes);
        expect(rest).toMatchObject({
          "github.operation": "listWorkflowRuns",
          "github.kind": "rest",
          "url.path": "/repos/acme/web/actions/runs",
          "http.response.status_code": 200,
          "github.ratelimit.remaining": 4800,
        });
        // Nothing recorded carries the query string, the variables, or the token.
        const everything = spans
          .flatMap((span) => [...span.attributes].map(([key, value]) => `${key}=${String(value)}`))
          .join("\n");
        expect(everything).not.toContain("head_sha");
        expect(everything).not.toContain("secret user text");
        expect(everything).not.toContain("first");
        expect(spans.some((span) => span.attributes.has("url.full"))).toBe(false);
      }).pipe(Effect.provide(layer), Effect.withTracer(tracer));
    },
  );

  it.effect("fails a GraphQL answer that carries errors, naming GitHub's reason", () => {
    const { layer } = harness(() =>
      json({ data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] }),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* Effect.flip(
        api.graphql({ host: "github.com", operation: "detail", query: "query { viewer { id } }" }),
      );
      expect(error._tag).toBe("GitHubApiResponseError");
      expect(error.message).toContain("Resource not accessible");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "reads a NOT_FOUND answer with another error as a failure, not a missing resource",
    () => {
      const { layer } = harness(() =>
        json({
          data: null,
          errors: [
            { type: "NOT_FOUND", message: "Could not resolve" },
            { message: "Something went wrong" },
          ],
        }),
      );
      return Effect.gen(function* () {
        const api = yield* GitHubApi.GitHubApi;
        const error = yield* Effect.flip(
          api.graphql({
            host: "github.com",
            operation: "detail",
            query: "query { viewer { id } }",
          }),
        );
        expect(error._tag).toBe("GitHubApiResponseError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("pauses the host after a GraphQL RATE_LIMITED answer until the reset", () => {
    const reset = Math.floor(NOW / 1000) + 600;
    const { layer, requests } = harness(() =>
      json(
        { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
        { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } },
      ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const first = yield* Effect.flip(
        api.graphql({ host: "github.com", operation: "summary", query: "query { viewer { id } }" }),
      );
      expect(first).toMatchObject({ _tag: "GitHubApiRateLimitError", retryAt: reset * 1000 });
      const second = yield* Effect.flip(
        api.rest({ host: "github.com", operation: "stack", path: "repos/acme/web/stacks" }),
      );
      expect(second).toMatchObject({
        _tag: "SourceControlRateLimitPausedError",
        retryAt: reset * 1000,
      });
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("carries GitHub's own reason for a refused REST request", () => {
    const { layer } = harness(() =>
      json(
        {
          message: "Validation Failed",
          errors: [
            {
              resource: "PullRequest",
              code: "custom",
              message: "A pull request already exists for acme:feature.",
            },
          ],
        },
        { status: 422 },
      ),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* Effect.flip(
        api.rest({
          host: "github.com",
          operation: "createPullRequest",
          method: "POST",
          path: "repos/acme/web/pulls",
        }),
      );
      expect(error.message).toBe(
        "GitHub returned an error: Validation Failed; A pull request already exists for acme:feature.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets an interactive request through a pause a background read recorded", () => {
    const reset = Math.floor(NOW / 1000) + 600;
    let call = 0;
    const { layer, requests } = harness(() =>
      ++call === 1
        ? json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
            },
          )
        : json({ ok: true }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const read = { host: "github.com", operation: "sweep", path: "repos/acme/web/pulls" };
      yield* Effect.flip(api.rest(read));
      expect((yield* Effect.flip(api.rest(read)))._tag).toBe("SourceControlRateLimitPausedError");
      const merged = yield* api
        .rest({
          host: "github.com",
          operation: "merge",
          method: "PUT",
          path: "repos/acme/web/pulls/7/merge",
        })
        .pipe(Effect.provideService(GitHubApi.AllowGitHubReserve, true));
      expect(merged.status).toBe(200);
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads an untyped GraphQL quota error as a rate limit", () => {
    const reset = Math.floor(NOW / 1000) + 900;
    const { layer } = harness(() =>
      json(
        { errors: [{ message: "API rate limit already exceeded for user ID 1." }] },
        { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } },
      ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* Effect.flip(
        api.graphql({ host: "github.com", operation: "lookup", query: "query { viewer { id } }" }),
      );
      expect(error).toMatchObject({ _tag: "GitHubApiRateLimitError", retryAt: reset * 1000 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps REST 403 with an exhausted quota to a rate limit, and 304 to an answer", () => {
    let call = 0;
    const { layer } = harness(() =>
      ++call === 1
        ? new Response(null, { status: 304 })
        : json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: { "retry-after": "60" },
            },
          ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubApi.GitHubApi;
      const notModified = yield* api.rest({
        host: "github.com",
        operation: "checks",
        path: "repos/acme/web/pulls/7",
        ifNoneMatch: '"abc"',
      });
      expect(notModified.status).toBe(304);
      const error = yield* Effect.flip(
        api.rest({ host: "github.com", operation: "checks", path: "repos/acme/web/pulls/7" }),
      );
      expect(error).toMatchObject({ _tag: "GitHubApiRateLimitError", retryAt: NOW + 60_000 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("drops a refused token so the next request asks the source again", () => {
    const { layer, requests, invalidations } = harness((request) =>
      request.headers.authorization === "Bearer first"
        ? new Response(null, { status: 401 })
        : json({ ok: true }),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const refused = yield* Effect.flip(
        api.rest({ host: "github.com", operation: "user", path: "user" }),
      );
      expect(refused._tag).toBe("GitHubApiAuthenticationError");
      expect(invalidations()).toBe(1);
      const answered = yield* api.rest({ host: "github.com", operation: "user", path: "user" });
      expect(answered.status).toBe(200);
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        "Bearer first",
        "Bearer second",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to send a pinned credential to another host", () => {
    const { layer, requests } = harness(() => json({}));
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      const error = yield* Effect.flip(
        api.rest({ host: "git.acme.internal", operation: "user", path: "user" }),
      ).pipe(
        Effect.provideService(GitHubApi.PinnedGitHubCredential, {
          host: "github.com",
          token: Redacted.make("pinned"),
          credentialFingerprint: "github.com:pinned",
        }),
      );
      expect(error._tag).toBe("GitHubApiAuthenticationError");
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHubCredentials", () => {
  const credentialsWith = (run: VcsProcess.VcsProcess["Service"]["run"]) =>
    GitHubCredentials.layer.pipe(
      Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run })),
      Layer.provide(NodeServices.layer),
    );

  it.effect("fails with GitHubCliMissingError when gh is not on PATH", () =>
    Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* Effect.flip(credentials.get("git.acme.internal"));
      expect(error._tag).toBe("GitHubCliMissingError");
    }).pipe(
      Effect.provide(
        credentialsWith(() =>
          Effect.fail(
            new VcsProcessSpawnError({
              operation: "GitHubCredentials.get",
              command: "gh",
              cwd: "/",
              cause: PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
              }),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("does not cache a gh failure that is not about signing in", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const first = yield* Effect.flip(credentials.get("github.com"));
      expect(first._tag).toBe("GitHubCliFailedError");
      expect((yield* credentials.get("github.com")).source).toBe("gh");
      expect(calls).toBe(2);
    }).pipe(
      Effect.provide(
        credentialsWith(() =>
          ++calls === 1
            ? Effect.fail(
                new VcsProcessTimeoutError({
                  operation: "GitHubCredentials.get",
                  command: "gh",
                  cwd: "/",
                  timeoutMs: 10_000,
                }),
              )
            : Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "token\n",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
        ),
      ),
    );
  });

  it.effect("fails with GitHubNotSignedInError when gh prints no token", () =>
    Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* Effect.flip(credentials.get("git.acme.internal"));
      expect(error._tag).toBe("GitHubNotSignedInError");
    }).pipe(
      Effect.provide(
        credentialsWith(() =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        ),
      ),
    ),
  );
});
