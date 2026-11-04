import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  WorkerBundle,
  type WorkerBundleOptions,
} from "@alchemy.run/cloudflare/Workers/Sources/Rolldown";
import { describe, expect, layer } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import RequireNodeBuiltinsWorker from "./fixtures/require-node-builtins/worker.ts";

const decode = (content: string | Uint8Array<ArrayBufferLike>) =>
  typeof content === "string" ? content : new TextDecoder().decode(content as Uint8Array);

/**
 * Write `files` (paths relative to a fresh temp directory) and return
 * the temp directory's absolute path.
 */
const writeFixture = Effect.fn(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({ prefix: "alchemy-worker-bundle-" });
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
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );
  // #2729: an import with an extension rolldown can't load is emitted as its
  // own module when it matches the Worker's `rules`, instead of failing.
  it.effect(
    "emits imports matching rules as separate modules",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* writeFixture({
          "package.json": "{}",
          "src/font.ttf": "FONT_BYTES",
          "src/skip.ttf": "SKIP_BYTES",
          "shared/logo.png": "LOGO_BYTES",
          "src/notes.md": "# NOTES",
          "src/worker.mjs": `import font from "./font.ttf"; import logo from "../shared/logo.png"; import notes from "./notes.md"; export default { fetch: () => new Response(font + logo + notes) };`,
        });
        const bundler = yield* WorkerBundle;
        const build = (rules: WorkerBundleOptions["rules"]) =>
          bundler.build({
            id: "worker-bundle-rules",
            main: path.join(root, "src/worker.mjs"),
            compatibility: { date: "2026-03-17", flags: [] },
            entry: { kind: "external" },
            stack: { name: "worker-bundle-test", stage: "test" },
            extraOptions: undefined,
            rules,
          });

        const output = yield* build([
          { globs: ["**/*.ttf", `${root}/shared/*.png`] },
          { type: "Text", globs: ["**/*.md"] },
        ]);
        const entry = decode(output.files[0].content);
        // `font.ttf` is in the entry's directory; `logo.png` is outside it
        // and matches an absolute glob.
        for (const [ext, bytes] of [
          [".ttf", "FONT_BYTES"],
          [".png", "LOGO_BYTES"],
        ]) {
          const file = output.files.find((file) => file.path.endsWith(ext));
          expect(file && decode(file.content)).toBe(bytes);
          expect(entry).toContain(path.basename(file!.path));
        }
        // A `Text` rule over an extension uploads would read as Data gets
        // the `.txt` extension the upload types it by.
        const notes = output.files.find((file) => /notes.*\.txt$/.test(file.path));
        expect(notes && decode(notes.content)).toBe("# NOTES");
        expect(entry).toContain(path.basename(notes!.path));

        // `!` globs exclude, as in the prebuilt walk: the excluded import is
        // left to rolldown. Its text parses as JavaScript, so the build fails
        // on the missing default export, and the hint still names the rule.
        const excluded = yield* Effect.flip(
          build([{ globs: ["**/*.ttf", "**/*.png", "**/*.md", `!${root}/src/font.ttf`] }]),
        );
        expect(excluded.message).toContain('add rules: [{ type: "Data", globs: ["**/*.ttf"] }]');

        // Without rules, the error names the rule that would import them.
        const error = yield* Effect.flip(build(undefined));
        expect(error.message).toContain('{ type: "Text", globs: ["**/*.md"] }');

        // `../` globs match files outside the entry's directory.
        const relative = yield* build([
          { globs: ["**/*.ttf", "../shared/*.png"] },
          { type: "Text", globs: ["**/*.md"] },
        ]);
        expect(relative.files.some((file) => file.path.endsWith(".png"))).toBe(true);
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );
  it.effect(
    "applies input aliases before Node compatibility for imports and requires",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* writeFixture({
          "package.json": "{}",
          "stub.mjs": `export const createRequire = () => "ALIASED_MODULE"; export default "ALIASED_PACKAGE";`,
          "worker.mjs": `
          import { createRequire } from "module";
          import { createRequire as nodeCreateRequire } from "node:module";
          import ts from "typescript";
          import execa from "execa";
          import readable from "readable-stream";
          const bare = require("module");
          const prefixed = require("node:module");
          export default { fetch: () => Response.json([
            createRequire(undefined), nodeCreateRequire(undefined),
            bare.createRequire(undefined), prefixed.createRequire(undefined),
            ts, execa, readable, BUILD_MARKER,
          ]) };
        `,
        });
        const bundler = yield* WorkerBundle;
        const output = yield* bundler.build({
          id: "worker-bundle-alias",
          main: path.join(root, "worker.mjs"),
          compatibility: { date: "2025-04-01", flags: ["nodejs_compat"] },
          entry: { kind: "external" },
          stack: { name: "worker-bundle-test", stage: "test" },
          extraOptions: {
            input: {
              resolve: {
                alias: Object.fromEntries(
                  ["module", "node:module", "typescript", "execa", "readable-stream"].map(
                    (name) => [name, path.join(root, "stub.mjs")],
                  ),
                ),
              },
              transform: { define: { BUILD_MARKER: JSON.stringify("INPUT_OPTIONS_MARKER") } },
            },
          },
        });
        const entry = decode(output.files[0].content);
        expect(entry).toContain("ALIASED_MODULE");
        expect(entry).toContain("ALIASED_PACKAGE");
        expect(entry).toContain("INPUT_OPTIONS_MARKER");
        expect(entry).not.toMatch(/from\s*["'](?:node:)?module["']/);
        expect(entry).not.toContain("Calling `require` for");
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );
  it.effect(
    "preserves native alias matching, fallback arrays, and disabled modules",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* writeFixture({
          "package.json": "{}",
          "stub.mjs": `export default "NATIVE_ALIAS_MARKER";`,
          "stubs/promises.mjs": `export default "SUBPATH_ALIAS_MARKER";`,
          "worker.mjs": `
          import module from "module";
          import promises from "node:fs/promises";
          import ignored from "node:inspector";
          import { createRequire } from "node:module";
          export default { fetch: () => Response.json([module, promises, ignored, typeof createRequire]) };
        `,
        });
        const bundler = yield* WorkerBundle;
        for (const fsAlias of ["node:fs", "node:fs/*"]) {
          const output = yield* bundler.build({
            id: "worker-bundle-native-alias",
            main: path.join(root, "worker.mjs"),
            compatibility: { date: "2025-04-01", flags: ["nodejs_compat"] },
            entry: { kind: "external" },
            stack: { name: "worker-bundle-test", stage: "test" },
            extraOptions: {
              input: {
                resolve: {
                  alias: {
                    module$: [path.join(root, "missing.mjs"), path.join(root, "stub.mjs")],
                    [fsAlias]: path.join(root, fsAlias.includes("*") ? "stubs/*" : "stubs"),
                    "node:inspector": false,
                    "node:module": [],
                  },
                },
              },
            },
          });
          const entry = decode(output.files[0].content);
          expect(entry).toContain("NATIVE_ALIAS_MARKER");
          expect(entry).toContain("SUBPATH_ALIAS_MARKER");
          expect(entry).toMatch(/from\s*["']node:module["']/);
          expect(entry).not.toMatch(/from\s*["'](?:module|node:fs\/promises|node:inspector)["']/);
        }
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );

  it.effect(
    "uses input plugins and aliases when watching",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* writeFixture({
          "package.json": "{}",
          "stub.mjs": `export const createRequire = () => "WATCH_ALIAS_MARKER";`,
          "worker.mjs": `import { createRequire } from "node:module"; import value from "virtual:custom"; export default { fetch: () => new Response(createRequire(undefined) + value) };`,
        });
        const bundler = yield* WorkerBundle;
        const events = yield* bundler
          .watch({
            id: "worker-bundle-watch-alias",
            main: path.join(root, "worker.mjs"),
            compatibility: { date: "2025-04-01", flags: ["nodejs_compat"] },
            entry: { kind: "external" },
            stack: { name: "worker-bundle-test", stage: "test" },
            extraOptions: {
              input: {
                resolve: { alias: { "node:module": path.join(root, "stub.mjs") } },
                plugins: [
                  {
                    name: "custom-input-plugin",
                    resolveId(id) {
                      if (id === "virtual:custom") return "\u0000custom";
                    },
                    load(id) {
                      if (id === "\u0000custom") return `export default "INPUT_PLUGIN_MARKER";`;
                    },
                  },
                ],
              },
            },
          })
          .pipe(
            Stream.filter((event) => event._tag !== "Start"),
            Stream.take(1),
            Stream.runCollect,
          );
        const event = events[0]!;
        expect(event._tag).toBe("Success");
        if (event._tag === "Success") {
          const entry = decode(event.output.files[0].content);
          expect(entry).toContain("WATCH_ALIAS_MARKER");
          expect(entry).toContain("INPUT_PLUGIN_MARKER");
          expect(entry).not.toMatch(/from\s*["']node:module["']/);
        }
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );
  // `?worker` imports (WorkerModulePlugin.ts): the target is bundled into
  // one self-contained module and imported as a STRING, ready for a
  // `WorkerLoader`. Nested `?worker` imports inside the target work too.
  it.effect(
    "bundles a ?worker import into a string, nested imports included",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* writeFixture({
          "package.json": "{}",
          "stub.mjs": `export const createRequire = () => "NESTED_ALIAS_MARKER";`,
          "grandchild.mjs": [
            `import { createRequire } from "node:module";`,
            `export default { fetch: () => new Response("GRANDCHILD_MARKER" + createRequire(undefined)) };`,
          ].join("\n"),
          "child.mjs": [
            `import grandchild from "./grandchild.mjs?worker";`,
            `export const MARKER = "CHILD_MARKER_";`,
            `export default { fetch: () => new Response(MARKER + grandchild) };`,
          ].join("\n"),
          "worker.mjs": [
            `import child from "./child.mjs?worker";`,
            `export default {`,
            `  fetch: () => new Response(typeof child + ":" + child.length),`,
            `};`,
          ].join("\n"),
        });
        const bundler = yield* WorkerBundle;
        const output = yield* bundler.build({
          id: "worker-bundle-worker-module",
          main: path.join(root, "worker.mjs"),
          compatibility: { date: "2026-03-17", flags: ["nodejs_compat"] },
          entry: { kind: "external" },
          stack: { name: "worker-bundle-test", stage: "test" },
          extraOptions: {
            input: { resolve: { alias: { "node:module": path.join(root, "stub.mjs") } } },
          },
        });
        const entry = decode(output.files[0].content);
        // The child's code is embedded as a JSON string literal …
        expect(entry).toContain("CHILD_MARKER_");
        // … which itself embeds the grandchild's code (one more level).
        expect(entry).toContain("GRANDCHILD_MARKER");
        expect(entry).toContain("NESTED_ALIAS_MARKER");
        // `child` is a string in the parent, not a module namespace.
        expect(entry).not.toContain("import child from");
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );
});

describe(
  "integration",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
      providers: Cloudflare.providers(),
    });

    const Stack = Alchemy.Stack(
      "NodeBuiltinRequireTestStack",
      { providers: Cloudflare.providers(), state: Cloudflare.state() },
      Effect.gen(function* () {
        const worker = yield* RequireNodeBuiltinsWorker;
        const path = yield* Path.Path;
        const stub = yield* path
          .fromFileUrl(new URL("./fixtures/module-alias/stub.mjs", import.meta.url))
          .pipe(Effect.orDie);
        const aliased = yield* Cloudflare.Worker("AliasedWorker", {
          main: new URL("./fixtures/module-alias/worker.mjs", import.meta.url).href,
          compatibility: {
            date: "2025-04-01",
            flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
          },
          build: {
            input: {
              resolve: {
                alias: Object.fromEntries(
                  ["module", "node:module", "typescript", "execa", "readable-stream"].map(
                    (name) => [name, stub],
                  ),
                ),
              },
            },
          },
        });
        const moduleRules = yield* Cloudflare.Worker("ModuleRulesWorker", {
          main: new URL("./fixtures/module-rules/worker.mjs", import.meta.url).href,
          compatibility: { date: "2025-04-01" },
          rules: [{ globs: ["**/*.ttf"] }, { type: "Text", globs: ["**/*.md"] }],
        });
        return {
          url: worker.url.as<string>(),
          aliasUrl: aliased.url.as<string>(),
          moduleRulesUrl: moduleRules.url.as<string>(),
        };
      }),
    );

    const stack = beforeAll(destroy(Stack).pipe(Effect.andThen(deploy(Stack))));
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

    test(
      "worker aliases override Node builtins without breaking other requires",
      Effect.gen(function* () {
        const { aliasUrl } = yield* stack;
        const client = yield* HttpClient.HttpClient;
        const body = yield* client.get(aliasUrl).pipe(
          Effect.flatMap((response) => response.json),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 8 }),
        );
        expect(body).toEqual({
          bare: "aliased:module",
          prefixed: "aliased:module",
          cjsBare: "aliased:module",
          cjsPrefixed: "aliased:module",
          typescript: "aliased:package",
          execa: "aliased:package",
          readable: "aliased:package",
          event: "builtin:ok",
        });
      }),
    );

    // #2729: a bundled Worker imports a file rolldown can't load (`.ttf`)
    // through `rules`, next to the built-in `.bin` and `.txt` rules. The
    // font's bytes cover every value, so any text decoding along the way
    // (bundle, upload, runtime) would change them.
    test(
      "bundled worker serves imports matched by rules as modules of their type",
      Effect.gen(function* () {
        const { moduleRulesUrl } = yield* stack;
        const client = yield* HttpClient.HttpClient;
        const body = yield* client.get(moduleRulesUrl).pipe(
          Effect.flatMap((response) => response.json),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 8 }),
        );
        const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
        const fs = yield* FileSystem.FileSystem;
        const fixture = (name: string) =>
          fs.readFile(new URL(`./fixtures/module-rules/${name}`, import.meta.url).pathname);
        expect(body).toEqual({
          font: { type: "[object ArrayBuffer]", hex: hex(yield* fixture("font.ttf")) },
          data: hex(yield* fixture("data.bin")),
          notice: "module-rules-notice\n",
          readme: "module-rules-readme\n",
        });
      }),
    );

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
          Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 5 }),
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
  },
);
