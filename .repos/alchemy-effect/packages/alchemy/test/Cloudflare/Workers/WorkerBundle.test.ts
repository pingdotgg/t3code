import * as Cloudflare from "@/Cloudflare";
import { WorkerBundle } from "@/Cloudflare/Workers/WorkerBundle";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import RequireNodeBuiltinsWorker from "./fixtures/require-node-builtins/worker.ts";

const decode = (content: string | Uint8Array<ArrayBufferLike>) =>
  typeof content === "string"
    ? content
    : new TextDecoder().decode(content as Uint8Array);

/**
 * Write `files` (paths relative to a fresh temp directory) and return
 * the temp directory's absolute path.
 */
const writeFixture = Effect.fn(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({
    prefix: "alchemy-worker-bundle-",
  });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, content);
  }
  return root;
});

layer(NodeServices.layer)("WorkerBundle", (it) => {
  // Regression test for #880: CJS dependencies (like `pg`) that
  // `require("events")` must have those requires converted into ESM imports
  // of the workerd-provided Node builtins. Left unconverted, rolldown emits
  // a throwing `require` fallback and the Worker fails Cloudflare startup
  // validation with "Calling `require` for \"events\" in an environment
  // that doesn't expose the `require` function".
  it.effect(
    "converts CJS requires of Node builtins into ESM imports under nodejs_compat",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* writeFixture({
          // Anchors findCwdForBundle so bundle output stays in the temp dir.
          "package.json": "{}",
          "dep.cjs": [
            `const { EventEmitter } = require("events");`,
            `const util = require("node:util");`,
            `module.exports = {`,
            `  Thing: class extends EventEmitter {`,
            `    describe() { return util.format("thing %s", "one"); }`,
            `  },`,
            `};`,
          ].join("\n"),
          "worker.mjs": [
            `import { Thing } from "./dep.cjs";`,
            `export default {`,
            `  fetch: () => new Response(new Thing().describe()),`,
            `};`,
          ].join("\n"),
        });

        const bundler = yield* WorkerBundle;
        const output = yield* bundler.build({
          id: "worker-bundle-require-events",
          main: path.join(root, "worker.mjs"),
          compatibility: { date: "2026-03-17", flags: ["nodejs_compat"] },
          entry: { kind: "external" },
          stack: { name: "worker-bundle-test", stage: "test" },
          extraOptions: undefined,
        });

        const entry = decode(output.files[0].content);
        // The CJS requires were rewritten to imports of the builtins.
        expect(entry).toMatch(/from\s*["'](?:node:)?events["']/);
        expect(entry).toMatch(/from\s*["']node:util["']/);
        // No chunk retains rolldown's throwing `require` fallback.
        for (const file of output.files) {
          if (!file.path.endsWith(".js")) continue;
          expect(decode(file.content)).not.toContain("Calling `require` for");
        }
      }),
  );
});

describe("integration", () => {
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
  });

  const Stack = Alchemy.Stack(
    "NodeBuiltinRequireTestStack",
    { providers: Cloudflare.providers(), state: Cloudflare.state() },
    Effect.gen(function* () {
      const worker = yield* RequireNodeBuiltinsWorker;
      return { url: worker.url.as<string>() };
    }),
  );

  const stack = beforeAll(deploy(Stack));
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

  // Regression test for #880: the deploy itself is the primary assertion —
  // a bundle that keeps rolldown's throwing `require` fallback for
  // `require("events")` fails Cloudflare startup validation at upload time
  // and `beforeAll(deploy(Stack))` fails the suite.
  test(
    "worker with a CJS dep requiring node builtins deploys and serves",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpClient.HttpClient;

      const get = client.get(`${url}/?value=pong`).pipe(
        Effect.flatMap((res) => res.text),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 5,
        }),
        Effect.orDie,
      );

      // Fresh workers.dev URLs can serve placeholder 200s while propagating,
      // so anchor the readiness poll on the fixture's marker, not the status.
      const body = yield* get.pipe(
        Effect.repeat({
          schedule: Schedule.exponential("500 millis"),
          until: (b) => b.includes("require-node-builtins:"),
          times: 10,
        }),
      );

      // The converted builtins really work at runtime: the EventEmitter
      // round-tripped the request's value and util.format made the marker.
      expect(body).toBe("require-node-builtins:pong");
    }),
    { timeout: 180_000 },
  );
});
