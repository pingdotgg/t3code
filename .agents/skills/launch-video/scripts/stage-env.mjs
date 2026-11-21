// Starts real T3 Code dev environments for staging a launch video: fresh homes, fictional
// machine labels, the free replay agent, no paid provider. Import from a staging script.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const REPO = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const BASE_WEB_PORT = 5733; // dev-runner.ts BASE_WEB_PORT
const REAL_PROVIDERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "muse",
  "pi",
  "opencode",
  "antigravity",
];

export const freePort = () =>
  new Promise((resolve) => {
    const server = NodeNet.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const FAKE_CLAUDE = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "fake-claude.mjs",
);
const NO_MODEL = `#!/bin/sh\necho 'staging runs no model' >&2\nexit 1\n`;

// What the server and its CLI call this machine, instead of the real host's name and kind.
const identityEnv = (home) => {
  const { label, machine } = JSON.parse(
    NodeFS.readFileSync(NodePath.join(home, "identity.json"), "utf8"),
  );
  return { T3CODE_ENVIRONMENT_LABEL: label, T3CODE_ENVIRONMENT_MACHINE_KIND: machine };
};

/**
 * A fresh T3 home whose server calls itself `label` on a `machine`. `settings` merge into
 * settings.json. With `claude` (scripted turns) the real Claude provider runs fake-claude.mjs
 * and `model` is a Claude model id; without it `model` is a replay-agent scenario.
 */
export function prepareHome(home, { label, machine = "laptop", settings = {}, model, claude }) {
  NodeFS.rmSync(home, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(home, "bin"));
  NodeFS.mkdirSync(NodePath.join(home, "workspaces"));
  NodeFS.writeFileSync(NodePath.join(home, "bin/no-model"), NO_MODEL, { mode: 0o755 });
  NodeFS.writeFileSync(NodePath.join(home, "identity.json"), JSON.stringify({ label, machine }));
  if (claude)
    NodeFS.writeFileSync(NodePath.join(home, "claude-script.json"), JSON.stringify(claude));
  NodeFS.writeFileSync(
    NodePath.join(home, "userdata/settings.json"),
    JSON.stringify({
      defaultModelSelection: claude
        ? { instanceId: "claudeAgent", model: model ?? "claude-opus-5-5" }
        : { instanceId: "devReplay", model: model ?? "showcase" },
      providerInstances: Object.fromEntries(
        REAL_PROVIDERS.map((driver) => [
          driver,
          driver === "claudeAgent" && claude
            ? { driver, enabled: true, config: { binaryPath: FAKE_CLAUDE } }
            : {
                driver,
                enabled: false,
                ...(driver === "codex"
                  ? { config: { binaryPath: NodePath.join(home, "bin/no-model") } }
                  : {}),
              },
        ]),
      ),
      ...settings,
    }),
  );
}

const children = [];
process.on("exit", () => {
  for (const child of children) child.kill("SIGTERM");
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));

function spawn(args, env, log) {
  const out = NodeFS.openSync(log, "a");
  const child = NodeChildProcess.spawn(process.execPath, args, {
    cwd: REPO,
    env,
    stdio: ["ignore", "pipe", out],
    // Its own process group, so stopping it ends the dev runner's children too.
    detached: true,
  });
  const handle = {
    kill: (s) => {
      try {
        process.kill(-child.pid, s);
      } catch {}
    },
  };
  children.push(handle);
  child.stopGroup = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      handle.kill("SIGTERM");
    });
  return child;
}

/**
 * Starts a dev server on `home` (and the web client when `web` is set). Resolves when it listens,
 * with its origin, the web origin, the startup pairing URL, and `stop()`. Pass the previous
 * `port` to restart a server where saved routes expect it.
 */
export async function startEnvironment(
  home,
  { host = "127.0.0.1", port, web = false, allowedOrigins = [], env = {} } = {},
) {
  const serverPort = port ?? (await freePort());
  const webPort = web ? await freePort() : await freePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const token = NodeCrypto.randomUUID().replaceAll("-", "").repeat(2);
  const baseEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    ...identityEnv(home),
    ...(NodeFS.existsSync(NodePath.join(home, "claude-script.json"))
      ? {
          FAKE_CLAUDE_SCRIPT: NodePath.join(home, "claude-script.json"),
          FAKE_CLAUDE_LOG: NodePath.join(home, "fake-claude.log"),
        }
      : {}),
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
    T3CODE_PORT_OFFSET: String(webPort - BASE_WEB_PORT),
    ...env,
  };
  const runner = (mode, extra) => [
    "scripts/dev-runner.ts",
    mode,
    "--home-dir",
    home,
    "--no-seed",
    "--port",
    String(serverPort),
    "--dev-url",
    webOrigin,
    ...extra,
  ];
  const log = NodePath.join(home, "dev.log");
  const server = spawn(
    runner("dev:server", ["--host", host]),
    {
      ...baseEnv,
      T3CODE_DEV_ALLOWED_ORIGINS: [webOrigin, ...allowedOrigins].join(","),
      T3CODE_DEV_AUTH_TOKEN: token,
    },
    log,
  );
  const pairingUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    server.stdout.on("data", (chunk) => {
      buffer += chunk;
      NodeFS.appendFileSync(
        log,
        String(chunk).replace(/pairingUrl:\s*\S+/g, "pairingUrl: <hidden>"),
      );
      const match = /pairingUrl:\s*(\S+)/.exec(buffer);
      if (match) resolve(match[1]);
    });
    server.once("exit", (code) =>
      reject(new Error(`server on ${home} exited ${code}; see ${log}`)),
    );
  });
  const processes = [server];
  if (web) {
    processes.push(spawn(runner("dev:web", ["--", "--host", "127.0.0.1"]), baseEnv, log));
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${webOrigin}/.well-known/t3/environment`)).ok) break;
      } catch {}
      if (i > 300) throw new Error(`web client for ${home} never answered; see ${log}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const reachableHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const origin = `http://${reachableHost.includes(":") ? `[${reachableHost}]` : reachableHost}:${serverPort}`;
  const descriptor = await (await fetch(`${origin}/.well-known/t3/environment`)).json();
  return {
    home,
    origin,
    descriptor,
    stop: () => Promise.all(processes.map((p) => p.stopGroup())),
    serverPort,
    webOrigin,
    pairingUrl,
    environmentId: descriptor.environmentId,
    label: descriptor.label,
  };
}

