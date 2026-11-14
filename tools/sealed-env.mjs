// Environments for the processes a check starts. Each gets only what it needs from the shell,
// a fresh HOME and a stand-in login shell, so no token, setting or login of this machine
// reaches it. `tools/canary.mjs` (the last check in tools/check.sh) proves that it holds.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** What a process needs from the shell to run; nothing else passes. */
const RUNTIME_VARIABLES = ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME"];

/** A fresh HOME under `dir`. */
function freshHome(dir) {
  const home = NodePath.join(dir, "home");
  NodeFS.mkdirSync(home, { recursive: true });
  return home;
}

/**
 * A stand-in login shell under `dir`: it runs the `-c` script with /bin/sh and reads no
 * profile, so the server's login environment lookup (`$SHELL -ilc`) never runs the user's
 * shell or its profile.
 */
export function standInShell(dir) {
  const shell = NodePath.join(dir, "login-shell");
  if (!NodeFS.existsSync(shell)) {
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(
      shell,
      [
        "#!/bin/sh",
        'cmd=""; found=0',
        'for arg in "$@"; do',
        '  if [ "$found" = 1 ]; then cmd="$arg"; found=2; fi',
        '  case "$arg" in -*c*) [ "$found" = 0 ] && found=1 ;; esac',
        "done",
        "HISTFILE=/dev/null; export HISTFILE",
        'if [ "$found" = 2 ]; then exec /bin/sh -c "$cmd"; fi',
        "exec /bin/sh",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  return shell;
}

function runtimeVariables() {
  return Object.fromEntries(
    RUNTIME_VARIABLES.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );
}

/**
 * The environment for a server that a check starts: `RUNTIME_VARIABLES` from the shell, a
 * fresh HOME and a stand-in shell. Discovery (`server.discoverSourceControl`) then reads no CLI
 * login of this machine (gh, glab, fj, ...), no token variable, and calls no host's API; the
 * Claude status probe is off. `dir` must be a fresh temp folder the check removes.
 */
export function sealedEnv(dir) {
  return {
    ...runtimeVariables(),
    HOME: freshHome(dir),
    SHELL: standInShell(dir),
    CONN_CLAUDE_STATUS_PROBE: "off",
  };
}

/** `sealedEnv` in a temp folder of its own, removed when the process exits. */
export function sealedEnvTemp() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-sealed-"));
  process.once("exit", () => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return sealedEnv(dir);
}

/**
 * The environment for T3's own code that a proof runs (vitest in the Conn monorepo): only
 * `RUNTIME_VARIABLES` from the shell, a fresh HOME and a stand-in shell, so no `ANTHROPIC_*`,
 * `CLAUDE_*`, token or other variable of the shell reaches it, and `os.homedir()` finds no
 * real home. `dir` must be a fresh temp folder the check removes.
 */
export function sealedNodeEnv(dir) {
  return { ...runtimeVariables(), HOME: freshHome(dir), SHELL: standInShell(dir) };
}

/**
 * `sealedNodeEnv` for a `cargo run` of an example: cargo and rustup keep their own folders
 * and settings (`CARGO_*`, `RUSTUP_*`, `RUSTFLAGS`), so the build is the one the shell would
 * make, while the example gets the throwaway HOME. `dir` must be a fresh temp folder.
 */
export function sealedCargoEnv(dir) {
  const cargo = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => /^(CARGO_|RUSTUP_|RUSTFLAGS$|RUSTC_WRAPPER$)/.test(name) && !/^CARGO_TARGET_\w+_RUNNER$/.test(name)),
  );
  return {
    ...sealedNodeEnv(dir),
    CARGO_HOME: NodePath.join(NodeOS.homedir(), ".cargo"),
    RUSTUP_HOME: NodePath.join(NodeOS.homedir(), ".rustup"),
    ...cargo,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/**
 * The environment for a `cargo build` that a tool makes: the tool's own, with a throwaway
 * HOME (cargo reads `~/.gitconfig` through HOME), cargo's and rustup's folders kept, and no
 * global git configuration. Without `dir`, a temp folder of its own, removed at exit.
 */
export function cargoBuildEnv(dir) {
  if (dir === undefined) {
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-cargo-"));
    const made = dir;
    process.once("exit", () => NodeFS.rmSync(made, { recursive: true, force: true }));
  }
  return {
    ...gitEnv(),
    CARGO_HOME: process.env.CARGO_HOME ?? NodePath.join(NodeOS.homedir(), ".cargo"),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? NodePath.join(NodeOS.homedir(), ".rustup"),
    HOME: freshHome(dir),
  };
}

/**
 * The environment for a `git` run that a tool makes: the tool's own, with no global or
 * system git configuration, so no user setting, credential helper or identity of this
 * machine reaches the run. Pass `env` to start from another environment.
 */
export function gitEnv(env = process.env) {
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}
