// @effect-diagnostics nodeBuiltinImport:off - one synchronous probe at module load, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Skip symlink fixtures when unsupported; Windows requires Developer Mode or elevation. */
export const symlinksSupported: boolean = (() => {
  let directory: string | undefined;
  try {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-symlink-probe-"));
    NodeFS.symlinkSync(NodePath.join(directory, "target"), NodePath.join(directory, "link"));
    return true;
  } catch {
    return false;
  } finally {
    // Cleanup EPERM/EBUSY must not fail module initialization or decide symlink support.
    try {
      if (directory !== undefined) NodeFS.rmSync(directory, { recursive: true, force: true });
    } catch {}
  }
})();
