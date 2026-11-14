#!/usr/bin/env node
// The canary: proves that no check reads the home folder or the shell's secrets.
//
// `tools/check.sh` runs every check with a decoy home as HOME and with marker variables in
// the shell, each holding a unique marker string. A tool that is sealed (its own temp HOME,
// only the variables it needs) never sees either. The canary then fails when:
//
// - a marker string appears in a check's output or in a file a check wrote under TMPDIR
//   (scanned while the checks run, and once after them);
// - a readable decoy file was read: its access time moved (set to 2000-01-01 at setup; reads
//   move it on APFS and on Linux relatime or strictatime mounts; a self-test says when the
//   file system does not, and the canary then fails, since it would prove nothing);
// - a credential stand-in (mode 000) was opened: the open fails, and the canary fails when
//   the decoy home's path appears in any output;
// - the git credential helper of the decoy `.gitconfig` ran (a tripwire script);
// - the decoy home changed: a listing with type, mode, size and SHA-256 before and after;
// - the static lint finds a passwd home lookup (`os.userInfo().homedir`, `getpwuid`, the
//   `dirs` or `home` crates, `std::env::home_dir`), an `env -i` without `HOME=`, or a tool
//   that passes `os.homedir()` on.
//
// It cannot see: a stat or an existence check of a decoy path; a read of a real home that a
// passwd lookup finds in a process we do not own (only the static lint covers our code); a
// marker in a file that lived less than one scan interval and printed nothing; reads on a
// file system mounted noatime; writes outside TMPDIR and the decoy home.
//
// Usage:
//   node tools/canary.mjs setup <root>       writes <root>/env.sh to source
//   node tools/canary.mjs watch <root>       scans <root>/tmp until <root>/stop exists
//   node tools/canary.mjs verify <root> <output log> [more folders to scan]
//   node tools/canary.mjs lint
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const repo = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "..");
const OLD_ATIME = new Date("2000-01-01T00:00:00Z");
const SCAN_LIMIT = 16 << 20;

const MARKER_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  "XAI_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "T3CODE_HOME",
  "CONN_CANARY",
];

/** Decoy files: `read` ones are watched by access time, `locked` ones are mode 000. */
function decoyFiles(token) {
  const m = (name) => `canary-${name}-${token}`;
  return [
    { path: ".claude/settings.json", kind: "read", body: `{"env":{"CANARY":"${m("claude-settings")}"}}\n` },
    { path: ".claude.json", kind: "read", body: `{"userID":"${m("claude-json")}"}\n` },
    { path: ".claude/.credentials.json", kind: "locked", body: `{"token":"${m("claude-credentials")}"}\n` },
    { path: ".codex/config.toml", kind: "read", body: `model = "${m("codex-config")}"\n` },
    { path: ".codex/auth.json", kind: "locked", body: `{"OPENAI_API_KEY":"${m("codex-auth")}"}\n` },
    { path: "codex-home/config.toml", kind: "read", body: `model = "${m("codex-home-config")}"\n` },
    { path: "codex-home/auth.json", kind: "locked", body: `{"OPENAI_API_KEY":"${m("codex-home-auth")}"}\n` },
    { path: ".grok/settings.json", kind: "read", body: `{"model":"${m("grok-settings")}"}\n` },
    { path: ".grok/user-settings.json", kind: "locked", body: `{"apiKey":"${m("grok-key")}"}\n` },
    { path: ".config/gh/config.yml", kind: "read", body: `editor: ${m("gh-config")}\n` },
    { path: ".config/gh/hosts.yml", kind: "locked", body: `github.com:\n  oauth_token: ${m("gh-hosts")}\n` },
    { path: ".config/glab-cli/config.yml", kind: "locked", body: `token: ${m("glab")}\n` },
    { path: ".netrc", kind: "locked", body: `machine github.com login x password ${m("netrc")}\n` },
    { path: ".t3/settings.json", kind: "read", body: `{"canary":"${m("t3-settings")}"}\n` },
    { path: ".t3/userdata/settings.json", kind: "read", body: `{"canary":"${m("t3-userdata-settings")}"}\n` },
    { path: ".t3/secrets/key", kind: "locked", body: `${m("t3-secret")}\n` },
    { path: ".t3/userdata/secrets/key.bin", kind: "locked", body: `${m("t3-userdata-secret")}\n` },
    { path: "t3-home/userdata/settings.json", kind: "read", body: `{"canary":"${m("t3code-home-settings")}"}\n` },
    { path: "t3-home/userdata/secrets/key.bin", kind: "locked", body: `${m("t3code-home-secret")}\n` },
    { path: ".profile", kind: "read", body: `export CONN_CANARY_PROFILE=${m("profile")}\n` },
    { path: ".bash_profile", kind: "read", body: `export CONN_CANARY_PROFILE=${m("bash-profile")}\n` },
    { path: ".zshrc", kind: "read", body: `export CONN_CANARY_PROFILE=${m("zshrc")}\n` },
    { path: ".zprofile", kind: "read", body: `export CONN_CANARY_PROFILE=${m("zprofile")}\n` },
  ];
}

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const fail = (message) => {
  console.error(`canary: ${message}`);
  process.exit(2);
};

