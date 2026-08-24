import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

// Fresh `workers.dev` URLs transiently 404 while the route propagates.
// `HttpClient.execute`/`get` resolve successfully on that 404, so a plain
// `Effect.retry` never fires — these helpers fail on the cold-start window and
// retry until the real response (which may be 200/204/400) comes back.
const { executeWhenReady, getWhenReady } = Test;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)));
afterAll(
  Effect.gen(function* () {
    if (!process.env.NO_DESTROY) {
      yield* destroy(Stack);
    }
  }),
);

const route = (url: string, params: Record<string, string>) =>
  `${url}/api/hello?${new URLSearchParams(params).toString()}`;

// Stable per-option keys so re-runs (e.g. NO_DESTROY=1) overwrite cleanly
// instead of leaving stale objects behind.
const KEYS = {
  binding: "integ:via-binding",
  fetch: "integ:via-fetch",
  rpc: "integ:via-rpc",
  httpClient: "integ:via-http-client",
};

test(
  "deploys and exposes a url",
  Effect.gen(function* () {
    const { websiteUrl } = yield* stack;
    expect(websiteUrl).toBeString();
  }),
  { timeout: 180_000 },
);

test(
  "option 1 — direct R2 binding round-trips through PUT and GET",
  Effect.gen(function* () {
    const { websiteUrl } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const key = KEYS.binding;

    const put = yield* executeWhenReady(
      HttpClientRequest.put(route(websiteUrl, { key, via: "binding" })).pipe(
        HttpClientRequest.bodyText("hello-binding", "text/plain"),
      ),
    );
    expect(put.status).toBe(204);

    const get = yield* client.get(route(websiteUrl, { key, via: "binding" }));
    expect(get.status).toBe(200);
    expect(yield* get.text).toBe("hello-binding");
  }),
  { timeout: 180_000 },
);

test(
  "option 2 — service-binding fetch into the Backend worker",
  Effect.gen(function* () {
    const { websiteUrl } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const key = KEYS.fetch;

    // Write through option 2's PUT path (Backend's fetch handler stores it
    // in R2), then read it back through option 2's GET (also Backend.fetch).
    const put = yield* executeWhenReady(
      HttpClientRequest.put(route(websiteUrl, { key, via: "fetch" })).pipe(
        HttpClientRequest.bodyText("hello-fetch", "text/plain"),
      ),
    );
    expect(put.status).toBe(204);

    const get = yield* client.get(route(websiteUrl, { key, via: "fetch" }));
    expect(get.status).toBe(200);
    expect(yield* get.text).toBe("hello-fetch");
  }),
  { timeout: 180_000 },
);

test(
  "option 3 — service-binding RPC method via toPromiseApi",
  Effect.gen(function* () {
    const { websiteUrl } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const key = KEYS.rpc;

    // Seed the bucket via option 1 (direct binding) so the RPC `hello`
    // method has something to read.
    const seed = yield* executeWhenReady(
      HttpClientRequest.put(route(websiteUrl, { key, via: "binding" })).pipe(
        HttpClientRequest.bodyText("hello-rpc", "text/plain"),
      ),
    );
    expect(seed.status).toBe(204);

    // RPC GET reads through Backend.hello — exercises toPromiseApi.
    const get = yield* client.get(route(websiteUrl, { key, via: "rpc" }));
    expect(get.status).toBe(200);
    expect(yield* get.text).toBe("hello-rpc");
  }),
  { timeout: 180_000 },
);

test(
  "option 4 — service-binding HTTP client",
  Effect.gen(function* () {
    const { websiteUrl } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const key = KEYS.httpClient;

    // Seed the bucket via option 1 (direct binding) so the RPC `hello`
    // method has something to read.
    const seed = yield* executeWhenReady(
      HttpClientRequest.put(
        route(websiteUrl, { key, via: "http-client" }),
      ).pipe(HttpClientRequest.bodyText("hello-http-client", "text/plain")),
    );
    expect(seed.status).toBe(204);

    // HTTP client GET reads through Backend.hello — exercises toPromiseApi.
    const get = yield* client.get(
      route(websiteUrl, { key, via: "http-client" }),
    );
    expect(get.status).toBe(200);
    expect(yield* get.text).toBe("hello-http-client");
  }),
  { timeout: 180_000 },
);

test(
  "missing `key` returns 400",
  Effect.gen(function* () {
    const { websiteUrl } = yield* stack;

    // `400` is the real answer; `getWhenReady` only retries the propagation
    // `404`/`5xx` window, so it returns the `400` as soon as the route is live.
    const res = yield* getWhenReady(route(websiteUrl, { via: "binding" }));
    expect(res.status).toBe(400);
  }),
);

test(
  "RPC for a non-existent key returns 404",
  Effect.gen(function* () {
    const { websiteUrl } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* client.get(
      route(websiteUrl, { key: "integ:does-not-exist", via: "rpc" }),
    );
    expect(res.status).toBe(404);
  }),
);

test(
  "PUT via=rpc returns 400 (RPC `hello` is read-only)",
  Effect.gen(function* () {
    const { websiteUrl } = yield* stack;

    const res = yield* executeWhenReady(
      HttpClientRequest.put(
        route(websiteUrl, { key: "integ:via-options", via: "rpc" }),
      ).pipe(HttpClientRequest.bodyText("nope")),
    );
    expect(res.status).toBe(400);
  }),
);
