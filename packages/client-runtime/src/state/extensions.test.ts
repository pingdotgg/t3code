import { describe, it, expect } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { environmentExtensionsHttp } from "./extensions.ts";
const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("env"),
  label: "Fixture",
  httpBaseUrl: "https://fixture.example/base",
  wsBaseUrl: "wss://fixture.example",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: "wss://fixture.example/ws",
  httpAuthorization: null,
  target,
};
describe("environment extension HTTP", () => {
  it.effect("uses the prepared environment's cookie and exact route", () =>
    Effect.gen(function* () {
      const calls: RequestInit[] = [];
      const result = yield* environmentExtensionsHttp.list(prepared).pipe(
        Effect.provide(
          remoteHttpClientLayer((url, init) => {
            expect(String(url)).toBe("https://fixture.example/api/extensions/list");
            calls.push(init ?? {});
            return Promise.resolve(Response.json({ installations: [] }));
          }),
        ),
      );
      expect(result.installations).toEqual([]);
      expect(calls[0]?.credentials).toBe("include");
      expect(calls[0]?.method).toBe("POST");
    }),
  );
  it.effect("sends bearer authorization and rejects malformed package responses", () =>
    Effect.gen(function* () {
      const result = yield* environmentExtensionsHttp
        .client(
          { ...prepared, httpAuthorization: { _tag: "Bearer", token: "fixture-token" } },
          { id: "test.reader", expectedContentHash: "a".repeat(64) },
        )
        .pipe(
          Effect.provide(
            remoteHttpClientLayer((_url, init) => {
              expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
              return Promise.resolve(
                Response.json({ code: "export default null", contentHash: "wrong" }),
              );
            }),
          ),
          Effect.result,
        );
      expect(result._tag).toBe("Failure");
    }),
  );
});

describe("binary installed package assets", () => {
  for (const bearer of [false, true]) {
    it.effect(
      bearer
        ? "delivers exact binary over bearer connection"
        : "delivers exact binary over cookie connection",
      () =>
        Effect.gen(function* () {
          const input = {
            id: "example.asset",
            expectedContentHash: "a".repeat(64),
            path: "assets/core.wasm",
          };
          const bytes = new Uint8Array([0, 97, 115, 109, 0, 255]);
          const result = yield* environmentExtensionsHttp
            .asset(
              bearer
                ? { ...prepared, httpAuthorization: { _tag: "Bearer", token: "asset-fixture" } }
                : prepared,
              input,
            )
            .pipe(
              Effect.provide(
                remoteHttpClientLayer((url, init) => {
                  expect(String(url)).toBe("https://fixture.example/api/extensions/asset");
                  expect(init?.method).toBe("POST");
                  const request = new Request(String(url), init);
                  return request.json().then((body) => {
                    expect(body).toEqual(input);
                    if (bearer)
                      expect(new Headers(init?.headers).get("authorization")).toBe(
                        "Bearer asset-fixture",
                      );
                    else expect(init?.credentials).toBe("include");
                    return Promise.resolve(
                      new Response(bytes, {
                        headers: {
                          "content-type": "application/octet-stream",
                          "cache-control": "no-store",
                          "x-content-type-options": "nosniff",
                        },
                      }),
                    );
                  });
                }),
              ),
            );
          expect(result).toEqual(bytes);
        }),
    );
  }
});

describe("extension API invocation deadlines", () => {
  const invocation = (method: string, id = "t3.browser/profiles") => ({
    installationId: "example.browser",
    expectedContentHash: "a".repeat(64),
    request: {
      id,
      versionRange: "^1.0.0",
      method,
      input: {},
      context: {
        resource: { namespace: "t3.thread", id: "thread", environmentId: target.environmentId },
        client: "web",
      },
    },
  });
  /** Answers only when the test says so: the user still deciding on the host. */
  const delayedServer = () => {
    let fetched!: () => void;
    const started = new Promise<void>((resolve) => (fetched = resolve));
    let answer!: (response: Response) => void;
    const answered = new Promise<Response>((resolve) => (answer = resolve));
    const layer = remoteHttpClientLayer((url) => {
      expect(String(url)).toBe("https://fixture.example/api/extensions/api/invoke");
      fetched();
      return answered;
    });
    return { started, answer, layer };
  };

  it.effect("cookie import outlives a confirmation held past the default deadline", () =>
    Effect.gen(function* () {
      const server = delayedServer();
      const fiber = yield* environmentExtensionsHttp
        .invokeApi(prepared, invocation("importCookies"))
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* Effect.promise(() => server.started);
      // Just inside the server broker's import deadline (5 min wait + 30s).
      yield* TestClock.adjust("329 seconds");
      server.answer(Response.json({ result: { imported: 3 } }));
      const result = yield* Fiber.join(fiber);
      expect(result.result).toEqual({ imported: 3 });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("a pull request handoff outlives a checkout held past the default deadline", () =>
    Effect.gen(function* () {
      const server = delayedServer();
      const fiber = yield* environmentExtensionsHttp
        .invokeApi(prepared, invocation("handoffPullRequest", "t3.vcs/actions"))
        .pipe(Effect.provide(server.layer), Effect.result, Effect.forkChild);
      yield* Effect.promise(() => server.started);
      // Just inside the server broker's whole handoff deadline.
      yield* TestClock.adjust("359 seconds");
      server.answer(Response.json({ result: { status: "drafted" } }));
      const result = yield* Fiber.join(fiber);
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") expect(result.success.result).toEqual({ status: "drafted" });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("every other API method keeps the 30-second deadline", () =>
    Effect.gen(function* () {
      const server = delayedServer();
      const fiber = yield* environmentExtensionsHttp
        .invokeApi(prepared, invocation("listImportSources"))
        .pipe(Effect.provide(server.layer), Effect.result, Effect.forkChild);
      yield* Effect.promise(() => server.started);
      yield* TestClock.adjust("31 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure._tag).toBe("RemoteEnvironmentAuthTimeoutError");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
