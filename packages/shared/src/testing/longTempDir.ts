// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { HostProcessPlatform } from "../hostProcess.ts";

// GitHub's Windows runners hand out the temp directory by its 8.3 short name
// (C:\Users\RUNNER~1\...). Anything that canonicalises a path, such as git or
// realpath, reports the long form, so equality checks between a temp path and
// its canonical form fail. Node reads TEMP/TMP on every os.tmpdir() call, so
// pointing them at the long form fixes every temp directory the suite makes.
if (HostProcessPlatform.defaultValue() === "win32") {
  try {
    const longForm = NodeFS.realpathSync.native(NodeOS.tmpdir());
    process.env.TEMP = longForm;
    process.env.TMP = longForm;
  } catch {
    // Leave the host's value alone if it cannot be resolved.
  }
}
