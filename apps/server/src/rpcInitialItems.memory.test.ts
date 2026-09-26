// @effect-diagnostics nodeBuiltinImport:off - memory assertions run in an isolated Node process with explicit GC.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

it.each(["prefix", "snapshot", "replay"])(
  "releases delivered %s history while RPC subscriptions remain open",
  async (mode) => {
    const root = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
    const fixture = NodeURL.fileURLToPath(
      new URL("./testkit/RpcInitialMemory.fixture.mjs", import.meta.url),
    );
    const { stdout } = await execFile(process.execPath, ["--expose-gc", fixture, root, mode]);
    const result = JSON.parse(stdout) as {
      checkpoints: ReadonlyArray<{ subscriptions: number; retained: number }>;
    };
    expect(
      result.checkpoints.map(({ subscriptions, retained }) => ({ subscriptions, retained })),
    ).toEqual([
      { subscriptions: 2, retained: 0 },
      { subscriptions: 4, retained: 0 },
    ]);
  },
);
