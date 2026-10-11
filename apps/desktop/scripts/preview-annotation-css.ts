// @effect-diagnostics nodeBuiltinImport:off - Bundler hooks run outside an Effect runtime and use Node file dependencies.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { compile } from "tailwindcss";
import type { TsdownPlugin } from "vite-plus/pack";

const moduleId = "virtual:preview-annotation-css";
const resolvedModuleId = `\0${moduleId}`;
const require = NodeModule.createRequire(import.meta.url);
const tailwindRoot = NodePath.dirname(require.resolve("tailwindcss/package.json"));

export function previewAnnotationCssPlugin(appRoot: string): TsdownPlugin {
  const previewRoot = NodePath.join(appRoot, "src", "preview");
  const inputs = [
    NodePath.join(previewRoot, "Annotation.css"),
    NodePath.join(previewRoot, "PickPreload.ts"),
    NodePath.join(tailwindRoot, "theme.css"),
    NodePath.join(tailwindRoot, "preflight.css"),
  ] as const;

  return {
    name: "preview-annotation-css",
    async buildStart() {
      // Older builds wrote this module into the source tree. It is no longer an input.
      await NodeFSP.rm(NodePath.join(previewRoot, "AnnotationStyles.generated.ts"), {
        force: true,
      });
    },
    resolveId(id) {
      if (id === moduleId) return { id: resolvedModuleId, external: false };
    },
    async load(id) {
      if (id !== resolvedModuleId) return;
      for (const input of inputs) this.addWatchFile(input);
      const [annotationSource, preloadSource, themeSource, preflightSource] = await Promise.all([
        NodeFSP.readFile(inputs[0], "utf8"),
        NodeFSP.readFile(inputs[1], "utf8"),
        NodeFSP.readFile(inputs[2], "utf8"),
        NodeFSP.readFile(inputs[3], "utf8"),
      ]);
      const candidates = new Set(
        Array.from(preloadSource.matchAll(/!?-?[A-Za-z0-9_:@/.[\]()%,-]+/g), (match) => match[0]),
      );
      const compiler = await compile(
        [
          themeSource,
          preflightSource,
          annotationSource.replace('@import "tailwindcss";', "@tailwind utilities;"),
        ].join("\n"),
        { base: appRoot },
      );
      return `export const previewAnnotationStyles = ${JSON.stringify(compiler.build([...candidates]))};`;
    },
  };
}
