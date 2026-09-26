import * as Cloudflare from "@/Cloudflare";
import type { WorkerBuildOptions } from "@/Cloudflare/Workers/Sources/Rolldown.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { fileURLToPath } from "node:url";

const fixtureMain = fileURLToPath(
  new URL("./fixtures/drizzle-schema-chunks/worker.ts", import.meta.url),
);

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

/**
 * Forces the *cyclic* chunk layout from
 * https://github.com/alchemy-run/alchemy/issues/749: the schema group
 * captures only the schema modules (`includeDependenciesRecursively:
 * false`), so `drizzle-orm` stays with the entry and the graph becomes
 * `entry -> auth-*.js -> entry`. ESM evaluation then runs the schema chunk
 * before drizzle's class bindings initialize. (An acyclic split — e.g.
 * drizzle in its own chunk imported by the schema chunk — would NOT
 * regress: plain import order already evaluates it correctly.)
 */
const chunking = {
  preserveEntrySignatures: "allow-extension",
  output: {
    cleanDir: true,
    codeSplitting: {
      groups: [
        {
          name: "auth",
          test: "drizzle-schema-chunks/(schema|auth)/",
          includeDependenciesRecursively: false,
        },
      ],
    },
  },
} satisfies WorkerBuildOptions;

const Stack = Alchemy.Stack(
  "DrizzleSchemaChunksTestStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("DrizzleSchemaChunks", {
      main: fixtureMain,
      compatibility: { date: "2026-06-24", flags: ["nodejs_compat"] },
      build: chunking,
    });
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "worker with drizzle schema modules split into their own chunk deploys and serves (#749)",
  Effect.gen(function* () {
    const { url } = yield* stack;

    // The worker evaluated its cross-chunk schema at startup and serves.
    const client = yield* HttpClient.HttpClient;
    const body = yield* client.get(url).pipe(
      Effect.flatMap((res) => res.text),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 5,
      }),
      // Fresh workers.dev URLs can serve placeholder pages while propagating.
      Effect.repeat({
        schedule: Schedule.exponential("500 millis"),
        until: (b) => b.includes('"ok":true'),
        times: 10,
      }),
      Effect.orDie,
    );
    expect(body).toContain('"ok":true');
  }),
  { timeout: 180_000 },
);

/**
 * Negative control for the test above.
 *
 * WorkerBundle defaults to `strictExecutionOrder: true`, which wraps
 * cross-chunk modules so evaluation follows ESM semantics regardless of how
 * the graph was chunked. Turning it off must make Cloudflare reject the
 * exact same fixture at upload — that is what proves the deploy above is
 * still exercising #749 rather than passing because a chunking change
 * quietly made the layout acyclic.
 *
 * Cloudflare is the oracle here, so nothing in this file has to assert on
 * chunk filenames or emitted code.
 */
test.provider(
  "the same layout fails startup validation without strictExecutionOrder",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("DrizzleSchemaChunksUnsafe", {
              main: fixtureMain,
              compatibility: { date: "2026-06-24", flags: ["nodejs_compat"] },
              build: {
                ...chunking,
                output: { ...chunking.output, strictExecutionOrder: false },
              },
            });
          }),
        )
        .pipe(Effect.flip);

      // `ScriptStartupError: Uncaught ReferenceError: Cannot access '<minified>'
      // before initialization at auth-*.js` — the #749 crash itself.
      expect(error._tag).toEqual("ScriptStartupError");

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
