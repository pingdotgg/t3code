import * as Bundle from "@/Bundle/Bundle";
import {
  collectPureAnchors,
  packageNameFromId,
  purePlugin,
  resolvePackageInfo,
  type PackageInfo,
} from "@/Bundle/PurePlugin";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as os from "node:os";
import { rolldown, RolldownMagicString, type RolldownLog } from "rolldown";

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

describe("resolvePackageInfo (filesystem walk)", () => {
  it("walks up to the nearest package.json", async () => {
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
        JSON.stringify({ name: "@scope/fancy-pkg", sideEffects: false }),
      );
      const dir = nodePath.join(pkgDir, "src", "deep");
      const cache = new Map<string, PackageInfo | null>();

      const info = await resolvePackageInfo(dir, cache);
      expect(info?.name).toBe("@scope/fancy-pkg");
      expect(info?.sideEffects).toBe(false);
      // Repeat hits the cache; result is identical and the visited dirs
      // are populated.
      expect((await resolvePackageInfo(dir, cache))?.name).toBe(
        "@scope/fancy-pkg",
      );
      expect(cache.size).toBeGreaterThan(0);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("caches results for sibling directories independently", async () => {
    const root = nodeFs.mkdtempSync(
      nodePath.join(os.tmpdir(), "alchemy-resolve-pkg-"),
    );
    try {
      for (const [dir, name] of [
        ["a", "pkg-a"],
        ["b", "pkg-b"],
      ] as const) {
        nodeFs.mkdirSync(nodePath.join(root, dir, "src"), { recursive: true });
        nodeFs.writeFileSync(
          nodePath.join(root, dir, "package.json"),
          JSON.stringify({ name }),
        );
      }
      const cache = new Map<string, PackageInfo | null>();
      expect(
        (await resolvePackageInfo(nodePath.join(root, "a", "src"), cache))
          ?.name,
      ).toBe("pkg-a");
      expect(
        (await resolvePackageInfo(nodePath.join(root, "b", "src"), cache))
          ?.name,
      ).toBe("pkg-b");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when no package.json is found upward", async () => {
    const root = nodeFs.mkdtempSync(
      nodePath.join(os.tmpdir(), "alchemy-resolve-pkg-"),
    );
    try {
      expect(await resolvePackageInfo(root, new Map())).toBeNull();
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never walks above a node_modules boundary", async () => {
    const root = nodeFs.mkdtempSync(
      nodePath.join(os.tmpdir(), "alchemy-resolve-pkg-"),
    );
    try {
      // A stray package.json ABOVE node_modules must never be latched onto.
      nodeFs.writeFileSync(
        nodePath.join(root, "package.json"),
        JSON.stringify({ name: "stray-parent" }),
      );
      const dir = nodePath.join(root, "node_modules", "no-manifest", "dist");
      nodeFs.mkdirSync(dir, { recursive: true });
      expect(await resolvePackageInfo(dir, new Map())).toBeNull();
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectPureAnchors", () => {
  /** Applies the returned anchors to `code` with a plain string splice. */
  const apply = (code: string, anchors: number[]): string => {
    let out = code;
    for (const anchor of [...anchors].sort((a, b) => b - a)) {
      out = `${out.slice(0, anchor)}/*#__PURE__*/ ${out.slice(anchor)}`;
    }
    return out;
  };
  // Applies BOTH bound and discarded anchors — the full-annotation view a
  // sideEffects-free package receives.
  const annotate = (code: string): string | null => {
    const anchors = collectPureAnchors(code, "/n/effect/dist/x.js");
    return anchors === null
      ? null
      : apply(code, [...anchors.bound, ...anchors.discarded]);
  };

  it("annotates calls in TypeScript source (worker/bun condition path)", () => {
    const code = `import { make } from "./util";\nexport const x: number = make();\n`;
    const anchors = collectPureAnchors(
      code,
      "/proj/packages/alchemy/src/Util.ts",
    );
    expect(anchors).not.toBeNull();
    expect(apply(code, anchors!.bound)).toContain("/*#__PURE__*/ make()");
  });

  it("classifies variable-initializer calls as bound", () => {
    const anchors = collectPureAnchors(`const x = create();`, "/n/x.js");
    expect(anchors!.bound.length).toBe(1);
    expect(anchors!.discarded.length).toBe(0);
  });

  it("classifies bare expression-statement calls as discarded", () => {
    const anchors = collectPureAnchors(`app.get("/", handler);`, "/n/x.js");
    expect(anchors!.bound.length).toBe(0);
    expect(anchors!.discarded.length).toBe(1);
  });

  it("classifies assignment right-hand sides as bound, even in statement position", () => {
    const anchors = collectPureAnchors(`exports.x = make();`, "/n/x.js");
    expect(anchors!.bound.length).toBe(1);
    expect(anchors!.discarded.length).toBe(0);
  });

  it("classifies non-final sequence expressions as discarded even in initializers", () => {
    const anchors = collectPureAnchors(
      `const x = (register(), make());`,
      "/n/x.js",
    );
    expect(anchors!.bound.length).toBe(1);
    expect(anchors!.discarded.length).toBe(1);
  });

  it("classifies optional-chained statement calls as discarded", () => {
    const anchors = collectPureAnchors(`app?.get("/", h);`, "/n/x.js");
    expect(anchors!.bound.length).toBe(0);
    expect(anchors!.discarded.length).toBe(1);
  });

  it("annotates top-level call expressions", () => {
    expect(annotate(`const x = create();`)).toBe(
      `const x = /*#__PURE__*/ create();`,
    );
  });

  it("annotates top-level new expressions", () => {
    expect(annotate(`const x = new Klass();`)).toBe(
      `const x = /*#__PURE__*/ new Klass();`,
    );
  });

  it("annotates calls inside named exports", () => {
    expect(annotate(`export const x = make();`)).toBe(
      `export const x = /*#__PURE__*/ make();`,
    );
  });

  it("annotates calls inside default exports", () => {
    expect(annotate(`export default make();`)).toBe(
      `export default /*#__PURE__*/ make();`,
    );
  });

  it("does NOT annotate calls inside function bodies", () => {
    expect(annotate(`function f() { return inner(); }`)).toBeNull();
  });

  it("does NOT annotate IIFEs", () => {
    expect(annotate(`(function () { sideEffect(); })();`)).toBeNull();
  });

  it("does NOT annotate arrow IIFEs", () => {
    expect(annotate(`(() => sideEffect())();`)).toBeNull();
  });

  it("skips already-annotated calls", () => {
    expect(annotate(`const x = /*#__PURE__*/ create();`)).toBeNull();
  });

  it("annotates calls through ts-as expressions", () => {
    expect(annotate(`const x = make() as Foo;`)).toContain(
      "/*#__PURE__*/ make()",
    );
  });

  it("annotates both branches of ternary initializers", () => {
    const result = annotate(`const x = cond ? a() : b();`);
    expect(result).toContain("/*#__PURE__*/ a()");
    expect(result).toContain("/*#__PURE__*/ b()");
  });

  it("preserves line numbers", () => {
    const input = `const a = first();\nconst b = second();\n`;
    const result = annotate(input);
    expect(result!.split("\n").length).toBe(input.split("\n").length);
  });

  it("returns null on unparseable input", () => {
    expect(collectPureAnchors(`const x = {;`, "/n/x.js")).toBeNull();
  });
});

interface TransformOutput {
  code?: unknown;
  moduleSideEffects?: boolean | string | null;
}

/**
 * Invokes a plugin's `transform` hook directly, regardless of whether it
 * was defined as a plain function or a `{ filter, handler }` object. The
 * plugin under test only reads `code`, `id` and `meta.magicString`, so we
 * stub the context and meta with minimal shapes.
 */
async function callTransform(
  plugin: ReturnType<typeof purePlugin>,
  code: string,
  id: string,
): Promise<TransformOutput | string | null> {
  const transform = plugin.transform;
  if (transform === undefined) throw new Error("plugin has no transform hook");
  const handler =
    typeof transform === "function" ? transform : transform.handler;
  return (await (handler as (...args: any[]) => unknown).call(
    {} as any,
    code,
    id,
    { moduleType: "js" },
  )) as TransformOutput | string | null;
}

/** Stringifies a transform result's `code` (RolldownMagicString or string). */
const codeOf = (result: TransformOutput | string | null): string => {
  if (result === null) throw new Error("expected a transform result");
  const code = typeof result === "string" ? result : result.code;
  if (code === undefined) throw new Error("expected transformed code");
  return String(code);
};

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

describe("purePlugin", () => {
  it("transforms only modules from matched packages", async () => {
    const plugin = purePlugin();
    const userCode = `const x = doThing();`;

    const matched = await callTransform(
      plugin,
      userCode,
      "/proj/node_modules/effect/dist/Effect.js",
    );
    expect(matched).not.toBeNull();
    expect(codeOf(matched)).toContain("/*#__PURE__*/");

    const unmatched = await callTransform(
      plugin,
      userCode,
      "/proj/node_modules/lodash/index.js",
    );
    expect(unmatched).toBeNull();

    const userland = await callTransform(
      plugin,
      userCode,
      "/proj/src/MyModule.ts",
    );
    expect(userland).toBeNull();
  });

  it("returns a RolldownMagicString so rolldown generates the sourcemap natively", async () => {
    const plugin = purePlugin();
    const result = await callTransform(
      plugin,
      `const x = doThing();`,
      "/proj/node_modules/effect/dist/Effect.js",
    );
    expect(result).not.toBeNull();
    expect((result as TransformOutput).code).toBeInstanceOf(
      RolldownMagicString,
    );
  });

  it("strips ?query and #hash suffixes before resolving", async () => {
    const root = nodeFs.mkdtempSync(
      nodePath.join(os.tmpdir(), "alchemy-pure-query-"),
    );
    try {
      const pkgDir = nodePath.join(root, "pkg");
      nodeFs.mkdirSync(pkgDir, { recursive: true });
      nodeFs.writeFileSync(
        nodePath.join(pkgDir, "package.json"),
        JSON.stringify({ name: "with-query" }),
      );
      const plugin = purePlugin({
        packages: ["with-query"],
        replaceDefaults: true,
      });
      const result = await callTransform(
        plugin,
        `const x = doThing();`,
        `${nodePath.join(pkgDir, "Mod.ts")}?v=123`,
      );
      expect(result).not.toBeNull();
      expect(codeOf(result)).toContain("/*#__PURE__*/");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("respects user-extended package list", async () => {
    const plugin = purePlugin({ packages: ["my-lib"] });

    const result = await callTransform(
      plugin,
      `const x = doThing();`,
      "/proj/node_modules/my-lib/index.js",
    );
    expect(result).not.toBeNull();
    expect(codeOf(result)).toContain("/*#__PURE__*/");

    const effectResult = await callTransform(
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

    const effectResult = await callTransform(
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
    const result = await callTransform(
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
        expect(codeOf(result)).toContain("/*#__PURE__*/ make()");
        // …but moduleSideEffects must NOT be forced false on a package
        // that did not declare `sideEffects: false`.
        expect((result as TransformOutput).moduleSideEffects).not.toBe(false);

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
        expect((result as TransformOutput).moduleSideEffects).toBe(false);

        yield* fs.remove(root, { recursive: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "returns a metadata-only result (no code) for side-effect-free modules with nothing to annotate",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-pure-metaonly-",
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

        // Only function declarations — nothing to annotate. The plugin
        // must set moduleSideEffects WITHOUT returning `code` (returning
        // untransformed code with no map is what caused rolldown's
        // SOURCEMAP_BROKEN warning).
        const result = yield* Effect.promise(() =>
          callTransform(
            plugin,
            `export function f() { return 1; }`,
            path.join(root, "lib.ts"),
          ),
        );
        expect(result).not.toBeNull();
        expect((result as TransformOutput).code).toBeUndefined();
        expect((result as TransformOutput).moduleSideEffects).toBe(false);

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
        // The entry's moduleSideEffects flag must NOT be false regardless
        // of what its package declares.
        if (entryResult !== null && typeof entryResult === "object") {
          expect(entryResult.moduleSideEffects).not.toBe(false);
        }

        yield* fs.remove(root, { recursive: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("discarded-result calls (issue #949)", () => {
  it("does NOT annotate entry-module expression-statement calls (route registrations)", async () => {
    const root = nodeFs.mkdtempSync(
      nodePath.join(os.tmpdir(), "alchemy-pure-949-entry-"),
    );
    try {
      nodeFs.writeFileSync(
        nodePath.join(root, "package.json"),
        JSON.stringify({ name: "my-app", type: "module" }),
      );
      const entryPath = nodePath.join(root, "entry.ts");
      const plugin = purePlugin();
      await callOptions(plugin, { input: entryPath, cwd: root });

      const code = [
        `const app = new Hono();`,
        `app.get("/", (c) => c.json({ code: "OK" }));`,
        `export default { fetch: app.fetch };`,
      ].join("\n");
      const result = await callTransform(plugin, code, entryPath);
      // `new Hono()` (bound to `app`) may be annotated; the discarded
      // `app.get(...)` registration must NOT be.
      if (result !== null) {
        expect(codeOf(result)).not.toContain("/*#__PURE__*/ app.get");
      }
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT annotate expression-statement calls in packages without an explicit sideEffects opt-in", async () => {
    const root = nodeFs.mkdtempSync(
      nodePath.join(os.tmpdir(), "alchemy-pure-949-noopt-"),
    );
    try {
      // No `sideEffects` field — the author never claimed purity.
      nodeFs.writeFileSync(
        nodePath.join(root, "package.json"),
        JSON.stringify({ name: "my-app", type: "module" }),
      );
      const plugin = purePlugin();
      await callOptions(plugin, {
        input: nodePath.join(root, "entry.ts"),
        cwd: root,
      });

      // A NON-entry module of the user's package, imported for its side
      // effects (`import "./routes.ts"`).
      const code = [
        `import { app } from "./app.ts";`,
        `app.get("/r", () => "ok");`,
        `export const x = makeX();`,
      ].join("\n");
      const result = await callTransform(
        plugin,
        code,
        nodePath.join(root, "routes.ts"),
      );
      expect(result).not.toBeNull();
      const out = codeOf(result);
      // Bound calls stay tree-shakeable...
      expect(out).toContain("/*#__PURE__*/ makeX()");
      // ...but the discarded-result registration is preserved.
      expect(out).not.toContain("/*#__PURE__*/ app.get");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("STILL annotates expression-statement calls in packages that declare sideEffects: false", async () => {
    // effect ships `sideEffects: []` on purpose — full annotation there is
    // intentional and must be preserved. Use a fake on-disk package to
    // avoid depending on the real effect layout.
    const root = nodeFs.mkdtempSync(
      nodePath.join(os.tmpdir(), "alchemy-pure-949-optin-"),
    );
    try {
      const pkgDir = nodePath.join(root, "node_modules", "fake-effect");
      nodeFs.mkdirSync(pkgDir, { recursive: true });
      nodeFs.writeFileSync(
        nodePath.join(pkgDir, "package.json"),
        JSON.stringify({ name: "fake-effect", sideEffects: false }),
      );
      const optIn = purePlugin({
        packages: ["fake-effect"],
        replaceDefaults: true,
      });
      const result = await callTransform(
        optIn,
        `registerGlobal();`,
        nodePath.join(pkgDir, "dist", "index.js"),
      );
      expect(result).not.toBeNull();
      expect(codeOf(result)).toContain("/*#__PURE__*/ registerGlobal()");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.effect(
    "route registrations in the entry survive minify: true (end-to-end)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-pure-949-e2e-",
        });

        // A user app package with NO sideEffects declaration — the exact
        // shape from the issue (Hono-style discarded-return registration).
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ name: "my-app", type: "module" }),
        );
        const entry = path.join(root, "entry.ts");
        yield* fs.writeFileString(
          entry,
          [
            `import { app } from "./app.ts";`,
            `import "./routes.ts";`,
            `app.get("/", () => "ENTRY_ROUTE_MARKER");`,
            `export default { fetch: (p: string) => app.handle(p) };`,
          ].join("\n"),
        );
        yield* fs.writeFileString(
          path.join(root, "app.ts"),
          [
            `type Handler = () => string;`,
            `class Router {`,
            `  routes: Record<string, Handler> = {};`,
            `  get(p: string, h: Handler) { this.routes[p] = h; }`,
            `  handle(p: string) { return this.routes[p]?.() ?? "404"; }`,
            `}`,
            `export const app = new Router();`,
          ].join("\n"),
        );
        // Side-effect-imported module registering more routes — the same
        // failure class beyond the entry file itself.
        yield* fs.writeFileString(
          path.join(root, "routes.ts"),
          [
            `import { app } from "./app.ts";`,
            `app.get("/side", () => "SIDE_EFFECT_ROUTE_MARKER");`,
          ].join("\n"),
        );

        const bundle = yield* Effect.tryPromise({
          try: () =>
            rolldown({
              input: entry,
              cwd: root,
              plugins: [purePlugin()],
              treeshake: true,
            }),
          catch: (cause) => cause,
        });
        const { output } = yield* Effect.tryPromise({
          try: () => bundle.generate({ format: "esm", minify: true }),
          catch: (cause) => cause,
        });
        yield* Effect.tryPromise({
          try: () => bundle.close(),
          catch: (cause) => cause,
        });

        const code = output
          .filter((c) => c.type === "chunk")
          .map((c) => c.code)
          .join("\n");
        expect(code).toContain("ENTRY_ROUTE_MARKER");
        expect(code).toContain("SIDE_EFFECT_ROUTE_MARKER");

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
        // Windows requires elevation for "dir" symlinks; junctions don't.
        const nm = path.join(root, "node_modules");
        yield* fs.makeDirectory(nm, { recursive: true });
        nodeFs.symlinkSync(
          pkgDir,
          path.join(nm, "fake-ws"),
          process.platform === "win32" ? "junction" : "dir",
        );

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

  it.effect("emits valid sourcemaps with no SOURCEMAP_BROKEN warning", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-pure-sourcemap-",
      });

      const fakePkgDir = path.join(root, "node_modules", "fake-effect");
      yield* fs.makeDirectory(fakePkgDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(fakePkgDir, "package.json"),
        JSON.stringify({
          name: "fake-effect",
          version: "0.0.0",
          type: "module",
          sideEffects: false,
          exports: { ".": "./index.js", "./decls": "./decls.js" },
        }),
      );
      // One module with annotatable top-level calls (transformed) and
      // one with only declarations (metadata-only result). Under the
      // old implementation the latter returned untransformed code with
      // no map, flooding the build with SOURCEMAP_BROKEN warnings.
      yield* fs.writeFileString(
        path.join(fakePkgDir, "index.js"),
        [
          `export * from "./decls.js";`,
          `export const used = makeUsed();`,
          `function makeUsed() { return "USED_MARKER"; }`,
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(fakePkgDir, "decls.js"),
        `export function helper() { return "HELPER_MARKER"; }`,
      );

      const entry = path.join(root, "entry.js");
      yield* fs.writeFileString(
        entry,
        [
          `import { used, helper } from "fake-effect";`,
          `console.log(used, helper());`,
        ].join("\n"),
      );

      const logs: RolldownLog[] = [];
      const bundle = yield* Effect.tryPromise({
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
            onLog: (_level, log) => {
              logs.push(log);
            },
          }),
        catch: (cause) => cause,
      });
      const { output } = yield* Effect.tryPromise({
        try: () => bundle.generate({ format: "esm", sourcemap: true }),
        catch: (cause) => cause,
      });
      yield* Effect.tryPromise({
        try: () => bundle.close(),
        catch: (cause) => cause,
      });

      expect(logs.map((log) => log.code)).not.toContain("SOURCEMAP_BROKEN");

      const chunk = output.find((c) => c.type === "chunk");
      expect(chunk).toBeDefined();
      expect(chunk!.map).toBeTruthy();
      expect(chunk!.map!.mappings.length).toBeGreaterThan(0);

      yield* fs.remove(root, { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// Touch Bundle to ensure tree-shaking re-export ordering during type-check.
void Bundle;
