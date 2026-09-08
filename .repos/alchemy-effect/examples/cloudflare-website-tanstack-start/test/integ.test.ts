import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

// Fresh `workers.dev` URLs transiently 404 while the route propagates.
// `HttpClient.execute`/`get` resolve successfully on that 404, so a plain
// `Effect.retry` never fires — these helpers fail on the cold-start window and
// retry until the real response (which may be 200/204/400) comes back.
const { executeWhenReady, getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// While the static-asset manifest is still propagating, requests can serve a
// stale or placeholder body with a 200 — the status alone can't distinguish
// "not yet" from "served", so retry until the body matches.
const getBodyWhenReady = (url: string, expected: string) =>
  Effect.gen(function* () {
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const body = yield* res.text;
    if (!body.includes(expected)) {
      return yield* Effect.fail(new AssetNotReady({ body }));
    }
    return body;
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof AssetNotReady,
      schedule: Schedule.max([
        Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("3 seconds"),
        ]),
        Schedule.recurs(20),
      ]),
    }),
  );

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
  timeout: 240_000,
});
afterAll(
  Effect.gen(function* () {
    if (!process.env.NO_DESTROY) {
      yield* destroy(Stack);
    }
  }),
  { timeout: 180_000 },
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
  "serves the server-rendered home page",
  Effect.gen(function* () {
    const { websiteUrl } = yield* stack;
    const base = websiteUrl.replace(/\/+$/, "");
    // The `GREETING` env value from alchemy.run.ts, read through the
    // `cloudflare:workers` env proxy in the server function — proves the
    // Worker rendered it at request time.
    const html = yield* getBodyWhenReady(
      base,
      "Hello from TanStack Start on Cloudflare!",
    );
    // The Card component rendered under the heading.
    expect(html).toContain("Styled with Tailwind CSS");
    expect(html).toContain(
      "This card is a React component styled with Tailwind utilities.",
    );
  }),
  { timeout: 180_000 },
);

test(
  "compiles tailwind from vite.config.ts",
  Effect.gen(function* () {
    const { websiteUrl } = yield* stack;
    const base = websiteUrl.replace(/\/+$/, "");
    const res = yield* getWhenReady(base);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    // The SSR'd markup uses Tailwind utilities...
    expect(html).toContain("text-3xl");
    // ...and links the stylesheet Vite emitted via the project-owned
    // vite.config.ts (the @tailwindcss/vite plugin), proving Alchemy loaded
    // the config file natively instead of the programmatic fallback.
    const match = html.match(/<link[^>]*href="([^"]+\.css[^"]*)"/);
    expect(match).not.toBeNull();
    const href = match![1]!;
    const cssUrl = href.startsWith("http") ? href : `${base}${href}`;
    const css = yield* getBodyWhenReady(cssUrl, ".text-3xl");
    expect(css).toContain(".text-3xl");
    expect(css).toContain(".font-bold");
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
