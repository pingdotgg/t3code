import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
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
 * tsconfig-selected runtime, a workspace dependency whose `exports` name
 * unbuilt JavaScript, and `require()` from a `.cts` into ESM TypeScript.
 */
const makeProject = () => {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "alchemy-register-oxc-")),
  );
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
    '{"name":"wsdep","type":"module","exports":{".":"./src/index.js"}}',
  );
  write(
    at("node_modules/wsdep/src/index.ts"),
    'export const fromWorkspaceDep: string = "ws";\n',
  );
  write(
    at("node_modules/conditional/package.json"),
    '{"name":"conditional","type":"module","exports":{".":{"bun":"./src/index.ts","import":"./lib/index.js"}}}',
  );
  write(
    at("node_modules/conditional/src/index.ts"),
    'export const selected: string = "src";\n',
  );
  write(
    at("node_modules/conditional/lib/index.js"),
    'export const selected = "lib";\n',
  );
  write(
    at("src/lib/helper.ts"),
    'export const helper = (): string => "helper";\n',
  );
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
      'import { fromWorkspaceDep } from "wsdep";',
      'import consumer from "../cjs/consumer.cts";',
      "export const report = {",
      "  helper: helper(), helperJs: helperJs(), sub, index, index2,",
      "  data: data.answer, view: view.tag, fromWorkspaceDep,",
      "  viaRequire: consumer.viaRequire, requiredSub: consumer.sub,",
      "};",
      "export const boom = (): never => {",
      '  throw new Error("boom");',
      "};",
    ].join("\n"),
  );
  return root;
};

const registerUrl = pathToFileURL(
  path.resolve(import.meta.dir, "../src/register-oxc.ts"),
).href;

const runNode = (cwd: string, script: string) =>
  spawnSync("node", ["--no-warnings", "--input-type=module", "-e", script], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
  });

describe("registerOxc", () => {
  it("resolves and transpiles TypeScript the way tsx does", () => {
    const root = makeProject();
    const result = runNode(
      root,
      `
      const { registerOxc } = await import(${JSON.stringify(registerUrl)});
      registerOxc();
      const entry = await import("./src/entry.ts");
      console.log(JSON.stringify(entry.report));
      try { entry.boom(); } catch (error) { console.log(error.stack.split("\\n")[1].trim()); }
      `,
    );
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
      // dependency `exports` pointing at unbuilt JavaScript
      fromWorkspaceDep: "ws",
      // `.cts` requiring `.ts` (parameter property) and an extensionless path
      viaRequire: 8,
      requiredSub: "sub",
    });
    // Inline source maps are applied to stack traces.
    expect(frame).toMatch(/entry\.ts:16:/);
  });

  it("adds configured package export conditions to project resolution", () => {
    const root = makeProject();
    write(
      path.join(root, "src/conditional.ts"),
      'export { selected } from "conditional";\n',
    );
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
      const { registerOxc, tsImport } = await import(${JSON.stringify(registerUrl)});
      const state = globalThis;
      state.count = 0;
      const seen = [];
      const api = registerOxc({ namespace: "one", onImport: (url) => seen.push(url.split("/").pop()) });
      const a = await api.import("./src/sub.ts", import.meta.url);
      const b = await api.import("./src/sub.ts", import.meta.url);
      const c = await tsImport("./src/sub.ts", import.meta.url);
      console.log(JSON.stringify({ same: a === b, fresh: a !== c, seen }));
      api.unregister();
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

  it("unregisters one-shot imports after success and failure", () => {
    const root = makeProject();
    write(path.join(root, "src/broken.ts"), "export const = ;\n");
    const result = runNode(
      root,
      `
      const { tsImport } = await import(${JSON.stringify(registerUrl)});
      if (process.sourceMapsEnabled) throw new Error("source maps unexpectedly enabled before import");
      await tsImport("./src/sub.ts", import.meta.url);
      const afterSuccess = process.sourceMapsEnabled;
      try {
        await tsImport("./src/broken.ts", import.meta.url);
      } catch {}
      console.log(JSON.stringify({ afterSuccess, afterFailure: process.sourceMapsEnabled }));
      `,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      afterSuccess: false,
      afterFailure: false,
    });
  });
});
