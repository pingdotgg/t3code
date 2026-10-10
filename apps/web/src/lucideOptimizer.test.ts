// @effect-diagnostics nodeBuiltinImport:off - exercises real dependency optimization in disposable directories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { optimizeDeps, resolveConfig } from "vite-plus";
import { expect, it } from "vite-plus/test";

import webConfig from "../vite.config";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const webRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));

async function optimizeIcons(withDynamic: boolean) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lucide-optimizer-"));
  try {
    await NodeFSP.symlink(
      NodePath.join(webRoot, "node_modules"),
      NodePath.join(root, "node_modules"),
      "junction",
    );
    await NodeFSP.writeFile(NodePath.join(root, "package.json"), '{"type":"module"}');
    const entry = NodePath.join(root, "entry.ts");
    await NodeFSP.writeFile(
      entry,
      'export { FolderCodeIcon } from "lucide-react";\n' +
        (withDynamic ? 'export { DynamicIcon, iconNames } from "lucide-react/dynamic";\n' : ""),
    );
    const appConfig = await webConfig({ command: "serve", mode: "development" });
    const config = await resolveConfig(
      {
        configFile: false,
        envDir: false,
        root,
        cacheDir: NodePath.join(root, "cache"),
        logLevel: "silent",
        optimizeDeps: {
          ...appConfig.optimizeDeps,
          // Discover the real import combination without prebundling unrelated app dependencies.
          include: [],
          entries: [entry],
        },
      },
      "serve",
    );
    const metadata = await optimizeDeps(config, true);
    const iconEntry = metadata.optimized["lucide-react"]?.file;
    if (!iconEntry) throw new Error("Lucide was not discovered by Vite");
    const { stdout } = await execFile(process.execPath, [
      "--input-type=module",
      "-e",
      `import { registerHooks } from "node:module";
const entry = process.argv[1];
const prefix = entry.slice(0, entry.lastIndexOf("/") + 1);
const loaded = new Set();
const hook = registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith(prefix)) loaded.add(url);
  return nextLoad(url, context);
} });
const icons = await import(entry);
hook.deregister();
console.log(JSON.stringify({ modules: loaded.size, exports: Object.keys(icons).sort() }));`,
      NodeURL.pathToFileURL(iconEntry).href,
    ]);
    return {
      optimized: Object.keys(metadata.optimized),
      ...(JSON.parse(stdout) as { modules: number; exports: string[] }),
    };
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

it("does not split every static icon into an eager module when dynamic project icons are discovered", async () => {
  const ordinary = await optimizeIcons(false);
  const withDynamic = await optimizeIcons(true);

  expect(withDynamic.modules).toBe(ordinary.modules);
  expect(withDynamic.exports).toEqual(ordinary.exports);
  expect(withDynamic.exports).toContain("FolderCodeIcon");
  expect(withDynamic.optimized).toContain("lucide-react");
  expect(withDynamic.optimized).not.toContain("lucide-react/dynamic");
});

it("keeps the unbundled dynamic registry lazy and resolves selected icons and aliases", async () => {
  const dynamicEntry = NodeURL.fileURLToPath(
    new URL("../node_modules/lucide-react/dynamic.mjs", import.meta.url),
  );
  const { stdout } = await execFile(process.execPath, [
    "--input-type=module",
    "-e",
    `import { registerHooks } from "node:module";
const iconLoads = new Set();
const hook = registerHooks({ load(url, context, nextLoad) {
  if (url.includes("/lucide-react/") && url.includes("/icons/")) iconLoads.add(url);
  return nextLoad(url, context);
} });
const { DynamicIcon, iconNames, dynamicIconImports } = await import(process.argv[1]);
const beforeSelection = iconLoads.size;
const selected = [];
for (const name of ["folder-code", "alarm-clock", "code-2"]) {
  const icon = await dynamicIconImports[name]();
  selected.push({ name, listed: iconNames.includes(name), displayName: icon.default.displayName,
    nodeCount: icon.__iconNode.length });
}
hook.deregister();
console.log(JSON.stringify({ beforeSelection, selected, iconLoads: [...iconLoads],
  isForwardRef: DynamicIcon.$$typeof === Symbol.for("react.forward_ref"),
  registryMatchesNames: JSON.stringify(iconNames) === JSON.stringify(Object.keys(dynamicIconImports)) }));`,
    NodeURL.pathToFileURL(dynamicEntry).href,
  ]);
  const result = JSON.parse(stdout) as {
    beforeSelection: number;
    selected: { name: string; listed: boolean; displayName: string; nodeCount: number }[];
    iconLoads: string[];
    isForwardRef: boolean;
    registryMatchesNames: boolean;
  };

  expect(result.beforeSelection).toBe(0);
  expect(result.isForwardRef).toBe(true);
  expect(result.registryMatchesNames).toBe(true);
  expect(
    result.selected.map(({ name, listed, displayName }) => ({ name, listed, displayName })),
  ).toEqual([
    { name: "folder-code", listed: true, displayName: "FolderCode" },
    { name: "alarm-clock", listed: true, displayName: "AlarmClock" },
    { name: "code-2", listed: true, displayName: "CodeXml" },
  ]);
  expect(result.selected.every(({ nodeCount }) => nodeCount > 0)).toBe(true);
  expect(result.iconLoads.length).toBeGreaterThan(0);
  expect(
    result.iconLoads.every((url) => /\/(folder-code|alarm-clock|code-2|code-xml)\.js$/.test(url)),
  ).toBe(true);
});
