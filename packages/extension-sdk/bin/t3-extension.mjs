#!/usr/bin/env node
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeChildProcess from "node:child_process";
import { build } from "esbuild";
import { validateEnvironmentPackage, validateServerExtension } from "../dist/environment.js";
import { rewriteEmittedLabels } from "./emit-labels.mjs";
const sdk = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url)));
const require = NodeModule.createRequire(import.meta.url);
const [command, target = "."] = process.argv.slice(2);
const sha = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
// Emitted bundles carry the resolved-path labels esbuild stamps into
// comments and generated wrapper keys; emit-labels.mjs rewrites just those
// positions to canonical node_modules/<name>/… spellings so build output
// is identical across checkout locations and working directories. The
// emitted JavaScript is the authoritative compile — it is parsed, never
// re-bundled.
const buildCanonical = async (dir, options) => {
  const result = await build({
    ...options,
    absWorkingDir: dir,
    stdin: options.stdin ? { ...options.stdin, resolveDir: dir } : undefined,
    write: false,
    metafile: true,
  });
  return rewriteEmittedLabels(result.outputFiles[0].text, Object.keys(result.metafile.inputs), dir);
};
async function check(dir) {
  const pkg = validateEnvironmentPackage(
    JSON.parse(await NodeFSP.readFile(NodePath.join(dir, "t3-extension.json"), "utf8")),
  );
  const hashes = {};
  for (const name of ["t3-extension.json", pkg.clientEntry, pkg.serverEntry].filter(Boolean)) {
    const bytes = await NodeFSP.readFile(NodePath.join(dir, name));
    hashes[name] = sha(bytes);
  }
  for (const asset of pkg.format === 4 ? pkg.assets : []) {
    const bytes = await NodeFSP.readFile(NodePath.join(dir, asset.path));
    if (bytes.length !== asset.byteLength || sha(bytes) !== asset.sha256)
      throw new Error("Package asset digest mismatch: " + asset.path);
    hashes[asset.path] = asset.sha256;
  }
  if (pkg.serverEntry) {
    const server = await import(
      NodeURL.pathToFileURL(NodePath.join(dir, pkg.serverEntry)).href + "?check=" + Date.now()
    );
    validateServerExtension(pkg, server.default);
  }
  if (pkg.clientEntry) {
    const client = await import(
      NodeURL.pathToFileURL(NodePath.join(dir, pkg.clientEntry)).href + "?check=" + Date.now()
    );
    if (typeof client.default !== "function") throw new Error("clientEntry must export a factory");
    const extension = client.default({ React: require("react") });
    if (JSON.stringify(extension.manifest) !== JSON.stringify(pkg.manifest))
      throw new Error("Client manifest differs from package manifest");
    if (
      JSON.stringify(extension.surfaces.map((s) => s.id).sort()) !==
      JSON.stringify(pkg.manifest.surfaces.map((s) => s.id).sort())
    )
      throw new Error("Client surface implementations differ from declarations");
  }
  try {
    const receipt = JSON.parse(await NodeFSP.readFile(NodePath.join(dir, "receipt.json"), "utf8"));
    if (
      receipt.generator === "t3-extension" &&
      JSON.stringify(receipt.hashes) !== JSON.stringify(hashes)
    )
      throw new Error("Built files differ from receipt; rebuild the source");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    kind: "package-check",
    installed: false,
    packageId: pkg.manifest.id,
    version: pkg.manifest.version,
    hashes,
  };
}
async function main() {
  if (command === "create") {
    const dir = NodePath.resolve(target);
    await NodeFSP.mkdir(dir); // Refuse to overwrite an existing directory.
    await NodeFSP.cp(NodePath.join(sdk, "examples/start-here"), dir, { recursive: true });
    console.log(
      JSON.stringify({ created: dir, next: "Install this SDK tarball here, then npm run build." }),
    );
    return;
  }
  if (command === "check") {
    console.log(JSON.stringify(await check(NodePath.resolve(target)), null, 2));
    return;
  }
  if (command !== "build")
    throw new Error(
      "Usage: t3-extension create <new-directory> | build <source-directory> | check <built-directory>",
    );
  // Realpath so labels esbuild derives from absWorkingDir never mix
  // symlinked and physical spellings of the same directory.
  const dir = await NodeFSP.realpath(NodePath.resolve(target));
  const out = NodePath.join(dir, ".t3-extension");
  const temp = await NodeFSP.mkdtemp(NodePath.join(dir, ".t3-extension-build-"));
  const backup = temp + "-previous";
  let moved = false;
  try {
    const entry = NodePath.join(dir, "extension.ts");
    await build({
      entryPoints: [entry],
      outfile: NodePath.join(temp, "definition.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      logLevel: "silent",
    });
    const authored = (
      await import(NodeURL.pathToFileURL(NodePath.join(temp, "definition.mjs")).href)
    ).default;
    const declaredAssets = authored.assets ?? [];
    const packedAssets = [];
    const sourceRoot = await NodeFSP.realpath(dir);
    for (const declared of declaredAssets) {
      const source = NodePath.join(dir, declared.path);
      const stat = await NodeFSP.lstat(source);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("Asset source must be a regular file: " + declared.path);
      if (!(await NodeFSP.realpath(source)).startsWith(sourceRoot + NodePath.sep))
        throw new Error("Asset source escapes the source directory: " + declared.path);
      const bytes = await NodeFSP.readFile(source);
      packedAssets.push({
        path: declared.path,
        byteLength: bytes.length,
        sha256: sha(bytes),
        mediaType: declared.mediaType,
      });
      const target = NodePath.join(temp, declared.path);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.copyFile(source, target);
    }
    const pkg = validateEnvironmentPackage(
      packedAssets.length ? { ...authored.package, assets: packedAssets } : authored.package,
    );
    if (
      authored.serverEntry &&
      (NodePath.isAbsolute(authored.serverEntry) ||
        authored.serverEntry.split(/[\\\\/]/).includes(".."))
    )
      throw new Error("serverEntry must stay inside the source directory");
    // Explicit files cannot be omitted by the author's include/exclude patterns.
    const config = NodePath.join(temp, "tsconfig.json");
    await NodeFSP.writeFile(
      config,
      JSON.stringify({
        extends: NodePath.join(dir, "tsconfig.json"),
        files: [
          entry,
          ...(authored.serverEntry ? [NodePath.resolve(dir, authored.serverEntry)] : []),
        ],
        compilerOptions: { noEmit: true, strict: true, allowJs: true, checkJs: true },
      }),
    );
    const typecheck = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(NodePath.dirname(require.resolve("typescript/package.json")), "bin/tsc"),
        "--project",
        config,
        "--noEmit",
      ],
      { stdio: "inherit" },
    );
    if (typecheck.status !== 0)
      throw new Error("Declared entry typecheck failed (exit " + typecheck.status + ")");
    await NodeFSP.rm(config);
    const bundle = async (contents, platform) =>
      buildCanonical(dir, {
        tsconfig: NodePath.join(dir, "tsconfig.json"),
        stdin: { contents, resolveDir: dir, sourcefile: "generated-entry.ts", loader: "ts" },
        bundle: true,
        platform,
        format: "esm",
        target: platform === "browser" ? "es2022" : "node24",
        logLevel: "silent",
      });
    if (pkg.clientEntry) {
      // Evaluate dependency modules inside each factory so imported hooks share the host identity.
      const client = await buildCanonical(dir, {
        tsconfig: NodePath.join(dir, "tsconfig.json"),
        stdin: {
          contents: 'import extension from "./extension.ts"; export default extension.client;',
          resolveDir: dir,
          sourcefile: "generated-client.ts",
          loader: "ts",
        },
        bundle: true,
        platform: "browser",
        format: "iife",
        globalName: "__t3Client",
        target: "es2022",
        logLevel: "silent",
        plugins: [
          {
            name: "host-react",
            setup(build) {
              build.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => {
                if (!["react", "react/jsx-runtime", "react/jsx-dev-runtime"].includes(path))
                  throw new Error("Unsupported host React entry: " + path);
                return { path, namespace: "host-react" };
              });
              build.onResolve({ filter: /^react-dom(?:\/.*)?$/ }, () => {
                throw new Error(
                  "React DOM imports need a public host contract; do not bundle another renderer.",
                );
              });
              build.onLoad({ filter: /.*/, namespace: "host-react" }, ({ path }) => ({
                loader: "js",
                contents:
                  path === "react"
                    ? "module.exports = __t3Host.React;"
                    : "const R = __t3Host.React; exports.Fragment = R.Fragment; " +
                      // Dev React warns for array children whose
                      // _store.validated is falsy, but createElement only
                      // marks its vararg children — the automatic runtime
                      // passes children inside props, so nothing was marked
                      // and every static sibling group warned. Mirror the
                      // real runtimes: jsxs and isStaticChildren jsxDEV
                      // mark each child element; jsx marks only the
                      // children node itself, so unkeyed dynamic lists
                      // still warn.
                      "const mark = (n) => { " +
                      "if (n && typeof n === 'object' && n._store) n._store.validated = 1; }; " +
                      "const el = (type, props, key, isStatic) => { " +
                      "const c = props == null ? undefined : props.children; " +
                      "if (Array.isArray(c)) { " +
                      "if (isStatic) { for (const x of c) mark(x); Object.freeze(c); } " +
                      "} else mark(c); " +
                      "return R.createElement(type, key === undefined ? props : { ...props, key }); " +
                      "}; " +
                      "exports.jsx = (t, p, k) => el(t, p, k, false); " +
                      "exports.jsxs = (t, p, k) => el(t, p, k, true); " +
                      "exports.jsxDEV = (t, p, k, s) => el(t, p, k, s === true);",
              }));
            },
          },
        ],
      });
      await NodeFSP.writeFile(
        NodePath.join(temp, pkg.clientEntry),
        "export default function (__t3Host) {\n" +
          client +
          "\nreturn __t3Client.default(__t3Host);\n}\n",
      );
    }
    if (pkg.serverEntry) {
      if (
        !authored.serverEntry ||
        NodePath.isAbsolute(authored.serverEntry) ||
        authored.serverEntry.split(/[\\/]/).includes("..")
      )
        throw new Error("serverEntry must stay inside the source directory");
      await NodeFSP.writeFile(
        NodePath.join(temp, pkg.serverEntry),
        await bundle(
          "import server from " +
            JSON.stringify("./" + authored.serverEntry) +
            "; export default { tools: [], ...server };",
          "node",
        ),
      );
    }
    await NodeFSP.rm(NodePath.join(temp, "definition.mjs"));
    await NodeFSP.writeFile(
      NodePath.join(temp, "t3-extension.json"),
      JSON.stringify(pkg, null, 2) + "\n",
    );
    const receipt = await check(temp);
    await NodeFSP.writeFile(
      NodePath.join(temp, "receipt.json"),
      JSON.stringify(
        {
          ...receipt,
          generator: "t3-extension",
          sourceEntrySha256: sha(await NodeFSP.readFile(entry)),
        },
        null,
        2,
      ) + "\n",
    );
    try {
      const old = JSON.parse(await NodeFSP.readFile(NodePath.join(out, "receipt.json"), "utf8"));
      if (old.generator !== "t3-extension")
        throw new Error("Refusing to replace an unowned output directory");
      await NodeFSP.rename(out, backup);
      moved = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        await NodeFSP.access(out);
        throw new Error("Output exists without a generated receipt", { cause: error });
      } catch (absent) {
        if (absent.code !== "ENOENT") throw absent;
      }
    }
    try {
      await NodeFSP.rename(temp, out);
    } catch (error) {
      if (moved) await NodeFSP.rename(backup, out);
      moved = false;
      throw error;
    }
    if (moved) {
      await NodeFSP.rm(backup, { recursive: true });
      moved = false;
    }
    console.log(JSON.stringify({ output: out, ...receipt }, null, 2));
  } finally {
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
