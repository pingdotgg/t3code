// @effect-diagnostics nodeBuiltinImport:off - The captured-generation compiler owns bounded filesystem reads and esbuild cancellation.
// @effect-diagnostics globalTimers:off - The native compiler's deadline cancels and disposes its esbuild context.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as Esbuild from "esbuild";
import type { PluginManifest } from "@t3tools/contracts";

type PluginEntries = NonNullable<PluginManifest["entries"]>;
type CompilationTarget = "web" | "server";

export interface CompilePluginEntriesInput {
  readonly directory: string;
  readonly entries: PluginEntries;
  readonly signal?: AbortSignal;
  /** Symbol.for keys registered by the host before importing a generation. */
  readonly hostRuntimeKeys: Readonly<Record<CompilationTarget, string>>;
  /** Export names from the actual host namespaces, never plugin-owned dependencies. */
  readonly hostModules: Readonly<
    Record<CompilationTarget, Readonly<Record<string, ReadonlyArray<string>>>>
  >;
}

export interface CompilePluginEntriesResult {
  readonly entries: PluginEntries;
  /** Stable surface labels let approval fingerprints include generated executable bytes. */
  readonly compiledFiles: ReadonlyArray<{
    readonly surface: CompilationTarget;
    readonly bytes: Uint8Array;
  }>;
}

const MAX_INPUT_FILES = 2_000;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_RESOLUTION_PATHS = 24_000;
const COMPILE_TIMEOUT_MS = 10_000;
const LOADERS: Readonly<Record<string, Esbuild.Loader>> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".json": "json",
};
const RESOLVE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".json"];
const NODE_BUILTINS = new Set(
  NodeModule.builtinModules.flatMap((name) => [name, `node:${name.replace(/^node:/, "")}`]),
);

function inside(root: string, relativePath: string) {
  if (
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    NodePath.isAbsolute(relativePath)
  )
    throw new Error("Plugin imports must use relative paths inside their captured directory.");
  const filename = NodePath.resolve(root, relativePath);
  if (filename === root || !filename.startsWith(`${root}${NodePath.sep}`))
    throw new Error(`Plugin import '${relativePath}' escapes its captured directory.`);
  return filename;
}

function hostModuleSource(key: string, specifier: string, names: ReadonlyArray<string>) {
  const exports = [...new Set([...names, "default"])].map((name, index) => {
    const value =
      name === "default" ? "module.default ?? module" : `module[${JSON.stringify(name)}]`;
    return `const value${index} = ${value}; export { value${index} as ${JSON.stringify(name)} };`;
  });
  return `const module = globalThis[Symbol.for(${JSON.stringify(key)})]?.[${JSON.stringify(specifier)}];
if (!module) throw new Error(${JSON.stringify(`The plugin host has not registered '${specifier}'.`)});
${exports.join("\n")}`;
}

