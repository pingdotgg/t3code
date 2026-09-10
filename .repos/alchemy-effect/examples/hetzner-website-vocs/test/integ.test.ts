import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const { getWhenReady } = Test;

const hasCreds = !!process.env.HCLOUD_TOKEN;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Hetzner.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
  stage: "test",
});

if (!hasCreds) {
  test.skip("skipped without HCLOUD_TOKEN", Effect.void);
} else {
  const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
    timeout: 600_000,
  });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

  const base = Effect.map(stack, ({ url }) => {
    if (!url) throw new Error("expected the site to expose a url");
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
      const home = yield* getWhenReady(url);
      expect(home.status).toBe(200);
      expect(yield* home.text).toContain("Alchemy with Vocs");

      const guide = yield* getWhenReady(`${url}/guide`);
      expect(guide.status).toBe(200);
      expect(yield* guide.text).toContain("Deployment guide");

      const counter = yield* getWhenReady(`${url}/counter`);
      expect(counter.status).toBe(200);
      expect(yield* counter.text).toContain("Interactive component");
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
}
