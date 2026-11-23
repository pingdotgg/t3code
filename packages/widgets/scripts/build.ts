// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone build script.
/** Builds each widget into one self-contained page: the frame's policy allows no other files. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { build } from "vite-plus";

const packageDir = NodePath.resolve(import.meta.dirname, "..");
const widgetsDir = NodePath.join(packageDir, "src/widgets");
const distDir = NodePath.join(packageDir, "dist");
const baseCss = await NodeFSP.readFile(NodePath.join(packageDir, "src/base.css"), "utf8");

// Every browser that runs the apps reads woff2; the other formats triple the page.
const woff2Only = (css: string) =>
  css.replace(/,\s*url\([^)]*\)\s*format\("?(?:woff|truetype)"?\)/g, "");

await NodeFSP.rm(distDir, { recursive: true, force: true });
await NodeFSP.mkdir(distDir, { recursive: true });

for (const file of await NodeFSP.readdir(widgetsDir)) {
  const name = NodePath.basename(file, ".ts");
  const result = await build({
    configFile: false,
    root: packageDir,
    logLevel: "error",
    plugins: [
      {
        name: "kompas:woff2-only",
        enforce: "pre",
        transform: (code, id) =>
          id.includes("katex") && id.endsWith(".css") ? woff2Only(code) : null,
      },
    ],
    build: {
      write: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      cssCodeSplit: false,
      modulePreload: false,
      minify: true,
      target: "es2022",
      rollupOptions: {
        input: NodePath.join(widgetsDir, file),
        output: { format: "iife", codeSplitting: false },
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) =>
    "output" in entry ? entry.output : [],
  );
  const script = outputs.find((output) => output.type === "chunk")?.code ?? "";
  const css = outputs
    .filter((output) => output.type === "asset" && output.fileName.endsWith(".css"))
    .map((output) => (output.type === "asset" ? String(output.source) : ""))
    .join("\n");
  const page = [
    "<!doctype html>",
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<style>${baseCss}\n${css}</style>`,
    "<body><!--widget-data-->",
    // Split so the page's own parser never sees the end of a script inside a string.
    `<script>${script.replaceAll("</script", "<\\/script")}</script>`,
  ].join("");
  await NodeFSP.writeFile(NodePath.join(distDir, `${name}.html`), page);
  console.log(`${name}.html ${Math.round(Buffer.byteLength(page) / 1024)} KiB`);
}
