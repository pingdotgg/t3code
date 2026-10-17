// @effect-diagnostics nodeBuiltinImport:off - runs from bin.ts before any Effect runtime.
// Desktop packaging uses this to catch missing lazy chunks that --version skips.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const CHUNK_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']\.\/([^"'/]+\.mjs)["']/g;

export async function loadBundle(entryUrl: string): Promise<number> {
  if (!entryUrl.endsWith(".mjs")) {
    throw new Error("t3 __load-bundle checks the built bundle; run it from dist/bin.mjs.");
  }
  const entryPath = NodeURL.fileURLToPath(entryUrl);
  const directory = NodePath.dirname(entryPath);
  const entry = NodePath.basename(entryPath);
  const files = [entry];
  const seen = new Set(files);
  for (const file of files) {
    // The entry is still in its top-level await, so importing it again would wait on itself.
    if (file !== entry) await import(NodeURL.pathToFileURL(NodePath.join(directory, file)).href);
    const source = NodeFS.readFileSync(NodePath.join(directory, file), "utf8");
    for (const [, chunk] of source.matchAll(CHUNK_IMPORT)) {
      if (chunk && !seen.has(chunk)) {
        seen.add(chunk);
        files.push(chunk);
      }
    }
  }
  // Cursor's disk-backed SDK loads on first call, outside the chunk graph.
  const { loadCursorSdk } = await import("@t3tools/provider-cursor/server/sdk");
  loadCursorSdk();
  return files.length - 1;
}
