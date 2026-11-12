import { assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { VcsProcessExitError } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as AzureDevOpsRest from "./AzureDevOpsRest.ts";

const ACME = "https://dev.azure.com/acme/p1/_apis/git/repositories/r1/pullRequests/7/threads";
const GLOBEX = "https://dev.azure.com/globex/p1/_apis/git/repositories/r1/pullRequests/7/threads";

const tokenJson = (token: string, expiresOn: number) =>
  JSON.stringify({ accessToken: token, expires_on: expiresOn, tokenType: "Bearer" });

function setup(input: {
  readonly respond: (request: HttpClientRequest.HttpClientRequest) => Response;
  readonly issue?: () => Effect.Effect<string, VcsProcessExitError>;
}) {
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    (input.issue ?? (() => Effect.succeed(tokenJson("t1", 3600))))().pipe(
      Effect.map((stdout) => TestSourceControlHost.processOutput(stdout)),
    ),
  );
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, input.respond(request))),
  );
  const layer = AzureDevOpsRest.layer.pipe(
    Layer.provide(TestSourceControlHost.layer({ process: { run } })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
  );
  const read = (url: string) =>
    AzureDevOpsRest.AzureDevOpsRest.use((rest) =>
      rest.getJson({ cwd: "/w", url, maxOutputBytes: 1_000_000 }),
    );
  return { run, execute, layer, read };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

it.effect("reads with one Entra token until it is due for renewal", () => {
  const { run, execute, layer, read } = setup({ respond: () => ok({ value: [] }) });
  return Effect.gen(function* () {
    assert.deepStrictEqual(yield* read(ACME), Option.some('{"value":[]}'));
    yield* read(ACME);
    expect(run).toHaveBeenCalledTimes(1);
    const request = execute.mock.calls[0]?.[0];
    expect(request?.url).toBe(`${ACME}?api-version=7.1`);
    expect(request?.headers.authorization).toBe("Bearer t1");

    // The token expires at 3,600 s and is renewed five minutes early.
    yield* TestClock.adjust("3300 seconds");
    yield* read(ACME);
    expect(run).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer));
});

it.effect("leaves an organization that refuses the token to az, and only that one", () => {
  const { execute, layer, read } = setup({
    respond: (request) =>
      request.url.includes("/acme/") ? new Response(null, { status: 401 }) : ok({ value: [] }),
  });
  return Effect.gen(function* () {
    assert.isTrue(Option.isNone(yield* read(ACME)));
    assert.isTrue(Option.isNone(yield* read(ACME)));
    assert.isTrue(Option.isSome(yield* read(GLOBEX)));
    expect(execute.mock.calls.map(([request]) => request.url)).toEqual([
      `${ACME}?api-version=7.1`,
      `${GLOBEX}?api-version=7.1`,
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("takes a sign-in page in place of JSON as a refusal", () => {
  const { execute, layer, read } = setup({
    respond: () =>
      new Response("<html>Sign in</html>", {
        status: 203,
        headers: { "content-type": "text/html" },
      }),
  });
  return Effect.gen(function* () {
    assert.isTrue(Option.isNone(yield* read(ACME)));
    assert.isTrue(Option.isNone(yield* read(ACME)));
    expect(execute).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(layer));
});

it.effect("hands any other failed response to az without giving up on the organization", () => {
  const { execute, layer, read } = setup({ respond: () => new Response(null, { status: 404 }) });
  return Effect.gen(function* () {
    assert.isTrue(Option.isNone(yield* read(ACME)));
    assert.isTrue(Option.isNone(yield* read(ACME)));
    expect(execute).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer));
});

it.effect("does not ask az for a token again soon after it could not issue one", () => {
  const { run, execute, layer, read } = setup({
    respond: () => ok({}),
    issue: () =>
      Effect.fail(
        new VcsProcessExitError({
          operation: "AzureDevOpsRest.issueToken",
          command: "az",
          cwd: "/w",
          exitCode: 1,
          detail: "Please run 'az login' to setup account.",
        }),
      ),
  });
  return Effect.gen(function* () {
    assert.isTrue(Option.isNone(yield* read(ACME)));
    assert.isTrue(Option.isNone(yield* read(ACME)));
    expect(run).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer));
});

it.effect("hands a response past the output budget to az", () => {
  const { layer } = setup({ respond: () => ok({ content: "x".repeat(64) }) });
  return AzureDevOpsRest.AzureDevOpsRest.use((rest) =>
    rest.getJson({ cwd: "/w", url: ACME, maxOutputBytes: 16 }),
  ).pipe(
    Effect.map((body) => assert.isTrue(Option.isNone(body))),
    Effect.provide(layer),
  );
});

it.effect("sends no token to a host outside Azure DevOps Services", () => {
  const { run, execute, layer, read } = setup({ respond: () => ok({}) });
  return Effect.gen(function* () {
    for (const url of [
      "https://attacker.example/p1/_apis/git/repositories/r1/pullRequests/7/threads",
      "https://tfs.example.com/tfs/c/p1/_apis/git/repositories/r1/pullRequests/7/threads",
      "https://dev.azure.com@attacker.example/acme/_apis/git/repositories/r1/items",
      "https://dev.azure.com:8443/acme/p1/_apis/git/repositories/r1/items",
    ]) {
      assert.isTrue(Option.isNone(yield* read(url)));
    }
    expect(run).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer));
});

it.effect(
  "gives a stalled request up to az after 30 seconds, and tries REST again next time",
  () => {
    const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
      Effect.succeed(TestSourceControlHost.processOutput(tokenJson("t1", 3600))),
    );
    const execute = vi.fn((_request: HttpClientRequest.HttpClientRequest) => Effect.never);
    const layer = AzureDevOpsRest.layer.pipe(
      Layer.provide(TestSourceControlHost.layer({ process: { run } })),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
    );
    const read = AzureDevOpsRest.AzureDevOpsRest.use((rest) =>
      rest.getJson({ cwd: "/w", url: ACME, maxOutputBytes: 1_000_000 }),
    );
    return Effect.gen(function* () {
      const first = yield* Effect.forkChild(read);
      yield* TestClock.adjust("30 seconds");
      assert.isTrue(Option.isNone(yield* Fiber.join(first)));
      const second = yield* Effect.forkChild(read);
      yield* TestClock.adjust("30 seconds");
      yield* Fiber.join(second);
      expect(execute).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer));
  },
);
