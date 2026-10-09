#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Host-side dev lab that spawns isolated servers and fake CLIs with Node APIs directly.
/**
 * Update lab: several isolated T3 servers ("machines") with fake provider
 * CLIs, a fake npm registry and a fake t3 release feed, for exercising
 * provider, server and launcher update flows end to end. State lives in the
 * gitignored `<repo>/.t3/update-lab`. Fake CLIs and package managers re-enter
 * this file as `__tool`, and the registry/feed server as `__feed`, so the lab
 * stays one file. Run `node scripts/update-lab.ts --help`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const REPO = NodePath.resolve(import.meta.dirname, "..");
const LAB = NodePath.join(REPO, ".t3", "update-lab");
const STATE_PATH = NodePath.join(LAB, "state.json");
const RELEASES = NodePath.join(LAB, "releases");
const SERVER_BIN = NodePath.join(REPO, "apps/server/src/bin.ts");
const MOCK_ACP_AGENT = NodePath.join(REPO, "apps/server/scripts/acp-mock-agent.ts");
const NODE = process.execPath;
const SELF = import.meta.filename;
const REPO_VERSION: string = JSON.parse(
  NodeFS.readFileSync(NodePath.join(REPO, "apps/server/package.json"), "utf8"),
).version;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Plain Node dev script; the lab only targets this host.
const PLATFORM_KEY = `${process.platform}-${process.arch}`;
const ORCHESTRATION_PROTOCOL = "2";

const HELP = `Usage: node scripts/update-lab.ts <command>

Isolated T3 servers with fake provider CLIs, a fake npm registry and a fake
t3 release feed, all under .t3/update-lab (state survives down/up).

  up [--envs N] [--host IP] [--launcher N] [--from-version V] [--busy-seconds S]
      Start the feed and N servers (default 3; host 127.0.0.1). The last N
      envs (default 1) run under the real service launcher on runtime V
      (default: repo version minus one patch) so self-update can be tried.
      Prints each env's origin and one-time pairing URL. Rerun to resume.
  down                          Stop only the processes the lab recorded.
  status                        Envs, ports, liveness, installed vs latest.
  pair <env>                    Mint a fresh pairing URL for env (e.g. env1).
  publish <provider> <version>  Set the registry's latest for a provider.
  fail <env> <provider> on|off  Make that env's installer/updater exit 1.
  delay <ms>                    Installer/updater duration (default 3000).
  providers <env>               Print the provider list clients see for env.
  update <env> <instance> [v]   Run server.updateProvider like the UI does.
  busy <env>                    Start a mock-acp turn that runs --busy-seconds.
  self-update <env> <version>   Run server.updateServer (launcher envs only).
  build-runtime <version> [--archive file]
      Publish a t3 runtime to the release feed: a source runtime (copy of
      apps/server stamped with <version>, runs on this checkout's deps) or
      a real CLI archive built by the release pipeline.
  reset                         Delete the lab (only after down).

Providers: codex claude opencode pi grok. Install methods rotate across envs:
npm prefix, pnpm, bun, yarn, volta, vite-plus, Homebrew formula and cask,
native installers (claude update, codex standalone, opencode upgrade,
grok update, pi update --self) and mise (manual-only). Each env also has a
"mock-acp" provider (apps/server/scripts/acp-mock-agent.ts) for busy turns.
Servers cache npm "latest" for an hour: down && up after publish.
Not covered: cursor, antigravity, muse (no npm advisory or network-only).`;

type ProviderKey = "codex" | "claude" | "opencode" | "pi" | "grok";
type Method =
  | "npm"
  | "pnpm"
  | "bun"
  | "yarn"
  | "volta"
  | "vite-plus"
  | "homebrew"
  | "native"
  | "mise";

const PROVIDERS: Record<
  ProviderKey,
  {
    readonly command: string;
    readonly pkg: string;
    readonly driver: string;
    readonly installed: string;
    readonly latest: string;
    readonly brew: { readonly kind: "formula" | "cask"; readonly name: string } | null;
  }
> = {
  codex: {
    command: "codex",
    pkg: "@openai/codex",
    driver: "codex",
    installed: "0.158.0",
    latest: "0.160.0",
    brew: { kind: "formula", name: "codex" },
  },
  claude: {
    command: "claude",
    pkg: "@anthropic-ai/claude-code",
    driver: "claudeAgent",
    installed: "2.1.285",
    latest: "2.1.290",
    brew: { kind: "cask", name: "claude-code" },
  },
  opencode: {
    command: "opencode",
    pkg: "opencode-ai",
    driver: "opencode",
    installed: "1.14.19",
    latest: "1.14.25",
    brew: { kind: "formula", name: "opencode" },
  },
  pi: {
    command: "pi",
    pkg: "@earendil-works/pi-coding-agent",
    driver: "pi",
    installed: "0.80.6",
    latest: "0.81.0",
    brew: null,
  },
  grok: {
    command: "grok",
    pkg: "@xai-official/grok",
    driver: "grok",
    installed: "1.0.13",
    latest: "1.0.20",
    brew: null,
  },
};
const PROVIDER_KEYS = Object.keys(PROVIDERS) as ProviderKey[];

// Env N uses row (N-1) % rows; three envs already reach every resolver branch.
const INSTALL_MATRIX: ReadonlyArray<Record<ProviderKey, Method>> = [
  { codex: "npm", claude: "native", opencode: "homebrew", pi: "pnpm", grok: "native" },
  { codex: "native", claude: "homebrew", opencode: "bun", pi: "native", grok: "npm" },
  { codex: "volta", claude: "yarn", opencode: "native", pi: "vite-plus", grok: "bun" },
  { codex: "mise", claude: "pnpm", opencode: "npm", pi: "yarn", grok: "native" },
  { codex: "vite-plus", claude: "bun", opencode: "volta", pi: "npm", grok: "pnpm" },
];

// The package manager each fake tool stands in for.
const TOOL_METHOD: Record<string, Method> = {
  npm: "npm",
  pnpm: "pnpm",
  bun: "bun",
  yarn: "yarn",
  volta: "volta",
  vp: "vite-plus",
  brew: "homebrew",
};

interface Install {
  method: Method;
  version: string;
  failing: boolean;
}

interface LabEnv {
  id: string;
  port: number;
  pid: number | null;
  launcher: boolean;
  projectId: string | null;
  installs: Record<ProviderKey, Install>;
}

interface LabState {
  host: string;
  feedPort: number;
  feedPid: number | null;
  delayMs: number;
  busySeconds: number;
  fromVersion: string;
  latest: Record<ProviderKey, string>;
  envs: LabEnv[];
}

// ---------------------------------------------------------------------------
// State

function readState(): LabState | null {
  if (!NodeFS.existsSync(STATE_PATH)) return null;
  return JSON.parse(NodeFS.readFileSync(STATE_PATH, "utf8"));
}

function requireState(): LabState {
  const state = readState();
  if (!state) fail("No lab yet. Run `node scripts/update-lab.ts up` first.");
  return state;
}

/** Keep the descriptor open so the kernel releases the lock even if this process dies. */
function acquireLock(name: "state" | "processes"): () => void {
  NodeFS.mkdirSync(NodePath.dirname(LAB), { recursive: true });
  // Keep lock files outside LAB so reset cannot unlink a lock another process holds.
  const fd = NodeFS.openSync(`${LAB}.${name}.lock`, "a");
  try {
    NodeChildProcess.execFileSync("flock", ["-x", "3"], {
      stdio: ["ignore", "ignore", "inherit", fd],
    });
  } catch (error) {
    NodeFS.closeSync(fd);
    throw error;
  }
  return () => NodeFS.closeSync(fd);
}