/** Runs the server CLI against `home`. */
export function cli(home, args) {
  return NodeChildProcess.execFileSync(
    process.execPath,
    ["apps/server/src/bin.ts", ...args, "--base-dir", home],
    {
      cwd: REPO,
      // The CLI names this environment itself (a link introduces it by label).
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...identityEnv(home) },
      encoding: "utf8",
    },
  );
}

/**
 * A folder under `home` registered as a project. Returns { projectId, workspace }. The folder is
 * one git repository, or with `repos` (folders relative to it) a plain folder holding those.
 */
export async function createProject(
  environment,
  title,
  files = { "README.md": "" },
  { repos = ["."] } = {},
) {
  const workspace = NodePath.join(environment.home, "workspaces", title);
  for (const [file, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(workspace, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(workspace, file), content);
  }
  for (const repo of repos) {
    const cwd = NodePath.join(workspace, repo);
    NodeFS.mkdirSync(cwd, { recursive: true });
    const git = (...args) => NodeChildProcess.execFileSync("git", args, { cwd });
    git("init", "--quiet", "--initial-branch=main");
    // A fictional author, so commits made on camera work and never carry a real name.
    git("config", "user.name", "Dana Reyes");
    git("config", "user.email", "dana@example.com");
    git("add", "--all");
    git("commit", "--quiet", "-m", "Initial commit");
  }
  const bearer = cli(environment.home, [
    "auth",
    "session",
    "issue",
    "--token-only",
    "--label",
    "staging",
  ]).trim();
  const projectId = NodeCrypto.randomUUID();
  const response = await fetch(`${environment.origin}/api/projects/mutate`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title,
      workspaceRoot: workspace,
    }),
  });
  if (!response.ok)
    throw new Error(
      `project.create on ${environment.label}: ${response.status} ${await response.text()}`,
    );
  return { projectId, workspace };
}

/** A Playwright page at the size beats are frozen at, dark, with production branding. */
export async function openBrowser({ width = 1440, height = 720, args = [] } = {}) {
  const { createRequire } = await import("node:module");
  const { chromium } = createRequire(NodePath.join(REPO, "scripts/package.json"))(
    "playwright-core",
  );
  const { findChrome } = await import("./chrome.mjs");
  const browser = await chromium.launch({
    executablePath: findChrome(chromium),
    args: ["--no-sandbox", ...args],
  });
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: "dark" });
  await context.addInitScript(() => {
    // "none" is what a release build shows: no dev or nightly artwork.
    if (!localStorage.getItem("t3code:client-settings:v1")) {
      localStorage.setItem(
        "t3code:client-settings:v1",
        JSON.stringify({ environmentIdentificationMode: "none" }),
      );
    }
  });
  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * Writes link rows straight into a stopped server's database, as if `t3 environment link` had
 * made them. The server must have started once (migrations). The map probes each row's URLs
 * live: a row is "reachable" only while something there answers as that environment.
 * Rows: { environmentId, label, urls, access = "full-access", lastError = null }.
 */
export async function insertPeerLinks(home, rows) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(NodePath.join(home, "userdata/statev2.sqlite"));
  const now = Date.now();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO peer_environment_links
      (environment_id, secret_name, label, urls_json, access, linked_at, expires_at, last_reached_at, last_error, fenced)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 1)`,
  );
  for (const row of rows) {
    insert.run(
      row.environmentId,
      `peer-link:${row.environmentId}`,
      row.label,
      JSON.stringify(row.urls),
      row.access ?? "full-access",
      new Date(now - 86_400_000).toISOString(),
      new Date(now + 60 * 86_400_000).toISOString(),
      row.lastError ?? null,
    );
  }
  db.close();
}

/**
 * Answers the descriptor probe for machines that only need to look alive: one port per
 * machine, each serving `template` (a real server's descriptor) under that machine's id and
 * label. Returns the URL for each machine, by environment id.
 */
export async function serveDescriptors(template, machines) {
  const urls = {};
  for (const machine of machines) {
    const body = JSON.stringify({
      ...template,
      environmentId: machine.environmentId,
      label: machine.label,
    });
    const server = NodeHttp.createServer((req, res) =>
      res.writeHead(200, { "content-type": "application/json" }).end(body),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    children.push({ kill: () => server.close() });
    urls[machine.environmentId] = `http://127.0.0.1:${server.address().port}`;
  }
  return urls;
}
