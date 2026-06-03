import * as Bundle from "@/Bundle/Bundle";
import {
  annotateModule,
  packageNameFromId,
  purePlugin,
  resolvePackageName,
} from "@/Bundle/PurePlugin";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as os from "node:os";
import { rolldown } from "rolldown";

describe("packageNameFromId", () => {
  it("extracts a top-level package name", () => {
    expect(packageNameFromId("/proj/node_modules/effect/dist/Effect.js")).toBe(
      "effect",
    );
  });

  it("extracts a scoped package name", () => {
    expect(
      packageNameFromId("/proj/node_modules/@effect/cluster/dist/index.js"),
    ).toBe("@effect/cluster");
  });

  it("uses the LAST node_modules segment for nested deps", () => {
    expect(
      packageNameFromId(
        "/proj/node_modules/foo/node_modules/effect/dist/Effect.js",
      ),
    ).toBe("effect");
  });

  it("returns null for ids outside node_modules", () => {
    expect(packageNameFromId("/proj/src/Bundle.ts")).toBeNull();
  });

  it("normalizes Windows-style separators", () => {
    expect(
      packageNameFromId(
        "C:\\proj\\node_modules\\@effect\\cluster\\dist\\index.js",
      ),
    ).toBe("@effect/cluster");
  });
});

