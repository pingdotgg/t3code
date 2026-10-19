import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import * as SourceControlReadContext from "@t3tools/source-control-core/server/SourceControlReadContext";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessSpawnError, VcsProcessTimeoutError } from "@t3tools/contracts";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function harness(
  respond: (request: HttpClientRequest.HttpClientRequest) => Response | Effect.Effect<Response>,
) {
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
      const response = respond(request);
      return Effect.map(Effect.isEffect(response) ? response : Effect.succeed(response), (value) =>
        HttpClientResponse.fromWeb(request, value),
      );
    }),
  );
  const layer = GitHubRest.layer.pipe(
    Layer.provide(Layer.mergeAll(credentials, http)),
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

describe("gitHubApiUrls", () => {
  it("maps github.com, GHE.com and GitHub Enterprise Server", () => {
    expect(GitHubRequestPolicy.gitHubApiUrls("GitHub.com")).toEqual({
      rest: "https://api.github.com",
      graphql: "https://api.github.com/graphql",
    });
    expect(GitHubRequestPolicy.gitHubApiUrls("acme.ghe.com").graphql).toBe(
      "https://api.acme.ghe.com/graphql",
    );
    expect(GitHubRequestPolicy.gitHubApiUrls("git.acme.internal")).toEqual({
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

describe("GitHubRest", () => {
  it.effect("ordinary reads pass a background backlog while both share eight HTTP slots", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const full = yield* Deferred.make<void>();
      const order: string[] = [];
      let active = 0;
      let maximum = 0;
      const h = harness((request) =>
        Effect.gen(function* () {
          const path = new URL(request.url).pathname.slice(1);
          order.push(path);
          maximum = Math.max(maximum, ++active);
          if (active === 8) yield* Deferred.succeed(full, undefined);
          if (path.startsWith("held-")) yield* Deferred.await(release);
          return json({ ok: true });
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active--;
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const api = yield* GitHubRest.GitHubRest;
        const read = (path: string, background: boolean) =>
          api
            .rest({
              host: "github.com",
              operation: "admission",
              path,
            })
            .pipe(Effect.provideService(SourceControlReadContext.Background, background));
        const held = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, i) => i),
          (i) => read(`held-${i}`, true).pipe(Effect.forkChild({ startImmediately: true })),
        );
        yield* Deferred.await(full);
        const backlog = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, i) => i),
          (i) => read(`background-${i}`, true).pipe(Effect.forkChild({ startImmediately: true })),
        );
        const ordinary = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, i) => i),
          (worker) =>
            Effect.forEach(
              Array.from({ length: 10 }, (_, i) => i),
              (i) => read(`ordinary-${worker}-${i}`, false),
            ).pipe(Effect.forkChild({ startImmediately: true })),
        );
        expect(order).toHaveLength(8);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach([...held, ...backlog], Fiber.join);
        yield* Effect.forEach(ordinary, Fiber.join);
        expect(order.findIndex((path) => path.startsWith("ordinary-"))).toBeLessThanOrEqual(10);
        let remaining = 8;
        let streak = 0;
        let longestStreak = 0;
        for (const path of order.slice(8)) {
          if (path.startsWith("background-")) {
            remaining--;
            streak = 0;
          } else if (remaining > 0) longestStreak = Math.max(longestStreak, ++streak);
        }
        expect(longestStreak).toBeLessThanOrEqual(16);
        expect(maximum).toBe(8);
        expect(active).toBe(0);
        expect(order).toHaveLength(96);
        expect(new Set(order).size).toBe(96);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect(
    "canceling queued reads and admission handoffs leaves all eight HTTP slots usable",
    () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const full = yield* Deferred.make<void>();
        const replacementsFull = yield* Deferred.make<void>();
        const releaseReplacements = yield* Deferred.make<void>();
        let active = 0;
        let maximum = 0;
        const h = harness((request) =>
          Effect.gen(function* () {
            maximum = Math.max(maximum, ++active);
            const path = new URL(request.url).pathname;
            if (path.startsWith("/held-")) {
              if (active === 8) yield* Deferred.succeed(full, undefined);
              yield* Deferred.await(release);
            } else if (path.startsWith("/replacement-")) {
              if (active === 8) yield* Deferred.succeed(replacementsFull, undefined);
              yield* Deferred.await(releaseReplacements);
            }
            return json({ ok: true });
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active--;
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const api = yield* GitHubRest.GitHubRest;
          const start = (path: string) =>
            api
              .rest({ host: "github.com", operation: "admission", path })
              .pipe(
                Effect.provideService(SourceControlReadContext.Background, true),
                Effect.forkChild({ startImmediately: true }),
              );
          const held = yield* Effect.forEach(
            Array.from({ length: 8 }, (_, i) => `held-${i}`),
            start,
          );
          yield* Deferred.await(full);
          const globalWaiter = yield* start("canceled-global");
          const admissionWaiter = yield* start("canceled-admission");
          yield* TestClock.adjust("0 millis");
          yield* Fiber.interrupt(admissionWaiter);
          yield* Fiber.interrupt(globalWaiter);
          const waiting = yield* Effect.forEach(
            Array.from({ length: 16 }, (_, i) => `queued-${i}`),
            start,
          );
          yield* TestClock.adjust("0 millis");
          yield* Deferred.succeed(release, undefined);
          yield* Effect.forEach(
            waiting.filter((_, i) => i % 2 === 0),
            Fiber.interrupt,
          );
          yield* Effect.forEach([...held, ...waiting.filter((_, i) => i % 2 === 1)], Fiber.join);
          expect(active).toBe(0);
          const replacements = yield* Effect.forEach(
            Array.from({ length: 8 }, (_, i) => `replacement-${i}`),
            start,
          );
          yield* Deferred.await(replacementsFull);
          expect(active).toBe(8);
          yield* Deferred.succeed(releaseReplacements, undefined);
          yield* Effect.forEach(replacements, Fiber.join);
          expect(maximum).toBe(8);
          expect(active).toBe(0);
          expect(h.requests.some((request) => request.url.includes("canceled-"))).toBe(false);
        }).pipe(Effect.provide(h.layer));
      }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 16)),
  );

  it.effect("traces the operation, path and quota, never the query string or the token", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const { layer } = harness(() =>
      json({ ok: true }, { headers: { "x-ratelimit-remaining": "4800" } }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubRest.GitHubRest;
      yield* api.rest({
        host: "github.com",
        operation: "listWorkflowRuns",
        path: "repos/acme/web/actions/runs?head_sha=abc123&branch=feat%2Fx",
      });
      const send = spans.find((span) => span.name === "GitHubRest.send")!;
      expect(Object.fromEntries(send.attributes)).toMatchObject({
        "github.operation": "listWorkflowRuns",
        "github.kind": "rest",
        "url.path": "/repos/acme/web/actions/runs",
        "http.response.status_code": 200,
        "github.ratelimit.remaining": 4800,
      });
      // Nothing recorded carries the query string or the token.
      const everything = spans
        .flatMap((span) => [...span.attributes].map(([key, value]) => `${key}=${String(value)}`))
        .join("\n");
      expect(everything).not.toContain("head_sha");
      expect(everything).not.toContain("first");
      expect(spans.some((span) => span.attributes.has("url.full"))).toBe(false);
    }).pipe(Effect.provide(layer), Effect.withTracer(tracer));
  });

  it.effect("keeps the last tenth of a quota for interactive requests until it resets", () => {
    const reset = Math.floor(NOW / 1000) + 600;
    const quota = (remaining: number) => ({
      "x-ratelimit-resource": "core",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-reset": String(reset),
    });
    let remaining = 499;
    const { layer, requests } = harness(() => json({ ok: true }, { headers: quota(remaining--) }));
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubRest.GitHubRest;
      const read = { host: "github.com", operation: "sweep", path: "repos/acme/web/pulls" };
      yield* api.rest(read);
      const refused = yield* Effect.flip(api.rest(read));
      expect(refused).toMatchObject({
        _tag: "SourceControlRateLimitPausedError",
        retryAt: reset * 1000,
      });
      const backgroundRefused = yield* Effect.flip(
        api.rest(read).pipe(Effect.provideService(SourceControlReadContext.Background, true)),
      );
      expect(backgroundRefused._tag).toBe("SourceControlRateLimitPausedError");
      // A user's own request may spend the reserve.
      yield* api.rest(read).pipe(Effect.provideService(SourceControlRateLimit.Interactive, true));
      expect(requests).toHaveLength(2);
      // The reset gives the background its quota back.
      yield* TestClock.setTime(reset * 1000);
      yield* api.rest(read);
      expect(requests).toHaveLength(3);
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
      const api = yield* GitHubRest.GitHubRest;
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
      const api = yield* GitHubRest.GitHubRest;
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
        .pipe(Effect.provideService(SourceControlRateLimit.Interactive, true));
      expect(merged.status).toBe(200);
      expect(requests).toHaveLength(2);
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
      const api = yield* GitHubRest.GitHubRest;
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
      const api = yield* GitHubRest.GitHubRest;
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
      const api = yield* GitHubRest.GitHubRest;
      const error = yield* Effect.flip(
        api.rest({ host: "git.acme.internal", operation: "user", path: "user" }),
      ).pipe(
        Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
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
  const credentialsWith = (run: SourceControlHost.SourceControlHost["Service"]["process"]["run"]) =>
    GitHubCredentials.layer.pipe(
      Layer.provide(TestSourceControlHost.layer({ process: { run } })),
      Layer.provide(NodeCrypto.layer),
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
