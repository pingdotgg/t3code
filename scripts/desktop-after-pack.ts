// @effect-diagnostics nodeBuiltinImport:off - electron-builder hooks run outside an Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const REQUIRED_UNPACKED_RUNTIME_FILES = [
  "effect/package.json",
  "effect/dist/Context.js",
  "@effect/platform-node/package.json",
  "@effect/platform-node/dist/NodeHttpClient.js",
  "@effect/platform-node-shared/package.json",
  "mime/package.json",
  "undici/package.json",
] as const;

interface DesktopAfterPackContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
  readonly packager: {
    readonly appInfo: {
      readonly productFilename: string;
    };
  };
}

export function resolveUnpackedNodeModules(context: DesktopAfterPackContext): string {
  const resourcesDirectory =
    context.electronPlatformName === "darwin"
      ? NodePath.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : NodePath.join(context.appOutDir, "resources");

  return NodePath.join(resourcesDirectory, "app.asar.unpacked", "node_modules");
}

export async function verifyUnpackedRuntimeFiles(context: DesktopAfterPackContext): Promise<void> {
  const unpackedNodeModules = resolveUnpackedNodeModules(context);
  const missingFiles: string[] = [];

  for (const relativeFile of REQUIRED_UNPACKED_RUNTIME_FILES) {
    try {
      await NodeFSP.access(NodePath.join(unpackedNodeModules, ...relativeFile.split("/")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      missingFiles.push(relativeFile);
    }
  }

  if (missingFiles.length > 0) {
    throw new Error(
      `Packaged runtime verification failed: app.asar references unpacked runtime files whose payloads are missing: ${missingFiles.join(", ")}`,
    );
  }
}

export async function afterPack(context: DesktopAfterPackContext): Promise<void> {
  await verifyUnpackedRuntimeFiles(context);
}
