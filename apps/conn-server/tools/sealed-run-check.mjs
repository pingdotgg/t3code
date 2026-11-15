#!/usr/bin/env node
// Proves that a hand run of `cargo test` is sealed by default (.cargo/config.toml,
// tools/cargo-runner.mjs), and that the way out is loud.
//
// 1. Plain `cargo test -p conn-support --lib sealed_environment_report`, with a decoy HOME,
//    marker variables, a stand-in SHELL and marker CLIs (codex, gh, ...) first on PATH in the
//    outer environment, and no CARGO_TARGET_*_RUNNER: the test must see another HOME (gone
//    after the run), none of the markers, a PATH without the marker CLIs, no global git
//    configuration, the outside network gate on (CONN_NETWORK_LOG), and `codex` must not be
//    found (the planted case of 2026-11-15); no marker CLI ran.
// 2. The same with CONN_UNSEALED=1: the runner prints its warning and the test sees the decoy.
// 3. CONN_UNSEALED=2: the runner refuses.
// 4. CARGO_TARGET_<HOST>_RUNNER in the environment wins over the config file's runner.
// 5. Drift: `HOST_CLIS` in sealed-env.mjs equals `HOST_CLIS` in conn-support's spawn guard,
//    and every variable our Rust code reads is passed, set or dropped on purpose by the runner.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_CLIS, RUN_DROPPED, RUN_KNOBS, RUN_SET } from "./sealed-env.mjs";

const repo = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const expect = (ok, what) => {
  if (!ok) failures.push(what);
};

// ---- 5. drift (no cargo) --------------------------------------------------------------------

const guard = NodeFS.readFileSync(NodePath.join(repo, "crates/conn-support/src/spawn_guard.rs"), "utf8");
const guardList = /pub const HOST_CLIS: &\[&str\] = &\[([^\]]*)\]/.exec(guard)?.[1] ?? "";
const rustClis = [...guardList.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
expect(
  JSON.stringify(rustClis) === JSON.stringify(HOST_CLIS),
  `HOST_CLIS differ: spawn_guard.rs ${JSON.stringify(rustClis)}, sealed-env.mjs ${JSON.stringify(HOST_CLIS)}`,
);

const RUNTIME = ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME"];
const known = new Set([...RUNTIME, ...RUN_KNOBS, ...RUN_SET, ...RUN_DROPPED]);
const read = new Set();
const walk = (dir) => {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "target" || entry.name === "generated") continue;
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".rs")) {
      for (const m of NodeFS.readFileSync(full, "utf8").matchAll(/env::var(?:_os)?\(\s*"([A-Z0-9_]+)"\s*\)/g)) read.add(m[1]);
    }
  }
};
walk(NodePath.join(repo, "crates"));
for (const name of read) {
  if (!known.has(name) && !/^(CARGO|RUST)_/.test(name)) {
    failures.push(`crates read ${name}: add it to RUN_KNOBS (passed), RUN_SET or RUN_DROPPED in tools/sealed-env.mjs`);
  }
}

// ---- the decoy outer environment ------------------------------------------------------------

const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-sealed-run-check-")));
process.once("exit", () => NodeFS.rmSync(root, { recursive: true, force: true }));
const token = NodeCrypto.randomBytes(8).toString("hex");
const decoyHome = NodePath.join(root, "decoy-home");
NodeFS.mkdirSync(decoyHome);
NodeFS.writeFileSync(NodePath.join(decoyHome, ".gitconfig"), `[user]\n\tname = marker-${token}\n`);
const markerBin = NodePath.join(root, "marker-bin");
NodeFS.mkdirSync(markerBin);
const cliLog = NodePath.join(root, "cli.log");
for (const name of HOST_CLIS) {
  NodeFS.writeFileSync(NodePath.join(markerBin, name), `#!/bin/sh\necho "${name} $*" >> '${cliLog}'\nexit 1\n`, { mode: 0o755 });
}
const shell = NodePath.join(root, "decoy-shell");
NodeFS.writeFileSync(shell, "#!/bin/sh\nexec /bin/sh \"$@\"\n", { mode: 0o755 });