/** Atomic replacement keeps readers from observing a partially written state. */
function writeState(state: LabState): void {
  const temp = `${STATE_PATH}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  NodeFS.renameSync(temp, STATE_PATH);
}

function updateState(mutate: (state: LabState) => void, initial?: LabState): LabState {
  const release = acquireLock("state");
  try {
    const state = readState() ?? initial ?? requireState();
    mutate(state);
    NodeFS.mkdirSync(LAB, { recursive: true });
    writeState(state);
    return state;
  } finally {
    release();
  }
}

function requireEnv(state: LabState, id: string | undefined): LabEnv {
  const env = state.envs.find((candidate) => candidate.id === id);
  if (!env) fail(`Unknown env ${id ?? "(none)"}. Envs: ${state.envs.map((e) => e.id).join(", ")}`);
  return env;
}

function requireProvider(name: string | undefined): ProviderKey {
  if (name && name in PROVIDERS) return name as ProviderKey;
  fail(`Unknown provider ${name ?? "(none)"}. Providers: ${PROVIDER_KEYS.join(", ")}`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const envDir = (id: string) => NodePath.join(LAB, "envs", id);
const homeDir = (id: string) => NodePath.join(envDir(id), "home");
const t3Home = (id: string) => NodePath.join(envDir(id), "t3");
const projectDir = (id: string) => NodePath.join(envDir(id), "project");
const logPath = (id: string) => NodePath.join(envDir(id), "server.log");
const originOf = (state: LabState, env: LabEnv) => `http://${state.host}:${env.port}`;

// ---------------------------------------------------------------------------
// Fake installs

function writeExecutable(path: string, content: string): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content, { mode: 0o755 });
}

function link(target: string, path: string): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.rmSync(path, { force: true });
  NodeFS.symlinkSync(target, path);
}

/** A shell shim that re-enters this file as a fake tool; `$0` names a shared volta shim. */
function toolShim(envId: string, tool: string | null): string {
  const name = tool === null ? `"$(basename "$0")"` : `'${tool}'`;
  return `#!/bin/sh\nexec '${NODE}' '${SELF}' __tool '${envId}' ${name} "$@"\n`;
}

/** Search order shared by the server's PATH and the fake login shell profile. */
function envPath(envId: string): string {
  const home = homeDir(envId);
  return [
    ".local/bin",
    ".npm-global/bin",
    ".local/share/pnpm",
    ".bun/bin",
    ".yarn/bin",
    ".volta/bin",
    ".vite-plus/bin",
    "homebrew/bin",
    ".opencode/bin",
    ".grok/bin",
    ".pi/bin",
    ".local/share/mise/shims",
  ]
    .map((dir) => NodePath.join(home, dir))
    .concat([NodePath.join(envDir(envId), "tools"), "/usr/local/bin", "/usr/bin", "/bin"])
    .join(":");
}

