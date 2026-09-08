import { safeHttpEffect } from "@/Http";
import { bindFunction } from "@/Railway/Bind.ts";
import { serveRailwayRpc } from "@/Railway/rpc-server.ts";
import {
  RPC_PATH_PREFIX,
  RPC_TOKEN_ENV,
  RPC_TOKEN_HEADER,
} from "@/Railway/rpc-token.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const TOKEN = "a".repeat(64);
const PRIVATE_URL = "http://greeter.railway.internal:3000";
const PUBLIC_URL = "https://greeter.up.railway.app";

const shape = {
  greet: (name: string) => Effect.succeed(`hello ${name}`),
};

const fallback = Effect.succeed(HttpServerResponse.text("ok"));

const webHandler = HttpEffect.toWebHandler(
  safeHttpEffect(serveRailwayRpc(shape, fallback)),
);

const fetchImpl = ((url: any, init?: any) => {
  const href = typeof url === "string" ? url : String(url);
  const parsed = new URL(href);
  const headers = new Headers(init?.headers);
  headers.set("host", parsed.host);
  return webHandler(new Request(href, { ...init, headers }));
}) as typeof globalThis.fetch;

const withEnv = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    const previous = process.env[RPC_TOKEN_ENV];
    process.env[RPC_TOKEN_ENV] = TOKEN;
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) {
            delete process.env[RPC_TOKEN_ENV];
          } else {
            process.env[RPC_TOKEN_ENV] = previous;
          }
        }),
      ),
    );
  });

const rpcPost = (url: string, headers: Record<string, string> = {}) =>
  webHandler(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(["sam"]),
    }),
  );

describe.sequential("Railway private-mesh RPC", () => {
  it("serves value methods on the private mesh with the token", () =>
    withEnv(
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          rpcPost(`${PRIVATE_URL}${RPC_PATH_PREFIX}greet`, {
            host: "greeter.railway.internal:3000",
            [RPC_TOKEN_HEADER]: TOKEN,
          }),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toBe(
          JSON.stringify("hello sam"),
        );
      }),
    ));

  it("401s public Host even with the token", () =>
    withEnv(
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          rpcPost(`${PUBLIC_URL}${RPC_PATH_PREFIX}greet`, {
            host: "greeter.up.railway.app",
            [RPC_TOKEN_HEADER]: TOKEN,
          }),
        );
        expect(response.status).toBe(401);
      }),
    ));

  it("401s the private mesh without a token", () =>
    withEnv(
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          rpcPost(`${PRIVATE_URL}${RPC_PATH_PREFIX}greet`, {
            host: "greeter.railway.internal:3000",
          }),
        );
        expect(response.status).toBe(401);
      }),
    ));

  it("401s a wrong token", () =>
    withEnv(
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          rpcPost(`${PRIVATE_URL}${RPC_PATH_PREFIX}greet`, {
            host: "greeter.railway.internal:3000",
            [RPC_TOKEN_HEADER]: "b".repeat(64),
          }),
        );
        expect(response.status).toBe(401);
      }),
    ));

  it("401s when X-Forwarded-Host is a public domain", () =>
    withEnv(
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          rpcPost(`${PRIVATE_URL}${RPC_PATH_PREFIX}greet`, {
            host: "greeter.railway.internal:3000",
            "x-forwarded-host": "greeter.up.railway.app",
            [RPC_TOKEN_HEADER]: TOKEN,
          }),
        );
        expect(response.status).toBe(401);
      }),
    ));

  it("falls through to fetch outside /__rpc__/", () =>
    withEnv(
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          webHandler(new Request(`${PUBLIC_URL}/`)),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toBe("ok");
      }),
    ));

  it("bindFunction stub round-trips through the private mesh", () =>
    withEnv(
      Effect.sync(() => {
        const previousFetch = globalThis.fetch;
        globalThis.__ALCHEMY_RUNTIME__ = true;
        globalThis.fetch = fetchImpl;
        process.env.RAILWAY_RPC_GREETER_HOST = "greeter.railway.internal";
        process.env.RAILWAY_RPC_GREETER_PORT = "3000";
        process.env.RAILWAY_RPC_GREETER_TOKEN = TOKEN;
        return previousFetch;
      }).pipe(
        Effect.flatMap((previousFetch) =>
          Effect.gen(function* () {
            const stub = yield* bindFunction<{
              greet: (name: string) => Effect.Effect<string>;
            }>({
              Type: "Railway.Function",
              LogicalId: "Greeter",
            } as never);
            const greeting = yield* stub.greet("sam");
            expect(greeting).toBe("hello sam");
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                globalThis.fetch = previousFetch;
                globalThis.__ALCHEMY_RUNTIME__ = false;
                delete process.env.RAILWAY_RPC_GREETER_HOST;
                delete process.env.RAILWAY_RPC_GREETER_PORT;
                delete process.env.RAILWAY_RPC_GREETER_TOKEN;
              }),
            ),
          ),
        ),
      ),
    ));
});
