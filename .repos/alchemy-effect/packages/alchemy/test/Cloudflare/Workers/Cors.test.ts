import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import CorsWorker from "./fixtures/cors-worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const ORIGIN = "https://example.test";

const Stack = Alchemy.Stack(
  "WorkersCorsStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* CorsWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Raw HttpClient does not fail on non-2xx, so Effect.retry would not fire
// through the freshly-deployed workers.dev 404/500 window. Fail non-2xx
// explicitly so the first request retries until the edge is ready.
const requestUntilReady = (
  effect: Effect.Effect<HttpClientResponse, unknown, never>,
) =>
  effect.pipe(
    Effect.flatMap(
      Effect.fn(function* (res) {
        return res.status >= 200 && res.status < 300
          ? res
          : yield* Effect.fail(
              new Error(`Worker not ready: ${res.status} ${yield* res.text}`),
            );
      }),
    ),
    Effect.retry({
      schedule: Schedule.exponential("500 millis"),
      times: 10,
    }),
  );

test(
  "HttpMiddleware.cors() adds Access-Control-Allow-Origin on OPTIONS preflight",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* requestUntilReady(
      client.execute(
        HttpClientRequest.make("OPTIONS")(`${url}/hello`).pipe(
          HttpClientRequest.setHeaders({
            Origin: ORIGIN,
            "Access-Control-Request-Method": "GET",
          }),
        ),
      ),
    );
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  }),
  { timeout: 120_000 },
);

test(
  "HttpMiddleware.cors() adds Access-Control-Allow-Origin on GET responses",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* requestUntilReady(
      client.execute(
        HttpClientRequest.get(`${url}/hello`).pipe(
          HttpClientRequest.setHeaders({ Origin: ORIGIN }),
        ),
      ),
    );
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { message: string };
    expect(body.message).toBe("world");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  }),
  { timeout: 120_000 },
);

test(
  "HttpMiddleware.cors() adds Access-Control-Allow-Origin on POST responses",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* requestUntilReady(
      client.execute(
        HttpClientRequest.post(`${url}/hello`).pipe(
          HttpClientRequest.setHeaders({ Origin: ORIGIN }),
        ),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  }),
  { timeout: 120_000 },
);
