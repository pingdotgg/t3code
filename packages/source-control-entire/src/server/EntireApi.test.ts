import { assert, describe, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as EntireCli from "./EntireCli.ts";

import * as EntireApi from "./EntireApi.ts";
import { API_ORIGIN, fakeEntire, REMOTE_URL } from "./entireTestServer.ts";

const request = { cwd: "/repo", repository: "gh/acme/web", operation: "test" } as const;

describe("EntireApi", () => {
  it.effect.each([
    [new EntireCli.EntireCliMissingError(), "missing-tool"],
    [new EntireCli.EntireNotSignedInError(), "unauthenticated"],
    [
      new EntireCli.EntireCliFailedError({
        operation: "find repository",
        detail: "private command output",
      }),
      "failed",
    ],
  ] as const)("keeps CLI failures in the cause with reason %s", ([cause, reason]) => {
    const server = fakeEntire({});
    return Effect.gen(function* () {
      const cli = yield* EntireCli.EntireCli;
      const api = yield* EntireApi.make.pipe(
        Effect.provideService(EntireCli.EntireCli, {
          ...cli,
          repository: () => Effect.fail(cause),
        }),
        Effect.provide(FetchHttpClient.layer),
      );
      const error = yield* api
        .requestJson({ ...request, path: "/trails/7" }, Schema.Unknown)
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, reason);
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, "private command output");
      assert.deepStrictEqual(server.sent, []);
    }).pipe(Effect.provide(server.layer));
  });
  it.effect("sends the CLI's bearer to the repository's cell and never follows a redirect", () => {
    const server = fakeEntire({ "GET /trails/7": { ok: true } });
    return Effect.gen(function* () {
      const api = yield* EntireApi.EntireApi;
      yield* api.requestJson({ ...request, path: "/trails/7" }, Schema.Unknown);
      assert.deepStrictEqual(
        server.sent.map((sent) => [sent.origin, sent.path, sent.authorization, sent.redirect]),
        [[API_ORIGIN, "/trails/7", "Bearer ent_token", "manual"]],
      );
      // The checkout's own clone URL names the cluster to the CLI.
      assert.deepStrictEqual(server.references, [REMOTE_URL]);
    }).pipe(Effect.provide(server.layer));
  });

  const unreadableRemote = (cwd: string) =>
    Effect.fail(
      new GitCommandError({
        operation: "resolvePrimaryRemoteName",
        command: "git remote",
        cwd,
        detail: "not a git repository",
      }),
    );
  it.effect.each([
    ["is another repository", { remoteUrl: "git@github.com:acme/web.git" }],
    ["is missing", { remoteUrl: null }],
    // `repo view /gh/...` still resolves through the active login.
    ["is unreadable", { git: { resolvePrimaryRemoteName: unreadableRemote } }],
  ] as const)("names a repository by path when the checkout's remote %s", ([, options]) => {
    const server = fakeEntire({ "GET /trails/7": { ok: true } }, options);
    return Effect.gen(function* () {
      const api = yield* EntireApi.EntireApi;
      yield* api.requestJson({ ...request, path: "/trails/7" }, Schema.Unknown);
      assert.deepStrictEqual(server.references, ["/gh/acme/web"]);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("skips reading git when the caller already names the remote", () => {
    const server = fakeEntire(
      { "GET /trails/7": { ok: true } },
      {
        git: {
          resolvePrimaryRemoteName: () => Effect.die("git must not be read"),
        },
      },
    );
    const remoteUrl = "entire://aws-eu-west-1.entire.io/gh/acme/web.git";
    return Effect.gen(function* () {
      const api = yield* EntireApi.EntireApi;
      yield* api.requestJson({ ...request, remoteUrl, path: "/trails/7" }, Schema.Unknown);
      assert.deepStrictEqual(server.references, [remoteUrl]);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each([
    "http://aws-us-east-2.api.entire.io",
    "https://api.entire.io.evil.example",
    "https://user:pass@aws-us-east-2.api.entire.io",
    "https://aws-us-east-2.api.entire.io:8443",
    "https://entire.io",
  ])("refuses to send a token to %s", (apiUrl) => {
    const server = fakeEntire({}, { apiUrl });
    return Effect.gen(function* () {
      const api = yield* EntireApi.EntireApi;
      const error = yield* api
        .requestJson({ ...request, path: "/trails/7" }, Schema.Unknown)
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "failed");
      assert.deepStrictEqual(server.sent, []);
      assert.strictEqual(server.tokenReads(), 0);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("refuses a repository that is not gh/ or et/ before resolving it", () => {
    const server = fakeEntire({});
    return Effect.gen(function* () {
      const api = yield* EntireApi.EntireApi;
      yield* api
        .requestJson({ ...request, repository: "acme/web", path: "" }, Schema.Unknown)
        .pipe(Effect.flip);
      assert.deepStrictEqual(server.references, []);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each([
    [401, "unauthenticated", 1],
    [404, "not-found", 0],
    [429, "rate-limited", 0],
    [500, "failed", 0],
  ] as const)("answers HTTP %i as %s", ([status, reason, invalidations]) => {
    const server = fakeEntire({ "GET /trails/7": { detail: "Nope" } }, { status });
    return Effect.gen(function* () {
      const api = yield* EntireApi.EntireApi;
      const error = yield* api
        .requestJson({ ...request, path: "/trails/7" }, Schema.Unknown)
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, reason);
      assert.strictEqual(error.detail, "Nope");
      // A refused token is dropped, since the CLI may hold a refreshed one.
      assert.strictEqual(server.invalidations(), invalidations);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("reads a bare error code when a route answers without a problem body", () => {
    const server = fakeEntire(
      { "POST /trails/7/merge": { error: "merge_gates_failed" } },
      { status: 422 },
    );
    return Effect.gen(function* () {
      const api = yield* EntireApi.EntireApi;
      const error = yield* api
        .requestJson(
          { ...request, method: "POST", path: "/trails/7/merge", body: {} },
          Schema.Unknown,
        )
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "failed");
      assert.strictEqual(error.detail, "merge gates failed");
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("says when a repository has trails turned off", () => {
    const server = fakeEntire(
      { "GET /trails": { detail: "repository not found" } },
      { status: 404 },
    );
    return Effect.gen(function* () {
      const api = yield* EntireApi.EntireApi;
      const error = yield* api
        .requestJson({ ...request, path: "/trails" }, Schema.Unknown)
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "not-found");
      assert.include(error.detail, "Trails aren't turned on");
    }).pipe(Effect.provide(server.layer));
  });

  it("accepts only an Entire API origin over TLS", () => {
    assert.strictEqual(
      EntireApi.entireApiOrigin("https://aws-us-east-2.api.entire.io/"),
      "https://aws-us-east-2.api.entire.io",
    );
    assert.isNull(EntireApi.entireApiOrigin("https://example.com"));
  });
});
