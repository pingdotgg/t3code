// @effect-diagnostics nodeBuiltinImport:off - memory assertions run in an isolated Node process with explicit GC.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

it.each(["regular", "handoff", "handoff-compact", "handoff-failure"])(
  "releases startup history while %s run workers remain alive",
  async (mode) => {
    const root = NodeURL.fileURLToPath(new URL("../../../../", import.meta.url));
    const fixture = NodeURL.fileURLToPath(
      new URL("./testkit/ProviderTurnStartMemory.fixture.mjs", import.meta.url),
    );
    const { stdout } = await execFile(process.execPath, ["--expose-gc", fixture, root, mode]);
    const result = JSON.parse(stdout) as {
      checkpoints: ReadonlyArray<{ runs: number; retained: number }>;
    };
    expect(result.checkpoints.map(({ runs, retained }) => ({ runs, retained }))).toEqual([
      { runs: 2, retained: 0 },
      { runs: 4, retained: 0 },
    ]);
  },
);