function compilationError(target: CompilationTarget, root: string, cause: unknown) {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "errors" in cause &&
    Array.isArray(cause.errors)
  ) {
    const errors = (cause as Esbuild.BuildFailure).errors.slice(0, 3).map((error) => {
      const location = error.location;
      const file = location?.file.replace(/^t3-plugin-source:/, "");
      const relative = file && NodePath.isAbsolute(file) ? NodePath.relative(root, file) : file;
      return `${relative ? `${relative}:${location!.line}:${location!.column + 1}: ` : ""}${error.text}`;
    });
    return new Error(`Plugin ${target} compilation failed: ${errors.join("\n").slice(0, 4_000)}`);
  }
  return new Error(
    `Plugin ${target} compilation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

/** Bundles captured entry graphs without consulting host node_modules or executing plugin code. */
export async function compilePluginEntries(
  input: CompilePluginEntriesInput,
): Promise<CompilePluginEntriesResult> {
  input.signal?.throwIfAborted();
  if (!NodePath.isAbsolute(input.directory))
    throw new Error("The plugin compiler requires an absolute captured-generation directory.");
  const root = NodePath.resolve(input.directory);
  const rootInfo = await NodeFSP.lstat(root);
  input.signal?.throwIfAborted();
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("The captured plugin directory must be a regular directory.");
  const files = new Map<string, Promise<Buffer>>();
  const inspected = new Map<string, Promise<boolean>>();
  let inputBytes = 0;
  let outputBytes = 0;
  const expiresAt = NodePerfHooks.performance.now() + COMPILE_TIMEOUT_MS;
  const assertDeadline = () => {
    input.signal?.throwIfAborted();
    if (NodePerfHooks.performance.now() >= expiresAt)
      throw new Error("Compilation exceeded 10 seconds. Reduce the entry graph and reload.");
  };

  const isFile = (filename: string): Promise<boolean> => {
    assertDeadline();
    const previous = inspected.get(filename);
    if (previous) return previous;
    if (inspected.size >= MAX_RESOLUTION_PATHS)
      throw new Error("The plugin entry graph requires too many filesystem paths.");
    const inspect = (async () => {
      const relative = NodePath.relative(root, filename);
      let current = root;
      const segments = relative.split(NodePath.sep);
      for (const [index, segment] of segments.entries()) {
        assertDeadline();
        current = NodePath.join(current, segment);
        try {
          const info = await NodeFSP.lstat(current);
          assertDeadline();
          if (info.isSymbolicLink())
            throw new Error("Plugin entry graphs cannot contain symlinks.");
          if (index === segments.length - 1) return info.isFile();
          if (!info.isDirectory()) return false;
        } catch (cause) {
          if (
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            (cause.code === "ENOENT" || cause.code === "ENOTDIR")
          )
            return false;
          throw cause;
        }
      }
      return false;
    })();
    inspected.set(filename, inspect);
    return inspect;
  };

  const read = (filename: string): Promise<Buffer> => {
    assertDeadline();
    const previous = files.get(filename);
    if (previous) return previous;
    if (files.size >= MAX_INPUT_FILES) throw new Error("A plugin entry graph exceeds 2,000 files.");
    const contents = (async () => {
      const handle = await NodeFSP.open(
        filename,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
      );
      try {
        assertDeadline();
        const info = await handle.stat();
        assertDeadline();
        if (!info.isFile()) throw new Error("Plugin imports must reference regular files.");
        if (info.size > MAX_INPUT_BYTES - inputBytes)
          throw new Error("The plugin entry graph exceeds 16 MiB.");
        inputBytes += info.size;
        const buffer = Buffer.alloc(info.size + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.byteLength) {
          assertDeadline();
          const chunk = await handle.read(
            buffer,
            bytesRead,
            buffer.byteLength - bytesRead,
            bytesRead,
          );
          assertDeadline();
          if (chunk.bytesRead === 0) break;
          bytesRead += chunk.bytesRead;
        }
        const after = await handle.stat();
        assertDeadline();
        if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
          throw new Error("The captured plugin changed during compilation. Reload it again.");
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    })();
    files.set(filename, contents);
    return contents;
  };

  const resolve = async (relative: string) => {
    const filename = inside(root, relative);
    const extension = NodePath.extname(filename);
    const aliases =
      extension === ".js"
        ? [".ts", ".tsx"]
        : extension === ".mjs"
          ? [".mts"]
          : extension === ".cjs"
            ? [".cts"]
            : [];
    const candidates = [
      filename,
      ...aliases.map((alias) => filename.slice(0, -extension.length) + alias),
      ...RESOLVE_EXTENSIONS.map((suffix) => filename + suffix),
      ...RESOLVE_EXTENSIONS.map((suffix) => NodePath.join(filename, `index${suffix}`)),
    ];
    for (const candidate of candidates) {
      const exists = await isFile(candidate);
      assertDeadline();
      if (exists) return candidate;
    }
    throw new Error(`Plugin import '${relative}' is missing from the captured directory.`);
  };

  const entries = { ...input.entries };
  const outputs: Array<{ surface: CompilationTarget; filename: string; contents: Uint8Array }> = [];
  for (const target of ["web", "server"] as const) {
    const entry = input.entries[target];
    if (!entry) continue;
    const entryPath = inside(root, entry);
    if (!LOADERS[NodePath.extname(entryPath)] || NodePath.extname(entryPath) === ".json")
      throw new Error(`Plugin ${target} entries must be JavaScript, TypeScript, or JSX files.`);
    const outfile = NodePath.join(
      NodePath.dirname(entryPath),
      `_t3-compiled-${target}-${NodeCrypto.randomUUID()}.mjs`,
    );
    let context: Esbuild.BuildContext | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      context = await Esbuild.context({
        absWorkingDir: root,
        entryPoints: [entry],
        outfile,
        bundle: true,
        format: "esm",
        platform: target === "server" ? "node" : "browser",
        inject: target === "server" ? ["t3:node-require"] : [],
        target: "es2022",
        jsx: "automatic",
        write: false,
        logLevel: "silent",
        logOverride: {
          "unsupported-dynamic-import": "error",
          "unsupported-require-call": "error",
        },
        legalComments: "none",
        // A captured tsconfig must never redirect resolution into the host workspace.
        tsconfigRaw: {},
        plugins: [
          {
            name: "t3-captured-plugin",
            setup(build) {
              build.onResolve({ filter: /.*/ }, async (args) => {
                if (target === "server" && args.path === "t3:node-require")
                  return { path: args.path, namespace: "t3-plugin-node-runtime" };
                if (Object.hasOwn(input.hostModules[target], args.path))
                  return { path: args.path, namespace: "t3-plugin-host" };
                if (target === "server" && NODE_BUILTINS.has(args.path))
                  return args.kind === "require-call"
                    ? { path: args.path, namespace: "t3-plugin-require" }
                    : { path: args.path, external: true };
                if (
                  args.kind !== "entry-point" &&
                  !args.path.startsWith("./") &&
                  !args.path.startsWith("../")
                )
                  throw new Error(
                    `Unsupported plugin import '${args.path}'. Use a host runtime or vendor dependencies with relative imports.`,
                  );
                const relative =
                  args.kind === "entry-point"
                    ? args.path
                    : NodePath.posix.join(NodePath.posix.dirname(args.importer), args.path);
                const filename = await resolve(relative);
                return {
                  path: NodePath.relative(root, filename).split(NodePath.sep).join("/"),
                  namespace: "t3-plugin-source",
                };
              });
              build.onLoad({ filter: /.*/, namespace: "t3-plugin-host" }, (args) => ({
                contents: hostModuleSource(
                  input.hostRuntimeKeys[target],
                  args.path,
                  input.hostModules[target][args.path]!,
                ),
                loader: "js",
              }));
              build.onLoad({ filter: /.*/, namespace: "t3-plugin-require" }, (args) => ({
                contents: `module.exports = __t3NodeRequire(${JSON.stringify(args.path)});`,
                loader: "js",
              }));
              build.onLoad({ filter: /.*/, namespace: "t3-plugin-node-runtime" }, () => ({
                contents:
                  'import { createRequire } from "node:module"; export const __t3NodeRequire = createRequire(import.meta.url);',
                loader: "js",
              }));
              build.onLoad({ filter: /.*/, namespace: "t3-plugin-source" }, async (args) => {
                const loader = LOADERS[NodePath.extname(args.path)];
                if (!loader)
                  throw new Error(
                    `Unsupported plugin module '${args.path}'. Import code or JSON; register CSS through host.style().`,
                  );
                return { contents: await read(inside(root, args.path)), loader };
              });
            },
          },
        ],
      });
      assertDeadline();
      const remaining = expiresAt - NodePerfHooks.performance.now();
      if (remaining <= 0)
        throw new Error("Compilation exceeded 10 seconds. Reduce the entry graph and reload.");
      const deadline = new Promise<never>((_, reject) => {
        abort = () => {
          void context!.cancel().catch(() => undefined);
          reject(new Error("Plugin compilation was cancelled."));
        };
        input.signal?.addEventListener("abort", abort, { once: true });
        timeout = setTimeout(() => {
          void context!.cancel().catch(() => undefined);
          reject(new Error("Compilation exceeded 10 seconds. Reduce the entry graph and reload."));
        }, remaining);
      });
      const result = await Promise.race([context.rebuild(), deadline]);
      assertDeadline();
      for (const output of result.outputFiles!) {
        outputBytes += output.contents.byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES)
          throw new Error("Compiled plugin entries exceed 16 MiB.");
        outputs.push({ surface: target, filename: output.path, contents: output.contents });
      }
      entries[target] = NodePath.relative(root, outfile).split(NodePath.sep).join("/");
    } catch (cause) {
      throw compilationError(target, root, cause);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abort) input.signal?.removeEventListener("abort", abort);
      await context?.dispose();
    }
  }

  const written: string[] = [];
  try {
    for (const output of outputs) {
      assertDeadline();
      const handle = await NodeFSP.open(output.filename, "wx");
      written.push(output.filename);
      try {
        assertDeadline();
        await handle.writeFile(
          output.contents,
          input.signal ? { signal: input.signal } : undefined,
        );
        assertDeadline();
      } finally {
        await handle.close();
      }
    }
  } catch (cause) {
    await Promise.all(written.map((filename) => NodeFSP.rm(filename, { force: true })));
    throw cause;
  }
  return {
    entries,
    compiledFiles: outputs.map((output) => ({ surface: output.surface, bytes: output.contents })),
  };
}
