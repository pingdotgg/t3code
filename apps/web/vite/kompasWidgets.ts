// @effect-diagnostics nodeBuiltinImport:off -- Vite plugins run outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { Plugin } from "vite-plus";

const widgetsDir = NodePath.resolve(import.meta.dirname, "../../../packages/widgets");

/** Ships the widget pages beside the client, where the packed server looks for them. */
export const kompasWidgetsPlugin = (): Plugin => ({
  name: "kompas:widgets",
  apply: "build",
  async generateBundle() {
    await NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, [
      NodePath.join(widgetsDir, "scripts/build.ts"),
    ]);
    const dist = NodePath.join(widgetsDir, "dist");
    for (const file of await NodeFSP.readdir(dist)) {
      this.emitFile({
        type: "asset",
        fileName: `kompas-widgets/${file}`,
        source: await NodeFSP.readFile(NodePath.join(dist, file)),
      });
    }
  },
});
