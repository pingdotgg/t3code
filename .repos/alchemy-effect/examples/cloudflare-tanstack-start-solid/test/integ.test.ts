import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "serves the TanStack Start Solid app shell",
  Effect.gen(function* () {
    const { websiteUrl } = yield* stack;

    // `HttpClient.get` resolves successfully even on the fresh-deploy 404, so a
    // plain `Effect.retry` never fires — `Test.getWhenReady` fails on the
    // cold-start window and retries until the route serves the real app.
    const res = yield* Test.getWhenReady(websiteUrl);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    expect(html).toContain("TanStack Start Solid");
    expect(html).toContain(
      "Hello from TanStack Start Solid on Cloudflare.Website.Vite",
    );
  }),
  { timeout: 180_000 },
);
