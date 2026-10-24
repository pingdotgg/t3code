import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus";

// Bundle the same viewer used by React Native. The Swift bridge supplies its
// ReactNativeWebView.postMessage shim, session ticket and platform controls.
// Xcode supplies the app resources directory as the first argument.
const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error("Pass the native app resources directory.");
const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const result = await build({
  configFile: false,
  // This browser-only entry lives under mobile, but does not need Expo's config.
  tsconfig: NodePath.join(repositoryRoot, "tsconfig.base.json"),
  logLevel: "silent",
  resolve: {
    // Swift CI installs the shared transport without the React Native app graph.
    alias: {
      "@t3tools/client-runtime": NodePath.join(repositoryRoot, "packages/client-runtime/src"),
    },
  },
  build: {
    write: false,
    target: "es2022",
    minify: true,
    lib: {
      entry: NodePath.join(
        repositoryRoot,
        "apps/mobile/src/features/devices/device-stream.browser.ts",
      ),
      name: "T3DeviceStream",
      formats: ["iife"],
    },
  },
});
const bundles = Array.isArray(result) ? result : [result];
const chunk = bundles
  .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
  .find((output) => output.type === "chunk");
if (!chunk) throw new Error("Device viewer did not emit a script.");
await NodeFSP.mkdir(outputDirectory, { recursive: true });
const destination = NodePath.join(outputDirectory, "T3DeviceStream.js");
if ((await NodeFSP.readFile(destination, "utf8").catch(() => null)) !== chunk.code) {
  await NodeFSP.writeFile(destination, chunk.code);
}
