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

/** What `tools/canary.mjs` sets for a check run (its Node hook and logs); nothing outside one. */
const CANARY_VARIABLES = ["NODE_OPTIONS", "CONN_CANARY_ROOT", "CONN_NETWORK_LOG", "CONN_CANARY_NODE_NETWORK_LOG"];

/** The canary's variables while `tools/check.sh` runs under it, else none. */
export function canaryEnv() {
  if (!process.env.CONN_CANARY_ROOT) return {};
  return Object.fromEntries(
    CANARY_VARIABLES.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );
}

function runtimeVariables() {
  return {
    ...Object.fromEntries(
      RUNTIME_VARIABLES.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
    ),
    ...canaryEnv(),
  };
}

/** Also hides upstream host CLIs: comparisons still start the full T3 server. */
export const HOST_CLIS = [
  "claude", "codex", "grok", "gh", "glab", "fj", "tea", "az", "cafe", "origin",
  "cursor-agent", "opencode", "kiro-cli", "jj",
];

/**
 * `PATH` without the CLIs in `HOST_CLIS`: a folder that holds one is replaced, at its place, by
 * a folder under `dir` with links to everything else in it. The server's source control
 * discovery and provider probes then run no CLI of this machine (they find none, as on a host
 * without them), while `node`, `git` and the system tools stay where they were.
 */
export function sealedPath(dir, path = process.env.PATH ?? "/usr/bin:/bin") {
  const out = [];
  path.split(":").filter(Boolean).forEach((folder, index) => {
    let names;
    try {
      names = NodeFS.readdirSync(folder);
    } catch {
      return;
    }
    if (!names.some((name) => HOST_CLIS.includes(name))) {
      out.push(folder);
      return;
    }
    const links = NodePath.join(dir, "path", String(index));
    NodeFS.mkdirSync(links, { recursive: true });
    for (const name of names) {
      if (HOST_CLIS.includes(name)) continue;
      try {
        NodeFS.symlinkSync(NodePath.join(folder, name), NodePath.join(links, name));
      } catch {
        // A name taken twice keeps its first link.
      }
    }
    out.push(links);
  });
  return out.join(":");
}

/**
 * The environment for a server that a check starts: `RUNTIME_VARIABLES` from the shell, a
 * fresh HOME, a stand-in shell and a `PATH` without provider or host CLIs. Discovery (`server.discoverSourceControl`) then reads no CLI
 * login of this machine (gh), no token variable, and calls no host's API; the
 * Claude and Codex status probes are off. `dir` must be a fresh temp folder the check removes.
 */
export function sealedEnv(dir) {
  return {
    ...runtimeVariables(),
    PATH: sealedPath(dir),
    HOME: freshHome(dir),
    SHELL: standInShell(dir),
    CONN_CLAUDE_STATUS_PROBE: "off",
    // Nor the Codex status probe: an entry stays T3's pending one. Checks that probe Codex on
    // a stub turn it on.
    CONN_CODEX_STATUS_PROBE: "off",
    // The server never fetches model-manifest.json from GitHub.
    CONN_MODEL_MANIFEST_URL: "off",
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
  // No server of ours reads CONN_MODEL_MANIFEST_URL there, but a check that starts one from
  // this environment must not fetch either.
  return { ...runtimeVariables(), HOME: freshHome(dir), SHELL: standInShell(dir), CONN_MODEL_MANIFEST_URL: "off" };
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
 * What cargo sets for a binary it runs, and what libtest and std read: these pass the cargo
 * runner (`tools/cargo-runner.mjs`). No `CARGO_HOME`, no registry token. Also macOS's
 * `__CF_USER_TEXT_ENCODING` (uid and text encoding): without it the system adds it to the
 * binary's children, and the conformance checks see a variable the parent never had.
 */
const CARGO_RUN_VARIABLE =
  /^(__CF_USER_TEXT_ENCODING|CARGO|CARGO_(PKG_\w+|BIN_\w+|CRATE_NAME|MANIFEST_DIR|MANIFEST_PATH|PRIMARY_PACKAGE|TARGET_TMPDIR)|RUST_(BACKTRACE|LIB_BACKTRACE|LOG|MIN_STACK|TEST_\w+)|DYLD_FALLBACK_LIBRARY_PATH|LD_LIBRARY_PATH)$/;

/**
 * Knobs that our tests and examples read from the environment, set by hand
 * (`RSS_TURNS=5 cargo run --example rss`): they pass the cargo runner.
 */
export const RUN_KNOBS = [
  "CONN_NETWORK_LOG", "ACP_FIXTURE", "ACP_DUMP", "CONN_CONTRACT_REAL_PAYLOADS",
  "REPLAY_MCP_CAPTURE", "RSS_TURNS", "RSS_SETTINGS", "STREAM", "REOPEN", "IDLE_MS", "CHECKPOINTS",
];

/** What the cargo runner sets itself, whatever the shell has. */
export const RUN_SET = [
  "HOME", "PATH", "SHELL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM",
  "CONN_CLAUDE_STATUS_PROBE", "CONN_CODEX_STATUS_PROBE", "CONN_MODEL_MANIFEST_URL",
];

/**
 * Variables our Rust code reads that the cargo runner never passes: they point at a real
 * login, a real home or the real machine. A run that needs one uses `CONN_UNSEALED=1`.
 * `tools/sealed-run-check.mjs` fails when the code reads a variable in none of these lists.
 */
export const RUN_DROPPED = [
  "CONN_SERVER_BROWSER_PATH", "T3CODE_SERVER_BROWSER_SANDBOX", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_BIN", "CAFE_TOKEN", "T3_ACP_MCP_ENDPOINT",
  "T3_ACP_MCP_AUTHORIZATION", "PROGRAMDATA", "HOSTNAME", "GIT_CONFIG_COUNT",
  // The Android SDK and emulator options of this machine (conn-devices, the local host).
  "ANDROID_HOME", "ANDROID_SDK_ROOT", "LOCALAPPDATA", "EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS",
  // The machine's switch for the local server scan (`T3CODE_PORT_DISCOVERY=0`).
  "T3CODE_PORT_DISCOVERY",
];

/** The prefix of the cargo runner's temp folders: `conn-run-<runner pid>-XXXXXX`. */
export const RUN_DIR_PREFIX = "conn-run-";

/**
 * The environment for a binary that cargo runs (tests, examples, benches, `cargo run`), built
 * by `tools/cargo-runner.mjs`: `RUNTIME_VARIABLES` and the canary's variables, what cargo and
 * libtest set (`CARGO_RUN_VARIABLE`), `RUN_KNOBS`; then a fresh HOME, a stand-in shell, a
 * `PATH` without provider or host CLIs, no global or system git configuration, the status
 * probes and the model manifest fetch off. `dir` must be a fresh temp folder.
 */
export function sealedRunEnv(dir, env = process.env) {
  const passed = Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) =>
        value !== undefined &&
        (RUNTIME_VARIABLES.includes(name) || CARGO_RUN_VARIABLE.test(name) || RUN_KNOBS.includes(name)),
    ),
  );
  const canary = env.CONN_CANARY_ROOT
    ? Object.fromEntries(CANARY_VARIABLES.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])))
    : {};
  return {
    ...passed,
    ...canary,
    PATH: sealedPath(dir, env.PATH ?? "/usr/bin:/bin"),
    HOME: freshHome(dir),
    SHELL: standInShell(dir),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    CONN_CLAUDE_STATUS_PROBE: "off",
    CONN_CODEX_STATUS_PROBE: "off",
    CONN_MODEL_MANIFEST_URL: "off",
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