/** Lay a provider out the way its installer would, so the server's resolver sees real paths. */
function layOutInstall(envId: string, provider: ProviderKey, method: Method): void {
  const home = homeDir(envId);
  const { command, pkg, brew } = PROVIDERS[provider];
  const shim = toolShim(envId, command);
  const at = (...parts: string[]) => NodePath.join(home, ...parts);
  switch (method) {
    case "npm": {
      const real = at(".npm-global/lib/node_modules", pkg, "bin", `${command}.js`);
      writeExecutable(real, shim);
      link(real, at(".npm-global/bin", command));
      return;
    }
    case "yarn": {
      const real = at(".config/yarn/global/node_modules", pkg, "bin", `${command}.js`);
      writeExecutable(real, shim);
      link(real, at(".yarn/bin", command));
      return;
    }
    case "pnpm":
      return writeExecutable(at(".local/share/pnpm", command), shim);
    case "bun":
      return writeExecutable(at(".bun/bin", command), shim);
    case "vite-plus":
      return writeExecutable(at(".vite-plus/bin", command), shim);
    case "volta":
      writeExecutable(at(".volta/bin/volta-shim"), toolShim(envId, null));
      writeExecutable(at(".volta/bin/volta"), toolShim(envId, "volta"));
      NodeFS.mkdirSync(at(".volta/tools/image/packages", ...pkg.split("/")), { recursive: true });
      link(at(".volta/bin/volta-shim"), at(".volta/bin", command));
      return;
    case "homebrew": {
      if (!brew) fail(`${provider} has no Homebrew package.`);
      const keg =
        brew.kind === "formula"
          ? at("homebrew/Cellar", brew.name, PROVIDERS[provider].installed, "bin", command)
          : at("homebrew/Caskroom", brew.name, PROVIDERS[provider].installed, command);
      writeExecutable(keg, shim);
      link(keg, at("homebrew/bin", command));
      writeExecutable(at("homebrew/bin/brew"), toolShim(envId, "brew"));
      return;
    }
    case "mise": {
      const real = at(".local/share/mise/installs", command, "latest", "bin", command);
      writeExecutable(real, shim);
      link(real, at(".local/share/mise/shims", command));
      return;
    }
    case "native":
      switch (provider) {
        case "claude":
          return writeExecutable(at(".local/bin/claude"), shim);
        case "codex": {
          const real = at(".codex/packages/standalone/current/bin/codex");
          writeExecutable(real, shim);
          link(real, at(".local/bin/codex"));
          return;
        }
        case "opencode":
          return writeExecutable(at(".opencode/bin/opencode"), shim);
        case "grok":
          return writeExecutable(at(".grok/bin/grok"), shim);
        case "pi":
          return writeExecutable(at(".pi/bin/pi"), shim);
      }
  }
}

function seedEnvFiles(state: LabState, env: LabEnv): void {
  const home = homeDir(env.id);
  NodeFS.mkdirSync(home, { recursive: true });
  // The server reads PATH from a login shell first; these dotfiles keep it on the lab PATH.
  const profile = `export PATH='${envPath(env.id)}'\n`;
  for (const file of [".bash_profile", ".bashrc", ".profile", ".zprofile", ".zshrc"]) {
    NodeFS.writeFileSync(NodePath.join(home, file), profile);
  }
  const tools = NodePath.join(envDir(env.id), "tools");
  for (const tool of ["npm", "pnpm", "bun", "yarn", "vp"]) {
    writeExecutable(NodePath.join(tools, tool), toolShim(env.id, tool));
  }
  link(NODE, NodePath.join(tools, "node"));
  for (const provider of PROVIDER_KEYS) {
    layOutInstall(env.id, provider, env.installs[provider].method);
  }

  const project = projectDir(env.id);
  if (!NodeFS.existsSync(NodePath.join(project, ".git"))) {
    NodeFS.mkdirSync(project, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(project, "README.md"), `# ${env.id} lab project\n`);
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", ["-C", project, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Update Lab", "-c", "user.email=lab@localhost", "commit", "-qm", "init");
  }

  const settingsPath = NodePath.join(t3Home(env.id), "userdata", "settings.json");
  NodeFS.mkdirSync(NodePath.dirname(settingsPath), { recursive: true });
  const settings = NodeFS.existsSync(settingsPath)
    ? JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"))
    : {};
  settings.providerInstances = {
    ...settings.providerInstances,
    opencode: { driver: "opencode", enabled: true },
    pi: { driver: "pi", enabled: true },
    grok: { driver: "grok", enabled: true },
    "mock-acp": {
      driver: "acpRegistry",
      displayName: "Mock ACP",
      enabled: true,
      environment: [
        { name: "T3_ACP_PROMPT_DELAY_MS", value: String(state.busySeconds * 1000) },
        { name: "T3_ACP_PROMPT_RESPONSE_TEXT", value: `${env.id} finished its busy turn.` },
      ],
      config: { source: "local", commandPath: NODE, commandArgs: [MOCK_ACP_AGENT] },
    },
  };
  settings.defaultModelSelection ??= { instanceId: "mock-acp", model: "default" };
  NodeFS.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Fake CLIs and package managers (`__tool <env> <tool> ...args`)

async function runTool(envId: string, tool: string, args: string[]): Promise<void> {
  const state = requireState();
  const env = requireEnv(state, envId);
  const provider = PROVIDER_KEYS.find((key) => PROVIDERS[key].command === tool);
  if (provider) return runProviderCli(state, env, provider, args);
  const method = TOOL_METHOD[tool];
  if (!method) fail(`update-lab: unknown fake tool ${tool}`);
  if (args[0] === "--version" || args[0] === "-v") return void console.log("0.0.0-update-lab");

  if (tool === "brew") {
    const prefix = NodePath.join(homeDir(env.id), "homebrew");
    if (args[0] === "--prefix") return void console.log(prefix);
    const name = args.findLast((arg) => !arg.startsWith("-"));
    const owner = PROVIDER_KEYS.find((key) => PROVIDERS[key].brew?.name === name);
    if (!owner) fail(`Error: No available formula or cask with the name "${name}".`);
    if (args[0] === "info") {
      const latest = state.latest[owner];
      return void console.log(
        JSON.stringify(
          PROVIDERS[owner].brew!.kind === "formula"
            ? { formulae: [{ versions: { stable: latest } }], casks: [] }
            : { formulae: [], casks: [{ version: `${latest},lab` }] },
        ),
      );
    }
    if (args[0] === "upgrade") return install(env.id, owner, tool, undefined);
    fail(`update-lab brew: unsupported ${args.join(" ")}`);
  }

  // npm/pnpm/bun/yarn/volta/vp install commands name `<pkg>`, `<pkg>@latest` or `<pkg>@x.y.z`.
  for (const arg of args) {
    for (const key of PROVIDER_KEYS) {
      const { pkg } = PROVIDERS[key];
      if (arg !== pkg && !arg.startsWith(`${pkg}@`)) continue;
      const requested = arg.slice(pkg.length + 1);
      if (method === "npm") {
        const prefix = args[args.indexOf("--prefix") + 1];
        if (
          env.installs[key].method !== "npm" ||
          prefix !== NodePath.join(homeDir(env.id), ".npm-global")
        ) {
          fail(`npm error ${pkg} is not installed under --prefix ${prefix ?? "(default)"}`);
        }
      }
      return install(
        env.id,
        key,
        tool,
        requested && requested !== "latest" ? requested : undefined,
      );
    }
  }
  fail(`update-lab ${tool}: unsupported ${args.join(" ")}`);
}

