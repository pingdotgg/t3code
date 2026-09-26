import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import React from "react";
import TestRenderer from "react-test-renderer";
import { rewriteEmittedLabels } from "../bin/emit-labels.mjs";

const sdk = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const cli = NodePath.join(sdk, "bin/t3-extension.mjs");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A self-contained extension source: no SDK import (the fixture only proves
// bundler behavior), real JSX through the automatic transform, and a server
// entry so both emitted bundles are exercised.
const tsconfig = (jsx) =>
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      jsx,
      allowImportingTsExtensions: true,
    },
    include: ["*.ts", "*.tsx"],
  });

// Component names and list tags vary per variant because dev React dedupes
// the missing-key warning per reconciled parent fiber name — "ul" in the
// prod pass would suppress the dev pass's warning if both used it.
const component = (suffix, list) => `import DepView from "jsx-dep";
export function StaticList${suffix}() {
  return (
    <${list}>
      <li>static one</li>
      <li>static two</li>
      <DepView />
    </${list}>
  );
}
export function DynamicList${suffix}() {
  return <${list}>{["a", "b"].map((item) => <li>{item}</li>)}</${list}>;
}
`;

const extension = (suffix) => `import dep from "fixture-dep";
import { StaticList${suffix}, DynamicList${suffix} } from "./component.js";
const surface = (name: string) => ({
  id: "test.bundler/" + name,
  title: name + "-" + dep.value,
  placements: ["side-panel"],
  clients: ["web"],
  scope: "environment",
  capabilities: [],
  stateVersion: 1,
});
const manifest = {
  id: "test.bundler",
  apiVersion: 1,
  version: "1.0.0",
  surfaces: [surface("static-${suffix.toLowerCase()}"), surface("dynamic-${suffix.toLowerCase()}")],
};
export default {
  package: {
    format: 2,
    manifest,
    clientEntry: "client.mjs",
    serverEntry: "server.mjs",
    tools: [],
    dependencies: [],
    provides: [],
    requires: [],
  },
  serverEntry: "server.ts",
  client: () => ({
    manifest,
    surfaces: [
      {
        id: "test.bundler/static-${suffix.toLowerCase()}",
        validateRestore: () => true,
        createView: () => ({ renderer: StaticList${suffix} }),
      },
      {
        id: "test.bundler/dynamic-${suffix.toLowerCase()}",
        validateRestore: () => true,
        createView: () => ({ renderer: DynamicList${suffix} }),
      },
    ],
  }),
};
`;

// The template literal embeds a line shaped exactly like a bundled-module
// banner comment — it is string data and must survive the build verbatim.
const TEXT = "before\n// server.ts\nafter";
const SERVER = `import dep from "fixture-dep";
import left from "left-dep";
import right from "right-dep";
import inner from "inner-dep";
import glob from "glob-dep";
import singleA from "alias-a";
import singleB from "alias-b";
import realPkg from "real-pkg";
import uni from "uni-dep";
const text = \`before
// server.ts
after\`;
export default {
  tools: [],
  depValue: dep.value,
  text,
  values: [left, right],
  interop: inner,
  globbed: glob.feature("a"),
  plugged: glob.plugin("b"),
  quoted: glob.feature('qu"ote'),
  loadFault: glob.feature,
  uni,
  singleA,
  singleB,
  transitive: realPkg,
};
`;

