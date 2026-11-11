import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { cloudflare as officialCloudflare } from "@cloudflare/vite-plugin";
import * as vite from "vite";
import { afterAll, describe, expect, it } from "vitest";
import cloudflareVitePlugin from "../../plugin.ts";

// Differential conformance: the same project built with
// `@cloudflare/vite-plugin` and with Alchemy's plugin must produce the same
// output layout, which frameworks and deploy tooling read back.

const COMPATIBILITY_DATE = "2026-03-17";
const FLAGS = ["nodejs_compat"];

// Wrangler's deploy configuration, not part of the build output Alchemy reads.
const WRANGLER_OUTPUTS = new Set([".dev.vars", "wrangler.json", ".assetsignore"]);

const WORKER = [
  `import { Buffer } from "node:buffer";`,
  `import text from "./message.txt";`,
  `export default {`,
  `  async fetch() {`,
  `    using _scope = { [Symbol.dispose]() {} };`,
  `    const { lazy } = await import("./lazy.ts");`,
  `    return new Response(Buffer.from(text + lazy).toString());`,
  `  },`,
  `};`,
].join("\n");

const CLIENT = {
  "index.html": `<!doctype html><html><body><script type="module" src="/src/client.ts"></script></body></html>`,
  "src/client.ts": `import "./client.css"; console.log("client");`,
  "src/client.css": `body { color: red; }`,
};

const WORKER_FILES = {
  "src/index.ts": WORKER,
  "src/lazy.ts": `export const lazy = "lazy";`,
  "src/message.txt": "hello",
};

interface Shape {
  name: string;
  files: Record<string, string>;
  /** Whether the project has a Worker entry. */
  worker: boolean;
}

const SHAPES: ReadonlyArray<Shape> = [
  {
    name: "a Worker and a client",
    worker: true,
    files: { ...WORKER_FILES, ...CLIENT, "public/robots.txt": "User-agent: *" },
  },
  {
    name: "a Worker and public assets only",
    worker: true,
    files: { ...WORKER_FILES, "public/robots.txt": "User-agent: *" },
  },
  {
    name: "a Worker importing an asset by URL",
    worker: true,
    files: {
      ...WORKER_FILES,
      "src/index.ts": `import logo from "./logo.svg?url";\nexport default { fetch: () => new Response(logo) };`,
      "src/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
    },
  },
  { name: "a Worker only", worker: true, files: WORKER_FILES },
  {
    name: "assets only",
    worker: false,
    files: { ...CLIENT, "public/robots.txt": "User-agent: *" },
  },
];

const roots: Array<string> = [];

const project = async (files: Record<string, string>) => {
  const root = await NodeFs.realpath(
    await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "alchemy-vite-build-parity-")),
  );
  roots.push(root);
  for (const [file, content] of Object.entries({
    "package.json": JSON.stringify({ type: "module" }),
    ...files,
  })) {
    await NodeFs.mkdir(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    await NodeFs.writeFile(NodePath.join(root, file), content);
  }
  return root;
};

const build = async (root: string, plugins: vite.PluginOption) => {
  const builder = await vite.createBuilder({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [plugins],
  });
  await builder.buildApp();
};

const official = (shape: Shape) =>
  officialCloudflare({
    viteEnvironment: { name: "ssr" },
    inspectorPort: false,
    persistState: false,
    config: {
      name: "worker",
      ...(shape.worker ? { main: "./src/index.ts" } : {}),
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: FLAGS,
    },
  });

const alchemy = (shape: Shape) =>
  cloudflareVitePlugin({
    ...(shape.worker ? { main: "./src/index.ts" } : {}),
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: FLAGS,
  });

/** Every output file, relative to `dist`, with content hashes normalized. */
const outputs = async (root: string) => {
  const dist = NodePath.join(root, "dist");
  const files = await NodeFs.readdir(dist, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  return files
    .filter((file) => file.isFile() && !WRANGLER_OUTPUTS.has(file.name))
    .map((file) =>
      NodePath.relative(dist, NodePath.join(file.parentPath, file.name))
        .replaceAll("\\", "/")
        .replace(/-[\w-]{8}(?=\.)/g, "-[hash]"),
    )
    .sort();
};

// The exported names; the local bindings behind them are the bundler's.
const exportedNames = (root: string) =>
  NodeFs.readFile(NodePath.join(root, "dist/ssr/index.js"), "utf8").then((code) =>
    [...code.matchAll(/export\s*\{([^}]*)\}/g)]
      .flatMap((match) => match[1]!.split(","))
      .map((specifier) =>
        specifier
          .trim()
          .split(/\s+as\s+/)
          .at(-1),
      )
      .filter(Boolean)
      .sort(),
  );

afterAll(async () => {
  await Promise.all(roots.map((root) => NodeFs.rm(root, { recursive: true, force: true })));
});

describe.each(SHAPES)("build output matches @cloudflare/vite-plugin for $name", (shape) => {
  const built = (async () => {
    const [officialRoot, alchemyRoot] = await Promise.all([
      project(shape.files),
      project(shape.files),
    ]);
    await build(officialRoot, official(shape));
    await build(alchemyRoot, alchemy(shape));
    return { officialRoot, alchemyRoot };
  })();

  it("emits the same files", async () => {
    const { officialRoot, alchemyRoot } = await built;
    expect(await outputs(alchemyRoot)).toEqual(await outputs(officialRoot));
  }, 120_000);

  it.skipIf(!shape.worker)(
    "keeps the same entry chunk exports",
    async () => {
      const { officialRoot, alchemyRoot } = await built;
      expect(await exportedNames(alchemyRoot)).toEqual(await exportedNames(officialRoot));
    },
    120_000,
  );
});

it("keeps `using` declarations as written", async () => {
  const root = await project(SHAPES[0]!.files);
  await build(root, alchemy(SHAPES[0]!));
  const code = await NodeFs.readFile(NodePath.join(root, "dist/ssr/index.js"), "utf8");
  expect(code).toMatch(/\busing [\w$]+ =/);
}, 120_000);
