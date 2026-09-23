// @effect-diagnostics nodeBuiltinImport:off - retention assertions need an isolated process with explicit GC.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
it.each([false, true])(
  "releases the traced caller snapshot while caching a result (failure=%s)",
  async (failure) => {
    const fixture = NodeURL.fileURLToPath(
      new URL("./testing/LookupRetention.fixture.mjs", import.meta.url),
    );
    const { stdout } = await execFile(process.execPath, [
      "--expose-gc",
      fixture,
      ...(failure ? ["failure"] : []),
    ]);
    expect(JSON.parse(stdout)).toEqual({
      retained: false,
      cachedResult: failure ? "unavailable" : 1,
    });
  },
);