async function runProviderCli(
  state: LabState,
  env: LabEnv,
  provider: ProviderKey,
  args: string[],
): Promise<void> {
  const version = env.installs[provider].version;
  const [first, second] = args;
  if (first === "--version" || first === "-v") {
    const banner = {
      codex: `codex-cli ${version}`,
      claude: `${version} (Claude Code)`,
      opencode: version,
      pi: version,
      grok: `grok ${version}`,
    }[provider];
    return void console.log(banner);
  }
  const native =
    (provider === "claude" && first === "update") ||
    (provider === "codex" && first === "update") ||
    (provider === "opencode" && first === "upgrade") ||
    (provider === "grok" && first === "update") ||
    (provider === "pi" && first === "update" && second === "--self");
  if (native) return install(env.id, provider, PROVIDERS[provider].command, undefined);
  if (provider === "grok" && first === "models") return void console.log("You are logged in");
  if (provider === "codex" && first === "app-server") return codexAppServer(env, version);
  // Session probes (claude stream-json, opencode serve, pi --mode rpc) are out of
  // scope: a quiet failure keeps installed + version, so advisories still show.
  process.stderr.write(`update-lab fake ${provider}: ${args.join(" ")} is not simulated\n`);
  process.exit(1);
}

/** Just enough of `codex app-server` for the status probe to read the version. */
async function codexAppServer(env: LabEnv, version: string): Promise<void> {
  const codexHome = process.env.CODEX_HOME || NodePath.join(homeDir(env.id), ".codex");
  const results: Record<string, unknown> = {
    initialize: {
      codexHome,
      platformFamily: "unix",
      platformOs: "linux",
      userAgent: `codex_cli_rs/${version}`,
    },
    "account/read": { account: null, requiresOpenaiAuth: false },
    "skills/list": { data: [] },
    "model/list": { data: [] },
  };
  const lines = NodeReadline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    let message: { id?: unknown; method?: string };
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined || message.method === undefined) continue;
    const result = results[message.method];
    process.stdout.write(
      `${JSON.stringify(
        result === undefined
          ? { id: message.id, error: { code: -32601, message: `${message.method} not simulated` } }
          : { id: message.id, result },
      )}\n`,
    );
  }
}

/** Shared install path: progress output for `delayMs`, injected failure, then the new version. */
async function install(
  envId: string,
  provider: ProviderKey,
  tool: string,
  requested: string | undefined,
): Promise<void> {
  const state = requireState();
  const env = requireEnv(state, envId);
  const current = env.installs[provider];
  const method = TOOL_METHOD[tool];
  if (method && method !== current.method) {
    fail(`${tool}: ${PROVIDERS[provider].pkg} is not managed by ${tool} here (${current.method}).`);
  }
  const target = requested ?? state.latest[provider];
  const steps = 5;
  for (let step = 1; step <= steps; step++) {
    console.log(`${tool}: fetching ${PROVIDERS[provider].pkg}@${target} [${step}/${steps}]`);
    await new Promise((resolve) => setTimeout(resolve, state.delayMs / steps));
  }
  if (requireState().envs.find((e) => e.id === envId)!.installs[provider].failing) {
    process.stderr.write(`${tool}: injected failure installing ${PROVIDERS[provider].pkg}\n`);
    process.exit(1);
  }
  updateState((next) => {
    requireEnv(next, envId).installs[provider].version = target;
  });
  console.log(`${tool}: installed ${PROVIDERS[provider].pkg}@${target} (was ${current.version})`);
}

// ---------------------------------------------------------------------------
// Fake npm registry + t3 release feed (`__feed <port>`)

function runFeed(port: number): void {
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://lab");
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const state = readState();
    if (!state) return send(503, { error: "no lab state" });

    // GET /npm/<pkg>/latest and /npm/<pkg>; the server URI-encodes scoped names.
    const npm = /^\/npm\/(.+?)(\/latest)?$/.exec(url.pathname);
    if (npm) {
      const name = decodeURIComponent(npm[1]!);
      const key = PROVIDER_KEYS.find((candidate) => PROVIDERS[candidate].pkg === name);
      if (!key) return send(404, { error: "Not found" });
      const version = state.latest[key];
      return npm[2]
        ? send(200, { name, version })
        : send(200, {
            name,
            "dist-tags": { latest: version },
            versions: { [version]: { name, version } },
          });
    }

    // GET /releases/index.json?page=N: GitHub's list-releases shape, newest first.
    if (url.pathname === "/releases/index.json") {
      const page = Number(url.searchParams.get("page") ?? "1");
      return send(
        200,
        page === 1 ? publishedRuntimes().map((v) => ({ tag_name: `v${v}`, draft: false })) : [],
      );
    }

    // GET /releases/v<version>/<file>: SHA256SUMS and archives.
    const asset = /^\/releases\/(v[^/]+)\/([^/]+)$/.exec(url.pathname);
    if (asset) {
      const file = NodePath.join(RELEASES, asset[1]!, asset[2]!);
      if (!NodeFS.existsSync(file)) return send(404, { error: "Not found" });
      response.writeHead(200, { "content-length": NodeFS.statSync(file).size });
      return void NodeFS.createReadStream(file).pipe(response);
    }
    send(404, { error: "Not found" });
  });
  server.listen(port, "127.0.0.1");
}

