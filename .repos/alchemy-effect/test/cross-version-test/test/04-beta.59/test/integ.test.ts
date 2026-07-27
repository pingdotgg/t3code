import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

// The marker baked into this stage's src/worker.ts.
const MARKER = "04-beta.59";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  // Separate stage from the cross-version orchestrator's "xver" so this
  // self-contained test doesn't clobber its state.
  stage: "integ",
});

// NOTE: this deploys via the account-wide Cloudflare state store, which must be
// at the version matching this folder's alchemy (v7 for beta.59). Run
// `bun run alc -- cloudflare bootstrap --profile <p>` in this folder first, or
// drive everything through ../../run.ts which bootstraps per stage.
const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

// A freshly-deployed workers.dev URL transiently 404/5xxs while the route
// propagates. Retry until it serves 200. Version-agnostic on purpose —
// beta.45's Test helpers predate `getWhenReady`.
const getOk = (url: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt++) {
      const res = yield* Effect.tryPromise(() => fetch(url));
      if (res.status === 200) return res;
      yield* Effect.sleep("1 second");
    }
    return yield* Effect.die(new Error(`worker never returned 200: ${url}`));
  });

test(
  "worker responds to an http request",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeString();

    const res = yield* getOk(url);
    expect(res.status).toBe(200);

    const body = yield* Effect.tryPromise(
      () => res.json() as Promise<{ marker: string }>,
    );
    expect(body.marker).toBe(MARKER);
  }),
  { timeout: 120_000 },
);
