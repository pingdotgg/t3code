import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus";

// Bundle the shared MCP host, not a second native implementation of its protocol.
const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error("Pass the native app resources directory.");
const root = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const result = await build({
  configFile: false,
  tsconfig: NodePath.join(root, "tsconfig.base.json"),
  logLevel: "silent",
  resolve: { alias: { "@t3tools/shared": NodePath.join(root, "packages/shared/src") } },
  build: {
    write: false,
    target: "es2022",
    minify: true,
    lib: {
      entry: NodePath.join(root, "apps/swift-ios/Features/Chat/embedded-content.browser.ts"),
      name: "T3EmbeddedContent",
      formats: ["iife"],
    },
  },
});
const bundles = Array.isArray(result) ? result : [result];
const chunk = bundles
  .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
  .find((output) => output.type === "chunk");
if (!chunk) throw new Error("Embedded content host did not emit a script.");
await NodeFSP.mkdir(outputDirectory, { recursive: true });
const destination = NodePath.join(outputDirectory, "T3EmbeddedContent.js");
if ((await NodeFSP.readFile(destination, "utf8").catch(() => null)) !== chunk.code)
  await NodeFSP.writeFile(destination, chunk.code);