function publishedRuntimes(): string[] {
  if (!NodeFS.existsSync(RELEASES)) return [];
  return NodeFS.readdirSync(RELEASES)
    .filter((dir) => NodeFS.existsSync(NodePath.join(RELEASES, dir, "SHA256SUMS")))
    .map((dir) => dir.slice(1))
    .sort((a, b) => compareVersions(b, a));
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(/[.-]/).map((part) => Number(part) || 0);
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Runtimes for the release feed and the service launcher

/**
 * Publish `t3-<version>-<platform>.tar.gz` + SHA256SUMS. Without `--archive`
 * this is a source runtime: a copy of apps/server whose package.json carries
 * `version` (every version check reads it) and whose node_modules links back
 * to this checkout, started by a `t3` wrapper.
 */
function buildRuntime(version: string, archive: string | undefined): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    fail(`Not an exact version: ${version}`);
  const releaseDir = NodePath.join(RELEASES, `v${version}`);
  const fileName = `t3-${version}-${PLATFORM_KEY}.tar.gz`;
  const archivePath = NodePath.join(releaseDir, fileName);
  NodeFS.mkdirSync(releaseDir, { recursive: true });
  if (archive) {
    NodeFS.copyFileSync(NodePath.resolve(archive), archivePath);
  } else {
    const stage = NodePath.join(LAB, "build", `t3-${version}-${PLATFORM_KEY}`);
    NodeFS.rmSync(stage, { recursive: true, force: true });
    const serverSource = NodePath.join(REPO, "apps/server");
    NodeFS.cpSync(serverSource, NodePath.join(stage, "server"), {
      recursive: true,
      filter: (source) =>
        !["node_modules", "dist", "dist-exe"].includes(NodePath.relative(serverSource, source)),
    });
    const packageJsonPath = NodePath.join(stage, "server/package.json");
    const packageJson = JSON.parse(NodeFS.readFileSync(packageJsonPath, "utf8"));
    packageJson.version = version;
    NodeFS.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    NodeFS.symlinkSync(
      NodePath.join(serverSource, "node_modules"),
      NodePath.join(stage, "server/node_modules"),
    );
    writeExecutable(
      NodePath.join(stage, "t3"),
      `#!/bin/sh\nexec '${NODE}' "$(dirname "$0")/server/src/bin.ts" "$@"\n`,
    );
    NodeChildProcess.execFileSync("tar", [
      "-czf",
      archivePath,
      "-C",
      NodePath.dirname(stage),
      NodePath.basename(stage),
    ]);
    NodeFS.rmSync(stage, { recursive: true, force: true });
  }
  const digest = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(archivePath))
    .digest("hex");
  NodeFS.writeFileSync(NodePath.join(releaseDir, "SHA256SUMS"), `${digest}  ${fileName}\n`);
  return archivePath;
}

/** Install a published runtime the way pinnedRuntime does, and make it the launcher's active version. */
function installLauncherRuntime(envId: string, version: string): void {
  const runtimeDir = NodePath.join(t3Home(envId), "runtime");
  const versionDir = NodePath.join(runtimeDir, "versions", version);
  if (!NodeFS.existsSync(NodePath.join(versionDir, ".install-complete"))) {
    const archive = NodePath.join(RELEASES, `v${version}`, `t3-${version}-${PLATFORM_KEY}.tar.gz`);
    if (!NodeFS.existsSync(archive)) buildRuntime(version, undefined);
    NodeFS.mkdirSync(versionDir, { recursive: true });
    NodeChildProcess.execFileSync("tar", [
      "-xzf",
      archive,
      "-C",
      versionDir,
      "--strip-components=1",
    ]);
    NodeFS.writeFileSync(NodePath.join(versionDir, ".install-complete"), `${version}\n`);
  }
  const statePath = NodePath.join(runtimeDir, "service-state.json");
  if (!NodeFS.existsSync(statePath)) {
    NodeFS.writeFileSync(statePath, `${JSON.stringify({ protocol: 3, activeVersion: version })}\n`);
  }
}

// ---------------------------------------------------------------------------
// Processes

function listeningPorts(): Set<number> {
  const output = NodeChildProcess.execFileSync("ss", ["-H", "-ltn"], { encoding: "utf8" });
  return new Set(
    output
      .split("\n")
      .map((line) => Number(line.trim().split(/\s+/)[3]?.split(":").pop()))
      .filter((port) => Number.isInteger(port) && port > 0),
  );
}

/** An OS-assigned port that `ss` does not already list and nobody else in the lab holds. */
async function freePort(host: string, taken: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = NodeNet.createServer();
      probe.once("error", reject);
      probe.listen(0, host, () => {
        const address = probe.address();
        probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
    });
    if (port > 0 && !taken.has(port) && !listeningPorts().has(port)) {
      taken.add(port);
      return port;
    }
  }
  fail("Could not find a free port.");
}

/** Check the recorded process's command and working directory before signaling it. */
function isLabProcess(pid: number | null, marker: string, cwd = REPO): pid is number {
  if (!pid) return false;
  try {
    const args = NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return (
      args.includes(marker) &&
      args.includes(marker === "__feed" ? SELF : SERVER_BIN) &&
      NodeFS.realpathSync(`/proc/${pid}/cwd`) === NodeFS.realpathSync(cwd)
    );
  } catch {
    return false;
  }
}

