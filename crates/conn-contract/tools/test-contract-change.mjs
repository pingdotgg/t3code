// Proves a contract change is caught: copies packages/contracts under target/, changes two
// schemas as an upstream merge might, then shows `gen-contract.mjs --check` fails and code
// written against the old contract stops compiling against the regenerated crate.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { monorepo, repoRoot } from "../../../tools/monorepo.mjs";

const crateDir = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const workspaceDir = repoRoot;
const repoDir = monorepo();
const work = NodePath.join(workspaceDir, "target/contract-change");
const contracts = NodePath.join(work, "contracts");
const crateCopy = NodePath.join(work, "conn-contract");

NodeFS.rmSync(work, { recursive: true, force: true });
NodeFS.mkdirSync(work, { recursive: true });
NodeFS.cpSync(NodePath.join(repoDir, "packages/contracts"), contracts, {
  recursive: true,
  filter: (src) => !src.includes(`${NodePath.sep}node_modules`),
});
NodeFS.symlinkSync(
  NodePath.join(repoDir, "packages/contracts/node_modules"),
  NodePath.join(contracts, "node_modules"),
);

const file = NodePath.join(contracts, "src/orchestrationV2.ts");
let src = NodeFS.readFileSync(file, "utf8");
const mutate = (from, to) => {
  if (!src.includes(from)) throw new Error(`mutation target missing: ${from}`);
  src = src.replace(from, to);
};
// A renamed field and a new required field, as an upstream change might bring.
mutate(
  "export const OrchestrationV2DispatchCommandResult = Schema.Struct({\n  sequence: NonNegativeInt,",
  "export const OrchestrationV2DispatchCommandResult = Schema.Struct({\n  resultSequence: NonNegativeInt,",
);
mutate(
  '    type: Schema.Literal("thread.stop"),\n    commandId: CommandId,',
  '    type: Schema.Literal("thread.stop"),\n    commandId: CommandId,\n    stopKind: Schema.Literals(["soft", "hard"]),',
);
NodeFS.writeFileSync(file, src);

const gen = (extra) =>
  NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(crateDir, "tools/gen-contract.mjs"), "--contracts", contracts, ...extra],
    {
      encoding: "utf8",
    },
  );

console.log("1. --check against the changed contract");
const checked = gen(["--check"]);
process.stdout.write(checked.stdout + checked.stderr);
if (checked.status === 0) {
  console.error("FAIL: --check passed on a changed contract");
  process.exit(1);
}
console.log(`   exit ${checked.status}: caught\n`);

console.log("2. code written against the old contract, compiled before and after regenerating");
NodeFS.cpSync(crateDir, crateCopy, {
  recursive: true,
  filter: (s) => !s.includes(`${NodePath.sep}target`),
});
NodeFS.mkdirSync(NodePath.join(crateCopy, "examples"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(crateCopy, "examples/old_contract.rs"),
  `// What another track might write today.
use conn_contract::*;
fn main() {
    let result = DispatchCommandResult { sequence: 1 };
    let stop = OrchestrationV2CommandThreadStop {
        r#type: lit::ThreadStop,
        command_id: "c1".into(),
        thread_id: "t1".into(),
        reason: None,
        stop_delegated_tasks: None,
    };
    println!("{} {:?}", result.sequence, stop);
}
`,
);
// A standalone copy of the crate: inline the workspace keys.
const cargoToml = NodePath.join(crateCopy, "Cargo.toml");
NodeFS.writeFileSync(
  cargoToml,
  NodeFS.readFileSync(cargoToml, "utf8")
    .replace("version.workspace = true", 'version = "0.1.0"')
    .replace("edition.workspace = true", 'edition = "2024"')
    .replace("license.workspace = true", 'license = "MIT"')
    .replace("publish.workspace = true", "publish = false")
    .replace("serde.workspace = true", 'serde = { version = "1", features = ["derive"] }')
    .replace("serde_json.workspace = true", 'serde_json = "1"')
    .replace(/\[lints\]\nworkspace = true\n?/, "") + "\n[workspace]\n",
);
const check = () =>
  NodeChildProcess.spawnSync(
    "cargo",
    ["check", "--offline", "--example", "old_contract", "--message-format", "short"],
    {
      cwd: crateCopy,
      encoding: "utf8",
      env: { ...process.env, CARGO_TARGET_DIR: NodePath.join(work, "target") },
    },
  );
const before = check();
if (before.status !== 0) {
  console.error(
    "FAIL: the example does not compile against the current contract\n" + before.stderr,
  );
  process.exit(1);
}
console.log("   against the current contract: compiles");
const written = gen(["--out", crateCopy]);
if (written.status !== 0) {
  process.stdout.write(written.stdout + written.stderr);
  process.exit(1);
}
const after = check();
console.log(
  after.stderr
    .split("\n")
    .filter((l) => l.includes("error"))
    .map((l) => "   " + l.replace(crateCopy + "/", ""))
    .join("\n"),
);
if (after.status === 0) {
  console.error("FAIL: old code still compiles against the changed contract");
  process.exit(1);
}
console.log(`   against the changed contract: cargo check exit ${after.status}: caught`);
NodeFS.rmSync(work, { recursive: true, force: true });
