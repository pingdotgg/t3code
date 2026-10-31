import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A real socket server verifies the HTTP wire format.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The socket fixture owns its temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Keep the native socket path within the temporary directory.
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
import { HttpClient, HttpClientResponse, HttpClientRequest } from "effect/http";
import { GraphQLClient } from "effect/graphql";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubHttpClient from "./GitHubHttpClient.ts";
import * as GitHubGraphQlClient from "./gitHubGraphQlClient.ts";
import { PullRequestBatchesGraphQLGroup } from "./pullRequestBatches.graphql.ts";
import { driver } from "./driver.ts";

const appSignedOut = Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
  enabled: false,
  token: () => Effect.succeedNone,
  invalidate: () => Effect.void,
});

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
      saved: () => Effect.succeedNone,
      fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
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
    Layer.provide(Layer.mergeAll(credentials, http, appSignedOut)),
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
  it.live("routes REST and GraphQL through gh's plain HTTP Unix socket", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gh-"))),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      const socketPath = NodePath.join(directory, "api.sock");
      const requests: Array<{
        method: string | undefined;
        path: string | undefined;
        headers: NodeHttp.IncomingHttpHeaders;
        body: string;
      }> = [];
      const server = NodeHttp.createServer(async (request, response) => {
        const chunks: Array<Buffer> = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        requests.push({
          method: request.method,
          path: request.url,
          headers: request.headers,
          body,
        });
        response.statusCode = request.url === "/user/starred/acme/web" ? 204 : 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            body.includes("query PullRequestByNumber")
              ? {
                  data: {
                    repository: {
                      pullRequest: {
                        number: 7,
                        title: "Socket request",
                        url: "https://github.com/acme/web/pull/7",
                        baseRefName: "main",
                        headRefName: "feature",
                        headRefOid: "f".repeat(40),
                        state: "OPEN",
                        isDraft: false,
                        mergedAt: null,
                        closedAt: null,
                        updatedAt: "2026-01-02T00:00:00Z",
                        isCrossRepository: false,
                        headRepository: { name: "web", nameWithOwner: "acme/web" },
                        headRepositoryOwner: { __typename: "User", login: "acme" },
                      },
                    },
                  },
                }
              : request.url?.endsWith("graphql")
                ? { data: { repository: { pullRequest: { additions: 3, deletions: 1 } } } }
                : { login: "proxy-user" },
          ),
        );
      });
      yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(socketPath, resolve);
            }),
        ),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              ),
          ),
      );
      const directRequests: Array<string> = [];
      const fallback = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          directRequests.push(request.url);
          return Effect.succeed(HttpClientResponse.fromWeb(request, json({}, { status: 401 })));
        }),
      );
      const host = TestSourceControlHost.layer({
        process: {
          run: (input) => {
            expect(input.command).toBe("gh");
            if (input.args[0] === "config") {
              expect(input.args).toEqual(["config", "get", "http_unix_socket"]);
              return Effect.succeed(TestSourceControlHost.processOutput(`${socketPath}\n`));
            }
            expect(input.args.slice(0, 2)).toEqual(["auth", "token"]);
            return Effect.succeed(TestSourceControlHost.processOutput("placeholder\n"));
          },
        },
      });
      const layer = GitHubRest.layerWithDependencies.pipe(
        Layer.provideMerge(GitHubHttpClient.layer),
        Layer.provide(
          Layer.mergeAll(host, fallback, NodeServices.layer, SourceControlRateLimit.layer),
        ),
      );
      yield* Effect.gen(function* () {
        const rest = yield* GitHubRest.GitHubRest;
        const client = yield* GraphQLClient.make(
          PullRequestBatchesGraphQLGroup.middleware(GitHubGraphQlClient.GitHubGraphQlAuth),
        ).pipe(Effect.provide(GitHubGraphQlClient.layer));
        for (const [host, apiHost, root] of [
          ["github.com", "api.github.com", ""],
          ["git.acme.test:8443", "git.acme.test:8443", "/api/v3"],
        ] as const) {
          const answer = yield* rest.rest({
            host,
            operation: "user",
            path: "user?per_page=1",
          });
          expect(JSON.parse(answer.body)).toEqual({ login: "proxy-user" });
          const stats = yield* client
            .PullRequestStats({ owner: "acme", name: "web", number: 7 })
            .pipe(GitHubGraphQlClient.call({ host, operation: "stats" }));
          expect(stats).toEqual({ repository: { pullRequest: { additions: 3, deletions: 1 } } });
          const [restRequest, graphqlRequest] = requests.slice(-2);
          expect(restRequest).toMatchObject({ method: "GET", path: `${root}/user?per_page=1` });
          expect(graphqlRequest).toMatchObject({
            method: "POST",
            path: root === "" ? "/graphql" : "/api/graphql",
          });
          for (const request of [restRequest!, graphqlRequest!]) {
            expect(request.headers).toMatchObject({
              host: apiHost,
              authorization: "Bearer placeholder",
              "user-agent": "t3code",
              "x-github-api-version": "2022-11-28",
            });
          }
          expect(JSON.parse(graphqlRequest!.body).variables).toEqual({
            owner: "acme",
            name: "web",
            number: 7,
          });
        }
        const instance = yield* driver.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              host,
              fallback,
              NodeServices.layer,
              NodeCrypto.layer,
              SourceControlRateLimit.layer,
            ),
          ),
        );
        const reference = yield* instance.sourceControl.getChangeRequest({
          cwd: directory,
          reference: "https://github.com/acme/web/pull/7",
        });
        expect(reference.number).toBe(7);
        expect(requests.at(-1)?.body).toContain("query PullRequestByNumber");
        expect(yield* instance.isRepositoryStarred!("github.com", "acme/web")).toBe(true);
        expect(requests.at(-1)?.path).toBe("/user/starred/acme/web");
        yield* Effect.promise(() => NodeFSP.unlink(socketPath));
        const error = yield* Effect.flip(
          rest.rest({ host: "github.com", operation: "user", path: "user" }),
        );
        expect(error._tag).toBe("GitHubApiRequestError");
        expect(directRequests).toEqual([]);
        const mediaUrl = "https://objects.githubusercontent.com/proof.png";
        const media = yield* instance.fetchMedia!({ url: mediaUrl, headers: {} });
        expect(media?.status).toBe(401);
        expect(directRequests).toEqual([mediaUrl]);
      }).pipe(Effect.provide(layer), Effect.provideService(HostProcess.Environment, {}));
    }).pipe(Effect.scoped),
  );

  it.effect.each(["", "unavailable"])(
    "keeps the existing HTTP client when gh's socket is %s",
    (config) => {
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const fallback = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, json({ login: "direct-user" })),
          );
        }),
      );
      const host = TestSourceControlHost.layer({
        process: {
          run: () =>
            config === ""
              ? Effect.succeed(TestSourceControlHost.processOutput("\n"))
              : Effect.fail(
                  new VcsProcessTimeoutError({
                    operation: "GitHubHttpClient.config",
                    command: "gh",
                    cwd: "/",
                    timeoutMs: 10_000,
                  }),
                ),
        },
      });
      return Effect.gen(function* () {
        const api = yield* HttpClient.HttpClient;
        const answer = yield* api.execute(
          HttpClientRequest.get("https://api.github.com/user").pipe(
            HttpClientRequest.bearerToken("first"),
          ),
        );
        expect(yield* answer.json).toEqual({ login: "direct-user" });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          url: "https://api.github.com/user",
          headers: { authorization: "Bearer first" },
        });
      }).pipe(
        Effect.provide(GitHubHttpClient.layer.pipe(Layer.provide(Layer.merge(host, fallback)))),
      );
    },
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
      const everything = spans
        .flatMap((span) => [...span.attributes].map(([key, value]) => `${key}=${String(value)}`))
        .join("\n");
      expect(everything).not.toContain("head_sha");
      expect(everything).not.toContain("first");
      expect(spans.some((span) => span.attributes.has("url.full"))).toBe(false);
    }).pipe(Effect.provide(layer), Effect.withTracer(tracer));
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
  const unexpectedHttp = HttpClient.make((request) =>
    Effect.die(`Unexpected request to ${request.url}`),
  );
  const credentialsWith = (run: SourceControlHost.SourceControlHost["Service"]["process"]["run"]) =>
    GitHubCredentials.layer.pipe(
      Layer.provide(TestSourceControlHost.layer({ process: { run } })),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, unexpectedHttp)),
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
