// Resolves the web app's `~/` alias and extensionless relative imports for plain Node.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const src = new URL("../../src/", import.meta.url);
export async function resolve(specifier, context, next) {
  let target = specifier.startsWith("~/") ? new URL(specifier.slice(2), src).href : specifier;
  if ((target.startsWith(".") || target.startsWith("file:")) && !/\.[cm]?[jt]sx?$|\.json$/.test(target)) {
    const base = new URL(target, context.parentURL);
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      if (existsSync(fileURLToPath(base) + ext)) return next(pathToFileURL(fileURLToPath(base) + ext).href, context);
    }
  }
  return next(target, context);
}
