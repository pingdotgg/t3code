// Writes ../methods.json: every RPC method a Conn client can call.
// Run after `vp i`:  node native/conn-server/crates/conn-contract/tools/dump-methods.mjs
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

// Resolve `effect` the way packages/contracts does, not from this folder.
const contracts = new URL("../../../../../packages/contracts/", import.meta.url);
const resolve = NodeModule.createRequire(new URL("package.json", contracts)).resolve;
const RpcSchema = await import(NodeURL.pathToFileURL(resolve("effect/rpc/RpcSchema")).href);
const { OfficialWsRpcGroup, ForkWsRpcGroup } = await import(new URL("src/rpc.ts", contracts).href);

const out = NodeURL.fileURLToPath(new URL("../methods.json", import.meta.url));
// The last commit that changed the contract, not this branch's own commits.
const commit = NodeChildProcess.execFileSync(
  "git",
  ["log", "-1", "--format=%H", "origin/main", "--", "packages/contracts"],
  { encoding: "utf8" },
).trim();

const entries = (group, origin) =>
  [...group.requests.values()].map((rpc) => ({
    tag: rpc._tag,
    stream: RpcSchema.isStreamSchema(rpc.successSchema),
    origin,
  }));

const methods = [
  ...entries(OfficialWsRpcGroup, "official"),
  ...entries(ForkWsRpcGroup, "fork"),
].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)); // byte order: Rust binary-searches it

NodeFS.writeFileSync(out, JSON.stringify({ commit, methods }, null, 2) + "\n");
console.log(
  `${methods.length} methods (${methods.filter((m) => m.stream).length} streams) -> ${out}`,
);
