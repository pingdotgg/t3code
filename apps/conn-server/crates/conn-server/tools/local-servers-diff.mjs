#!/usr/bin/env node
// Local servers for previews on the T3 server and the Conn Server, on the same machine state.
//
//   node crates/conn-server/tools/local-servers-diff.mjs <conn-server>
//
// The check starts its own listeners, each in its own process group: three HTML servers whose
// environment names an agent thread (`T3CODE_THREAD_ID`), one HTML server and one JSON server
// with no thread. Both servers (the T3 server from the monorepo, the Conn Server; temp homes,
// free ports, sealed environments) then answer, over `/ws` as the client calls them:
// - `subscribeDiscoveredLocalServers` with configured URLs (the JSON server, an owned server,
//   the unowned HTML server, a URL nobody listens on): the first list, on this check's ports;
// - `preview.stopLocalServer` for an unowned listener and for a wrong port (both refused), then
//   one owned server stopped by each side; each server must be gone;
// - a second subscription: neither stopped server is listed.
// Lists are compared whole after `scannedAt` (and other machines' listeners) are left out.
// Only loopback connections; no model; every process is stopped by PID.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { pairBearer } from "../../conn-mcp/tools/mcp-client.mjs";
import { monorepo } from "../../../tools/monorepo.mjs";
import { sealedEnv, sealedNodeEnv } from "../../../tools/sealed-env.mjs";
import { GUARD_ARG } from "../../../tools/no-outside-fetch.mjs";

const [binaryArg] = process.argv.slice(2);
if (binaryArg === undefined) {
  console.error("usage: local-servers-diff.mjs <conn-server>");
  process.exit(2);
}
const rustBinary = NodePath.resolve(binaryArg);
const MONOREPO = monorepo();
const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-local-servers-")));
const started = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function stopAll() {
  for (const child of started) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}
process.on("exit", stopAll);

