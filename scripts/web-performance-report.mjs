import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { resolve, relative, basename } from "node:path";

const distDir = resolve(process.argv[2] ?? "apps/web/dist");
const manifestPath = resolve(distDir, ".vite/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const files = new Map();
async function readAsset(file) {
  if (!files.has(file)) {
    const data = await readFile(resolve(distDir, file));
    files.set(file, {
      bytes: data.byteLength,
      gzipBytes: gzipSync(data, { level: 9 }).byteLength,
    });
  }
  return files.get(file);
}

const entry = manifest["index.html"];
if (!entry) throw new Error("Vite manifest does not contain index.html");

const initialFiles = new Set(["index.html"]);
const visitedModules = new Set();
function visitModule(moduleKey) {
  if (visitedModules.has(moduleKey)) return;
  visitedModules.add(moduleKey);
  const module = manifest[moduleKey];
  if (!module) throw new Error(`Missing manifest module: ${moduleKey}`);
  if (module.file) initialFiles.add(module.file);
  for (const css of module.css ?? []) initialFiles.add(css);
  for (const imported of module.imports ?? []) visitModule(imported);
}

if (entry.file) initialFiles.add(entry.file);
for (const imported of entry.imports ?? []) visitModule(imported);
// The HTML entry launches the bootstrap module, which deliberately imports the
// app entry asynchronously. Include that known boot path, but do not pull in
// route chunks that are only requested after navigation.
for (const imported of entry.dynamicImports ?? []) visitModule(imported);
for (const css of entry.css ?? []) initialFiles.add(css);

const initialStats = await Promise.all([...initialFiles].map(readAsset));
const initialBytes = initialStats.reduce((sum, item) => sum + item.bytes, 0);
const initialGzipBytes = initialStats.reduce((sum, item) => sum + item.gzipBytes, 0);

const allAssetFiles = Object.values(manifest)
  .flatMap((item) => [item.file, ...(item.css ?? [])])
  .filter(Boolean);
const uniqueAssetFiles = [...new Set(allAssetFiles)];
const assetRows = await Promise.all(
  uniqueAssetFiles.map(async (file) => ({ file, ...(await readAsset(file)) })),
);

const byLargest = [...assetRows]
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 12)
  .map(({ file, bytes, gzipBytes }) => ({ file: basename(file), bytes, gzipBytes }));

const html = await readAsset("index.html");
const js = assetRows.filter(({ file }) => file.endsWith(".js"));
const css = assetRows.filter(({ file }) => file.endsWith(".css"));
const output = {
  dist: relative(process.cwd(), distDir),
  manifestEntries: Object.keys(manifest).length,
  initialAssetCount: initialFiles.size,
  initialBytes,
  initialGzipBytes,
  htmlBytes: html.bytes,
  htmlGzipBytes: html.gzipBytes,
  jsAssetCount: js.length,
  jsBytes: js.reduce((sum, item) => sum + item.bytes, 0),
  jsGzipBytes: js.reduce((sum, item) => sum + item.gzipBytes, 0),
  cssAssetCount: css.length,
  cssBytes: css.reduce((sum, item) => sum + item.bytes, 0),
  cssGzipBytes: css.reduce((sum, item) => sum + item.gzipBytes, 0),
  largestAssets: byLargest,
};

console.log(JSON.stringify(output, null, 2));