const MARKERS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_HOME", "GH_TOKEN", "GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "T3CODE_HOME", "SEALED_RUN_MARKER"];
const cargoHome = process.env.CARGO_HOME ?? NodePath.join(NodeOS.homedir(), ".cargo");
const rustupHome = process.env.RUSTUP_HOME ?? NodePath.join(NodeOS.homedir(), ".rustup");
const outer = Object.fromEntries(
  // Not the canary's network log either: the runner must set its own.
  Object.entries(process.env).filter(
    ([name]) => !/^CARGO_TARGET_\w+_RUNNER$/.test(name) && !["CONN_UNSEALED", "CONN_NETWORK_LOG", "CONN_CANARY_ROOT"].includes(name),
  ),
);
const base = {
  ...outer,
  ...Object.fromEntries(MARKERS.map((name) => [name, `marker-${name}-${token}`])),
  HOME: decoyHome,
  SHELL: shell,
  PATH: `${markerBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  CARGO_HOME: cargoHome,
  RUSTUP_HOME: rustupHome,
  // Cargo itself reads ~/.gitconfig through HOME; only the binary it runs is in question here.
  GIT_CONFIG_GLOBAL: NodePath.join(decoyHome, ".gitconfig"),
};

function probe(name, extra) {
  const tmp = NodePath.join(root, `tmp-${name}`);
  NodeFS.mkdirSync(tmp);
  NodeFS.writeFileSync(NodePath.join(tmp, "conn-sealed-probe.request"), `${token}\n`);
  const run = NodeChildProcess.spawnSync(
    "cargo",
    ["test", "--quiet", "-p", "conn-support", "--lib", "sealed_probe::sealed_environment_report"],
    { cwd: repo, env: { ...base, TMPDIR: tmp, ...extra }, encoding: "utf8" },
  );
  let report = {};
  const names = [];
  const markers = [];
  try {
    for (const line of NodeFS.readFileSync(NodePath.join(tmp, "conn-sealed-probe.txt"), "utf8").split("\n")) {
      const at = line.indexOf("=");
      if (at < 0) continue;
      const [key, value] = [line.slice(0, at), line.slice(at + 1)];
      if (key === "name") names.push(value);
      else if (key === "marker") markers.push(value);
      else report[key] = value;
    }
  } catch {
    report = undefined;
  }
  return { run, report, names, markers };
}

const cliRuns = () => (NodeFS.existsSync(cliLog) ? NodeFS.readFileSync(cliLog, "utf8").split("\n").filter(Boolean) : []);

// ---- 1. sealed by default ---------------------------------------------------------------------

const sealed = probe("sealed", {});
expect(sealed.run.status === 0, `sealed run: cargo test exited ${sealed.run.status}\n${sealed.run.stderr}`);
expect(sealed.report !== undefined, "sealed run: the probe wrote no report (did the test run?)");
if (sealed.report) {
  const r = sealed.report;
  expect(r.HOME !== decoyHome && r.HOME !== "", `sealed run: HOME is ${r.HOME}`);
  expect(!NodeFS.existsSync(r.HOME), `sealed run: the throwaway HOME ${r.HOME} is still there after the run`);
  expect(sealed.markers.length === 0, `sealed run: markers reached the test: ${sealed.markers.join(", ")}`);
  for (const name of MARKERS) expect(!sealed.names.includes(name), `sealed run: ${name} reached the test`);
  const clisOnPath = r.PATH.split(":").flatMap((dir) => HOST_CLIS.filter((cli) => NodeFS.existsSync(NodePath.join(dir, cli))).map((cli) => `${cli} in ${dir}`));
  expect(clisOnPath.length === 0, `sealed run: the test's PATH holds ${clisOnPath.join(", ")}`);
  expect(!r.PATH.split(":").includes(markerBin), "sealed run: the marker folder is on the test's PATH");
  expect(r.SHELL !== shell, `sealed run: SHELL is the outer one`);
  expect(r.GIT_CONFIG_GLOBAL === "/dev/null", `sealed run: GIT_CONFIG_GLOBAL is ${r.GIT_CONFIG_GLOBAL}`);
  expect(r.codex === "not found", `sealed run: codex ${r.codex}`);
  expect(sealed.names.includes("CONN_NETWORK_LOG"), "sealed run: the outside network gate (CONN_NETWORK_LOG) is off");
  expect(!/WARNING/.test(sealed.run.stderr), "sealed run: the runner warned");
}
expect(cliRuns().length === 0, `sealed run: a marker CLI ran: ${cliRuns().join("; ")}`);

