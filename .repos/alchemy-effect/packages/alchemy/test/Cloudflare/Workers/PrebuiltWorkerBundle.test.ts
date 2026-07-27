import { readPrebuiltWorkerBundle } from "@/Cloudflare/Workers/WorkerBundle";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const decode = (content: string | Uint8Array<ArrayBufferLike>) =>
  typeof content === "string"
    ? content
    : new TextDecoder().decode(content as Uint8Array);

/**
 * Write `files` (paths relative to a fresh temp directory) and return
 * the temp directory's absolute path.
 */
const writeFixture = Effect.fn(function* (
  files: Record<string, string | Uint8Array>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({ prefix: "alchemy-prebuilt-" });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    if (typeof content === "string") {
      yield* fs.writeFileString(file, content);
    } else {
      yield* fs.writeFile(file, content);
    }
  }
  return root;
});

layer(NodeServices.layer)("readPrebuiltWorkerBundle", (it) => {
  it.effect(
    "collects modules matching the default rules, entry first, names POSIX-relative to the entry's directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* writeFixture({
          "index.mjs": `import { greeting } from "./lib/greeting.mjs";\nexport default { fetch: () => new Response(greeting) };\n`,
          "lib/greeting.mjs": `export const greeting = "hello";\n`,
          "lib/deep/notice.txt": "NOTICE",
          "add.wasm": new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
          "schema.sql": "select 1;",
          "page.html": "<html></html>",
          "blob.bin": new Uint8Array([1, 2, 3]),
          // hidden directories are walked (wrangler glob parity)
          ".chunks/extra.mjs": `export const extra = 1;\n`,
          // not matched by any default rule
          "README.md": "# not a module",
          // source maps are never uploaded as modules
          "index.mjs.map": "{}",
          "lib/greeting.mjs.map": "{}",
        });

        const bundle = yield* readPrebuiltWorkerBundle({
          main: path.join(root, "index.mjs"),
        });

        expect(bundle.files[0].path).toEqual("index.mjs");
        expect(bundle.files.slice(1).map((file) => file.path)).toEqual([
          ".chunks/extra.mjs",
          "add.wasm",
          "blob.bin",
          "lib/deep/notice.txt",
          "lib/greeting.mjs",
          "page.html",
          "schema.sql",
        ]);

        yield* fs.remove(root, { recursive: true });
      }),
  );

  it.effect("uploads file contents byte-for-byte", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Comments and formatting that any bundler/minifier would strip.
      const entrySource = `// SENTINEL: must survive byte-for-byte 7f1c\nconst kSentinel = "sentinel/7f1c";\nexport default { fetch: () => new Response(kSentinel) };\n`;
      const wasmBytes = new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 42,
      ]);
      const root = yield* writeFixture({
        "index.mjs": entrySource,
        "add.wasm": wasmBytes,
      });

      const bundle = yield* readPrebuiltWorkerBundle({
        main: path.join(root, "index.mjs"),
      });

      expect(decode(bundle.files[0].content)).toEqual(entrySource);
      const wasm = bundle.files.find((file) => file.path === "add.wasm")!;
      expect(new Uint8Array(wasm.content as Uint8Array)).toEqual(wasmBytes);

      yield* fs.remove(root, { recursive: true });
    }),
  );

  it.effect("does not walk outside the entry's directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* writeFixture({
        "outside.mjs": `export const outside = true;\n`,
        "dist/index.mjs": `export default { fetch: () => new Response("ok") };\n`,
        "dist/chunk.mjs": `export const chunk = 1;\n`,
      });

      const bundle = yield* readPrebuiltWorkerBundle({
        main: path.join(root, "dist/index.mjs"),
      });

      expect(bundle.files.map((file) => file.path)).toEqual([
        "index.mjs",
        "chunk.mjs",
      ]);

      yield* fs.remove(root, { recursive: true });
    }),
  );

  it.effect("custom rules replace the defaults", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* writeFixture({
        "index.mjs": `export default { fetch: () => new Response("ok") };\n`,
        "data/weights.dat": "0101",
        "data/skipped.txt": "skipped",
        "skipped.mjs": `export const skipped = true;\n`,
      });

      const bundle = yield* readPrebuiltWorkerBundle({
        main: path.join(root, "index.mjs"),
        rules: [{ globs: ["**/*.dat"] }],
      });

      // The entry is always included, even when it matches no rule.
      expect(bundle.files.map((file) => file.path)).toEqual([
        "index.mjs",
        "data/weights.dat",
      ]);

      yield* fs.remove(root, { recursive: true });
    }),
  );

  it.effect("hash is stable across reads and sensitive to module changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* writeFixture({
        "index.mjs": `import { x } from "./lib/x.mjs";\nexport default { fetch: () => new Response(String(x)) };\n`,
        "lib/x.mjs": `export const x = 1;\n`,
      });
      const main = path.join(root, "index.mjs");

      const first = yield* readPrebuiltWorkerBundle({ main });
      const second = yield* readPrebuiltWorkerBundle({ main });
      expect(second.hash).toEqual(first.hash);

      yield* fs.writeFileString(
        path.join(root, "lib/x.mjs"),
        `export const x = 2;\n`,
      );
      const changed = yield* readPrebuiltWorkerBundle({ main });
      expect(changed.hash).not.toEqual(first.hash);

      yield* fs.remove(root, { recursive: true });
    }),
  );

  it.effect("fails with BundleError when the entry does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prebuilt-",
      });

      const error = yield* readPrebuiltWorkerBundle({
        main: path.join(root, "missing.mjs"),
      }).pipe(Effect.flip);

      expect(error._tag).toEqual("BundleError");
      expect(error.message).toContain("missing.mjs");

      yield* fs.remove(root, { recursive: true });
    }),
  );
});