const serverMarker = (env: LabEnv) => (env.launcher ? "__service-launcher" : t3Home(env.id));

/** The runtime the service launcher runs now, which moves after a self-update. */
function launcherLabel(env: LabEnv): string {
  if (!env.launcher) return "";
  const statePath = NodePath.join(t3Home(env.id), "runtime", "service-state.json");
  const active = NodeFS.existsSync(statePath)
    ? JSON.parse(NodeFS.readFileSync(statePath, "utf8")).activeVersion
    : "?";
  return ` launcher@${active}`;
}

/** The minimal environment a lab server sees; nothing from this shell leaks in. */
function serverEnvironment(state: LabState, env: LabEnv): NodeJS.ProcessEnv {
  const home = homeDir(env.id);
  const keep = ["LANG", "LC_ALL", "TZ", "USER", "LOGNAME", "TMPDIR"];
  return {
    ...Object.fromEntries(
      keep.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
    ),
    HOME: home,
    PATH: envPath(env.id),
    SHELL: "/bin/bash",
    XDG_CONFIG_HOME: NodePath.join(home, ".config"),
    XDG_DATA_HOME: NodePath.join(home, ".local/share"),
    XDG_CACHE_HOME: NodePath.join(home, ".cache"),
    XDG_STATE_HOME: NodePath.join(home, ".local/state"),
    npm_config_registry: `http://127.0.0.1:${state.feedPort}/npm`,
    T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${state.feedPort}/releases`,
    T3CODE_UPDATE_LAB: "1",
    T3CODE_NO_BROWSER: "1",
  };
}

function spawnDetached(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; log: string },
): number {
  const fd = NodeFS.openSync(options.log, "a");
  const child = NodeChildProcess.spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  NodeFS.closeSync(fd);
  child.unref();
  if (!child.pid) fail(`Failed to start ${command} ${args.join(" ")}`);
  return child.pid;
}

function startServer(state: LabState, env: LabEnv): number {
  NodeFS.writeFileSync(logPath(env.id), "");
  const environment = serverEnvironment(state, env);
  if (env.launcher) {
    installLauncherRuntime(env.id, state.fromVersion);
    // The launcher runs `<runtime>/t3 serve` and passes its environment through.
    return spawnDetached(NODE, [SERVER_BIN, "__service-launcher"], {
      env: {
        ...environment,
        T3CODE_HOME: t3Home(env.id),
        T3CODE_PORT: String(env.port),
        T3CODE_HOST: state.host,
      },
      cwd: projectDir(env.id),
      log: logPath(env.id),
    });
  }
  return spawnDetached(
    NODE,
    [
      SERVER_BIN,
      "serve",
      "--base-dir",
      t3Home(env.id),
      "--port",
      String(env.port),
      "--host",
      state.host,
      projectDir(env.id),
    ],
    { env: environment, cwd: projectDir(env.id), log: logPath(env.id) },
  );
}

async function waitForPairingUrl(env: LabEnv): Promise<string> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const log = NodeFS.readFileSync(logPath(env.id), "utf8");
    const url = /Pairing URL: (\S+)/.exec(log)?.[1];
    if (url) return url;
    if (!isLabProcess(env.pid, serverMarker(env), projectDir(env.id))) {
      fail(`${env.id} exited during startup; see ${logPath(env.id)}\n${log.slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`${env.id} did not print a pairing URL within 120s; see ${logPath(env.id)}`);
}

/** SIGTERM the process group we created, then SIGKILL it if it lingers. */
async function stopGroup(pid: number, marker: string, cwd = REPO): Promise<void> {
  if (!isLabProcess(pid, marker, cwd)) return;
  process.kill(-pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && isLabProcess(pid, marker, cwd)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}

// ---------------------------------------------------------------------------
// Talking to a lab server like a client does

async function sessionToken(env: LabEnv): Promise<string> {
  const tokenPath = NodePath.join(envDir(env.id), "session-token");
  if (NodeFS.existsSync(tokenPath)) return NodeFS.readFileSync(tokenPath, "utf8").trim();
  const token = NodeChildProcess.execFileSync(
    NODE,
    [
      SERVER_BIN,
      "auth",
      "session",
      "issue",
      "--base-dir",
      t3Home(env.id),
      "--label",
      "update-lab",
      "--token-only",
    ],
    { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH, HOME: homeDir(env.id) } },
  ).trim();
  NodeFS.writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

async function authHeaders(env: LabEnv): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await sessionToken(env)}`,
    "Content-Type": "application/json",
    "x-t3-orchestration-protocol": ORCHESTRATION_PROTOCOL,
  };
}

/** One unary call over the server's Effect RPC WebSocket protocol (JSON frames). */
async function rpc(state: LabState, env: LabEnv, tag: string, payload: unknown): Promise<any> {
  const origin = originOf(state, env);
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: await authHeaders(env),
  });
  if (!ticketResponse.ok) fail(`${env.id}: websocket ticket failed (${ticketResponse.status})`);
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  const socket = new WebSocket(
    `${origin.replace("http", "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL}&wsTicket=${encodeURIComponent(ticket)}`,
  );
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${tag} timed out`)), 10 * 60_000);
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      socket.close();
      settle();
    };
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
    );
    socket.addEventListener("error", () => finish(() => reject(new Error(`${tag}: socket error`))));
    socket.addEventListener("message", (event) => {
      const decoded = JSON.parse(String(event.data));
      for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
        if (message._tag !== "Exit" || message.requestId !== "1") continue;
        const exit = message.exit;
        finish(() =>
          exit._tag === "Success"
            ? resolve(exit.value)
            : reject(new Error(`${tag} failed: ${JSON.stringify(exit.cause)}`)),
        );
      }
    });
  });
}

function printProviders(providers: ReadonlyArray<any>): void {
  for (const provider of providers) {
    const advisory = provider.versionAdvisory ?? {};
    const update = provider.updateState ?? null;
    console.log(
      [
        `  ${provider.instanceId.padEnd(10)} ${String(provider.status).padEnd(8)}`,
        `installed=${provider.version ?? "-"} latest=${advisory.latestVersion ?? "-"} advisory=${advisory.status ?? "-"}`,
        `update=${advisory.canUpdate ? JSON.stringify(advisory.updateCommand) : "manual"}`,
        update ? `last=${update.status}: ${update.message ?? ""}` : "",
      ].join("  "),
    );
  }
}

// ---------------------------------------------------------------------------
// Commands

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function up(args: string[]): Promise<void> {
  const previous = readState();
  const host = option(args, "host") ?? previous?.host ?? "127.0.0.1";
  const envCount = Number(option(args, "envs") ?? previous?.envs.length ?? 3);
  const launcherCount = Number(option(args, "launcher") ?? 1);
  const [major, minor, patch] = REPO_VERSION.split(/[.-]/).map(Number);
  const initial: LabState = {
    host,
    feedPort: 0,
    feedPid: null,
    delayMs: 3000,
    busySeconds: 120,
    fromVersion: `${major}.${minor}.${Math.max(0, patch! - 1)}`,
    latest: Object.fromEntries(
      PROVIDER_KEYS.map((key) => [key, PROVIDERS[key].latest]),
    ) as LabState["latest"],
    envs: [],
  };
  let state = updateState((next) => {
    next.host = host;
    next.busySeconds = Number(option(args, "busy-seconds") ?? next.busySeconds);
    next.fromVersion = option(args, "from-version") ?? next.fromVersion;
    for (let index = next.envs.length; index < envCount; index++) {
      const row = INSTALL_MATRIX[index % INSTALL_MATRIX.length]!;
      next.envs.push({
        id: `env${index + 1}`,
        port: 0,
        pid: null,
        launcher: index >= envCount - launcherCount,
        projectId: null,
        installs: Object.fromEntries(
          PROVIDER_KEYS.map((key) => [
            key,
            { method: row[key], version: PROVIDERS[key].installed, failing: false },
          ]),
        ) as LabEnv["installs"],
      });
    }
  }, initial);
  const taken = new Set(state.envs.map((env) => env.port).concat(state.feedPort));

  if (!isLabProcess(state.feedPid, "__feed")) {
    const feedPort =
      state.feedPort > 0 && !listeningPorts().has(state.feedPort)
        ? state.feedPort
        : await freePort("127.0.0.1", taken);
    // Running servers retain the old feed origin in their environment until restarted.
    if (feedPort !== state.feedPort) {
      for (const env of state.envs) {
        if (env.pid) await stopGroup(env.pid, serverMarker(env), projectDir(env.id));
        state = updateState((next) => {
          requireEnv(next, env.id).pid = null;
        });
      }
    }
    const feedPid = spawnDetached(NODE, [SELF, "__feed", String(feedPort)], {
      env: { PATH: process.env.PATH },
      cwd: REPO,
      log: NodePath.join(LAB, "feed.log"),
    });
    state = updateState((next) => {
      next.feedPort = feedPort;
      next.feedPid = feedPid;
    });
  }
  // The feed always offers this checkout's version, the update a launcher env is behind on.
  if (!publishedRuntimes().includes(REPO_VERSION)) buildRuntime(REPO_VERSION, undefined);

  const started: LabEnv[] = [];
  for (const env of state.envs) {
    if (isLabProcess(env.pid, serverMarker(env), projectDir(env.id))) continue;
    seedEnvFiles(state, env);
    const port =
      !env.port || listeningPorts().has(env.port) ? await freePort(host, taken) : env.port;
    const pid = startServer(state, { ...env, port });
    state = updateState((next) => {
      const current = requireEnv(next, env.id);
      current.port = port;
      current.pid = pid;
    });
    started.push(requireEnv(state, env.id));
  }
  console.log(
    `feed      http://127.0.0.1:${state.feedPort} (npm registry /npm, releases /releases)`,
  );
  const urls = await Promise.all(started.map(waitForPairingUrl));
  for (const env of state.envs) {
    const index = started.findIndex((candidate) => candidate.id === env.id);
    console.log(`${env.id.padEnd(9)} ${originOf(state, env)} pid ${env.pid}${launcherLabel(env)}`);
    console.log(`          ${index >= 0 ? urls[index] : "(already running; `pair` mints a URL)"}`);
  }
}