/** A listener in its own process group; `thread` goes into its environment. */
async function listener(name, kind, thread) {
  const port = await freePort();
  const script = NodePath.join(root, `${name}.mjs`);
  const [type, body] = kind === "html" ? ["text/html; charset=utf-8", "<h1>x</h1>"] : ["application/json", "{}"];
  NodeFS.writeFileSync(
    script,
    `import { createServer } from "node:http";\ncreateServer((q, r) => { r.writeHead(200, { "content-type": ${JSON.stringify(type)} }); r.end(${JSON.stringify(body)}); }).listen(${port}, "127.0.0.1");\n`,
  );
  const env = { ...sealedNodeEnv(NodePath.join(root, name)), ...(thread ? { T3CODE_THREAD_ID: thread } : {}) };
  const child = NodeChildProcess.spawn(process.execPath, [script], { env, detached: true, stdio: "ignore" });
  started.add(child);
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(50)) {
    const ok = await new Promise((resolve) => {
      const socket = NodeNet.connect(port, "127.0.0.1", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ok) return { name, port, pid: child.pid, child };
  }
  throw new Error(`listener ${name} did not start`);
}

class Side {
  constructor(kind) {
    this.kind = kind;
    this.name = kind === "ts" ? "T3" : "Conn";
    this.dir = NodePath.join(root, kind);
    NodeFS.mkdirSync(this.dir, { recursive: true });
    this.out = NodePath.join(this.dir, "server.log");
  }

  async start() {
    this.port = await freePort();
    this.origin = `http://127.0.0.1:${this.port}`;
    const [command, args, env] =
      this.kind === "ts"
        ? [process.execPath, [GUARD_ARG, NodePath.join(MONOREPO, "apps/server/src/bin.ts"), "serve", "--no-browser", "--port", String(this.port), "--host", "127.0.0.1", "--base-dir", NodePath.join(this.dir, "base")],
            { ...sealedNodeEnv(this.dir), PATH: sealedEnv(this.dir).PATH, T3CODE_NO_BROWSER: "1", T3CODE_TELEMETRY_ENABLED: "false" }]
        : [rustBinary, ["serve", "--listen", `127.0.0.1:${this.port}`, "--state-dir", NodePath.join(this.dir, "state")], sealedEnv(this.dir)];
    // Terminals need a real shell; a fresh HOME keeps it from reading any rc file of ours.
    env.SHELL = "/bin/sh";
    const out = NodeFS.openSync(this.out, "a");
    const child = NodeChildProcess.spawn(command, args, { cwd: this.dir, env, detached: true, stdio: ["ignore", out, out] });
    NodeFS.closeSync(out);
    started.add(child);
    this.child = child;
    for (const deadline = Date.now() + 90_000; Date.now() < deadline; await sleep(100)) {
      if (child.exitCode !== null) throw new Error(`${this.name} server exited; see ${this.out}`);
      const code = NodeFS.readFileSync(this.out, "utf8").match(/pair#token=([A-Za-z0-9]+)/)?.[1];
      if (code === undefined) continue;
      try {
        if ((await fetch(`${this.origin}/.well-known/t3/environment`)).ok) {
          this.bearer = await pairBearer(this.origin, code);
          return;
        }
      } catch {}
    }
    throw new Error(`${this.name} server did not start; see ${this.out}`);
  }

  async socket() {
    const ticket = await fetch(`${this.origin}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${this.bearer}` } });
    const url = `${this.origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent((await ticket.json()).ticket)}`;
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error(`${this.name}: socket failed`));
    });
    return socket;
  }

  /** One RPC: `{ ok }` or `{ failure }` (the typed error). */
  async rpc(tag, payload) {
    const socket = await this.socket();
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${this.name}: ${tag} did not answer`)), 30_000);
        socket.onmessage = (event) => {
          for (const line of String(event.data).split("\n").filter(Boolean)) {
            const frame = JSON.parse(line);
            if (frame._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
            if (frame._tag !== "Exit" || String(frame.requestId) !== "1") continue;
            clearTimeout(timer);
            if (frame.exit._tag === "Success") resolve({ ok: frame.exit.value ?? null });
            else resolve({ failure: frame.exit.cause?.failure ?? frame.exit.cause?.error ?? frame.exit });
          }
        };
        socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
      });
    } finally {
      socket.close();
    }
  }

  /** The first list of `subscribeDiscoveredLocalServers`. */
  async firstList(configuredUrls) {
    const socket = await this.socket();
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${this.name}: no local server list`)), 30_000);
        socket.onmessage = (event) => {
          for (const line of String(event.data).split("\n").filter(Boolean)) {
            const frame = JSON.parse(line);
            if (frame._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
            if (String(frame.requestId) !== "1") continue;
            if (frame._tag === "Chunk" && frame.values?.length > 0) {
              clearTimeout(timer);
              resolve(frame.values[0]);
            } else if (frame._tag === "Exit") {
              clearTimeout(timer);
              reject(new Error(`${this.name}: ${JSON.stringify(frame.exit).slice(0, 500)}`));
            }
          }
        };
        socket.send(JSON.stringify({ _tag: "Request", id: "1", tag: "subscribeDiscoveredLocalServers", payload: { configuredUrls }, headers: [] }));
      });
    } finally {
      socket.close();
    }
  }
}

const failures = [];
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).toSorted().map((k) => [k, canonical(value[k])]))
      : value;
const same = (label, ts, conn) => {
  const [a, b] = [JSON.stringify(canonical(ts)), JSON.stringify(canonical(conn))];
  if (a === b) console.log(`ok   ${label}`);
  else failures.push(`${label}\n  T3:   ${a}\n  Conn: ${b}`);
};

