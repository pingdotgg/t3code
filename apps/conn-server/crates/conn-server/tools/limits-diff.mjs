// Payload limits check: each case in limits-cases.json is decoded with the payload schema of
// its method from the T3 contract (packages/contracts/src/rpc.ts), and the result must be the
// case's `ok`. The Rust test `limits::tests::cases_agree_with_the_contract` runs the same cases
// through `limits::check`, so both sides agree on every case.
//
//   CONN_MONOREPO=<conn checkout> node crates/conn-server/tools/limits-diff.mjs
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { importSource, packageImporter, repoRoot } from "../../../tools/monorepo.mjs";

const Schema = await packageImporter("packages/contracts")("effect/Schema");
const Exit = await packageImporter("packages/contracts")("effect/Exit");
const rpc = await importSource("packages/contracts/src/rpc.ts");

const file = NodePath.join(repoRoot, "crates/conn-server/tools/limits-cases.json");
const { cases } = JSON.parse(NodeFS.readFileSync(file, "utf8"));
const payloadOf = (tag) => {
  for (const group of [rpc.OfficialWsRpcGroup, rpc.ForkWsRpcGroup]) {
    const found = group.requests.get(tag);
    if (found) return found.payloadSchema;
  }
  throw new Error(`no RPC ${tag} in the contract`);
};

let failed = 0;
for (const c of cases) {
  const exit = Schema.decodeUnknownExit(payloadOf(c.tag))(c.payload);
  const ok = Exit.isSuccess(exit);
  if (ok !== c.ok) {
    failed++;
    console.error(`FAIL ${c.name}: the T3 contract ${ok ? "accepts" : "rejects"} it, the case says ${c.ok ? "accept" : "reject"}`);
    if (!ok) console.error(String(exit.cause).slice(0, 400));
  } else if (ok && c.after) {
    // Entries the decode drops: the decoded value must equal `after` for each key named there.
    for (const [key, expected] of Object.entries(c.after)) {
      if (JSON.stringify(exit.value[key]) !== JSON.stringify(expected)) {
        failed++;
        console.error(`FAIL ${c.name}: the T3 contract decodes \`${key}\` as ${JSON.stringify(exit.value[key])}`);
      }
    }
  }
}
console.log(`limits-diff: ${cases.length - failed} of ${cases.length} cases agree with the T3 contract`);
if (failed) process.exit(1);