describe("resolvePackageName (filesystem walk)", () => {
  it("falls back to walking up to the nearest package.json for non-node_modules ids", async () => {
    const root = nodeFs.mkdtempSync(
      nodePath.join(os.tmpdir(), "alchemy-resolve-pkg-"),
    );
    try {
      const pkgDir = nodePath.join(root, "packages", "fancy-pkg");
      nodeFs.mkdirSync(nodePath.join(pkgDir, "src", "deep"), {
        recursive: true,
      });
      nodeFs.writeFileSync(
        nodePath.join(pkgDir, "package.json"),
        JSON.stringify({ name: "@scope/fancy-pkg" }),
      );
      const id = nodePath.join(pkgDir, "src", "deep", "Mod.ts");
      const cache = new Map<string, string | null>();

      expect(await resolvePackageName(id, cache)).toBe("@scope/fancy-pkg");
      // Repeat hits the cache; result is identical and the visited dirs
      // are populated.
      expect(await resolvePackageName(id, cache)).toBe("@scope/fancy-pkg");
      expect(cache.size).toBeGreaterThan(0);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("strips ?query and #hash suffixes before walking", async () => {
    const root = nodeFs.mkdtempSync(
      nodePath.join(os.tmpdir(), "alchemy-resolve-pkg-"),
    );
    try {
      const pkgDir = nodePath.join(root, "pkg");
      nodeFs.mkdirSync(pkgDir, { recursive: true });
      nodeFs.writeFileSync(
        nodePath.join(pkgDir, "package.json"),
        JSON.stringify({ name: "with-query" }),
      );
      const id = `${nodePath.join(pkgDir, "Mod.ts")}?v=123`;
      expect(await resolvePackageName(id, new Map())).toBe("with-query");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when no package.json is found upward", async () => {
    const root = nodeFs.mkdtempSync(
      nodePath.join(os.tmpdir(), "alchemy-resolve-pkg-"),
    );
    try {
      const id = nodePath.join(root, "lonely.ts");
      nodeFs.writeFileSync(id, "");
      expect(await resolvePackageName(id, new Map())).toBeNull();
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("annotateModule", () => {
  const annotate = (code: string) =>
    annotateModule(code, "/n/effect/dist/x.js");

  it("annotates calls in TypeScript source (worker/bun condition path)", () => {
    const result = annotateModule(
      `import { make } from "./util";\nexport const x: number = make();\n`,
      "/proj/packages/alchemy/src/Util.ts",
    );
    expect(result).not.toBeNull();
    expect(result!.code).toContain("/*#__PURE__*/ make()");
  });

  it("annotates top-level call expressions", () => {
    const result = annotate(`const x = create();`);
    expect(result).not.toBeNull();
    expect(result!.code).toBe(`const x = /*#__PURE__*/ create();`);
  });

  it("annotates top-level new expressions", () => {
    const result = annotate(`const x = new Klass();`);
    expect(result!.code).toBe(`const x = /*#__PURE__*/ new Klass();`);
  });

  it("annotates calls inside named exports", () => {
    const result = annotate(`export const x = make();`);
    expect(result!.code).toBe(`export const x = /*#__PURE__*/ make();`);
  });

  it("annotates calls inside default exports", () => {
    const result = annotate(`export default make();`);
    expect(result!.code).toBe(`export default /*#__PURE__*/ make();`);
  });

  it("does NOT annotate calls inside function bodies", () => {
    const result = annotate(`function f() { return inner(); }`);
    expect(result).toBeNull();
  });

  it("does NOT annotate IIFEs", () => {
    const result = annotate(`(function () { sideEffect(); })();`);
    expect(result).toBeNull();
  });

  it("does NOT annotate arrow IIFEs", () => {
    const result = annotate(`(() => sideEffect())();`);
    expect(result).toBeNull();
  });

  it("skips already-annotated calls", () => {
    const result = annotate(`const x = /*#__PURE__*/ create();`);
    expect(result).toBeNull();
  });

  it("annotates calls through ts-as expressions", () => {
    const result = annotate(`const x = make() as Foo;`);
    expect(result!.code).toContain("/*#__PURE__*/ make()");
  });

  it("annotates both branches of ternary initializers", () => {
    const result = annotate(`const x = cond ? a() : b();`);
    expect(result!.code).toContain("/*#__PURE__*/ a()");
    expect(result!.code).toContain("/*#__PURE__*/ b()");
  });

  it("returns a high-resolution source map", () => {
    const result = annotate(`const x = create();`);
    expect(result!.map.mappings.length).toBeGreaterThan(0);
  });

  it("preserves line numbers", () => {
    const input = `const a = first();\nconst b = second();\n`;
    const result = annotate(input);
    expect(result!.code.split("\n").length).toBe(input.split("\n").length);
  });
});

/**
 * Invokes a plugin's `transform` hook directly, regardless of whether it
 * was defined as a plain function or a `{ filter, handler }` object. The
 * rolldown transform hook expects four positional arguments `(this, code,
 * id, meta)` plus a `TransformPluginContext` — we stub both with `any`
 * since the plugin under test only reads `code` and `id`.
 */
async function callTransform(
  plugin: ReturnType<typeof purePlugin>,
  code: string,
  id: string,
): Promise<unknown> {
  const transform = plugin.transform;
  if (transform === undefined) throw new Error("plugin has no transform hook");
  const handler =
    typeof transform === "function" ? transform : transform.handler;
  return await (handler as (...args: any[]) => unknown).call(
    {} as any,
    code,
    id,
    { moduleType: "js" },
  );
}

/**
 * Invokes a plugin's `options` hook with stubbed plugin context. Awaits
 * any returned promise so async hooks complete before we proceed.
 */
async function callOptions(
  plugin: ReturnType<typeof purePlugin>,
  opts: { input: string; cwd?: string },
): Promise<void> {
  const optsHook = plugin.options;
  if (typeof optsHook !== "function") return;
  await (optsHook as (...args: any[]) => unknown).call({} as any, opts);
}

const runTransform = callTransform;

describe("purePlugin", () => {
  it("transforms only modules from matched packages", async () => {
    const plugin = purePlugin();
    const userCode = `const x = doThing();`;

    const matched = await runTransform(
      plugin,
      userCode,
      "/proj/node_modules/effect/dist/Effect.js",
    );
    expect(matched).not.toBeNull();
    expect((matched as { code: string }).code).toContain("/*#__PURE__*/");

    const unmatched = await runTransform(
      plugin,
      userCode,
      "/proj/node_modules/lodash/index.js",
    );
    expect(unmatched).toBeNull();

    const userland = await runTransform(
      plugin,
      userCode,
      "/proj/src/MyModule.ts",
    );
    expect(userland).toBeNull();
  });

  it("respects user-extended package list", async () => {
    const plugin = purePlugin({ packages: ["my-lib"] });

    const result = await runTransform(
      plugin,
      `const x = doThing();`,
      "/proj/node_modules/my-lib/index.js",
    );
    expect(result).not.toBeNull();
    expect((result as { code: string }).code).toContain("/*#__PURE__*/");

    const effectResult = await runTransform(
      plugin,
      `const x = doThing();`,
      "/proj/node_modules/effect/dist/Effect.js",
    );
    expect(effectResult).not.toBeNull();
  });

  it("replaceDefaults overrides the default package list", async () => {
    const plugin = purePlugin({
      packages: ["my-lib"],
      replaceDefaults: true,
    });

    const effectResult = await runTransform(
      plugin,
      `const x = doThing();`,
      "/proj/node_modules/effect/dist/Effect.js",
    );
    expect(effectResult).toBeNull();
  });

  it("does NOT override moduleSideEffects when the package's sideEffects field is unknown", async () => {
    // Virtual id — there is no real `package.json` to read, so the
    // plugin must conservatively leave `moduleSideEffects` alone.
    const plugin = purePlugin();
    const result = await runTransform(
      plugin,
      `function f() { return 1; }`,
      "/proj/node_modules/effect/dist/Effect.js",
    );
    // No annotatable top-level calls AND no disk-backed sideEffects:false
    // declaration → plugin returns null (no rewrite, no hint).
    expect(result).toBeNull();
  });
});

describe("auto-detect entry package", () => {
  it.effect(
    "auto-detects the entry's owning package even WITHOUT a sideEffects field (default-on for user code)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-pure-autodetect-",
        });
        // Plain user package.json — no `sideEffects` field.
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ name: "my-app", type: "module" }),
        );
        yield* fs.writeFileString(
          path.join(root, "entry.ts"),
          `export const x = makeX();\nfunction makeX() { return 1; }`,
        );

        const plugin = purePlugin();
        yield* Effect.promise(() =>
          callOptions(plugin, {
            input: path.join(root, "entry.ts"),
            cwd: root,
          }),
        );

        // Annotation must happen even though `sideEffects` is absent.
        const sourcePath = path.join(root, "lib.ts");
        const result = yield* Effect.promise(() =>
          callTransform(
            plugin,
            `export const v = make();\nfunction make() { return 1; }`,
            sourcePath,
          ),
        );
        expect(result).not.toBeNull();
        expect((result as { code: string }).code).toContain(
          "/*#__PURE__*/ make()",
        );
        // …but moduleSideEffects must NOT be forced false on a package
        // that did not declare `sideEffects: false`.
        expect(
          (result as { moduleSideEffects?: boolean | null }).moduleSideEffects,
        ).not.toBe(false);

        yield* fs.remove(root, { recursive: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "still overrides moduleSideEffects when the package DOES declare sideEffects: false",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-pure-autodetect-sef-",
        });
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({
            name: "my-pure-app",
            type: "module",
            sideEffects: false,
          }),
        );

        const plugin = purePlugin();
        yield* Effect.promise(() =>
          callOptions(plugin, {
            input: path.join(root, "entry.ts"),
            cwd: root,
          }),
        );

        const result = yield* Effect.promise(() =>
          callTransform(
            plugin,
            `export const v = make();\nfunction make() { return 1; }`,
            path.join(root, "lib.ts"),
          ),
        );
        expect(result).not.toBeNull();
        expect(
          (result as { moduleSideEffects?: boolean | null }).moduleSideEffects,
        ).toBe(false);

        yield* fs.remove(root, { recursive: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "does NOT mark entries as moduleSideEffects: false, even in matched packages",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-pure-entry-preserve-",
        });
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({
            name: "my-app",
            type: "module",
            sideEffects: false,
          }),
        );
        const entryPath = path.join(root, "entry.ts");

        const plugin = purePlugin();
        yield* Effect.promise(() =>
          callOptions(plugin, { input: entryPath, cwd: root }),
        );

        const entryResult = yield* Effect.promise(() =>
          callTransform(plugin, `console.log("hello");`, entryPath),
        );
        // Entry has no top-level annotatable calls (console.log() is a
        // top-level call, but it is not a const initializer — wait, it
        // IS, our walker visits ExpressionStatement.expression too).
        // Either way the moduleSideEffects flag must NOT be false.
        if (entryResult !== null) {
          expect(
            (entryResult as { moduleSideEffects?: boolean | null })
              .moduleSideEffects,
          ).not.toBe(false);
        }

        yield* fs.remove(root, { recursive: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Bundle.build with purePlugin", () => {
  it.effect(
    "drops unused exports from a workspace-linked TS package (no node_modules)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-pure-plugin-ts-",
        });

        // Mimic a monorepo workspace symlink: the package lives at
        // packages/fake-ws/, with `src/index.ts` directly importable.
        const pkgDir = path.join(root, "packages", "fake-ws");
        yield* fs.makeDirectory(path.join(pkgDir, "src"), { recursive: true });
        yield* fs.writeFileString(
          path.join(pkgDir, "package.json"),
          JSON.stringify({
            name: "fake-ws",
            version: "0.0.0",
            type: "module",
            sideEffects: false,
            exports: { ".": "./src/index.ts" },
          }),
        );
        yield* fs.writeFileString(
          path.join(pkgDir, "src", "index.ts"),
          [
            `export const used: string = makeUsed();`,
            `export const unused: string = makeUnused();`,
            `function makeUsed(): string { return "USED_TS_MARKER"; }`,
            `function makeUnused(): string { return "UNUSED_TS_MARKER"; }`,
          ].join("\n"),
        );

        // Symlink the package under node_modules so rolldown can find it.
        const nm = path.join(root, "node_modules");
        yield* fs.makeDirectory(nm, { recursive: true });
        nodeFs.symlinkSync(pkgDir, path.join(nm, "fake-ws"), "dir");

        const entry = path.join(root, "entry.ts");
        yield* fs.writeFileString(
          entry,
          `import { used } from "fake-ws";\nconsole.log(used);`,
        );

        const result = yield* Effect.tryPromise({
          try: () =>
            rolldown({
              input: entry,
              cwd: root,
              plugins: [
                purePlugin({
                  packages: ["fake-ws"],
                  replaceDefaults: true,
                }),
              ],
              treeshake: true,
            }),
          catch: (cause) => cause,
        });
        const { output } = yield* Effect.tryPromise({
          try: () => result.generate({ format: "esm" }),
          catch: (cause) => cause,
        });
        yield* Effect.tryPromise({
          try: () => result.close(),
          catch: (cause) => cause,
        });

        const code = output
          .filter((c) => c.type === "chunk")
          .map((c) => c.code)
          .join("\n");
        expect(code).toContain("USED_TS_MARKER");
        expect(code).not.toContain("UNUSED_TS_MARKER");

        yield* fs.remove(root, { recursive: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("drops unused exports from a side-effect-free fake package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-pure-plugin-",
      });

      const fakePkgDir = path.join(root, "node_modules", "fake-effect");
      yield* fs.makeDirectory(fakePkgDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(fakePkgDir, "package.json"),
        JSON.stringify({
          name: "fake-effect",
          version: "0.0.0",
          type: "module",
          main: "./index.js",
          exports: { ".": "./index.js" },
        }),
      );
      // Module-top-level call without annotation: bundlers normally
      // assume this could have side-effects and keep it. With pure
      // annotations + sideEffects:false we expect it dropped.
      yield* fs.writeFileString(
        path.join(fakePkgDir, "index.js"),
        [
          `export const used = makeUsed();`,
          `export const unused = makeUnused();`,
          `function makeUsed() { return "USED_MARKER"; }`,
          `function makeUnused() { return "UNUSED_MARKER"; }`,
        ].join("\n"),
      );

      const entry = path.join(root, "entry.js");
      yield* fs.writeFileString(
        entry,
        `import { used } from "fake-effect"; console.log(used);`,
      );

      const result = yield* Effect.tryPromise({
        try: () =>
          rolldown({
            input: entry,
            cwd: root,
            plugins: [
              purePlugin({
                packages: ["fake-effect"],
                replaceDefaults: true,
              }),
            ],
            treeshake: true,
          }),
        catch: (cause) => cause,
      });
      const { output } = yield* Effect.tryPromise({
        try: () => result.generate({ format: "esm" }),
        catch: (cause) => cause,
      });
      yield* Effect.tryPromise({
        try: () => result.close(),
        catch: (cause) => cause,
      });

      const code = output
        .filter((c) => c.type === "chunk")
        .map((c) => c.code)
        .join("\n");
      expect(code).toContain("USED_MARKER");
      expect(code).not.toContain("UNUSED_MARKER");

      yield* fs.remove(root, { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// Touch Bundle to ensure tree-shaking re-export ordering during type-check.
void Bundle;
