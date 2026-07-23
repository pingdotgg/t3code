import * as Bundle from "@/Bundle/Bundle";
import { RAW_RE, rawPlugin, splitFileAndPostfix } from "@/Bundle/RawPlugin";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as NodeFs from "node:fs/promises";

layer(NodeServices.layer)("Bundle.build with rawPlugin", (it) => {
  it.effect("inlines a sibling file imported with ?raw", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-raw-bundle-",
      });
      yield* fs.writeFileString(
        path.join(root, "hello.txt"),
        "HELLO_RAW_MARKER",
      );
      const entry = path.join(root, "entry.ts");
      yield* fs.writeFileString(
        entry,
        `import txt from "./hello.txt?raw";\nconsole.log(txt);\n`,
      );

      const result = yield* Bundle.build({
        input: entry,
        cwd: root,
      });

      const code = result.files
        .filter((f) => typeof f.content === "string")
        .map((f) => f.content as string)
        .join("\n");
      expect(code).toContain(`"HELLO_RAW_MARKER"`);
      // The bundle should not emit hello.txt as a separate asset.
      expect(result.files.every((f) => !f.path.endsWith("hello.txt"))).toBe(
        true,
      );

      yield* fs.remove(root, { recursive: true });
    }),
  );

  it.effect("resolves ?raw imports through subdirectories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-raw-subdir-",
      });
      yield* fs.makeDirectory(path.join(root, "sub"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "sub", "foo.json"),
        `{"marker":"SUBDIR_RAW_MARKER"}`,
      );
      const entry = path.join(root, "entry.ts");
      yield* fs.writeFileString(
        entry,
        `import foo from "./sub/foo.json?raw";\nconsole.log(foo);\n`,
      );

      const result = yield* Bundle.build({
        input: entry,
        cwd: root,
      });

      const code = result.files
        .filter((f) => typeof f.content === "string")
        .map((f) => f.content as string)
        .join("\n");
      expect(code).toContain("SUBDIR_RAW_MARKER");

      yield* fs.remove(root, { recursive: true });
    }),
  );
});

layer(NodeServices.layer)("rawPlugin load hook", (it) => {
  /**
   * Invokes a plugin's `load` hook directly with a stubbed plugin
   * context. The handler reads through `this.fs` (rolldown's
   * plugin-context filesystem); we stub it with `node:fs/promises` so the
   * disk read works without booting a full rolldown build.
   */
  const load = (id: string) =>
    Effect.promise(async () => {
      const plugin = rawPlugin();
      assert(
        Predicate.hasProperty(plugin, "load") &&
          Predicate.hasProperty(plugin.load, "handler") &&
          typeof plugin.load.handler === "function",
        "plugin has no load hook",
      );
      const result = await plugin.load.handler.call({ fs: NodeFs } as any, id);
      assert(Predicate.isObject(result), "load hook returned non-object");
      return result;
    });

  it.effect("inlines a .txt file as a JSON-encoded default export", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "alchemy-raw-load-" });
      const file = path.join(root, "hello.txt");
      yield* fs.writeFileString(file, "Hello, World!\n");

      const result = yield* load(file);

      expect(result.code).toBe(`export default "Hello, World!\\n";`);
      expect(result.moduleType).toBe("js");

      yield* fs.remove(root, { recursive: true });
    }),
  );

  it.effect("inlines a .json file verbatim (no parsing)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "alchemy-raw-json-" });
      const file = path.join(root, "data.json");
      const raw = `{"a": 1, "b": "two"}`;
      yield* fs.writeFileString(file, raw);

      const result = yield* load(`${file}?raw`);

      expect(result.code).toBe(`export default ${JSON.stringify(raw)};`);

      yield* fs.remove(root, { recursive: true });
    }),
  );

  it.effect("strips additional query params before reading the file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "alchemy-raw-q-" });
      const file = path.join(root, "page.html");
      yield* fs.writeFileString(file, "<h1>hi</h1>");

      const result = yield* load(`${file}?raw&t=12345`);

      expect(result.code).toBe(`export default "<h1>hi</h1>";`);

      yield* fs.remove(root, { recursive: true });
    }),
  );
});

describe("RAW_RE", () => {
  it("matches `?raw`", () => {
    expect(RAW_RE.test("/foo/bar.txt?raw")).toBe(true);
  });

  it("matches `?raw&foo`", () => {
    expect(RAW_RE.test("/foo/bar.txt?raw&foo")).toBe(true);
  });

  it("matches `?other&raw`", () => {
    expect(RAW_RE.test("/foo/bar.txt?other&raw")).toBe(true);
  });

  it("does NOT match ids without ?raw", () => {
    expect(RAW_RE.test("/foo/bar.txt")).toBe(false);
    expect(RAW_RE.test("/foo/bar.txt?url")).toBe(false);
    expect(RAW_RE.test("/foo/bar.txt?rawish")).toBe(false);
  });
});

describe("splitFileAndPostfix", () => {
  it("splits at the first `?`", () => {
    expect(splitFileAndPostfix("./foo.txt?raw")).toEqual(["./foo.txt", "?raw"]);
  });

  it("splits at the first `#`", () => {
    expect(splitFileAndPostfix("./foo.txt#frag")).toEqual([
      "./foo.txt",
      "#frag",
    ]);
  });

  it("returns empty postfix when no query/hash", () => {
    expect(splitFileAndPostfix("./foo.txt")).toEqual(["./foo.txt", ""]);
  });

  it("splits at whichever of `?` / `#` comes first", () => {
    expect(splitFileAndPostfix("./foo.txt#frag?raw")).toEqual([
      "./foo.txt",
      "#frag?raw",
    ]);
  });
});
