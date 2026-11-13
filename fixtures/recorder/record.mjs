#!/usr/bin/env node
// Records real web-client sessions against the TypeScript server at this checkout.
// Usage: record.mjs [scenario ...] [--explore] [--rust <binary> | --rust-url <pairingUrl>]
//   [--rust-sample <command>]. rust-* scenarios pair the Rust server as a remote environment.
// See ../README.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { redactText, redactValue, addSecret } from "./redact.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
// The Conn monorepo (web client, TypeScript server): `$CONN_MONOREPO`, else the checkout
// this folder sits in.
const repo = NodePath.resolve(process.env.CONN_MONOREPO ?? NodePath.resolve(here, "../../../.."));
const sessionsDir = NodePath.resolve(here, "../sessions");
const require = NodeModule.createRequire(NodePath.join(repo, "apps/server/package.json"));
const { chromium } = require("playwright-core");

const args = process.argv.slice(2);
const explore = args.includes("--explore");
const rustAt = args.indexOf("--rust");
const rustBinary = rustAt === -1 ? null : NodePath.resolve(args.splice(rustAt, 2)[1]);
const takeOption = (flag) => {
  const at = args.indexOf(flag);
  return at === -1 ? null : args.splice(at, 2)[1];
};
const rustUrl = takeOption("--rust-url");
const rustSample = takeOption("--rust-sample");
const wanted = args.filter((a) => !a.startsWith("--"));
const order = Object.keys(SCENARIOS);
const selected =
  wanted.length === 0
    ? order.filter((n) => !n.startsWith("rust-"))
    : order.filter((n) => wanted.includes(n));

const log = (...m) => console.error("[record]", ...m);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = NodeNet.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** A git repo with one commit, in `root/project`. */
function scratchProject(root, name = "project") {
  const project = NodePath.join(root, name);
  NodeFS.mkdirSync(project);
  NodeFS.writeFileSync(NodePath.join(project, "README.md"), "# scratch\n");
  // The host's user Claude settings may allow Bash outright; an ask rule wins over allow, so the
  // permission scenario gets its prompt.
  NodeFS.mkdirSync(NodePath.join(project, ".claude"));
  NodeFS.writeFileSync(
    NodePath.join(project, ".claude/settings.json"),
    JSON.stringify({ permissions: { ask: ["Bash"] } }, null, 2) + "\n",
  );
  const git = (...a) => NodeChildProcess.execFileSync("git", a, { cwd: project, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=rec", "-c", "user.email=rec@example.com", "add", ".");
  git("-c", "user.name=rec", "-c", "user.email=rec@example.com", "commit", "-qm", "init");
  return project;
}

/**
 * Starts the Rust conn-server on a scratch project. Pass an earlier result to restart it on the
 * same state directory and port.
 */
async function startRustServer(previous, prepare) {
  if (rustUrl !== null && previous === undefined) {
    const url = new URL(rustUrl);
    addSecret(url.hash.replace("#token=", ""));
    return {
      origin: url.origin,
      token: url.hash.replace("#token=", ""),
      rust: true,
      external: true,
    };
  }
  if (rustBinary === null) throw new Error("rust-* scenarios need --rust <conn-server binary>");
  const root = previous?.root ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-rust-"));
  const project = previous?.project ?? scratchProject(root, "rust-project");
  if (previous === undefined) prepare?.(project);
  const port = previous?.port ?? (await freePort());
  const child = NodeChildProcess.spawn(
    rustBinary,
    [
      "--listen",
      `127.0.0.1:${port}`,
      "--state-dir",
      NodePath.join(root, "state"),
      "--project",
      project,
    ],
    { cwd: project, stdio: ["ignore", "pipe", "pipe"] },
  );
  const logFile = NodeFS.createWriteStream(NodePath.join(root, "server.log"), { flags: "a" });
  process.once("exit", () => child.exitCode === null && child.kill("SIGKILL"));
  child.stderr.pipe(logFile);
  const token = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => {
      logFile.write(d);
      out += d;
      const m = out.match(/\/pair#token=([A-Za-z0-9_-]+)/);
      if (m) resolve(m[1]);
    });
    child.once("exit", (code) =>
      reject(new Error(`rust server exited ${code}; see ${root}/server.log`)),
    );
  });
  addSecret(token);
  log(`rust server pid ${child.pid} on ${port}, root ${root}`);
  return { root, project, port, token, child, origin: `http://127.0.0.1:${port}`, rust: true };
}

