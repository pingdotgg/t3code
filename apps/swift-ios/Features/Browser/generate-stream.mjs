import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus";

// Xcode supplies its resources directory. No generated bundle is committed.
const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error("Pass the native app resources directory.");
const directory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repositoryRoot = NodePath.resolve(directory, "../../../..");
const result = await build({
  configFile: false,
  tsconfig: NodePath.join(repositoryRoot, "tsconfig.base.json"),
  logLevel: "silent",
  resolve: {
    alias: {
      "@t3tools/client-runtime/preview/server-browser-stream": NodePath.join(
        repositoryRoot,
        "packages/client-runtime/src/preview/serverBrowserStream.ts",
      ),
      // Only preview contracts are used by this browser-only entry.
      "@t3tools/contracts": NodePath.join(repositoryRoot, "packages/contracts/src/preview.ts"),
    },
  },
  build: {
    write: false,
    target: "es2022",
    minify: true,
    lib: {
      entry: NodePath.join(directory, "browser-stream.browser.ts"),
      name: "T3BrowserStream",
      formats: ["iife"],
    },
  },
});
const bundles = Array.isArray(result) ? result : [result];
const chunk = bundles
  .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
  .find((output) => output.type === "chunk");
if (!chunk) throw new Error("Browser viewer did not emit a script.");
await NodeFSP.mkdir(outputDirectory, { recursive: true });
const destination = NodePath.join(outputDirectory, "T3BrowserStream.js");
if ((await NodeFSP.readFile(destination, "utf8").catch(() => null)) !== chunk.code) {
  await NodeFSP.writeFile(destination, chunk.code);
}
