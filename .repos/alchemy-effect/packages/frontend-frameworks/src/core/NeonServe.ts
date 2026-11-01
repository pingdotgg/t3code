import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { createRequire } from "node:module";
import { toOutputFile, type BuildOutput } from "./BuildOutput.ts";
import { DeployTargetError, type DeployTarget } from "./DeployTarget.ts";
import { pinNodeServeModule, type NodeServeEntryOptions } from "./NodeServe.ts";

/** Fetch entry emitted for Neon Functions; no listening socket is created. */
export const NEON_SERVE_ENTRY_FILE_NAME = "serve-neon.mjs";

/** Generate a Node 24 Fetch module from a framework's portable handler description. */
export const makeNeonServeEntrySource = (
  options: NodeServeEntryOptions,
): string => {
  const handler = options.handler;
  return `import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
${handler?.kind === "node" ? 'import { toFetchHandler } from "srvx/node";' : ""}
${handler?.imports ?? ""}
const handle = ${handler === undefined ? "undefined" : handler.kind === "node" ? `toFetchHandler((request, response) => { Promise.resolve((${handler.expr})(request, response)).catch(error => response.destroy(error)); })` : handler.expr};
const client = ${options.clientDirExpression ?? "undefined"};
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".ico": "image/x-icon", ".webp": "image/webp", ".avif": "image/avif", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".wasm": "application/wasm", ".pdf": "application/pdf" };
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const lookup = (pathname, directoryIndex = true) => {
  if (client === undefined) return;
  if (pathname.split("/").some(part => part.startsWith(".") || part === "serve-node.mjs" || part === "serve-neon.mjs")) return;
  const root = path.resolve(client);
  let file = path.resolve(root, pathname.replace(/^\\/+/, ""));
  if (!within(root, file)) return;
  try {
    let stat = fs.statSync(file);
    if (stat.isDirectory() && directoryIndex) {
      file = path.join(file, "index.html");
      stat = fs.statSync(file);
    }
    if (!stat.isFile() || !within(fs.realpathSync(root), fs.realpathSync(file))) return;
    return { file, size: stat.size };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return;
    throw error;
  }
};
const serve = (found, request, status = 200) => new Response(
  request.method === "HEAD" ? null : Readable.toWeb(fs.createReadStream(found.file)),
  { status, headers: { "content-type": mime[path.extname(found.file).toLowerCase()] ?? "application/octet-stream", "content-length": String(found.size), "cache-control": "no-cache" } },
);
export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);
      const forwarded = request.headers.get("x-forwarded-host");
      if (forwarded && /^[a-zA-Z0-9.\\-]+(?::[0-9]+)?$/.test(forwarded)) {
        url.host = forwarded;
        request = new Request(url, request);
      }
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return new Response("Bad Request", { status: 400 }); }
      if (pathname.includes("\\0") || pathname.includes("\\\\")) return new Response("Bad Request", { status: 400 });
      if (request.method === "GET" || request.method === "HEAD") {
        const found = lookup(pathname, handle === undefined || pathname !== "/")${options.htmlHandling === "drop-trailing-slash" ? ' ?? (!path.extname(pathname) ? lookup(pathname + ".html") : undefined)' : ""};
        if (found) return serve(found, request);
${options.notFoundHandling === "spa" ? '        const fallback = lookup("/index.html");\n        if (fallback) return serve(fallback, request);' : ""}
      }
      if (handle) {
        const response = await handle(request);
        if (request.method !== "HEAD" || response.body === null) return response;
        await response.body.cancel();
        return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
${options.notFoundHandling === "404-page" ? '      if (request.method === "GET" || request.method === "HEAD") {\n        const missing = lookup("/404.html");\n        if (missing) return serve(missing, request, 404);\n      }' : ""}
      return new Response(request.method === "HEAD" ? null : "Not Found", { status: 404 });
    } catch (error) {
      console.error("Neon website request failed", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
`;
};

/** Replace a Node target's listening wrapper with a Fetch wrapper, preserving its actual framework build. */
export const finishNeonOutput = (output: BuildOutput) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entry = output.serverModules?.[0];
    if (entry?.name.endsWith(NEON_SERVE_ENTRY_FILE_NAME)) return output;
    if (!output.distDirectory || !entry || !output.nodeServe) {
      return yield* Effect.fail(
        new DeployTargetError({
          platform: "neon",
          message:
            "The framework did not provide a portable Node handler description for Neon.",
        }),
      );
    }
    const name = path.join(
      path.dirname(entry.name),
      NEON_SERVE_ENTRY_FILE_NAME,
    );
    let source = makeNeonServeEntrySource(output.nodeServe);
    if (output.nodeServe.handler?.kind === "node") {
      const adapter = yield* Effect.try(() =>
        createRequire(import.meta.url).resolve("srvx/node"),
      );
      const bundle = yield* Effect.tryPromise(() =>
        import("esbuild").then((esbuild) =>
          esbuild.build({
            entryPoints: [adapter],
            bundle: true,
            platform: "node",
            target: "node24",
            format: "esm",
            write: false,
          }),
        ),
      );
      const adapterPath = path.join(
        output.distDirectory,
        path.dirname(name),
        "neon-node-adapter.mjs",
      );
      yield* fs.writeFile(adapterPath, bundle.outputFiles[0]!.contents);
      source = source.replace(
        'from "srvx/node"',
        'from "./neon-node-adapter.mjs"',
      );
    }
    yield* fs.writeFileString(path.join(output.distDirectory, name), source);
    const module = yield* toOutputFile(name, source);
    const result = pinNodeServeModule(
      {
        ...output,
        serverModules: output.serverModules?.filter(
          (item) => item.name !== entry.name,
        ),
      },
      module,
    );
    yield* fs.remove(path.join(output.distDirectory, entry.name), {
      force: true,
    });
    return result;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof DeployTargetError
        ? cause
        : new DeployTargetError({
            platform: "neon",
            message: "Failed to emit the Neon Fetch entry.",
            cause,
          }),
    ),
  );

/** Reuse framework build/configuration hooks while selecting Neon's Fetch runtime. */
export const makeNeonTarget = <T extends DeployTarget>(node: T): T => ({
  ...node,
  platform: "neon",
  ...(node.build
    ? {
        build: (context) =>
          node.build!(context).pipe(Effect.flatMap(finishNeonOutput)),
      }
    : {}),
  ...(node.finish
    ? {
        finish: (output, context) =>
          node.finish!(output, context).pipe(Effect.flatMap(finishNeonOutput)),
      }
    : {}),
});
