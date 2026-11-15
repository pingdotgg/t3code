// Cargo's target runner for this workspace (`.cargo/config.toml`, through `tools/cargo-runner`):
// every binary that cargo starts (tests, examples, benches, `cargo run`) runs sealed, so a hand
// run cannot reach this machine's home, provider or host CLIs, or their logins.
//
// The binary gets `sealedRunEnv` (tools/sealed-env.mjs): a fresh HOME, a stand-in SHELL, only
// the variables it needs, a PATH without provider or host CLIs, no global git configuration,
// the status probes and the model manifest fetch off, and our server's HTTP client refuses
// hosts outside loopback (CONN_NETWORK_LOG; the run then fails). The temp folder is removed when the
// binary ends; one left by a killed runner is removed by the next run.
//
// The way out, for runs that need the real environment on purpose (the live tests with
// `--ignored`, the recorder with a live model, the server by hand against a state folder):
// `CONN_UNSEALED=1`. The runner then prints a warning and passes the shell's environment on.
// `tools/check.sh` and CI refuse to run with it set.
//
// `CARGO_TARGET_<TRIPLE>_RUNNER` in the environment wins over this runner (cargo prefers a
// `target.<triple>` runner to a `target.'cfg(...)'` one); `tools/check.sh` uses that for the
// canary, and `tools/sealed-run-check.mjs` proves both.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { RUN_DIR_PREFIX, sealedRunEnv } from "./sealed-env.mjs";

const [program, ...args] = process.argv.slice(2);
if (program === undefined) {
  console.error("cargo-runner: no program to run");
  process.exit(2);
}

const unsealed = process.env.CONN_UNSEALED;
if (unsealed !== undefined && unsealed !== "" && unsealed !== "1") {
  console.error(`cargo-runner: CONN_UNSEALED must be 1 or unset (it is ${JSON.stringify(unsealed)}); refusing to run`);
  process.exit(2);
}

/** Removes the folders of runners that no longer run (killed before their cleanup). */
function sweep(tmp) {
  let names;
  try {
    names = NodeFS.readdirSync(tmp);
  } catch {
    return;
  }
  for (const name of names) {
    const match = new RegExp(`^${RUN_DIR_PREFIX}(\\d+)-`).exec(name);
    if (!match) continue;
    try {
      process.kill(Number(match[1]), 0);
      continue; // still running (or another user's process: not ours to judge)
    } catch (error) {
      if (error.code !== "ESRCH") continue;
    }
    NodeFS.rmSync(NodePath.join(tmp, name), { recursive: true, force: true });
  }
}

let dir;
let env;
let networkLog;
if (unsealed === "1") {
  console.error(
    `cargo-runner: WARNING: CONN_UNSEALED=1: ${NodePath.basename(program)} runs UNSEALED, with this shell's ` +
      "environment: the real HOME, every variable, every CLI on PATH. Only for live tests and hand runs that need it.",
  );
  env = process.env;
} else {
  const tmp = NodeOS.tmpdir();
  sweep(tmp);
  dir = NodeFS.mkdtempSync(NodePath.join(tmp, `${RUN_DIR_PREFIX}${process.pid}-`));
  env = sealedRunEnv(dir);
  // Our server's HTTP client refuses and names any host outside loopback while this is set
  // (conn_source_control::http). The canary's own log, when it runs us, takes precedence.
  if (env.CONN_NETWORK_LOG === undefined) {
    networkLog = NodePath.join(dir, "network.log");
    env.CONN_NETWORK_LOG = networkLog;
  }
}

/** Hosts outside loopback that our code tried and the gate refused, if any. */
const refusedHosts = () => {
  if (networkLog === undefined) return [];
  try {
    return NodeFS.readFileSync(networkLog, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const cleanup = () => {
  if (dir !== undefined) NodeFS.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
};

const child = NodeChildProcess.spawn(program, args, { env, stdio: "inherit" });
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
for (const signal of SIGNALS) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  });
}
child.on("error", (error) => {
  cleanup();
  console.error(`cargo-runner: could not start ${program}: ${error.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  const refused = refusedHosts();
  cleanup();
  if (refused.length > 0) {
    console.error(`cargo-runner: ${NodePath.basename(program)} tried hosts outside loopback (refused): ${refused.join(", ")}`);
    if (signal === null && code === 0) process.exit(1);
  }
  if (signal !== null) {
    for (const s of SIGNALS) process.removeAllListeners(s);
    process.kill(process.pid, signal);
    process.exit(128 + (NodeOS.constants.signals[signal] ?? 1));
  }
  process.exit(code ?? 1);
});
