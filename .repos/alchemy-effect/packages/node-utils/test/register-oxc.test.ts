import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const write = (file: string, content: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};

/**
 * A project exercising everything tsx layers over Node that a TypeScript
 * codebase relies on: tsconfig `paths`, emitted-extension imports, implicit
 * extensions and directory indexes, JSON without attributes, TSX with a
 * tsconfig-selected runtime, and `require()` from a `.cts` into ESM
 * TypeScript.
 */
const makeProject = () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "alchemy-register-oxc-")));
  temporaryDirectories.push(root);
  const at = (file: string) => path.join(root, file);
  write(at("package.json"), '{"type":"module"}');
  write(
    at("tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "myjsx",
        baseUrl: ".",
        paths: { "@lib/*": ["src/lib/*"] },
      },
    }),
  );
  write(
    at("node_modules/myjsx/package.json"),
    '{"name":"myjsx","type":"module","exports":{"./jsx-runtime":"./jsx-runtime.js","./jsx-dev-runtime":"./jsx-runtime.js"}}',
  );
  write(
    at("node_modules/myjsx/jsx-runtime.js"),
    "export const jsx = (tag, props) => ({ tag, props });\nexport const jsxs = jsx;\nexport const jsxDEV = jsx;\nexport const Fragment = 'F';\n",
  );
  write(
    at("node_modules/wsdep/package.json"),
    '{"name":"wsdep","type":"module","exports":{".":"./src/index.ts"}}',
  );
  write(at("node_modules/wsdep/src/index.ts"), 'export const fromWorkspaceDep: string = "ws";\n');
  write(
    at("node_modules/conditional/package.json"),
    '{"name":"conditional","type":"module","exports":{".":{"bun":"./src/index.ts","import":"./lib/index.js"}}}',
  );
  write(at("node_modules/conditional/src/index.ts"), 'export const selected: string = "src";\n');
  write(at("node_modules/conditional/lib/index.js"), 'export const selected = "lib";\n');
  write(at("src/lib/helper.ts"), 'export const helper = (): string => "helper";\n');
  write(at("src/lib/helper.js"), 'export const helper = () => "emitted";\n');
  write(at("src/dir/index.ts"), 'export const index = "dir-index";\n');
  write(at("src/sub.ts"), 'export const sub = "sub";\n');
  write(at("src/data.json"), '{ "answer": 42 }');
  write(at("src/View.tsx"), 'export const view = <p id="x">hi</p>;\n');
  write(at("cjs/package.json"), '{"type":"commonjs"}');
  write(
    at("cjs/esmish.ts"),
    "export const value: number = 7;\nexport class A { constructor(readonly x: number) {} }\n",
  );
  write(
    at("cjs/consumer.cts"),
    'const { value, A } = require("./esmish.ts");\nconst sub = require("../src/sub");\nmodule.exports = { viaRequire: new A(value).x + 1, sub: sub.sub };\n',
  );
  write(
    at("src/entry.ts"),
    [
      'import { helper } from "@lib/helper";',
      'import { helper as helperJs } from "./lib/helper.js";',
      'import { sub } from "./sub";',
      'import { index } from "./dir";',
      'import { index as index2 } from "./dir/";',
      'import data from "./data.json";',
      'import { view } from "./View.tsx";',
      'import consumer from "../cjs/consumer.cts";',
      "export const report = {",
      "  helper: helper(), helperJs: helperJs(), sub, index, index2,",
      "  data: data.answer, view: view.tag,",
      "  viaRequire: consumer.viaRequire, requiredSub: consumer.sub,",
      "};",
      "export const boom = (): never => {",
      '  throw new Error("boom");',
      "};",
    ].join("\n"),
  );
  return root;
};

const srcUrl = (file: string) => pathToFileURL(path.resolve(import.meta.dir, "../src", file)).href;
const registerUrl = srcUrl("loader/register.ts");

