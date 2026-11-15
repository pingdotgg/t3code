// @effect-diagnostics nodeBuiltinImport:off - electron-builder calls this hook outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeModule from "node:module";
import { prebuildDesktopCompileCache } from "./lib/desktop-compile-cache.ts";
import { removeSharedWriteAccess } from "./linux-after-pack.ts";

export function deduplicateLicenseBlocks(html: string): string {
  const licenses = new Map<string, string>();
  return html.replace(/<pre>[\s\S]*?<\/pre>/g, (block) => {
    const existing = licenses.get(block);
    if (existing !== undefined) return `<a href="#${existing}">License text</a>`;
    const id = `t3-license-${licenses.size}`;
    licenses.set(block, id);
    return block.replace("<pre>", `<pre id="${id}">`);
  });
}

export default async function afterPack(context: {
  appOutDir: string;
  electronPlatformName: string;
  arch?: number;
  packager: {
    getResourcesDir: (appOutDir: string) => string;
    appInfo: { productFilename: string };
    executableName?: string;
  };
}) {
  const resources = context.packager.getResourcesDir(context.appOutDir);
  // Foreign executables cannot generate bytecode for a cross-packaged target.
  const targetArch = context.arch === 1 ? "x64" : context.arch === 3 ? "arm64" : undefined;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- electron-builder invokes this hook outside the Effect runtime.
  const hostPlatform = NodeOS.platform();
  // oxlint-disable-next-line t3code/no-global-process-runtime -- electron-builder invokes this hook outside the Effect runtime.
  const hostArch = NodeOS.arch();
  const nativeTarget =
    context.electronPlatformName === hostPlatform &&
    (targetArch === undefined || targetArch === hostArch);
  if (nativeTarget) {
    if (hostPlatform === "darwin") {
      // Renaming Electron invalidates its signature before electron-builder's final signing pass.
      NodeChildProcess.execFileSync("/usr/bin/codesign", [
        "--force",
        "--sign",
        "-",
        "--preserve-metadata=entitlements",
        NodePath.resolve(resources, "../.."),
      ]);
    }
    const executable =
      context.electronPlatformName === "darwin"
        ? NodePath.join(resources, "../MacOS", context.packager.appInfo.productFilename)
        : NodePath.join(
            context.appOutDir,
            `${context.packager.executableName ?? context.packager.appInfo.productFilename}${context.electronPlatformName === "win32" ? ".exe" : ""}`,
          );
    await prebuildDesktopCompileCache(resources, executable);
  }
  // electron-builder accepts one afterPack hook, so the backend's prepared cache runs here too.
  await NodeModule.createRequire(import.meta.url)("./prepare-server-compile-cache.cjs")(context);
  if (context.electronPlatformName === "win32") return;
  const licensePath = NodePath.join(
    context.electronPlatformName === "darwin" ? resources : context.appOutDir,
    "LICENSES.chromium.html",
  );
  await NodeFSP.writeFile(
    licensePath,
    deduplicateLicenseBlocks(await NodeFSP.readFile(licensePath, "utf8")),
  );
  if (context.electronPlatformName === "darwin" && hostPlatform === "darwin") {
    const cursorRoot = NodePath.join(resources, "node_modules", "@cursor");
    if (
      await NodeFSP.stat(cursorRoot).then(
        () => true,
        () => false,
      )
    ) {
      for (const entry of await NodeFSP.readdir(cursorRoot, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!entry.isFile()) continue;
        const filePath = NodePath.join(entry.parentPath, entry.name);
        const relativePath = NodePath.relative(cursorRoot, filePath);
        if (
          !/^sdk-darwin-(?:arm64|x64)\/(?:bin\/cursorsandbox|vendor\/tree-sitter(?:-bash)?\/binding\.node)$/.test(
            relativePath,
          )
        )
          continue;
        // Keep exported symbols for dlopen; signing runs after afterPack.
        NodeChildProcess.execFileSync("strip", ["-S", "-x", filePath]);
      }
    }
  }
  if (context.electronPlatformName !== "linux") return;
  const machine = hostArch === "arm64" ? 183 : hostArch === "x64" ? 62 : undefined;
  for (const entry of await NodeFSP.readdir(resources, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".node")) continue;
    const filePath = NodePath.join(entry.parentPath, entry.name);
    const header = await NodeFSP.readFile(filePath);
    // A cross-packaging host's strip cannot rewrite the target architecture.
    if (
      header.length < 20 ||
      header.toString("hex", 0, 4) !== "7f454c46" ||
      header.readUInt16LE(18) !== machine
    )
      continue;
    NodeChildProcess.execFileSync("strip", ["--strip-unneeded", filePath]);
  }
  // Electron's Linux zips can ship world-writable files, and the .deb and AppImage keep zip modes.
  await removeSharedWriteAccess(context.appOutDir);
}
