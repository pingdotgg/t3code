// @effect-diagnostics nodeBuiltinImport:off - blockmap tests exercise the host filesystem used by release tooling.

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";

import {
  blockmapPathForArtifact,
  regenerateElectronBlockmap,
  verifyElectronBlockmap,
} from "./electron-blockmap.ts";

describe("2code Electron blockmaps", () => {
  it("rejects a blockmap created before the final artifact mutation", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "2code-blockmap-test-"));
    try {
      const artifactPath = NodePath.join(directory, "2code-1.0.108-arm64.dmg");
      await NodeFSP.writeFile(artifactPath, Buffer.alloc(48 * 1024, 0x2a));
      assert.equal(
        await regenerateElectronBlockmap(artifactPath),
        blockmapPathForArtifact(artifactPath),
      );
      await verifyElectronBlockmap(artifactPath);

      await NodeFSP.appendFile(artifactPath, Buffer.from("stapled-ticket"));
      await expect(verifyElectronBlockmap(artifactPath)).rejects.toThrow(/final artifact bytes/);

      await regenerateElectronBlockmap(artifactPath);
      await verifyElectronBlockmap(artifactPath);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
