import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { getWhenReady } = Test;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
  timeout: 600_000,
});
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a workers.dev url");
  return url.replace(/\/+$/, "");
});

test(
  "deploys and exposes a url",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeString();
  }),
  { timeout: 180_000 },
);

test(
  "serves documentation pages",
  Effect.gen(function* () {
    const url = yield* base;
    for (const [pathname, content] of [
      ["/", "Alchemy with Vocs"],
      ["/guide", "Deployment guide"],
      ["/counter", "Interactive component"],
    ] as const) {
      const response = yield* Test.executeWhenReady(
        HttpClientRequest.get(`${url}${pathname}`, {
          headers: { accept: "text/html", "user-agent": "Mozilla/5.0" },
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(yield* response.text).toContain(content);
    }
  }),
  { timeout: 180_000 },
);

test(
  "serves public and generated assets",
  Effect.gen(function* () {
    const url = yield* base;
    const asset = yield* getWhenReady(`${url}/hello.txt`);
    expect(asset.status).toBe(200);
    expect(yield* asset.text).toContain("Vocs public directory");

    const llms = yield* getWhenReady(`${url}/llms.txt`);
    expect(llms.status).toBe(200);
    expect(yield* llms.text).toContain("Alchemy with Vocs");
  }),
  { timeout: 180_000 },
);