async function down(): Promise<void> {
  const state = readState();
  if (!state) return;
  for (const env of state.envs) {
    if (env.pid) await stopGroup(env.pid, serverMarker(env), projectDir(env.id));
    updateState((next) => {
      requireEnv(next, env.id).pid = null;
    });
  }
  if (state.feedPid) await stopGroup(state.feedPid, "__feed");
  updateState((next) => {
    next.feedPid = null;
  });
  console.log("Lab stopped.");
}

function status(): void {
  const state = requireState();
  const feed = isLabProcess(state.feedPid, "__feed") ? "up" : "down";
  console.log(
    `feed http://127.0.0.1:${state.feedPort} ${feed}; delay ${state.delayMs}ms; runtimes ${publishedRuntimes().join(", ") || "-"}`,
  );
  for (const env of state.envs) {
    const alive = isLabProcess(env.pid, serverMarker(env), projectDir(env.id));
    console.log(
      `${env.id} ${originOf(state, env)} pid ${env.pid ?? "-"} ${alive ? "up" : "down"}${launcherLabel(env)}`,
    );
    for (const key of PROVIDER_KEYS) {
      const install = env.installs[key];
      const behind = compareVersions(install.version, state.latest[key]) < 0 ? "behind" : "current";
      console.log(
        `  ${key.padEnd(9)} ${install.method.padEnd(9)} installed ${install.version.padEnd(8)} latest ${state.latest[key].padEnd(8)} ${behind}${install.failing ? " FAILING" : ""}`,
      );
    }
  }
}