function readState(root) {
  try {
    return JSON.parse(NodeFS.readFileSync(NodePath.join(root, "state.json"), "utf8"));
  } catch (error) {
    return fail(`no state in ${root} (${error.message}); run setup first`);
  }
}

function setup(root) {
  NodeFS.mkdirSync(root, { recursive: true });
  const token = NodeCrypto.randomBytes(12).toString("hex");
  const home = NodePath.join(root, `canary-HOME-${token}`);
  const tmp = NodePath.join(root, "tmp");
  NodeFS.mkdirSync(home, { recursive: true });
  NodeFS.mkdirSync(tmp, { recursive: true });
  const files = decoyFiles(token);

  // The git credential helper is a tripwire: a run of it leaves a line in tripwire.log.
  const tripwire = NodePath.join(root, "tripwire");
  NodeFS.writeFileSync(
    tripwire,
    `#!/bin/sh\nprintf '%s\\n' "git credential helper ran: $*" >> ${shellQuote(NodePath.join(root, "tripwire.log"))}\nexit 1\n`,
    { mode: 0o755 },
  );
  files.push({
    path: ".gitconfig",
    kind: "read",
    body:
      `[user]\n\tname = canary-git-user-${token}\n\temail = canary-${token}@example.invalid\n` +
      `[credential]\n\thelper = !${tripwire}\n`,
  });

  // The stand-in login shell: runs the `-c` script with /bin/sh and reads no profile.
  const shell = NodePath.join(root, "shell");
  NodeFS.writeFileSync(
    shell,
    [
      "#!/bin/sh",
      "# Stand-in for the login shell in checks: no profile, no rc file.",
      'cmd=""; found=0',
      'for arg in "$@"; do',
      '  if [ "$found" = 1 ]; then cmd="$arg"; found=2; fi',
      '  case "$arg" in -*c*) [ "$found" = 0 ] && found=1 ;; esac',
      "done",
      'if [ "$found" = 2 ]; then exec /bin/sh -c "$cmd"; fi',
      "exec /bin/sh",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  for (const file of files) {
    const full = NodePath.join(home, file.path);
    NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
    NodeFS.writeFileSync(full, file.body);
  }

  const values = Object.fromEntries(MARKER_VARIABLES.map((name) => [name, `canary-${name}-${token}`]));
  // Variables that hold a path or a URL get a value of that kind, still with the marker.
  values.CODEX_HOME = NodePath.join(home, "codex-home");
  values.T3CODE_HOME = NodePath.join(home, "t3-home");
  values.ANTHROPIC_BASE_URL = `http://127.0.0.1:9/canary-${token}`;

  for (const file of files) {
    if (file.kind === "locked") NodeFS.chmodSync(NodePath.join(home, file.path), 0o000);
  }
  const listing = list(home);
  // Last, as `list` reads every file.
  for (const file of files) {
    const full = NodePath.join(home, file.path);
    NodeFS.utimesSync(full, OLD_ATIME, NodeFS.statSync(full).mtime);
  }
  const state = { token, home, tmp, shell, files: files.map(({ path, kind }) => ({ path, kind })), listing };
  NodeFS.writeFileSync(NodePath.join(root, "state.json"), `${JSON.stringify(state, null, 1)}\n`);

  const exports = [
    `export HOME=${shellQuote(home)}`,
    `export SHELL=${shellQuote(shell)}`,
    `export TMPDIR=${shellQuote(tmp)}`,
    ...Object.entries(values).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
  ];
  NodeFS.writeFileSync(NodePath.join(root, "env.sh"), `${exports.join("\n")}\n`);
  atimeSelfTest(root);
}

/** Fails when this file system does not move the access time on a read. */
function atimeSelfTest(root) {
  const probe = NodePath.join(root, "atime-probe");
  NodeFS.writeFileSync(probe, "probe\n");
  NodeFS.utimesSync(probe, OLD_ATIME, NodeFS.statSync(probe).mtime);
  NodeFS.readFileSync(probe);
  if (NodeFS.statSync(probe).atimeMs <= OLD_ATIME.getTime()) {
    fail(`reads do not move the access time on the file system of ${root} (noatime?); the canary cannot see reads there`);
  }
  NodeFS.rmSync(probe);
}

/** Every entry under `dir`: type, mode, size and SHA-256 (locked files are opened for this). */
function list(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of NodeFS.readdirSync(current, { withFileTypes: true })) {
      const full = NodePath.join(current, entry.name);
      const rel = NodePath.relative(dir, full);
      const stat = NodeFS.lstatSync(full);
      const mode = (stat.mode & 0o7777).toString(8);
      if (entry.isDirectory()) {
        out[rel] = `dir ${mode}`;
        walk(full);
      } else if (entry.isFile()) {
        let content;
        if ((stat.mode & 0o400) === 0) {
          NodeFS.chmodSync(full, 0o600);
          content = NodeFS.readFileSync(full);
          NodeFS.chmodSync(full, stat.mode & 0o7777);
        } else {
          content = NodeFS.readFileSync(full);
        }
        out[rel] = `file ${mode} ${stat.size} ${NodeCrypto.createHash("sha256").update(content).digest("hex")}`;
      } else {
        out[rel] = `other ${mode}`;
      }
    }
  };
  walk(dir);
  return out;
}

