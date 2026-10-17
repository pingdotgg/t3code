// @effect-diagnostics nodeBuiltinImport:off - Bundler integration fixtures use Node filesystem APIs outside an Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { build } from "vite-plus/pack";
import { expect, it } from "vite-plus/test";

import { previewAnnotationCssPlugin } from "./preview-annotation-css.ts";

it("embeds annotation CSS without generating a source file and removes legacy output", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "annotation-css-"));
  try {
    const preview = NodePath.join(root, "src", "preview");
    await NodeFSP.mkdir(preview, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(preview, "Annotation.css"), '@import "tailwindcss";\n');
    await NodeFSP.writeFile(
      NodePath.join(preview, "PickPreload.ts"),
      'const className = "fixed";\n',
    );
    const legacyPath = NodePath.join(preview, "AnnotationStyles.generated.ts");
    await NodeFSP.writeFile(legacyPath, "stale generated styles");
    const entry = NodePath.join(root, "entry.ts");
    await NodeFSP.writeFile(
      entry,
      'export { previewAnnotationStyles } from "virtual:preview-annotation-css";\n',
    );
    await build({
      entry: [entry],
      outDir: NodePath.join(root, "dist"),
      format: "cjs",
      dts: false,
      config: false,
      plugins: [previewAnnotationCssPlugin(root)],
    });
    const require = NodeModule.createRequire(import.meta.url);
    const { previewAnnotationStyles } = require(NodePath.join(root, "dist", "entry.cjs"));
    expect(previewAnnotationStyles).toContain(".fixed");
    expect(previewAnnotationStyles).not.toContain(".static");
    await expect(NodeFSP.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await NodeFSP.readdir(preview)).toEqual(["Annotation.css", "PickPreload.ts"]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rebuilds CSS and removes obsolete utilities when either annotation input changes", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "annotation-css-watch-"));
  let handle: Awaited<ReturnType<typeof build>> | undefined;
  try {
    const preview = NodePath.join(root, "src", "preview");
    await NodeFSP.mkdir(preview, { recursive: true });
    const sourcePath = NodePath.join(preview, "Annotation.css");
    const preloadPath = NodePath.join(preview, "PickPreload.ts");
    await NodeFSP.writeFile(sourcePath, '@import "tailwindcss";\n');
    await NodeFSP.writeFile(preloadPath, 'const className = "fixed";\n');
    const entry = NodePath.join(root, "entry.ts");
    await NodeFSP.writeFile(
      entry,
      'export { previewAnnotationStyles } from "virtual:preview-annotation-css";\n',
    );
    let complete: (() => void) | undefined;
    const nextBuild = () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      });
    const firstBuild = nextBuild();
    handle = await build({
      entry: [entry],
      outDir: NodePath.join(root, "dist"),
      format: "cjs",
      dts: false,
      config: false,
      watch: true,
      plugins: [previewAnnotationCssPlugin(root)],
      onSuccess: () => {
        complete?.();
      },
    });
    await firstBuild;
    const require = NodeModule.createRequire(import.meta.url);
    const output = NodePath.join(root, "dist", "entry.cjs");
    const readCss = () => {
      delete require.cache[output];
      return require(output).previewAnnotationStyles as string;
    };
    expect(readCss()).toContain(".fixed");
    const preloadBuild = nextBuild();
    await NodeFSP.writeFile(preloadPath, 'const className = "absolute";\n');
    await preloadBuild;
    expect(readCss()).toContain(".absolute");
    expect(readCss()).not.toContain(".fixed");
    const cssBuild = nextBuild();
    await NodeFSP.writeFile(
      sourcePath,
      '@import "tailwindcss";\n.annotation-marker { color: red; }\n',
    );
    await cssBuild;
    expect(readCss()).toContain(".annotation-marker");
    expect(await NodeFSP.readdir(preview)).toEqual(["Annotation.css", "PickPreload.ts"]);
  } finally {
    await handle?.watch.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