async function busy(state: LabState, env: LabEnv): Promise<void> {
  const headers = await authHeaders(env);
  if (!env.projectId) {
    const projectId = NodeCrypto.randomUUID();
    const created = await fetch(`${originOf(state, env)}/api/projects/mutate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "project.create",
        commandId: NodeCrypto.randomUUID(),
        projectId,
        title: `${env.id} lab project`,
        workspaceRoot: projectDir(env.id),
      }),
    });
    if (!created.ok) fail(`Project creation failed: ${created.status} ${await created.text()}`);
    updateState((next) => {
      requireEnv(next, env.id).projectId = projectId;
    });
    env.projectId = projectId;
  }
  const threadId = NodeCrypto.randomUUID();
  await rpc(state, env, "orchestration.launchThread", {
    commandId: NodeCrypto.randomUUID(),
    threadId,
    projectId: env.projectId,
    title: `Busy for ${state.busySeconds}s`,
    modelSelection: { instanceId: "mock-acp", model: "default" },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { text: "Stay busy so updates have to wait.", attachments: [] },
  });
  console.log(`${env.id}: thread ${threadId} runs for ~${state.busySeconds}s on mock-acp.`);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case "__tool":
      return runTool(args[0]!, args[1]!, args.slice(2));
    case "__feed":
      return runFeed(Number(args[0]));
    case "up":
      return up(args);
    case "down":
      return down();
    case "status":
      return status();
    case "pair": {
      const state = requireState();
      const env = requireEnv(state, args[0]);
      const output = NodeChildProcess.execFileSync(
        NODE,
        [
          SERVER_BIN,
          "auth",
          "pairing",
          "create",
          "--base-dir",
          t3Home(env.id),
          "--base-url",
          originOf(state, env),
        ],
        { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH, HOME: homeDir(env.id) } },
      );
      return void console.log(/(http\S+\/pair#token=\S+)/.exec(output)?.[1] ?? output);
    }
    case "publish": {
      const provider = requireProvider(args[0]);
      if (!args[1]) fail("Usage: publish <provider> <version>");
      updateState((state) => {
        state.latest[provider] = args[1]!;
      });
      return void console.log(`${PROVIDERS[provider].pkg} latest is now ${args[1]}.`);
    }
    case "fail": {
      const provider = requireProvider(args[1]);
      if (args[2] !== "on" && args[2] !== "off") fail("Usage: fail <env> <provider> on|off");
      updateState((state) => {
        requireEnv(state, args[0]).installs[provider].failing = args[2] === "on";
      });
      return void console.log(
        `${args[0]} ${provider} installs will ${args[2] === "on" ? "fail" : "succeed"}.`,
      );
    }
    case "delay": {
      const ms = Number(args[0]);
      if (!Number.isInteger(ms) || ms < 0) fail("Usage: delay <ms>");
      updateState((state) => {
        state.delayMs = ms;
      });
      return void console.log(`Installers now take ${ms}ms.`);
    }
    case "providers": {
      const state = requireState();
      const env = requireEnv(state, args[0]);
      const result = await rpc(state, env, "server.getConfig", {});
      console.log(`${env.id} ${originOf(state, env)}`);
      return printProviders(result.providers);
    }
    case "update": {
      const state = requireState();
      const env = requireEnv(state, args[0]);
      const instanceId = args[1] ?? fail("Usage: update <env> <instance> [version]");
      const driver =
        PROVIDER_KEYS.map((key) => PROVIDERS[key].driver).find((d) => d === instanceId) ??
        instanceId;
      const result = await rpc(state, env, "server.updateProvider", {
        provider: driver,
        instanceId,
        ...(args[2] ? { targetVersion: args[2] } : {}),
      });
      return printProviders(result.providers.filter((p: any) => p.instanceId === instanceId));
    }
    case "busy": {
      const state = requireState();
      return busy(state, requireEnv(state, args[0]));
    }
    case "self-update": {
      const state = requireState();
      const env = requireEnv(state, args[0]);
      if (!args[1]) fail("Usage: self-update <env> <version>");
      const result = await rpc(state, env, "server.updateServer", { targetVersion: args[1] });
      return void console.log(JSON.stringify(result));
    }
    case "build-runtime": {
      if (!args[0]) fail("Usage: build-runtime <version> [--archive file]");
      return void console.log(`Published ${buildRuntime(args[0], option(args, "archive"))}`);
    }
    case "reset": {
      const release = acquireLock("state");
      try {
        const state = readState();
        if (state && [state.feedPid, ...state.envs.map((e) => e.pid)].some((pid) => pid !== null)) {
          fail("Run `down` first.");
        }
        NodeFS.rmSync(LAB, { recursive: true, force: true });
      } finally {
        release();
      }
      return void console.log(`Removed ${LAB}.`);
    }
    default:
      console.log(HELP);
      if (command && command !== "--help" && command !== "help") process.exit(1);
  }
}

const argv = process.argv.slice(2);
const release = ["up", "down", "reset"].includes(argv[0] ?? "") ? acquireLock("processes") : null;
try {
  await main(argv);
} finally {
  release?.();
}
