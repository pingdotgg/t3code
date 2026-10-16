// @effect-diagnostics nodeBuiltinImport:off - one synchronous probe at module load, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Windows refuses without Developer Mode or elevation, so tests that plant a
 * symlink to prove containment or escape detection should
 * `skipIf(!symlinksSupported)` rather than fail at setup.
 */
export const symlinksSupported: boolean = (() => {
  let directory: string | undefined;
  try {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-symlink-probe-"));
    NodeFS.symlinkSync(NodePath.join(directory, "target"), NodePath.join(directory, "link"));
    return true;
  } catch {
    return false;
  } finally {
    // Cleanup must not decide the answer: a transient EPERM/EBUSY on the
    // probe directory would otherwise throw out of module initialisation.
    try {
      if (directory !== undefined) NodeFS.rmSync(directory, { recursive: true, force: true });
    } catch {}
  }
})();
