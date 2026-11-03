// @effect-diagnostics nodeBuiltinImport:off - the fixture gates native spawn with a synchronous descriptor read.
// oxlint-disable-next-line t3code/namespace-node-imports -- The fixture replaces the native CJS export before syncing ESM bindings.
import NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import { runSpawnHost } from "./spawnHostProcess.ts";

const spawn = NodeChildProcess.spawn;
const gatedSpawn = (
  command: string,
  args: ReadonlyArray<string> = [],
  options: NodeChildProcess.SpawnOptions = {},
) => {
  if (command === "/t3-blocked-spawn") {
    NodeFS.writeSync(4, "blocked");
    NodeFS.readSync(4, Buffer.alloc(1), 0, 1, null);
    return spawn("/bin/true", [], options);
  }
  return spawn(command, args, options);
};
NodeChildProcess.spawn = gatedSpawn as typeof NodeChildProcess.spawn;
NodeModule.syncBuiltinESMExports();
runSpawnHost();