const runNode = (
  cwd: string,
  script: string,
  env: Record<string, string> = {},
  nodeArgs: ReadonlyArray<string> = [],
) =>
  spawnSync("node", [...nodeArgs, "--no-warnings", "--input-type=module", "-e", script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 20_000,
  });

describe("registerOxc", () => {
  it("resolves and transpiles TypeScript the way tsx does", () => {
    const root = makeProject();
    const cache = path.join(root, "cache");
    const script = `
      const { registerOxc } = await import(${JSON.stringify(registerUrl)});
      registerOxc();
      const entry = await import("./src/entry.ts");
      console.log(JSON.stringify(entry.report));
      try { entry.boom(); } catch (error) { console.log(error.stack.split("\\n")[1].trim()); }
      `;
    const result = runNode(root, script, { ALCHEMY_TRANSFORM_CACHE: cache });
    expect(result.status, result.stderr).toBe(0);
    const [report, frame] = result.stdout.trim().split("\n");
    expect(JSON.parse(report!)).toEqual({
      // tsconfig paths alias
      helper: "helper",
      // `.js` import prefers the `.ts` source over the emitted sibling
      helperJs: "helper",
      // extensionless and directory imports
      sub: "sub",
      index: "dir-index",
      index2: "dir-index",
      // JSON without an import attribute
      data: 42,
      // TSX through the tsconfig's jsxImportSource
      view: "p",
      // `.cts` requiring `.ts` (parameter property) and an extensionless path
      viaRequire: 8,
      requiredSub: "sub",
    });
    // Source maps are applied to stack traces. They are not inlined: each
    // sits next to its cache entry, without `sourcesContent`, and the module
    // points at it by path.
    expect(frame).toMatch(/entry\.ts:15:/);
    const maps = readdirSync(cache).filter((name) => name.endsWith(".map"));
    expect(maps.length).toBeGreaterThan(0);
    for (const name of maps) {
      const map = JSON.parse(readFileSync(path.join(cache, name), "utf8"));
      expect(map.sourcesContent).toBeUndefined();
      // By URL: a bare path would resolve against the cache directory.
      expect(map.sources[0]).toMatch(/^file:\/\/.*\.(ts|tsx|cts|js)$/);
    }
    // The cache-hit path references the same file.
    const hit = runNode(root, script, { ALCHEMY_TRANSFORM_CACHE: cache });
    expect(hit.status, hit.stderr).toBe(0);
    expect(hit.stdout.trim().split("\n")[1]).toMatch(/entry\.ts:15:/);
    // With no cache there is nowhere to put the map, so it is inlined.
    const inline = runNode(root, script, { ALCHEMY_TRANSFORM_CACHE: "0" });
    expect(inline.status, inline.stderr).toBe(0);
    expect(inline.stdout.trim().split("\n")[1]).toMatch(/entry\.ts:15:/);
  });

  it("inlines source maps with their source while an inspector is attached", () => {
    const root = makeProject();
    const cache = path.join(root, "cache");
    // What a debugger sees for each module: a map it can always read, not a
    // reference into the shared cache directory. Run twice to cover a cold
    // transform and a cache hit.
    const script = `
      const { Session } = await import("node:inspector");
      const session = new Session();
      session.connect();
      const maps = {};
      session.on("Debugger.scriptParsed", ({ params }) => {
        if (params.url.endsWith("/src/sub.ts")) maps.sub = params.sourceMapURL;
      });
      session.post("Debugger.enable");
      const { registerOxc } = await import(${JSON.stringify(registerUrl)});
      registerOxc();
      await import("./src/sub.ts");
      console.log(maps.sub);
      `;
    for (const _ of [0, 1]) {
      const result = runNode(root, script, { ALCHEMY_TRANSFORM_CACHE: cache }, ["--inspect=0"]);
      expect(result.status, result.stderr).toBe(0);
      const sourceMapUrl = result.stdout.trim();
      expect(sourceMapUrl).toStartWith("data:application/json;base64,");
      const map = JSON.parse(Buffer.from(sourceMapUrl.split(",")[1]!, "base64").toString("utf8"));
      expect(map.sources).toEqual([pathToFileURL(path.join(root, "src/sub.ts")).href]);
      expect(map.sourcesContent).toEqual([readFileSync(path.join(root, "src/sub.ts"), "utf8")]);
    }
  });

  it("imports files as text with the type: text attribute", () => {
    const root = makeProject();
    write(path.join(root, "src/notes.txt"), "\uFEFFhéllo\n`${not code}`\n");
    write(path.join(root, "node_modules/textdep/data.txt"), "from a dependency");
    write(
      path.join(root, "src/texts.ts"),
      [
        'import notes from "./notes.txt" with { type: "text" };',
        'import source from "./sub.ts" with { type: "text" };',
        'import { sub } from "./sub.ts";',
        'import dependency from "textdep/data.txt" with { type: "text" };',
        "export const texts = { notes, source, sub, dependency };",
      ].join("\n"),
    );
    const result = runNode(
      root,
      `
      const { registerOxc } = await import(${JSON.stringify(registerUrl)});
      registerOxc({ filter: (path) => !path.includes("/node_modules/") });
      const { texts } = await import("./src/texts.ts");
      console.log(JSON.stringify(texts));
      `,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      // UTF-8 decoded like TextDecoder: BOM stripped, nothing evaluated
      notes: "héllo\n`${not code}`\n",
      // TypeScript imported as text is its untranspiled source, a module
      // distinct from the same file imported as code
      source: 'export const sub = "sub";\n',
      sub: "sub",
      // the node_modules filter only limits transpiling
      dependency: "from a dependency",
    });
  });

  it("adds configured package export conditions to project resolution", () => {
    const root = makeProject();
    write(path.join(root, "src/conditional.ts"), 'export { selected } from "conditional";\n');
    const result = runNode(
      root,
      `
      const { registerOxc } = await import(${JSON.stringify(registerUrl)});
      registerOxc({ conditions: ["bun"] });
      const conditional = await import("./src/conditional.ts");
      console.log(conditional.selected);
      `,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("src");
  });

  it("isolates namespaced imports and leaves node_modules to Node with a filter", () => {
    const root = makeProject();
    const result = runNode(
      root,
      `
      const { registerHooks } = await import("node:module");
      const { createHooks } = await import(${JSON.stringify(srcUrl("loader/hooks.ts"))});
      const { namespaced, importNamespaced } = await import(${JSON.stringify(srcUrl("loader/namespace.ts"))});
      const { registerOxc } = await import(${JSON.stringify(registerUrl)});
      const seen = [];
      const one = registerHooks(namespaced(createHooks(), { namespace: "one", onImport: (url) => seen.push(url.split("/").pop()) }));
      const a = await importNamespaced("./src/sub.ts", import.meta.url, "one");
      const b = await importNamespaced("./src/sub.ts", import.meta.url, "one");
      const two = registerHooks(namespaced(createHooks(), { namespace: "two" }));
      const c = await importNamespaced("./src/sub.ts", import.meta.url, "two");
      console.log(JSON.stringify({ same: a === b, fresh: a !== c, seen }));
      one.deregister();
      two.deregister();
      registerOxc({ filter: (file) => !file.includes("/node_modules/") });
      try {
        await import("wsdep");
        console.log("wsdep: loaded");
      } catch (error) {
        console.log("wsdep: " + error.code);
      }
      `,
    );
    expect(result.status, result.stderr).toBe(0);
    const [scoped, filtered] = result.stdout.trim().split("\n");
    expect(JSON.parse(scoped!)).toEqual({
      same: true,
      fresh: true,
      seen: ["sub.ts"],
    });
    // With node_modules filtered out, the dependency's `.ts` is Node's to
    // reject: the loader neither transpiles nor rewrites it.
    expect(filtered).toBe("wsdep: ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
  });
});

describe("transform cache", () => {
  /** `options` is the literal passed to `registerOxc` in the child. */
  const importSub = (options: string) => `
    const { registerOxc } = await import(${JSON.stringify(registerUrl)});
    registerOxc(${options});
    const { sub } = await import("./src/sub.ts");
    console.log(sub);
    `;

  it("reuses Oxc output across processes and keys on the tsconfig", () => {
    const root = makeProject();
    const cache = path.join(root, "cache");
    const first = runNode(root, importSub(`{ cache: ${JSON.stringify(cache)} }`));
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout.trim()).toBe("sub");
    const entries = readdirSync(cache)
      .filter((name) => name.endsWith(".code"))
      .map((name) => path.join(cache, name));
    expect(entries.length).toBeGreaterThan(0);
    // The only proof a second process READ the entry rather than
    // transforming again: make the cached code say something the source
    // does not.
    const entry = entries.find((file) => readFileSync(file, "utf8").includes('"sub"'));
    expect(entry).toBeDefined();
    writeFileSync(entry!, readFileSync(entry!, "utf8").replace('"sub"', '"from-cache"'));
    const second = runNode(root, importSub(`{ cache: ${JSON.stringify(cache)} }`));
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout.trim()).toBe("from-cache");
    // The resolved tsconfig is part of the key: editing it is a miss.
    const tsconfig = path.join(root, "tsconfig.json");
    const config = JSON.parse(readFileSync(tsconfig, "utf8")) as {
      compilerOptions: Record<string, unknown>;
    };
    config.compilerOptions.target = "ES2020";
    writeFileSync(tsconfig, JSON.stringify(config));
    const third = runNode(root, importSub(`{ cache: ${JSON.stringify(cache)} }`));
    expect(third.status, third.stderr).toBe(0);
    expect(third.stdout.trim()).toBe("sub");
  });

  it("takes its directory from the environment and can be switched off", () => {
    const root = makeProject();
    const fromEnv = path.join(root, "cache-from-env");
    const viaEnv = runNode(root, importSub("{}"), {
      ALCHEMY_TRANSFORM_CACHE: fromEnv,
    });
    expect(viaEnv.status, viaEnv.stderr).toBe(0);
    expect(readdirSync(fromEnv).length).toBeGreaterThan(0);

    const disabled = path.join(root, "cache-disabled");
    const off = runNode(root, importSub("{ cache: false }"), {
      ALCHEMY_TRANSFORM_CACHE: disabled,
    });
    expect(off.status, off.stderr).toBe(0);
    expect(off.stdout.trim()).toBe("sub");
    expect(existsSync(disabled)).toBe(false);
  });
});

describe("compile cache", () => {
  it("flushes lazily loaded modules to Node's compile cache", () => {
    const root = makeProject();
    const directory = path.join(root, "compile-cache");
    const result = runNode(
      root,
      `
      import { enableCompileCache } from "node:module";
      import { readdirSync } from "node:fs";
      enableCompileCache(${JSON.stringify(directory)});
      const count = () =>
        readdirSync(${JSON.stringify(directory)}, { recursive: true })
          .filter((name) => name.includes("/")).length;
      const { registerOxc } = await import(${JSON.stringify(registerUrl)});
      registerOxc();
      // Past Node's own post-entry persist.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const before = count();
      await import("./src/sub.ts");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      console.log(JSON.stringify({ before, after: count() }));
      // Not a clean exit: whatever is on disk got there through the flush.
      process.kill(process.pid, "SIGKILL");
      `,
    );
    expect(result.signal).toBe("SIGKILL");
    const { before, after } = JSON.parse(result.stdout.trim()) as {
      before: number;
      after: number;
    };
    expect(after).toBeGreaterThan(before);
  });
});