// Real external dependencies that live OUTSIDE the package directory and
// are reached through node_modules symlinks — the shapes that used to leak
// checkout-relative paths into emitted module identities. Everything sits
// under depDir/node_modules so realpath resolution lands modules on a path
// whose canonical label is the node_modules/ suffix:
// - fixture-dep: ordinary named CJS package.
// - left-dep/right-dep: nameless packages (no "name" in package.json) whose
//   index.cjs bytes are IDENTICAL but whose relative imports must resolve
//   into different sibling files — content-equal modules that must not merge.
// - inner-dep: "type": "module" package whose .js entry default-imports a
//   transpiled-looking .cjs — native interop must yield module.exports.
// - glob-dep: two dynamic require globs in one importer — expanded files
//   never reach onResolve — plus non-ASCII and quote-containing filenames
//   whose emitted keys arrive JavaScript-escaped.
// - single: one physical package the fixture links under two names — the
//   bundle must wire both spellings to one instance, not two copies.
// - real-pkg: package whose own dependency (transitive-dep) exists ONLY
//   beside its real target — reachable by realpath, invisible from the
//   symlink spelling.
// - transitive-dep: pulled in solely through real-pkg's sibling lookup.
// - uni-dep: a package whose entry filename is non-ASCII — esbuild emits
//   its label ASCII-escaped, so matching must decode first.
// - jsx-dep: a package whose entry is .tsx — jsxdev emits its escaped path
//   as fileName metadata inside each jsxDEV call.
async function writeSharedDeps(dir) {
  const w = async (pkg, files) => {
    await NodeFSP.mkdir(pkg, { recursive: true });
    await Promise.all(
      Object.entries(files).map(async ([name, body]) => {
        const file = NodePath.join(pkg, name);
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        await NodeFSP.writeFile(file, body);
      }),
    );
  };
  const modules = NodePath.join(dir, "node_modules");
  await Promise.all([
    w(NodePath.join(modules, "fixture-dep"), {
      "package.json": JSON.stringify({
        name: "fixture-dep",
        version: "1.0.0",
        type: "commonjs",
        main: "index.cjs",
        types: "index.d.ts",
      }),
      "index.cjs": "module.exports = { value: 42 };\n",
      "index.d.ts": "declare const dep: { value: number };\nexport default dep;\n",
    }),
    // left-dep / right-dep (nameless, byte-identical index.cjs)
    ...["left", "right"].map((value) =>
      w(NodePath.join(modules, value), {
        "package.json": JSON.stringify({
          version: "1.0.0",
          type: "commonjs",
          main: "index.cjs",
          types: "index.d.ts",
        }),
        "index.cjs": 'module.exports = require("./value.cjs");\n',
        "value.cjs": "module.exports = " + JSON.stringify(value) + ";\n",
        "index.d.ts": "declare const v: string;\nexport default v;\n",
      }),
    ),
    w(NodePath.join(modules, "inner"), {
      "package.json": JSON.stringify({
        name: "inner-dep",
        version: "1.0.0",
        type: "module",
        main: "entry.js",
        types: "entry.d.ts",
      }),
      "entry.js": 'import dep from "./dep.cjs";\nexport default dep;\n',
      "dep.cjs":
        'exports.__esModule = true;\nexports.default = "inner";\nexports.extra = "outer";\n',
      "entry.d.ts": "declare const v: { default: string; extra: string };\nexport default v;\n",
    }),
    w(NodePath.join(modules, "glob-dep"), {
      "package.json": JSON.stringify({
        name: "glob-dep",
        version: "1.0.0",
        type: "commonjs",
        main: "index.cjs",
        types: "index.d.ts",
      }),
      "index.cjs":
        'exports.feature = (name) => require("./features/" + name + ".cjs");\n' +
        'exports.plugin = (name) => require("./plugins/" + name + ".cjs");\n',
      "features/a.cjs": 'module.exports = "loaded";\n',
      "features/fail-é.cjs": 'throw new Error("glob-fault");\n',
      "features/ok-🚀.cjs": 'module.exports = "astral";\n',
      'features/qu"ote.cjs': 'module.exports = "quoted";\n',
      "plugins/b.cjs": 'module.exports = "plugged";\n',
      "index.d.ts":
        "declare const load: { feature: (name: string) => unknown; plugin: (name: string) => unknown };\nexport default load;\n",
    }),
    // One physical package the fixture links under two spellings.
    w(NodePath.join(modules, "single"), {
      "package.json": JSON.stringify({
        name: "single-dep",
        version: "1.0.0",
        type: "commonjs",
        main: "index.cjs",
        types: "index.d.ts",
      }),
      "index.cjs": 'module.exports = { marker: "single" };\n',
      "index.d.ts": "declare const v: { marker: string };\nexport default v;\n",
    }),
    // real-pkg's require("transitive-dep") resolves only by walking up from
    // its real location — the fixture never links transitive-dep itself.
    w(NodePath.join(modules, "real-pkg"), {
      "package.json": JSON.stringify({
        name: "real-pkg",
        version: "1.0.0",
        type: "commonjs",
        main: "index.cjs",
        types: "index.d.ts",
      }),
      "index.cjs": 'module.exports = require("transitive-dep");\n',
      "index.d.ts": "declare const v: string;\nexport default v;\n",
    }),
    w(NodePath.join(modules, "transitive-dep"), {
      "package.json": JSON.stringify({
        name: "transitive-dep",
        version: "1.0.0",
        type: "commonjs",
        main: "index.cjs",
      }),
      "index.cjs": 'module.exports = "transitive-loaded";\n',
    }),
    w(NodePath.join(modules, "uni-dep"), {
      "package.json": JSON.stringify({
        name: "uni-dep",
        version: "1.0.0",
        type: "commonjs",
        main: "café.cjs",
        types: "index.d.ts",
      }),
      "café.cjs": 'module.exports = "café";\n',
      "index.d.ts": "declare const v: string;\nexport default v;\n",
    }),
    w(NodePath.join(modules, "jsx-dep"), {
      "package.json": JSON.stringify({
        name: "jsx-dep",
        version: "1.0.0",
        type: "module",
        main: "view.tsx",
        types: "view.d.ts",
      }),
      "view.tsx": "export default function DepView() {\n  return <b>dep</b>;\n}\n",
      "view.d.ts": "declare const v: () => null;\nexport default v;\n",
    }),
  ]);
}

// Fixtures live outside the package root: `test/` is in the package's
// `files` list, so temp dirs under it would ship in `npm pack` and race the
// pack scan. A local node_modules symlink gives tsc the real React types —
// exactly what a consuming project gets from its install.
async function writeFixture(dir, jsx = "react-jsx", depDir) {
  const suffix = jsx === "react-jsxdev" ? "Dev" : "Prod";
  const list = jsx === "react-jsxdev" ? "ol" : "ul";
  await NodeFSP.mkdir(NodePath.join(dir, "node_modules", "@types"), { recursive: true });
  await NodeFSP.symlink(
    NodePath.join(sdk, "node_modules/react"),
    NodePath.join(dir, "node_modules", "react"),
  );
  await NodeFSP.symlink(
    NodePath.join(sdk, "node_modules/@types/react"),
    NodePath.join(dir, "node_modules", "@types", "react"),
  );
  for (const [entry, target] of [
    ["fixture-dep", "fixture-dep"],
    ["left-dep", "left"],
    ["right-dep", "right"],
    ["inner-dep", "inner"],
    ["glob-dep", "glob-dep"],
    ["alias-a", "single"],
    ["alias-b", "single"],
    ["real-pkg", "real-pkg"],
    ["uni-dep", "uni-dep"],
    ["jsx-dep", "jsx-dep"],
  ])
    await NodeFSP.symlink(
      NodePath.join(depDir, "node_modules", target),
      NodePath.join(dir, "node_modules", entry),
    );
  await NodeFSP.writeFile(NodePath.join(dir, "tsconfig.json"), tsconfig(jsx));
  await NodeFSP.writeFile(NodePath.join(dir, "extension.ts"), extension(suffix));
  await NodeFSP.writeFile(NodePath.join(dir, "component.tsx"), component(suffix, list));
  await NodeFSP.writeFile(NodePath.join(dir, "server.ts"), SERVER);
}