async function startServer(name = "project", prepare) {
  if (!NodeFS.existsSync(NodePath.join(repo, "apps/web/dist/index.html"))) {
    log("building apps/web (no dist yet)");
    NodeChildProcess.execFileSync("vp", ["build"], {
      cwd: NodePath.join(repo, "apps/web"),
      stdio: "inherit",
    });
  }
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-rec-"));
  const base = NodePath.join(root, "base");
  NodeFS.mkdirSync(base);
  const project = scratchProject(root, name);
  prepare?.(project);

  const port = await freePort();
  // env -i: the service launcher IPC channel of an outer T3 must not leak in.
  const env = {
    HOME: NodeOS.homedir(),
    USER: NodeOS.userInfo().username,
    PATH: [
      NodePath.dirname(process.execPath),
      NodePath.join(NodeOS.homedir(), ".local/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
    T3CODE_HOME: base,
    T3CODE_NO_BROWSER: "1",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "1",
  };
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(repo, "apps/server/src/bin.ts"),
      "--no-browser",
      "--auto-bootstrap-project-from-cwd",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--base-dir",
      base,
      project,
    ],
    { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const logFile = NodeFS.createWriteStream(NodePath.join(root, "server.log"));
  // The server must never outlive the recorder, even when startup fails.
  process.once("exit", () => child.exitCode === null && child.kill("SIGKILL"));
  child.stderr.pipe(logFile);
  const token = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(new Error("server did not print a token in 90 s")),
      90_000,
    );
    const onData = (d) => {
      out += d;
      const m = out.match(/Token: (\S+)/) ?? out.match(/\/pair#token=([A-Za-z0-9_-]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout.on("data", (d) => (logFile.write(d), onData(d)));
    child.stderr.on("data", onData);
    child.once("exit", (code) =>
      reject(new Error(`server exited ${code}; see ${root}/server.log`)),
    );
  });
  addSecret(token);
  log(`server pid ${child.pid} on ${port}, root ${root}`);
  return { root, base, project, port, token, child, origin: `http://127.0.0.1:${port}` };
}

/** RSS and macOS `footprint` of a server this run started, in KB. Only the server, no children. */
function localMemory(s) {
  const rss = Number(
    NodeChildProcess.execFileSync("ps", ["-o", "rss=", "-p", String(s.child.pid)], {
      encoding: "utf8",
    }).trim(),
  );
  let footprint = null;
  try {
    // macOS only; elsewhere the tool is missing and RSS stands alone.
    const out = NodeChildProcess.execFileSync("footprint", [String(s.child.pid)], {
      encoding: "utf8",
    });
    const m = /Footprint: ([\d.]+) (KB|MB)/.exec(out);
    if (m) footprint = Number(m[1]) * (m[2] === "MB" ? 1024 : 1);
  } catch {}
  return { rss, footprint };
}

const STATIC = /\/assets\/|\.(png|ico|svg|webmanifest|woff2?|css|js)(\?|$)|third-party-licenses/;

/** Captures every /ws frame and non-static HTTP exchange of one page, for the hosts in `hosts`. */
function capture(page, server) {
  const lines = [];
  const http = [];
  // A scenario may swap this to record a different server (see `remote`).
  const hosts = new Set([new URL(server.origin).host]);
  const accept = (url) => hosts.has(new URL(url).host);
  // Raw times from page start; writeSession rebases them on the first /ws open.
  const start = performance.now();
  const clock = { wsOpen: null };
  let wsCount = 0;
  const ms = () => performance.now() - start;
  page.on("websocket", (ws) => {
    if (!new URL(ws.url()).pathname.startsWith("/ws") || !accept(ws.url())) return;
    if (clock.wsOpen === null) clock.wsOpen = ms();
    const idx = wsCount++;
    http.push({ ms: ms(), ws: idx, method: "GET", url: ws.url(), upgrade: "websocket" });
    const wsHost = new URL(ws.url()).host;
    let pending = "";
    let parts = 0;
    const push = (dir, text, nParts) => {
      if (!hosts.has(wsHost)) return;
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        lines.push({ dir, ms: ms(), ws: idx, unparsed: text });
        return;
      }
      const frames = Array.isArray(value) ? value : [value];
      for (const frame of frames) {
        const line = { dir, ms: ms(), ws: idx, frame };
        if (nParts > 1) line.parts = nParts;
        if (Array.isArray(value)) line.batch = frames.length;
        lines.push(line);
      }
    };
    ws.on("framesent", (f) => push("in", String(f.payload), 1));
    ws.on("framereceived", (f) => {
      const text = String(f.payload);
      if (text.startsWith("\u001e")) {
        pending += text.slice(1);
        parts++;
        return;
      }
      const whole = pending + text;
      const n = parts + 1;
      pending = "";
      parts = 0;
      push("out", whole, n);
    });
    ws.on("close", () => http.push({ ms: ms(), ws: idx, closed: true }));
  });
  page.on("requestfinished", async (req) => {
    const url = req.url();
    if (!accept(url) || STATIC.test(new URL(url).pathname)) return;
    const entry = { ms: ms(), method: req.method(), url };
    http.push(entry);
    try {
      entry.requestHeaders = pickHeaders(await req.allHeaders());
      const body = req.postData();
      if (body) entry.requestBody = parseMaybe(body);
      const res = await req.response();
      if (res) {
        entry.status = res.status();
        entry.responseHeaders = pickHeaders(await res.allHeaders());
        const ct = res.headers()["content-type"] ?? "";
        if (ct.includes("json")) entry.responseBody = parseMaybe(await res.text());
        else if (ct.includes("html")) entry.responseBody = "<html>";
      }
    } catch (e) {
      entry.error = String(e.message ?? e);
    }
  });
  page.on("requestfailed", (req) => {
    if (accept(req.url()) && !STATIC.test(new URL(req.url()).pathname))
      http.push({
        ms: ms(),
        method: req.method(),
        url: req.url(),
        failed: req.failure()?.errorText,
      });
  });
  /** Records only `host` from now on and forgets everything captured so far. */
  const only = (host) => {
    hosts.clear();
    hosts.add(host);
    lines.length = 0;
    http.length = 0;
    clock.wsOpen = null;
  };
  return { lines, http, clock, hosts, only };
}