/** Scans files under `dir` changed since `seen` recorded them; returns hits. */
function scanTree(dir, token, seen, hits) {
  let entries;
  try {
    entries = NodeFS.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      scanTree(full, token, seen, hits);
      continue;
    }
    if (!entry.isFile()) continue;
    let stat;
    try {
      stat = NodeFS.statSync(full);
    } catch {
      continue;
    }
    const key = `${stat.size}:${stat.mtimeMs}`;
    if (seen.get(full) === key || stat.size > SCAN_LIMIT) continue;
    seen.set(full, key);
    let content;
    try {
      content = NodeFS.readFileSync(full, "latin1");
    } catch {
      continue;
    }
    for (const hit of findMarkers(content, token)) hits.add(`${full}: ${hit}`);
  }
}

/** The marker names in `text` (never the text around them, which may hold other values). */
function findMarkers(text, token) {
  const found = new Set();
  let index = text.indexOf(token);
  while (index !== -1) {
    const start = text.lastIndexOf("canary-", index);
    const name = start !== -1 && index - start < 80 ? text.slice(start, index - 1) : "canary-?";
    found.add(name.replace(/[^\w.-]/g, "?"));
    index = text.indexOf(token, index + token.length);
  }
  return found;
}

async function watch(root) {
  const state = readState(root);
  const seen = new Map();
  const hits = new Set();
  const stop = NodePath.join(root, "stop");
  const out = NodePath.join(root, "watch-hits.txt");
  for (;;) {
    scanTree(state.tmp, state.token, seen, hits);
    NodeFS.writeFileSync(out, [...hits].map((h) => `${h}\n`).join(""));
    if (NodeFS.existsSync(stop)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function verify(root, outputLog, extra) {
  const state = readState(root);
  const problems = [];

  // 1. Reads of decoy files, by access time; before anything here opens them.
  for (const file of state.files) {
    const full = NodePath.join(state.home, file.path);
    let stat;
    try {
      stat = NodeFS.statSync(full);
    } catch {
      problems.push(`decoy file removed: ~/${file.path}`);
      continue;
    }
    if (stat.atimeMs > OLD_ATIME.getTime()) problems.push(`decoy file read: ~/${file.path} (${file.kind})`);
  }

  // 2. The git credential tripwire.
  const tripwire = NodePath.join(root, "tripwire.log");
  if (NodeFS.existsSync(tripwire)) {
    for (const line of NodeFS.readFileSync(tripwire, "utf8").split("\n").filter(Boolean)) problems.push(line);
  }

  // 3. The decoy home is unchanged.
  const after = list(state.home);
  for (const [path, entry] of Object.entries(after)) {
    if (!(path in state.listing)) problems.push(`decoy home: new ${entry.split(" ")[0]} ~/${path}`);
    else if (state.listing[path] !== entry) problems.push(`decoy home: changed ~/${path} (${state.listing[path]} -> ${entry})`);
  }
  for (const path of Object.keys(state.listing)) {
    if (!(path in after)) problems.push(`decoy home: removed ~/${path}`);
  }

  // 4. Markers in the output, and the decoy home's path (an open of a locked file names it).
  let output = "";
  try {
    output = NodeFS.readFileSync(outputLog, "latin1");
  } catch (error) {
    problems.push(`no output log ${outputLog}: ${error.message}`);
  }
  for (const hit of findMarkers(output, state.token)) problems.push(`marker in the checks' output: ${hit}`);

  // 5. Markers in files the checks wrote: the watcher's hits, then what is left now.
  const hits = new Set();
  const watched = NodePath.join(root, "watch-hits.txt");
  if (NodeFS.existsSync(watched)) {
    for (const line of NodeFS.readFileSync(watched, "utf8").split("\n").filter(Boolean)) hits.add(line);
  }
  const seen = new Map();
  for (const dir of [state.tmp, ...extra]) scanTree(dir, state.token, seen, hits);
  for (const hit of hits) problems.push(`marker in a written file: ${hit}`);

  // 6. The static lint.
  problems.push(...lint());

  if (problems.length > 0) {
    console.error(`canary: ${problems.length} finding(s)`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(
    `canary: ${state.files.length} decoy files unread, the decoy home unchanged, ` +
      `${MARKER_VARIABLES.length} marker variables in no output or written file, lint clean`,
  );
}

/** Files the lint reads: every tool script, every Rust source, the SDK host. */
function lintFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (["node_modules", "target", ".git", "generated"].includes(entry.name)) continue;
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(rs|mjs|js|cjs|ts|sh)$/.test(entry.name) || /^(run|stub-claude|conn-checkout|bump-conn)/.test(entry.name)) out.push(full);
    }
  };
  for (const dir of ["tools", "crates", "helpers", "fixtures/recorder"]) walk(NodePath.join(repo, dir));
  return out;
}

const LINT_RULES = [
  { re: /userInfo\(\)\s*\.homedir/, why: "a passwd home lookup (os.userInfo().homedir ignores HOME)" },
  { re: /\bgetpw(uid|nam)(_r)?\b/, why: "a passwd home lookup (getpwuid ignores HOME)" },
  { re: /\b(dirs|home|dirs_next|directories)::\w*home_dir\b|\benv::home_dir\b/, why: "a home lookup that falls back to passwd when HOME is unset" },
  { re: /\benv -i\b(?![^\n]*HOME=)(?![^\n]*"\$\{base_env)/, why: "env -i without HOME=: the child falls back to a passwd lookup and finds the real home" },
  { re: /\bHOME:\s*(NodeOS|os|OS)\.homedir\(\)/, why: "passes the shell's home on to a process a check starts" },
];

function lint() {
  const problems = [];
  const self = fileURLToPath(import.meta.url);
  for (const file of lintFiles()) {
    if (file === self) continue;
    const lines = NodeFS.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|#|\*)/.test(line) || line.includes("canary: allow")) return;
      for (const rule of LINT_RULES) {
        if (rule.re.test(line)) problems.push(`lint: ${NodePath.relative(repo, file)}:${index + 1}: ${rule.why}`);
      }
    });
  }
  return problems;
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "setup":
    if (!rest[0]) fail("usage: setup <root>");
    setup(NodePath.resolve(rest[0]));
    break;
  case "watch":
    if (!rest[0]) fail("usage: watch <root>");
    await watch(NodePath.resolve(rest[0]));
    break;
  case "verify":
    if (!rest[0] || !rest[1]) fail("usage: verify <root> <output log> [folders]");
    verify(NodePath.resolve(rest[0]), rest[1], rest.slice(2));
    break;
  case "lint": {
    const problems = lint();
    for (const problem of problems) console.error(problem);
    process.exit(problems.length > 0 ? 1 : 0);
  }
  default:
    fail("usage: canary.mjs setup|watch|verify|lint ...");
}
