// @effect-diagnostics nodeBuiltinImport:off - Applies real file modes in a temporary app folder.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import afterPack from "./linux-after-pack.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("linux afterPack", () => {
  it("removes group and other write access from the packed app", async () => {
    const appOutDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-after-pack-"));
    try {
      const modes = {
        t3code: [0o777, 0o755],
        "resources.pak": [0o666, 0o644],
        "chrome-sandbox": [0o4777, 0o4755],
        "resources/app.asar": [0o644, 0o644],
      } as const;
      await NodeFSP.mkdir(NodePath.join(appOutDir, "resources"));
      for (const [file, [before]] of Object.entries(modes)) {
        await NodeFSP.writeFile(NodePath.join(appOutDir, file), "");
        await NodeFSP.chmod(NodePath.join(appOutDir, file), before);
      }
      await NodeFSP.chmod(NodePath.join(appOutDir, "resources"), 0o777);
      await NodeFSP.symlink("t3code", NodePath.join(appOutDir, "t3code-link"));

      await afterPack({ appOutDir });

      for (const [file, [, after]] of Object.entries(modes)) {
        const { mode } = await NodeFSP.stat(NodePath.join(appOutDir, file));
        expect([file, mode & 0o7777]).toEqual([file, after]);
      }
      const { mode: resourcesMode } = await NodeFSP.stat(NodePath.join(appOutDir, "resources"));
      expect(resourcesMode & 0o7777).toBe(0o755);
    } finally {
      await NodeFSP.rm(appOutDir, { recursive: true, force: true });
    }
  });
});