try {
  const [a, b, c, page, json] = await Promise.all([
    listener("agent-a", "html", "thread-a"),
    listener("agent-b", "html", "thread-b"),
    listener("agent-c", "html", "thread-c"),
    listener("page", "html", null),
    listener("json", "json", null),
  ]);
  const nobody = await freePort();
  const ours = new Set([a, b, c, page, json].map((l) => l.port).concat(nobody));
  const sides = [new Side("ts"), new Side("rust")];
  await Promise.all(sides.map((side) => side.start()));
  const configuredUrls = [`http://localhost:${json.port}/`, `http://127.0.0.1:${a.port}/x#y`, `http://0.0.0.0:${page.port}`, `http://localhost:${nobody}/`, "https://example.com/"];
  const view = (list) => ({
    keys: Object.keys(list).toSorted(),
    configuredUrlProbing: list.configuredUrlProbing,
    servers: list.servers.filter((s) => ours.has(s.port)),
  });
  const first = await Promise.all(sides.map((side) => side.firstList(configuredUrls)));
  same("first list", view(first[0]), view(first[1]));
  if (!first[0].servers.some((s) => s.port === b.port && s.agent?.threadId === "thread-b")) failures.push("T3 does not list the agent's server: the fixture is wrong");

  for (const [label, input] of [
    ["stop an unowned listener", { pid: page.pid, port: page.port }],
    ["stop with the wrong port", { pid: a.pid, port: json.port }],
  ]) {
    const results = await Promise.all(sides.map((side) => side.rpc("preview.stopLocalServer", input)));
    same(label, results[0], results[1]);
  }
  const stops = await Promise.all([sides[0].rpc("preview.stopLocalServer", { pid: b.pid, port: b.port }), sides[1].rpc("preview.stopLocalServer", { pid: c.pid, port: c.port })]);
  same("stop an agent's server", stops[0], stops[1]);
  for (const stopped of [b, c]) {
    for (const deadline = Date.now() + 5_000; alive(stopped.pid) && Date.now() < deadline; await sleep(100));
    if (alive(stopped.pid)) failures.push(`${stopped.name} still runs after its stop`);
  }
  if (!alive(a.pid) || !alive(page.pid)) failures.push("a stop ended a server it did not name");
  // A server a thread's terminal started in the background (`server &`): each side's own.
  const shellServers = await Promise.all(sides.map(async (side) => {
    const port = await freePort();
    const script = NodePath.join(root, `terminal-${side.kind}.mjs`);
    NodeFS.writeFileSync(script, `import { createServer } from "node:http";\ncreateServer((q, r) => r.end("x")).listen(${port}, "127.0.0.1");\n`);
    const ids = { threadId: "thread-terminal", terminalId: "term-1" };
    const opened = await side.rpc("terminal.open", { ...ids, cwd: root, cols: 80, rows: 24 });
    if (opened.ok === undefined) throw new Error(`${side.name}: terminal.open ${JSON.stringify(opened.failure).slice(0, 300)}`);
    await side.rpc("terminal.write", { ...ids, data: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} &\n` });
    return port;
  }));
  const terminalView = (list, port) => list.servers.filter((s) => s.port === port).map(({ pid, port: _p, url: _u, ...rest }) => ({ ...rest, pid: typeof pid }));
  let terminalLists = [];
  for (const deadline = Date.now() + 20_000; Date.now() < deadline; await sleep(500)) {
    terminalLists = await Promise.all(sides.map((side) => side.firstList([])));
    if (terminalLists.every((list, i) => list.servers.some((s) => s.port === shellServers[i] && s.terminal !== null))) break;
  }
  same("a terminal's background server", terminalView(terminalLists[0], shellServers[0]), terminalView(terminalLists[1], shellServers[1]));
  if (!terminalLists[1].servers.some((s) => s.port === shellServers[1] && s.terminal?.terminalId === "term-1")) failures.push("Conn does not list its terminal's background server");
  await Promise.all(sides.map((side) => side.rpc("terminal.close", { threadId: "thread-terminal", terminalId: "term-1" })));
  const after = await Promise.all(sides.map((side) => side.firstList(configuredUrls)));
  same("list after the stops", view(after[0]), view(after[1]));
  if (after[1].servers.some((s) => s.port === b.port || s.port === c.port)) failures.push("Conn still lists a stopped server");
} finally {
  stopAll();
}
if (failures.length > 0) {
  console.error(`\n${failures.length} difference(s):\n${failures.join("\n")}\nlogs: ${root}`);
  process.exit(1);
}
NodeFS.rmSync(root, { recursive: true, force: true });
console.log("local servers agree with the T3 server");
