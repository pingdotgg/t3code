import path from "node:path";
import type * as rolldown from "rolldown";

const PACKAGE_NAME = "@alchemy.run/cloudflare-runtime";

/**
 * Keeps the Vite build's references to sibling runtime components external.
 * Source code uses ordinary relative TypeScript imports, while published
 * output must cross component boundaries through the package export map so
 * consumers receive one shared copy of the runtime types.
 */
export const RuntimeSubpathExportPlugin = (): rolldown.Plugin => ({
  name: "alchemy:runtime-subpath-exports",
  resolveId(source, importer) {
    if (importer === undefined || !source.startsWith(".")) {
      return;
    }

    const normalizedImporter = importer.replaceAll("\\", "/");
    const normalizedSource = source.replaceAll("\\", "/");
    const absoluteImporter = /^[A-Za-z]:\//.test(normalizedImporter)
      ? `/${normalizedImporter}`
      : normalizedImporter;
    const resolved = path.posix.resolve(
      path.posix.dirname(absoluteImporter),
      normalizedSource,
    );
    const match = resolved.match(/\/src\/(core|rolldown)\/(.+)\.ts$/);
    if (match === null) {
      return;
    }

    const [, component, modulePath] = match;
    const subpath =
      modulePath === "index"
        ? component
        : `${component}/${modulePath.replace(/\/index$/, "")}`;
    return { id: `${PACKAGE_NAME}/${subpath}`, external: true };
  },
});