// ---- 2. the way out is loud -----------------------------------------------------------------

const unsealed = probe("unsealed", { CONN_UNSEALED: "1" });
expect(unsealed.run.status === 0, `CONN_UNSEALED=1: cargo test exited ${unsealed.run.status}\n${unsealed.run.stderr}`);
expect(/cargo-runner: WARNING: CONN_UNSEALED=1/.test(unsealed.run.stderr), "CONN_UNSEALED=1: no warning line");
expect(unsealed.report?.HOME === decoyHome, `CONN_UNSEALED=1: HOME is ${unsealed.report?.HOME}, not the outer one`);
expect(unsealed.markers.includes("SEALED_RUN_MARKER"), "CONN_UNSEALED=1: the outer variables did not pass");
// The probe starts `codex`, as the planted case did: unsealed, the marker on PATH runs.
expect(cliRuns().length === 1, `CONN_UNSEALED=1: the marker codex ran ${cliRuns().length} times, expected once`);

// ---- 3. a wrong value is refused --------------------------------------------------------------

const refused = probe("refused", { CONN_UNSEALED: "yes" });
expect(refused.run.status !== 0 && /CONN_UNSEALED must be 1 or unset/.test(refused.run.stderr), "CONN_UNSEALED=yes: not refused");

// ---- 4. an environment runner wins over the config file -----------------------------------------

const host = /^host: (.*)$/m.exec(NodeChildProcess.execFileSync("rustc", ["-vV"], { env: base, encoding: "utf8" }))?.[1] ?? "";
const envRunner = NodePath.join(root, "env-runner");
NodeFS.writeFileSync(envRunner, `#!/bin/sh\necho env-runner >> '${NodePath.join(root, "env-runner.log")}'\nexec "$@"\n`, { mode: 0o755 });
const viaEnv = probe("env-runner", { [`CARGO_TARGET_${host.toUpperCase().replace(/[.-]/g, "_")}_RUNNER`]: envRunner });
expect(viaEnv.run.status === 0, `env runner: cargo test exited ${viaEnv.run.status}\n${viaEnv.run.stderr}`);
expect(NodeFS.existsSync(NodePath.join(root, "env-runner.log")), "env runner: CARGO_TARGET_<HOST>_RUNNER did not run");
expect(viaEnv.report?.HOME === decoyHome, "env runner: the config file's runner ran as well (HOME was sealed)");

// What the runner adds per binary (it runs once per test binary, not per test).
const timed = (argv) => {
  const started = process.hrtime.bigint();
  for (let i = 0; i < 10; i += 1) NodeChildProcess.spawnSync(argv[0], argv.slice(1), { env: { ...base, TMPDIR: root } });
  return Number(process.hrtime.bigint() - started) / 1e7;
};
const added = timed([NodePath.join(repo, "tools/cargo-runner"), "/usr/bin/true"]) - timed(["/usr/bin/true"]);

if (failures.length > 0) {
  for (const failure of failures) console.error(`sealed-run: ${failure}`);
  process.exit(1);
}
console.log(
  `sealed-run: plain cargo test is sealed (another HOME, removed after; ${MARKERS.length} markers and ` +
    `${HOST_CLIS.length} marker CLIs unseen; codex not found; no marker CLI ran); CONN_UNSEALED=1 warns; ` +
    `a wrong value is refused; CARGO_TARGET_<HOST>_RUNNER wins over the config file; ` +
    `HOST_CLIS equal; ${read.size} variables the code reads all classified. ` +
    `The runner adds ${added.toFixed(0)} ms per binary.`,
);