function build(dir, cwd) {
  const result = NodeChildProcess.spawnSync(process.execPath, [cli, "build", dir], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
  if (result.status !== 0)
    throw new Error(`t3-extension build ${dir} (cwd ${cwd}) failed:\n${result.stderr}`);
}

const readBundle = (dir, entry) => NodeFSP.readFile(NodePath.join(dir, ".t3-extension", entry));

NodeTest.test("bundler output is deterministic across build cwd and checkout path", async (t) => {
  // Two fixture copies at different depths, each built from a different cwd,
  // each consuming the same out-of-package CommonJS dep through a symlink.
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bundler-"));
  t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const depDir = NodePath.join(root, "shared-deps");
  await writeSharedDeps(depDir);
  for (const jsx of ["react-jsx", "react-jsxdev"]) {
    const first = NodePath.join(root, "a", jsx, "proj");
    const second = NodePath.join(root, "b", "nested", "deep", jsx, "proj");
    await writeFixture(first, jsx, depDir);
    await writeFixture(second, jsx, depDir);
    build(first, root);
    const firstBytes = {
      client: await readBundle(first, "client.mjs"),
      server: await readBundle(first, "server.mjs"),
    };
    build(first, sdk);
    NodeAssert.deepEqual(
      await readBundle(first, "client.mjs"),
      firstBytes.client,
      `rebuild from another cwd changed bytes (${jsx})`,
    );
    build(second, first);
    for (const entry of ["client", "server"]) {
      NodeAssert.deepEqual(
        await readBundle(second, `${entry}.mjs`),
        firstBytes[entry],
        `checkout path leaked into ${entry}.mjs (${jsx})`,
      );
    }
    const server = firstBytes.server.toString("utf8");
    const client = firstBytes.client.toString("utf8");
    // The CommonJS wrapper key is the node_modules spelling, never the
    // depth-dependent relative path the module resolved from — including
    // glob-expanded files, which never reach an onResolve hook.
    NodeAssert.ok(
      server.includes('"node_modules/fixture-dep/index.cjs"'),
      `no canonical dep key: ${jsx}`,
    );
    NodeAssert.ok(
      server.includes('"node_modules/glob-dep/features/a.cjs"'),
      `glob-expanded file lost its canonical key: ${jsx}`,
    );
    NodeAssert.ok(
      server.includes('"node_modules/transitive-dep/index.cjs"'),
      `transitive dep beside a linked package's real target lost its canonical key: ${jsx}`,
    );
    // Escaped and quote-bearing filenames canonicalize too: esbuild emits
    // café.cjs as caf\xE9.cjs and qu"ote.cjs in single quotes — the emitted
    // spelling asserts the decoded name is canonical.
    NodeAssert.ok(
      server.includes('"node_modules/uni-dep/caf\\xE9.cjs"('),
      `escaped dep key not canonicalized: ${jsx}`,
    );
    NodeAssert.ok(
      server.includes('"node_modules/glob-dep/features/fail-\\xE9.cjs"('),
      `escaped glob-expanded key not canonicalized: ${jsx}`,
    );
    // Astral-plane filenames escape as uppercase \u{…} — matching esbuild's
    // convention so the emitted spelling stays canonical.
    NodeAssert.ok(
      server.includes('"node_modules/glob-dep/features/ok-\\u{1F680}.cjs"('),
      `astral dep key not canonicalized: ${jsx}`,
    );
    NodeAssert.ok(
      server.includes("'node_modules/glob-dep/features/qu\"ote.cjs'("),
      `quote-bearing dep key not canonicalized: ${jsx}`,
    );
    // Each glob-expansion synthetic name keeps its own require pattern with
    // a canonical importer — distinct labels, no literal "$1" interpolation
    // bug.
    NodeAssert.ok(
      server.includes("'require(\"./features/**/*.cjs\") in node_modules/glob-dep/index.cjs'("),
      `features glob synthetic name not canonical: ${jsx}`,
    );
    NodeAssert.ok(
      server.includes("'require(\"./plugins/**/*.cjs\") in node_modules/glob-dep/index.cjs'("),
      `plugins glob synthetic name not canonical: ${jsx}`,
    );
    NodeAssert.ok(
      server.includes('// require("./plugins/**/*.cjs") in node_modules/glob-dep/index.cjs'),
      `glob synthetic banner not canonical: ${jsx}`,
    );
    NodeAssert.ok(!server.includes("$1"), `literal "$1" in output: ${jsx}`);
    // No generated method key retains a checkout-relative spelling.
    NodeAssert.ok(
      !/^[\t ]*["'][^"'\n]*\.\.[^"'\n]*["']\s*\(/m.test(server),
      `checkout-relative wrapper key survived: ${jsx}`,
    );
    if (jsx === "react-jsxdev") {
      // jsxdev emits dep source paths as fileName metadata — canonical there
      // too, not just in comments and keys.
      NodeAssert.ok(
        client.includes('fileName: "node_modules/jsx-dep/view.tsx"'),
        `jsxdep fileName not canonicalized: ${jsx}`,
      );
      NodeAssert.ok(
        !/fileName:\s*["']\.{2}/.test(client),
        `checkout-relative fileName survived: ${jsx}`,
      );
    }
    // The built server module imports with everything intact.
    const built = (
      await import(
        NodeURL.pathToFileURL(NodePath.join(second, ".t3-extension/server.mjs")).href +
          "?t=" +
          Date.now()
      )
    ).default;
    NodeAssert.equal(built.text, TEXT, `template-literal content was eaten (${jsx})`);
    NodeAssert.equal(built.depValue, 42, `bundled dep not wired (${jsx})`);
    // Byte-identical nameless packages are distinct modules: their relative
    // imports resolve into different siblings.
    NodeAssert.deepEqual(built.values, ["left", "right"], `content-equal modules merged (${jsx})`);
    // .js inside "type": "module" keeps native interop: a default import of
    // transpiled-looking CJS yields the whole module.exports object.
    NodeAssert.deepEqual(
      built.interop,
      { __esModule: true, default: "inner", extra: "outer" },
      `package-type interop changed (${jsx})`,
    );
    NodeAssert.equal(built.globbed, "loaded", `glob-expanded dep not wired (${jsx})`);
    NodeAssert.equal(built.plugged, "plugged", `second glob pattern not wired (${jsx})`);
    NodeAssert.equal(built.quoted, "quoted", `quote-named glob file not wired (${jsx})`);
    NodeAssert.equal(built.uni, "café", `non-ASCII dep entry not wired (${jsx})`);
    // A lazily required dep that throws: the runtime stack's function label
    // is the canonical module name, not the checkout-relative source path.
    // (The executing bundle's own file:// URL is expected and unrelated.)
    let fault = null;
    try {
      built.loadFault("fail-é");
    } catch (error) {
      fault = error;
    }
    NodeAssert.ok(fault, `throwing dep did not throw (${jsx})`);
    NodeAssert.ok(
      fault.stack.includes("at node_modules/glob-dep/features/fail-é.cjs"),
      `stack label not canonical (${jsx}): ${fault.stack}`,
    );
    NodeAssert.ok(
      !fault.stack.includes("shared-deps") && !/at \.{2}/.test(fault.stack),
      `checkout-relative label leaked into stack (${jsx}): ${fault.stack}`,
    );
    // Two spellings of one physical package share a single module instance —
    // preserveSymlinks bundled them as separate singletons.
    NodeAssert.equal(
      built.singleA,
      built.singleB,
      `same physical dep under two names bundled twice (${jsx})`,
    );
    // real-pkg's dependency exists only beside its real target — resolution
    // must walk the realpath, not the symlink spelling.
    NodeAssert.equal(
      built.transitive,
      "transitive-loaded",
      `dep beside a linked package's real target did not resolve (${jsx})`,
    );
    for (const entry of ["client", "server"]) {
      const text = firstBytes[entry].toString("utf8");
      for (const line of text.split("\n"))
        // Module banners are single-token `// <id>` lines; esbuild's own
        // helper comments are sentences and stay. With preserveSymlinks a
        // banner is always the import spelling — never ".." or absolute.
        if (/^[ \t]*\/\/ \S+\s*$/.test(line))
          NodeAssert.match(
            line.trim(),
            /^\/\/ (?!.*(\.\.|\/private\/|\/tmp\/|\/var\/))\S+$/,
            `${entry}.mjs embeds a location-dependent comment (${jsx}): ${line.trim()}`,
          );
    }
  }
});

NodeTest.test("canonicalization leaves path-shaped user data byte-for-byte intact", async (t) => {
  // The external dependency-relative path a bundled module is labeled
  // with can also legitimately appear in extension data — as a string
  // literal, inside a template, even as an object method name. Only
  // generated metadata positions may be rewritten.
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bundler-"));
  t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const depDir = NodePath.join(root, "shared-deps");
  await writeSharedDeps(depDir);
  const dir = NodePath.join(root, "data-probe");
  await writeFixture(dir, "react-jsx", depDir);
  // The emitted label spelling for fixture-dep's entry in this checkout —
  // an escaping path like ../shared-deps/node_modules/fixture-dep/index.cjs.
  const depLabel = NodePath.relative(
    dir,
    await NodeFSP.realpath(NodePath.join(depDir, "node_modules", "fixture-dep", "index.cjs")),
  );
  NodeAssert.ok(depLabel.startsWith(".."), "fixture does not exercise the leak shape");
  // An escaped spelling that decodes to the same path — string contents
  // are user data even when they equal a generated label's decode. The
  // source text must hold a real \x69 escape, so interpolate directly.
  const mixedLabel = depLabel.replace("index.cjs", "\\x69ndex.cjs");
  const template = `before\nfileName: "${depLabel}", lineNumber: 17\n// ${depLabel}\nafter`;
  const source = `import dep from "fixture-dep";
function user__esm(value: object) { return value; }
export default {
  tools: [],
  depValue: dep.value,
  pathLiteral: ${JSON.stringify(depLabel)},
  bannerLiteral: \`before
// ${depLabel}
after\`,
  labelKeyed: { ${JSON.stringify(depLabel)}() { return 7; } },
  // Ordinary records shaped like JSX fileName metadata are not labels.
  record: { fileName: ${JSON.stringify(depLabel)}, lineNumber: 17 },
  prefixRecord: { fileName: ${JSON.stringify(depLabel)}, lineNumberExtra: 23 },
  // A user identifier ending in a generated-suffix name is not a wrapper.
  adjacent: user__esm({ ${JSON.stringify(depLabel)}() { return 8; } }),
  // The same label inside metadata-shaped template text is still data.
  template: \`${template}\`,
  // Regex literals — including ones following control-flow parens — are
  // not string positions the rewriter may touch.
  regex: /__esm\\(\\{/.source,
  regexAfterParen: ("x".length ? ${JSON.stringify(depLabel)} : "") && /\\.\\./.test(".."),
  regexLabelBody: ${JSON.stringify(depLabel)}.length ? /\\.\\.\\/shared-deps/.source : "",
  mixed: "${mixedLabel}",
};
`;
  await NodeFSP.writeFile(NodePath.join(dir, "server.ts"), source);
  build(dir, root);
  const built = (
    await import(
      NodeURL.pathToFileURL(NodePath.join(dir, ".t3-extension/server.mjs")).href +
        "?t=" +
        Date.now()
    )
  ).default;
  NodeAssert.equal(
    built.pathLiteral,
    depLabel,
    "dependency-relative path string literal was rewritten",
  );
  NodeAssert.equal(
    built.bannerLiteral,
    `before\n// ${depLabel}\nafter`,
    "banner-shaped line inside a template literal was rewritten",
  );
  NodeAssert.equal(
    built.labelKeyed[depLabel](),
    7,
    "user object method named like a dep path was renamed",
  );
  NodeAssert.deepEqual(
    built.record,
    { fileName: depLabel, lineNumber: 17 },
    "ordinary fileName/lineNumber record was rewritten",
  );
  NodeAssert.deepEqual(
    built.prefixRecord,
    { fileName: depLabel, lineNumberExtra: 23 },
    "ordinary fileName/lineNumberExtra record was rewritten",
  );
  NodeAssert.equal(
    built.adjacent[depLabel](),
    8,
    "label-shaped key inside a __esm-suffixed user call was rewritten",
  );
  NodeAssert.equal(built.template, template, "metadata-shaped template text was rewritten");
  NodeAssert.equal(built.regex, "__esm\\(\\{", "regex literal source was rewritten");
  NodeAssert.equal(
    built.regexAfterParen,
    true,
    "regex literal after a control-flow paren was corrupted",
  );
  NodeAssert.equal(
    built.regexLabelBody,
    "\\.\\.\\/shared-deps",
    "regex literal following a label-shaped operand was corrupted",
  );
  NodeAssert.equal(
    built.mixed,
    depLabel,
    "escaped spelling of a dep path in user data was rewritten",
  );
  // The generated metadata for the same module is still canonical.
  const server = (await readBundle(dir, "server.mjs")).toString("utf8");
  NodeAssert.ok(
    server.includes('"node_modules/fixture-dep/index.cjs"'),
    "dep wrapper key lost its canonical label",
  );
});

NodeTest.test("emitted-label rewriter edits only generated positions", async (t) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-emit-labels-"));
  t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  await NodeFSP.mkdir(NodePath.join(root, "dep", "node_modules", "fixture-dep"), {
    recursive: true,
  });
  await NodeFSP.writeFile(
    NodePath.join(root, "dep", "node_modules", "fixture-dep", "package.json"),
    JSON.stringify({ name: "fixture-dep", type: "commonjs", main: "index.cjs" }),
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "dep", "node_modules", "fixture-dep", "index.cjs"),
    "module.exports = 1;\n",
  );
  const dir = NodePath.join(root, "proj");
  await NodeFSP.mkdir(dir, { recursive: true });
  const label = "../dep/node_modules/fixture-dep/index.cjs";
  const canon = "node_modules/fixture-dep/index.cjs";
  const helper = "var __commonJS = (cb, mod) => () => cb[Object.keys(cb)[0]]();\n";
  const inputs = [label, "server.ts"];

  // Banner comment and helper map key are generated positions; both rewrite.
  const emitted =
    helper +
    `// ${label}\nvar require_dep = __commonJS({ ${JSON.stringify(label)}(exports, module) {} });\n`;
  const out = rewriteEmittedLabels(emitted, inputs, dir);
  NodeAssert.ok(out.includes(`// ${canon}`), "banner comment kept raw label");
  NodeAssert.ok(
    out.includes(`${JSON.stringify(canon)}(exports, module)`),
    "helper map key kept raw label",
  );

  // A string key the build cannot explain fails the build — generated
  // metadata must never be half-rewritten. Provenance is positional: the
  // wrapper statement sits under its own banner and binds a
  // `require_*`/`init_*` name to a prologue helper call.
  NodeAssert.throws(
    () =>
      rewriteEmittedLabels(
        helper +
          `// ${label}\nvar require_dep = __commonJS({ ${JSON.stringify(label)}(exports, module) {}, "unexplained/key.cjs"(exports) {} });\n`,
        inputs,
        dir,
      ),
    /not a bundled input/,
  );

  // A helper-shaped call outside the wrapper position is user code — a
  // bare statement, a differently named var, a nested function — its keys
  // are data, never validated or rewritten. This holds even when the key
  // matches a bundled input label.
  const unproven =
    helper +
    `// ${label}\nvar require_dep = __commonJS({ ${JSON.stringify(label)}(exports, module) {} });\n` +
    `{ function __commonJS(x) { return x; } __commonJS({ ${JSON.stringify(label)}() {} }); }\n` +
    `const f = function __esm() { return __esm({ ${JSON.stringify(label)}() {} }); };\n` +
    `var mine = __commonJS({ "never-validated/key.cjs"() {} });\n` +
    `var __esm = (x) => Object.keys(x)[0];\n` +
    `var v = __esm({ "also-not-validated.cjs"() {} });\n`;
  const unprovenOut = rewriteEmittedLabels(unproven, inputs, dir);
  NodeAssert.ok(
    unprovenOut.includes("never-validated/key.cjs"),
    "non-wrapper helper call was validated",
  );
  NodeAssert.ok(
    unprovenOut.includes("also-not-validated.cjs"),
    "user var __esm call was validated",
  );
  NodeAssert.equal(
    unprovenOut.split(label).length - 1,
    2,
    "unproven helper calls had label-shaped keys rewritten",
  );

  // fileName metadata only rewrites inside a generated jsxDEV call — a
  // bare import pinned to the react/jsx-dev-runtime specifier — not a
  // user object's method, an arbitrary imported member, or any other
  // argument position.
  const jsx =
    `import runtime from "react/jsx-dev-runtime";\n` +
    `import fakeRuntime from "some-dep";\n` +
    `runtime.jsxDEV(a, b, c, d, { fileName: ${JSON.stringify(label)}, lineNumber: 1 });\n` +
    `fakeRuntime.jsxDEV(a, b, c, d, { fileName: ${JSON.stringify(label)}, lineNumber: 1 });\n` +
    `userObj.jsxDEV(a, b, c, d, { fileName: ${JSON.stringify(label)}, lineNumber: 1 });\n` +
    `runtime.jsxDEV(a, b, c, { fileName: ${JSON.stringify(label)}, lineNumber: 1 }, self);\n`;
  const jsxOut = rewriteEmittedLabels(jsx, inputs, dir);
  NodeAssert.ok(
    jsxOut.includes(`d, { fileName: ${JSON.stringify(canon)}, lineNumber: 1 })`),
    "jsxDEV source fileName kept raw label",
  );
  NodeAssert.equal(
    jsxOut.split(label).length - 1,
    3,
    "non-generated fileName positions were rewritten",
  );

  // In IIFE output the jsx namespace is a bundler `var` initialized by a
  // prologue __toESM over the require_* of the dev-runtime module — the
  // fileName rewrites there, but not through a look-alike var nor through
  // a namespace whose require_ wraps any other module.
  const wrapped =
    `var __commonJS = (cb, mod) => () => cb[Object.keys(cb)[0]]();\n` +
    `var __toESM = (x, m) => x;\n` +
    `// host-react:react/jsx-dev-runtime\n` +
    `var require_dev = __commonJS({ "host-react:react/jsx-dev-runtime"(e, m) {} });\n` +
    `// ${label}\n` +
    `var require_other = __commonJS({ ${JSON.stringify(label)}(e, m) {} });\n` +
    `// component.tsx\n` +
    `var import_jsx_dev_runtime = __toESM(require_dev());\n` +
    `var notRuntime = __toESM(require_other());\n` +
    `var userNs = userFactory();\n` +
    `import_jsx_dev_runtime.jsxDEV(a, b, c, d, { fileName: ${JSON.stringify(label)}, lineNumber: 1 });\n` +
    `notRuntime.jsxDEV(a, b, c, d, { fileName: ${JSON.stringify(label)}, lineNumber: 1 });\n` +
    `userNs.jsxDEV(a, b, c, d, { fileName: ${JSON.stringify(label)}, lineNumber: 1 });\n`;
  const wrappedOut = rewriteEmittedLabels(
    wrapped,
    [...inputs, "host-react:react/jsx-dev-runtime"],
    dir,
  );
  NodeAssert.ok(
    wrappedOut.includes(`d, { fileName: ${JSON.stringify(canon)}, lineNumber: 1 })`),
    "bundler-namespace jsxDEV fileName kept raw label",
  );
  NodeAssert.equal(
    wrappedOut.split(label).length - 1,
    2,
    "non-runtime-namespace jsxDEV fileName was rewritten",
  );

  // Plugin-namespace inputs (host-react:…) are valid helper-map keys but
  // not filesystem labels — accepted, never rewritten.
  const namespaced = rewriteEmittedLabels(
    helper +
      `// host-react:react/jsx-dev-runtime\n` +
      `var require_dev = __commonJS({ "host-react:react/jsx-dev-runtime"(exports) {} });\n`,
    [...inputs, "host-react:react/jsx-dev-runtime"],
    dir,
  );
  NodeAssert.ok(namespaced.includes('"host-react:react/jsx-dev-runtime"'));

  // Metafile keys keep every input spelling, including `<…>` pseudo-inputs
  // and filenames that begin with an angle bracket.
  const angle = rewriteEmittedLabels(`// <stdin>\nvar x = 1;\n`, ["<stdin>", "<local.cjs"], dir);
  NodeAssert.ok(angle.includes("// <stdin>"), "pseudo-input banner was rewritten");

  // A comment at byte zero bounds the prologue: a first-module banner (or
  // a leading user comment) means the bundle's first `var` already sits
  // under a comment and cannot be a helper, so a later banner cannot
  // promote it into provenance. The banner itself still rewrites; the
  // user map's keys and unknown keys are data and never validated.
  const bannerAtZero =
    `// ${label}\nvar __esm = (x) => Object.keys(x);\n` +
    `// entry.js\nvar init_x = __esm({ "entry.js": 1, ${JSON.stringify(label)}: 2 });\n`;
  const bannerAtZeroOut = rewriteEmittedLabels(bannerAtZero, [...inputs, "entry.js"], dir);
  NodeAssert.ok(
    bannerAtZeroOut.includes(`${JSON.stringify(label)}: 2`),
    "user map under a byte-zero banner was rewritten",
  );
  const commentAtZero =
    `// user comment\nvar __esm = (x) => Object.keys(x);\n` +
    `// entry.js\nvar init_x = __esm({ "entry.js": 1, ${JSON.stringify(label)}: 2 });\n`;
  NodeAssert.equal(
    rewriteEmittedLabels(commentAtZero, [...inputs, "entry.js"], dir),
    commentAtZero,
    "user comment at byte zero leaked a user var into the prologue",
  );
  const leadingNewline =
    `\n// user comment\nvar __esm = (x) => Object.keys(x);\n` +
    `// entry.js\nvar init_x = __esm({ "entry.js": 1, "customer-record": 2 });\n`;
  NodeAssert.doesNotThrow(() => rewriteEmittedLabels(leadingNewline, [...inputs, "entry.js"], dir));
  NodeAssert.ok(
    rewriteEmittedLabels(leadingNewline, [...inputs, "entry.js"], dir).includes(
      '"customer-record": 2',
    ),
    "user map after a leading newline was validated",
  );
});

NodeTest.test(
  "production CLI leaves user-authored helper and jsxDEV shapes untouched",
  async () => {
    // Provenance negatives, end to end through `t3-extension build`: user code
    // that resembles generated metadata is data, not a label position. `dep`
    // exports a jsxDEV-shaped function and lives outside the package root so
    // its own label canonicalizes — the user copies must not follow it.
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bundler-"));
    const dep = NodePath.join(root, "dep");
    await NodeFSP.mkdir(dep, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(dep, "package.json"),
      JSON.stringify({ name: "dep", main: "index.cjs" }),
    );
    await NodeFSP.writeFile(
      NodePath.join(dep, "index.cjs"),
      "// @ts-nocheck\nexports.jsxDEV = (a, b, c, d, source) => source.fileName;\nexports.value = 42;\n",
    );
    const dir = NodePath.join(root, "proj");
    await NodeFSP.mkdir(NodePath.join(dir, "node_modules", "@types"), { recursive: true });
    await NodeFSP.symlink(dep, NodePath.join(dir, "node_modules", "dep"));
    await NodeFSP.symlink(
      NodePath.join(sdk, "node_modules", "react"),
      NodePath.join(dir, "node_modules", "react"),
    );
    await NodeFSP.symlink(
      NodePath.join(sdk, "node_modules", "@types", "react"),
      NodePath.join(dir, "node_modules", "@types", "react"),
    );
    await NodeFSP.writeFile(NodePath.join(dir, "<local.cjs"), "module.exports = 'angle';\n");
    await NodeFSP.writeFile(
      NodePath.join(dir, "tsconfig.json"),
      tsconfig("react-jsxdev").replace(
        '"strict": true',
        '"strict": true, "checkJs": false, "allowJs": true',
      ),
    );
    await NodeFSP.writeFile(
      NodePath.join(dir, "extension.ts"),
      `export default {
  package: {
    format: 2,
    manifest: { id: "test.spoof", apiVersion: 1, version: "1.0.0", surfaces: [] },
    serverEntry: "server.mjs",
    tools: [],
    dependencies: [],
    provides: [],
    requires: [],
  },
  serverEntry: "server.ts",
};
`,
    );
    // Every reachable shape: a user var bound to a helper name whose map keys
    // match (and don't match) bundled inputs, the same inside a nested
    // function, a dep-exported jsxDEV member, a filename that opens with `<`,
    // and a hand-authored call into the real dev runtime — the documented
    // mimicry boundary, asserted as treated as generated.
    await NodeFSP.writeFile(
      NodePath.join(dir, "server.ts"),
      `// @ts-nocheck
import dep from "dep";
import angled from "./<local.cjs";
import { jsxDEV } from "react/jsx-dev-runtime";
var __esm = (x) => Object.keys(x)[0];
function nested() {
  var __commonJS = (x) => x;
  return Object.keys(__commonJS({ "../dep/index.cjs": () => dep.value, "never-a-module.cjs": () => 2 }));
}
export default {
  tools: [],
  angled,
  matched: __esm({ "../dep/index.cjs": () => dep.value }),
  unmatched: __esm({ "customer-record": () => dep.value }),
  nested: nested(),
  imported: dep.jsxDEV(null, null, null, null, { fileName: "../dep/index.cjs", lineNumber: 7 }),
  handAuthored: jsxDEV("b", {}, null, false, { fileName: "../dep/index.cjs", lineNumber: 1 }, undefined),
};
`,
    );
    build(dir, root);
    const server = (await readBundle(dir, "server.mjs")).toString("utf8");
    // The generated wrapper for `dep` still canonicalizes.
    NodeAssert.ok(
      server.includes('"node_modules/dep/index.cjs"('),
      "generated dep wrapper key was not canonicalized",
    );
    // The hand-authored call into the real dev runtime is emitted through
    // the same namespace the transform uses — the documented mimicry
    // boundary — so its fileName canonicalizes too.
    NodeAssert.ok(
      server.includes('fileName: "node_modules/dep/index.cjs"'),
      "hand-authored real-runtime fileName not canonicalized (boundary)",
    );
    const mod = await import(
      NodeURL.pathToFileURL(NodePath.join(dir, ".t3-extension", "server.mjs")).href +
        "?t=" +
        Date.now()
    );
    NodeAssert.equal(mod.default.matched, "../dep/index.cjs", "user map key was rewritten");
    NodeAssert.equal(mod.default.unmatched, "customer-record", "unknown user key was rewritten");
    NodeAssert.deepEqual(
      mod.default.nested,
      ["../dep/index.cjs", "never-a-module.cjs"],
      "nested user helper map was validated or rewritten",
    );
    NodeAssert.equal(
      mod.default.imported,
      "../dep/index.cjs",
      "dep-exported jsxDEV fileName was rewritten",
    );
    NodeAssert.equal(mod.default.angled, "angle", "<-named file failed to bundle");
  },
);

NodeTest.test(
  "production CLI never trusts prologue-position user helpers or look-alike runtime paths",
  async (t) => {
    // More provenance negatives, end to end. An ESM dep emitting a top-level
    // `var __esm` puts a user declaration where a no-helper bundle's prologue
    // would be: the module banner at byte zero must still bound the prologue,
    // so a later module's banner cannot promote the user var into a trusted
    // helper — neither its matching-key map nor its unknown-key map is
    // validated or rewritten. A dep whose file collides with the dev runtime's
    // path text — `react/jsx-dev-runtime.*` anywhere, including a nested
    // `node_modules/react/` inside the dep — is not the runtime: only
    // resolution identity (the file `react/jsx-dev-runtime` actually selects
    // from this package, or the controlled host-react namespace) proves the
    // jsxDEV provenance. The real runtime is installed alongside to make the
    // separation explicit.
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bundler-"));
    t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
    const w = async (p, s) => {
      await NodeFSP.mkdir(NodePath.dirname(p), { recursive: true });
      await NodeFSP.writeFile(p, s);
    };
    await w(
      NodePath.join(root, "esm-dep", "package.json"),
      JSON.stringify({ name: "esm-dep", type: "module", main: "index.js" }),
    );
    await w(
      NodePath.join(root, "esm-dep", "index.js"),
      "// @ts-nocheck\nexport var __esm = (x) => Object.keys(x);\n",
    );
    for (const [pkg, file] of [
      ["spoof-cjs", "react/jsx-dev-runtime.cjs"],
      ["spoof-js", "react/jsx-dev-runtime.js"],
      ["nested-dep", "node_modules/react/jsx-dev-runtime.js"],
    ]) {
      await w(NodePath.join(root, pkg, "package.json"), JSON.stringify({ name: pkg, main: file }));
      await w(
        NodePath.join(root, pkg, file),
        "// @ts-nocheck\nexports.jsxDEV = (a, b, c, d, source) => source.fileName;\n",
      );
    }
    const dir = NodePath.join(root, "proj");
    await NodeFSP.mkdir(NodePath.join(dir, "node_modules"), { recursive: true });
    for (const pkg of ["esm-dep", "spoof-cjs", "spoof-js", "nested-dep"])
      await NodeFSP.symlink(NodePath.join(root, pkg), NodePath.join(dir, "node_modules", pkg));
    // The real runtime is installed and resolvable — the nested look-alike
    // file is a different file, proven by resolution, not by its path text.
    await NodeFSP.symlink(
      NodePath.join(sdk, "node_modules", "react"),
      NodePath.join(dir, "node_modules", "react"),
    );
    await w(
      NodePath.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          jsx: "react-jsxdev",
          checkJs: false,
          allowJs: true,
          allowImportingTsExtensions: true,
          paths: {
            "ordinary-alias": ["../nested-dep/node_modules/react/jsx-dev-runtime.js"],
          },
        },
      }),
    );
    await w(
      NodePath.join(dir, "extension.ts"),
      `export default {
  package: {
    format: 2,
    manifest: { id: "test.prologue-spoof", apiVersion: 1, version: "1.0.0", surfaces: [] },
    serverEntry: "server.mjs",
    tools: [],
    dependencies: [],
    provides: [],
    requires: [],
  },
  serverEntry: "server.ts",
};
`,
    );
    await w(
      NodePath.join(dir, "server.ts"),
      `// @ts-nocheck
import { __esm } from "esm-dep";
import { jsxDEV as spoofCjs } from "spoof-cjs";
import { jsxDEV as spoofJs } from "spoof-js";
import { jsxDEV as nested } from "nested-dep";
import { jsxDEV as relative } from "../nested-dep/node_modules/react/jsx-dev-runtime.js";
import { jsxDEV as alias } from "ordinary-alias";
var init_user = __esm({ "server.ts": 1, "../esm-dep/index.js": 2 });
export default {
  tools: [],
  matched: init_user,
  unmatched: __esm({ "customer-record": 3 }),
  cjs: spoofCjs(null, null, null, null, { fileName: "../spoof-cjs/react/jsx-dev-runtime.cjs", lineNumber: 7 }),
  js: spoofJs(null, null, null, null, { fileName: "../spoof-js/react/jsx-dev-runtime.js", lineNumber: 7 }),
  nested: nested(null, null, null, null, { fileName: "../nested-dep/node_modules/react/jsx-dev-runtime.js", lineNumber: 7 }),
  relative: relative(null, null, null, null, { fileName: "../nested-dep/node_modules/react/jsx-dev-runtime.js", lineNumber: 7 }),
  alias: alias(null, null, null, null, { fileName: "../nested-dep/node_modules/react/jsx-dev-runtime.js", lineNumber: 7 }),
};
`,
    );
    build(dir, root);
    const mod = await import(
      NodeURL.pathToFileURL(NodePath.join(dir, ".t3-extension", "server.mjs")).href +
        "?t=" +
        Date.now()
    );
    NodeAssert.deepEqual(
      mod.default.matched,
      ["server.ts", "../esm-dep/index.js"],
      "first-module user helper map was rewritten",
    );
    NodeAssert.deepEqual(
      mod.default.unmatched,
      ["customer-record"],
      "unknown-key user map was validated or rewritten",
    );
    NodeAssert.equal(
      mod.default.cjs,
      "../spoof-cjs/react/jsx-dev-runtime.cjs",
      "colliding .cjs runtime filename was treated as the real runtime",
    );
    NodeAssert.equal(
      mod.default.js,
      "../spoof-js/react/jsx-dev-runtime.js",
      "colliding .js runtime filename was treated as the real runtime",
    );
    for (const field of ["nested", "relative", "alias"])
      NodeAssert.equal(
        mod.default[field],
        "../nested-dep/node_modules/react/jsx-dev-runtime.js",
        `nested look-alike path (${field}) was treated as the real runtime`,
      );
  },
);

