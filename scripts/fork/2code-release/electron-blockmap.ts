// @effect-diagnostics nodeBuiltinImport:off - release artifact verification uses Electron Builder's pinned blockmap implementation.

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap.js";

export function blockmapPathForArtifact(artifactPath: string): string {
  return `${artifactPath}.blockmap`;
}

export async function regenerateElectronBlockmap(artifactPath: string): Promise<string> {
  const blockmapPath = blockmapPathForArtifact(artifactPath);
  await buildBlockMap(artifactPath, "gzip", blockmapPath);
  return blockmapPath;
}

export async function verifyElectronBlockmap(artifactPath: string): Promise<void> {
  const temporaryDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "2code-blockmap-verify-"),
  );
  const expectedBlockmapPath = NodePath.join(temporaryDirectory, "expected.blockmap");
  try {
    await buildBlockMap(artifactPath, "gzip", expectedBlockmapPath);
    const [actual, expected] = await Promise.all([
      NodeFSP.readFile(blockmapPathForArtifact(artifactPath)),
      NodeFSP.readFile(expectedBlockmapPath),
    ]);
    const actualBlockmap = NodeZlib.gunzipSync(actual);
    const expectedBlockmap = NodeZlib.gunzipSync(expected);
    if (!actualBlockmap.equals(expectedBlockmap)) {
      throw new Error(
        `Electron blockmap ${NodePath.basename(blockmapPathForArtifact(artifactPath))} does not match final artifact bytes.`,
      );
    }
  } finally {
    await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true });
  }
}
