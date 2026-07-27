import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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
 * Regression stack for https://github.com/alchemy-run/alchemy/issues/749.
 *
 * The `build` options force the *cyclic* chunk layout from the issue: the
 * schema group captures only the schema modules
 * (`includeDependenciesRecursively: false`), so `drizzle-orm` stays in the
 * entry chunk and the graph becomes `worker.js -> auth-*.js -> worker.js`.
 * ESM evaluation then runs the schema chunk before drizzle's class bindings
 * initialize. Without WorkerBundle's default `strictExecutionOrder: true`,
 * Cloudflare rejects the upload with `ScriptStartupError: Cannot access
 * '<minified>' before initialization` — so the deploy in `beforeAll` is
 * itself the regression assertion. (An acyclic split — e.g. drizzle in its
 * own chunk imported by the schema chunk — would NOT regress: plain import
 * order already evaluates it correctly.)
 */
const Stack = Alchemy.Stack(
  "DrizzleSchemaChunksTestStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("DrizzleSchemaChunks", {
      main: fixtureMain,
      compatibility: { date: "2026-06-24", flags: ["nodejs_compat"] },
      build: {
        // Required by `includeDependenciesRecursively: false`; rolldown
        // rejects it under the default "strict".
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
      },
    });
    return { url: worker.url.as<string>() };
  }),
);

const bundleDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(".alchemy/bundles/DrizzleSchemaChunks");
});

// `cleanDir: true` on the stack's output options drops chunks from previous
// runs, so the chunk-layout assertions below can't pass on stale files.
const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "code splitting options are applied and produce the cyclic layout",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* bundleDir;
    const files = yield* fs.readDirectory(dir);

    // The schema modules landed in their own chunk...
    const authChunk = files.find((f) => /^auth-.*\.js$/.test(f));
    expect(authChunk).toBeDefined();

    // ...which imports the entry back (drizzle-orm stayed in `worker.js`):
    // the cyclic `worker.js <-> auth-*.js` graph that TDZ-crashed workerd
    // startup in #749 before `strictExecutionOrder` became the default.
    const authContent = yield* fs.readFileString(path.join(dir, authChunk!));
    expect(authContent).toMatch(/from\s*"\.\/worker\.js"/);
  }),
);

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