const KEEP_HEADERS =
  /^(authorization|cookie|set-cookie|content-type|dpop|x-t3-[\w-]+|origin|location|www-authenticate|cache-control)$/i;
function pickHeaders(h) {
  return Object.fromEntries(Object.entries(h).filter(([k]) => KEEP_HEADERS.test(k)));
}
function parseMaybe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function writeSession(name, cap) {
  NodeFS.mkdirSync(sessionsDir, { recursive: true });
  const zero = cap.clock.wsOpen ?? 0;
  const rebase = (l) => ({ ...l, ms: Math.round(l.ms - zero) });
  // Pass 1 redacts by key and learns those secret values; pass 2 removes them everywhere else.
  const wireValues = cap.lines.map(rebase).map((l) => redactValue(l));
  const httpValues = cap.http
    .sort((a, b) => a.ms - b.ms)
    .map(rebase)
    .map((l) => redactValue(l));
  const wire = wireValues.map((l) => redactText(JSON.stringify(l))).join("\n") + "\n";
  const http = httpValues.map((l) => redactText(JSON.stringify(l))).join("\n") + "\n";
  NodeFS.writeFileSync(NodePath.join(sessionsDir, `${name}.ndjson`), wire);
  NodeFS.writeFileSync(NodePath.join(sessionsDir, `${name}.http.ndjson`), http);
  log(`${name}: ${cap.lines.length} frames, ${cap.http.length} http entries`);
}

