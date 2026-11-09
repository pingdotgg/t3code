// @effect-diagnostics nodeBuiltinImport:off
// Builds the publishable package into dist: JavaScript and bundled declarations from src, and a
// package.json whose exports point at them. Publish or pack dist itself, never this folder, whose
// manifest exports the sources.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { build } from "vite-plus/pack";

const packageRoot = NodePath.resolve(import.meta.dirname, "..");
const repoRoot = NodePath.resolve(packageRoot, "../..");
const outDir = NodePath.join(packageRoot, "dist");
const entries = ["atom", "atom-react", "server", "shared", "ui", "vite", "web"];
// What the published declarations may import besides each other.
const PEER_IMPORT = /^react(\/|$)/;
const tsgo = NodePath.join(repoRoot, "node_modules/.bin/effect-tsgo");

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly license?: string;
  readonly repository?: object;
  readonly exports?: Readonly<Record<string, { readonly types: string }>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: object;
}
const readManifest = (file: string): PackageManifest =>
  JSON.parse(NodeFS.readFileSync(file, "utf8"));

NodeFS.rmSync(outDir, { recursive: true, force: true });
await build({
  cwd: packageRoot,
  config: false,
  logLevel: "warn",
  entry: Object.fromEntries(entries.map((name) => [name, `src/${name}.ts`])),
  outDir,
  platform: "node",
  fixedExtension: false,
  dts: false,
});

const declarations = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-plugin-sdk-types-"));
try {
  const emitted = NodeChildProcess.spawnSync(
    tsgo,
    ["tsrs", "-p", "tsconfig.build.json", "--outDir", declarations, "--noCheck"],
    { cwd: packageRoot, encoding: "utf8" },
  );
  if (emitted.error !== undefined) {
    throw new Error(`Could not run ${tsgo}.`, { cause: emitted.error });
  }
  if (emitted.status !== 0) {
    throw new Error(`Writing declarations failed:\n${emitted.stdout}${emitted.stderr}`);
  }

  await build({
    cwd: packageRoot,
    config: false,
    logLevel: "warn",
    entry: Object.fromEntries(
      entries.map((name) => [name, NodePath.join(declarations, `${name}.d.ts`)]),
    ),
    outDir,
    clean: false,
    fixedExtension: false,
    hash: false,
    dts: { dtsInput: true },
    deps: { neverBundle: PEER_IMPORT },
    inputOptions: { checks: { pluginTimings: false } },
    outputOptions: { chunkFileNames: "chunks/[name].d.ts" },
    plugins: [
      {
        // The sources import each other as `./name.ts`.
        name: "t3-sibling-declarations",
        resolveId(source: string, importer: string | undefined) {
          if (importer === undefined || !source.startsWith(".") || !/\.tsx?$/.test(source)) {
            return undefined;
          }
          return NodePath.resolve(NodePath.dirname(importer), source).replace(/\.tsx?$/, ".d.ts");
        },
      },
    ],
  });
} finally {
  NodeFS.rmSync(declarations, { recursive: true, force: true });
}

// The published declarations must import nothing but each other and peer dependencies, and must
// typecheck on their own.
const declarationFiles = NodeFS.readdirSync(outDir).filter((file) => file.endsWith(".d.ts"));
for (const file of declarationFiles) {
  const text = NodeFS.readFileSync(NodePath.join(outDir, file), "utf8");
  for (const [, specifier = ""] of text.matchAll(/(?:from|import\()\s*"([^"]+)"/g)) {
    if (!specifier.startsWith("./") && !PEER_IMPORT.test(specifier)) {
      throw new Error(
        `dist/${file} imports ${specifier}, which the published package can't reach.`,
      );
    }
  }
}
const checked = NodeChildProcess.spawnSync(
  tsgo,
  [
    "tsrs",
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "false",
    "--module",
    "nodenext",
    "--target",
    "es2023",
    "--lib",
    "esnext,dom",
    ...declarationFiles.map((file) => NodePath.join(outDir, file)),
  ],
  { cwd: packageRoot, encoding: "utf8" },
);
if (checked.error !== undefined)
  throw new Error(`Could not run ${tsgo}.`, { cause: checked.error });
if (checked.status !== 0) {
  throw new Error(
    `The published declarations don't typecheck:\n${checked.stdout}${checked.stderr}`,
  );
}

// The source manifest, private and exporting src, becomes one that exports dist.
const sources = readManifest(NodePath.join(packageRoot, "package.json"));
const published = {
  name: sources.name,
  version: sources.version,
  description: sources.description,
  license: sources.license,
  repository: sources.repository,
  type: "module",
  files: ["*.js", "*.d.ts", "chunks"],
  exports: Object.fromEntries(
    Object.entries(sources.exports ?? {}).map(([subpath, target]) => {
      const name = NodePath.basename(target.types, ".ts");
      return [subpath, { types: `./${name}.d.ts`, default: `./${name}.js` }];
    }),
  ),
  peerDependencies: sources.peerDependencies,
  peerDependenciesMeta: sources.peerDependenciesMeta,
};
NodeFS.writeFileSync(
  NodePath.join(outDir, "package.json"),
  `${JSON.stringify(published, null, 2)}\n`,
);
NodeFS.copyFileSync(NodePath.join(packageRoot, "README.md"), NodePath.join(outDir, "README.md"));
NodeFS.copyFileSync(NodePath.join(repoRoot, "LICENSE"), NodePath.join(outDir, "LICENSE"));
