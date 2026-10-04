import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus";

const mobileRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

/** Metro embeds each shared browser transport as a small script in a native WebView. */
async function generateWebViewScript(entry: string, name: string, output: string) {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      target: "es2022",
      minify: true,
      lib: {
        entry: NodePath.join(mobileRoot, entry),
        name,
        formats: ["iife"],
      },
    },
  });
  const bundles = Array.isArray(result) ? result : [result];
  const chunk = bundles
    .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
    .find((output) => output.type === "chunk");
  if (!chunk) throw new Error(`${name} build did not emit a script.`);
  const root = NodePath.join(mobileRoot, output);
  await NodeFSP.mkdir(root, { recursive: true });
  for (const [file, contents] of [
    ["index.js", `module.exports = ${JSON.stringify(chunk.code)};\n`],
    ["package.json", '{"main":"index.js"}\n'],
  ] as const) {
    const destination = NodePath.join(root, file);
    const previous = await NodeFSP.readFile(destination, "utf8").catch(() => null);
    if (previous !== contents) await NodeFSP.writeFile(destination, contents);
  }
}

export const generateDeviceStreamScript = () =>
  generateWebViewScript(
    "src/features/devices/device-stream.browser.ts",
    "T3DeviceStream",
    ".generated/device-stream",
  );

export const generatePreviewStreamScript = () =>
  generateWebViewScript(
    "src/features/browser/preview-stream.browser.ts",
    "T3PreviewStream",
    ".generated/preview-stream",
  );