NodeTest.test("canonicalization preserves manifest semantics and never degrades", async (t) => {
  // Regression pair: a staged rebuild dropped an inherited package.json
  // `sideEffects` entry, and tsconfig `paths` (or absolute imports) silently
  // shipped location-dependent labels. The emitted-text post-process leaves the
  // authoritative compile untouched, so both hold.
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bundler-"));
  t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const depDir = NodePath.join(root, "shared-deps");
  await writeSharedDeps(depDir);
  // The extension sits inside a parent package whose manifest marks the
  // entry's side effect — esbuild must see that context directly. Each
  // fixture copy writes the manifest at its own parent so the
  // package-relative path matches in both.
  const writeProbe = async (dir) => {
    await NodeFSP.mkdir(NodePath.dirname(dir), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(NodePath.dirname(dir), "package.json"),
      JSON.stringify({
        name: "parent",
        type: "module",
        sideEffects: ["./proj/effect.js"],
      }),
    );
    await NodeFSP.mkdir(NodePath.join(dir, "node_modules"), { recursive: true });
    await NodeFSP.symlink(
      NodePath.join(depDir, "node_modules", "fixture-dep"),
      NodePath.join(dir, "node_modules", "fixture-dep"),
    );
    await NodeFSP.mkdir(NodePath.join(dir, "lib"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(dir, "lib", "util.ts"),
      'export const v = "via-paths";\n',
    );
    await NodeFSP.writeFile(
      NodePath.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowJs: true,
          checkJs: false,
          allowImportingTsExtensions: true,
          paths: { "lib/*": ["./lib/*"] },
        },
      }),
    );
    await NodeFSP.writeFile(
      NodePath.join(dir, "extension.ts"),
      `export default {
  package: {
    format: 2,
    manifest: {
      id: "test.manifest-probe",
      apiVersion: 1,
      version: "1.0.0",
      surfaces: [],
    },
    serverEntry: "server.mjs",
    tools: [],
    dependencies: [],
    provides: [],
    requires: [],
  },
  serverEntry: "server.ts",
};
`,
    );
    await NodeFSP.writeFile(
      NodePath.join(dir, "effect.js"),
      "// @ts-nocheck\nglobalThis.__effectCount = (globalThis.__effectCount ?? 0) + 1;\n",
    );
    await NodeFSP.writeFile(
      NodePath.join(dir, "server.ts"),
      `import "./effect.js";
import dep from "fixture-dep";
// @ts-ignore - resolved through tsconfig paths
import { v } from "lib/util.ts";
export default { tools: [], dep, v, load: () => import("./effect.js") };
`,
    );
  };
  const shallow = NodePath.join(root, "proj");
  await writeProbe(shallow);
  build(shallow, root);
  const shallowServer = (await readBundle(shallow, "server.mjs")).toString("utf8");
  NodeAssert.ok(
    shallowServer.includes('"node_modules/fixture-dep/index.cjs"'),
    "dep label not canonicalized beside a tsconfig paths import",
  );
  NodeAssert.ok(
    !/^\/\/ \.\./m.test(shallowServer),
    "checkout-relative banner leaked into canonical output",
  );
  // The inherited-manifest side effect executes eagerly at module init;
  // the dynamic import returns the same evaluated module.
  globalThis.__effectCount = 0;
  const mod = await import(
    NodeURL.pathToFileURL(NodePath.join(shallow, ".t3-extension", "server.mjs")).href +
      "?t=" +
      Date.now()
  );
  NodeAssert.equal(globalThis.__effectCount, 1, "inherited-manifest side effect dropped");
  await mod.default.load();
  NodeAssert.equal(globalThis.__effectCount, 1, "dynamic import re-executed or lost");
  NodeAssert.equal(mod.default.v, "via-paths");
  // The same sources at another checkout depth are byte-identical — no
  // fallback path exists to silently degrade to.
  const deep = NodePath.join(root, "x", "y", "z", "proj");
  await writeProbe(deep);
  build(deep, root);
  NodeAssert.equal(
    (await readBundle(deep, "server.mjs")).toString("utf8"),
    shallowServer,
    "tsconfig-paths build changed bytes across checkout depth",
  );
});

