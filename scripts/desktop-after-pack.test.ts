// @effect-diagnostics nodeBuiltinImport:off - This fixture verifies the packaging filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  REQUIRED_UNPACKED_RUNTIME_FILES,
  resolveUnpackedNodeModules,
  verifyUnpackedRuntimeFiles,
} from "./desktop-after-pack.ts";

const temporaryDirectories: string[] = [];

async function createPackagedRuntimeFixture(platform: "darwin" | "linux" | "win32"): Promise<{
  readonly root: string;
  readonly context: Parameters<typeof verifyUnpackedRuntimeFiles>[0];
  readonly unpackedNodeModules: string;
}> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-after-pack-"));
  temporaryDirectories.push(root);
  const appOutDir = NodePath.join(root, `${platform}-unpacked`);
  const productFilename = "T3 Code";
  const context = {
    appOutDir,
    electronPlatformName: platform,
    packager: { appInfo: { productFilename } },
  };
  const unpackedNodeModules = NodePath.join(
    appOutDir,
    ...(platform === "darwin"
      ? [`${productFilename}.app`, "Contents", "Resources"]
      : ["resources"]),
    "app.asar.unpacked",
    "node_modules",
  );

  for (const relativeFile of REQUIRED_UNPACKED_RUNTIME_FILES) {
    const filePath = NodePath.join(unpackedNodeModules, ...relativeFile.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
    await NodeFSP.writeFile(filePath, `${relativeFile}\n`);
  }

  return { root, context, unpackedNodeModules };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("desktop afterPack", () => {
  it.each(["win32", "linux", "darwin"] as const)(
    "accepts a complete %s unpacked runtime closure",
    async (platform) => {
      const fixture = await createPackagedRuntimeFixture(platform);

      expect(resolveUnpackedNodeModules(fixture.context)).toBe(fixture.unpackedNodeModules);
      await verifyUnpackedRuntimeFiles(fixture.context);
    },
  );

  it("fails the build when unpacked runtime payloads are missing", async () => {
    const fixture = await createPackagedRuntimeFixture("win32");
    await NodeFSP.rm(NodePath.join(fixture.unpackedNodeModules, "effect/dist/Context.js"));
    await NodeFSP.rm(NodePath.join(fixture.unpackedNodeModules, "mime/package.json"));

    await expect(verifyUnpackedRuntimeFiles(fixture.context)).rejects.toThrow(
      /effect\/dist\/Context\.js, mime\/package\.json/u,
    );
  });
});