for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => process.exit(130));
const server = await startServer();
const extraServers = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
let failed = false;
try {
  for (const name of selected) {
    const page = await context.newPage();
    const cap = capture(page, server);
    // CONN_RECORDER_SHOTS keeps screenshots after the run; else they go with the temp folder.
    const shots = NodePath.join(
      process.env.CONN_RECORDER_SHOTS ?? NodePath.join(server.root, "shots"),
      name,
    );
    NodeFS.mkdirSync(shots, { recursive: true });
    let step = 0;
    const ctx = {
      page,
      server,
      log: (...m) => log(name, ...m),
      shot: async (label) => {
        if (!explore) return;
        const file = NodePath.join(shots, `${String(step++).padStart(2, "0")}-${label}.png`);
        await page.screenshot({ path: file });
        log(name, "shot", file);
      },
      cap,
      startServer: async (name, prepare) => {
        const extra = await startServer(name, prepare);
        extraServers.push(extra);
        return extra;
      },
      startRustServer: async (previous, prepare) => {
        const extra = await startRustServer(previous, prepare);
        if (previous) extraServers[extraServers.indexOf(previous)] = extra;
        else extraServers.push(extra);
        return extra;
      },
      /** Issues a bearer session on `s` from its own CLI, as Orbit does; returns its id. */
      issueSession: (s, label) => {
        const argv = s.rust
          ? [
              rustBinary,
              [
                "auth",
                "session",
                "issue",
                "--state-dir",
                NodePath.join(s.root, "state"),
                "--label",
                label,
                "--json",
              ],
            ]
          : [
              process.execPath,
              [
                NodePath.join(repo, "apps/server/src/bin.ts"),
                "auth",
                "session",
                "issue",
                "--base-dir",
                s.base,
                "--label",
                label,
                "--json",
              ],
            ];
        const out = NodeChildProcess.execFileSync(argv[0], argv[1], {
          cwd: s.project,
          encoding: "utf8",
          env: { ...process.env, T3CODE_HOME: s.base ?? "" },
        });
        const issued = JSON.parse(out.slice(out.indexOf("{")));
        addSecret(issued.token);
        return issued.sessionId;
      },
      stopServer: (s) =>
        new Promise((r) => {
          if (s.external) throw new Error("cannot stop a server this run did not start");
          if (s.child.exitCode !== null) return r();
          s.child.once("exit", () => r());
          s.child.kill("SIGTERM");
        }),
      /**
       * Memory of one server process in KB: `--rust-sample` output for a running server, else RSS
       * and macOS `footprint` of the child. Logged with `label` either way.
       */
      memory: (s, label = "") => {
        if (rustSample !== null && s.rust) {
          const out = NodeChildProcess.execSync(`${rustSample} ${label}`, { encoding: "utf8" });
          log(name, `sample ${out.trim()}`);
          return JSON.parse(out).server;
        }
        return localMemory(s);
      },
      shotAlways: async (label) => {
        const file = NodePath.join(shots, `${label}.png`);
        await page.screenshot({ path: file });
        log(name, "shot", file);
        return file;
      },
    };
    try {
      log(`scenario ${name}`);
      await SCENARIOS[name](ctx);
      for (const c of await context.cookies()) addSecret(c.value);
      writeSession(name, cap);
    } catch (e) {
      failed = true;
      log(`scenario ${name} FAILED: ${e.stack ?? e}`);
      await page.screenshot({ path: NodePath.join(shots, "failure.png") }).catch(() => {});
      log(`failure screenshot ${NodePath.join(shots, "failure.png")}`);
      for (const c of await context.cookies()) addSecret(c.value);
      writeSession(`${name}.partial`, cap);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  for (const s of [server, ...extraServers]) {
    if (s.external) continue;
    s.child.kill("SIGTERM");
    await new Promise((r) => {
      if (s.child.exitCode !== null) return r();
      const t = setTimeout(() => {
        s.child.kill("SIGKILL");
        r();
      }, 10_000);
      s.child.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
    if (s.rust) {
      // Claude keeps a session folder per project path; remove the ones our turns made.
      const real = NodeFS.realpathSync(s.project);
      const dir = NodePath.join(
        NodeOS.homedir(),
        ".claude/projects",
        real.replace(/[^A-Za-z0-9-]/g, "-"),
      );
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
    if (explore || failed) log(`kept ${s.root} for inspection; remove it when done`);
    else NodeFS.rmSync(s.root, { recursive: true, force: true });
  }
}
process.exitCode = failed ? 1 : 0;
