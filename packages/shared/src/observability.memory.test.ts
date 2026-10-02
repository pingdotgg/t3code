// @effect-diagnostics nodeBuiltinImport:off - memory assertions run in an isolated Node process with explicit GC.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

it("releases traced results while cached lookup fibers remain alive", async () => {
  const root = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
  const fixture = NodeURL.fileURLToPath(
    new URL("./testing/TraceRetention.fixture.mjs", import.meta.url),
  );
  const { stdout } = await execFile(process.execPath, ["--expose-gc", fixture, root]);
  const result = JSON.parse(stdout) as { cacheSize: number; retained: number; exported: number };
  expect(result.cacheSize).toBe(4);
  expect(result.exported).toBe(4);
  expect(result.retained).toBe(0);
});