NodeTest.test(
  "host-react shim marks static children validated like the real jsx runtime",
  async (t) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bundler-"));
    t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
    const depDir = NodePath.join(root, "shared-deps");
    await writeSharedDeps(depDir);
    for (const jsx of ["react-jsx", "react-jsxdev"]) {
      const dir = NodePath.join(root, jsx, "proj");
      await writeFixture(dir, jsx, depDir);
      build(dir, root);
      const factory = (
        await import(
          NodeURL.pathToFileURL(NodePath.join(dir, ".t3-extension/client.mjs")).href +
            "?t=" +
            Date.now()
        )
      ).default;
      const extension = factory({ React });
      const suffix = jsx === "react-jsxdev" ? "Dev" : "Prod";
      const rendererFor = (id) =>
        extension.surfaces.find((surface) => surface.id === id).createView({}).renderer;

      const errors = [];
      const original = console.error;
      console.error = (...args) => errors.push(args.join(" "));
      try {
        for (const id of [
          `test.bundler/static-${suffix.toLowerCase()}`,
          `test.bundler/dynamic-${suffix.toLowerCase()}`,
        ]) {
          const Component = rendererFor(id);
          let tree;
          await TestRenderer.act(async () => {
            tree = TestRenderer.create(React.createElement(Component));
          });
          NodeAssert.ok(tree.toJSON(), `${id} rendered nothing (${jsx})`);
          await TestRenderer.act(async () => tree.unmount());
        }
      } finally {
        console.error = original;
      }
      const keyWarnings = errors.filter((line) => line.includes('unique "key" prop'));
      // The dynamic unkeyed map still warns — marking is surgical, not
      // blanket. The static sibling group must not warn at all.
      NodeAssert.equal(keyWarnings.length, 1, `warnings (${jsx}): ${keyWarnings.join(" | ")}`);
      NodeAssert.ok(
        keyWarnings[0].includes(`DynamicList${suffix}`),
        `warning should name the dynamic-list owner (${jsx}): ${keyWarnings[0]}`,
      );
    }
  },
);
