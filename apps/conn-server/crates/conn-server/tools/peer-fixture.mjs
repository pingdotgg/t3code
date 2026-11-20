// Two or more servers on loopback for the linked-environment checks: T3 servers (the Claude CLI
// stand-in, no model) and Conn servers (`replay_server`, the fake provider), each with a temp
// home and a free port, and the calls the checks make on them. No model is called.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { oauthMcpToken, pairBearer } from "../../conn-mcp/tools/mcp-client.mjs";
import { claudeStub, rustCredential, tsCredential } from "../../conn-mcp/tools/handoff-fixture.mjs";
import { monorepo } from "../../../tools/monorepo.mjs";
import { canaryEnv, gitEnv, sealedEnv, sealedPath } from "../../../tools/sealed-env.mjs";
import { GUARD_ARG } from "../../../tools/no-outside-fetch.mjs";

/**
 * `prefix` names the temp folder. `claudeScripts` (T3 only): transcripts the Claude CLI
 * stand-in replays, by name, for every start (`stub-claude`'s `scripts/default.ndjson`).
 */
/** A command run to its end without blocking this process: `{status, stdout, stderr}`. */
function runCli(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

export function peerFixture(rustBinary, prefix, { host = "127.0.0.1" } = {}) {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  const children = [];
  process.once("exit", () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    try {
      NodeFS.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // A server still writing as it stops; the temp folder goes with the next cleanup.
    }
  });

  const freePort = () =>
    new Promise((resolve) => {
      const server = NodeNet.createServer();
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });

  function scratchProject(dir) {
    const project = NodePath.join(dir, "project");
    NodeFS.mkdirSync(project, { recursive: true });
    NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: project, env: gitEnv() });
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.name=p", "-c", "user.email=p@p", "commit", "-q", "--allow-empty", "-m", "init"],
      { cwd: project, env: gitEnv() },
    );
    return project;
  }

  function start(command, args, options, port) {
    const child = NodeChildProcess.spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    return new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`${command}: no pairing code in 90 s`)), 90_000);
      const onData = (data) => {
        out += data;
        const match = out.match(/pair#token=([A-Za-z0-9]+)/);
        if (match) {
          clearTimeout(timer);
          resolve({ origin: `http://${host}:${port}`, code: match[1] });
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("exit", (code) => reject(new Error(`${command} exited ${code}`)));
    });
  }

  const SETTINGS = { enableProviderUpdateChecks: false, linkedEnvironmentsEnabled: true };

  async function startTs(name, { script } = {}) {
    const dir = NodePath.join(root, name);
    const project = scratchProject(dir);
    const base = NodePath.join(dir, "base");
    const home = NodePath.join(dir, "home");
    NodeFS.mkdirSync(NodePath.join(base, "userdata"), { recursive: true });
    NodeFS.mkdirSync(home);
    // The Claude CLI stand-in: with no script a turn starts and stays running, with no model;
    // `script` is the transcript every start replays.
    const stub = claudeStub(dir);
    if (script !== undefined) {
      NodeFS.mkdirSync(NodePath.join(dir, "cli", "scripts"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, "cli", "scripts", "default.ndjson"), script);
    }
    NodeFS.writeFileSync(
      NodePath.join(base, "userdata", "settings.json"),
      JSON.stringify({
        ...SETTINGS,
        providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: true, config: { binaryPath: stub.binary } } },
      }),
    );
    const port = await freePort();
    const node = process.execPath;
    let tsEnv;
    const { origin, code } = await start(
      node,
      [
        GUARD_ARG,
        NodePath.join(monorepo(), "apps/server/src/bin.ts"),
        "--no-browser",
        "--auto-bootstrap-project-from-cwd",
        "--port",
        String(port),
        "--host",
        host,
        "--base-dir",
        base,
        project,
      ],
      {
        cwd: project,
        env: (tsEnv = {
          HOME: home,
          USER: NodeOS.userInfo().username,
          PATH: sealedPath(dir, [NodePath.dirname(node), "/usr/bin", "/bin"].join(":")),
          T3CODE_HOME: base,
          T3CODE_NO_BROWSER: "1",
          SHELL: "/bin/sh",
          ...canaryEnv(),
        }),
      },
      port,
    );
    const bearer = await pairBearer(origin, code);
    const mcp = `Bearer ${await oauthMcpToken(origin, bearer)}`;
    const forget = () => {
      for (const file of NodeFS.readdirSync(stub.records)) NodeFS.rmSync(NodePath.join(stub.records, file));
    };
    // `cli`: the T3 command line on this server's home (`t3 <args>`).
    const cli = (args) =>
      runCli(node, [GUARD_ARG, NodePath.join(monorepo(), "apps/server/src/bin.ts"), ...args, "--base-dir", base], {
        cwd: project,
        env: tsEnv,
      });
    return { kind: "T3", name, origin, bearer, mcp, forget, cli, credential: () => tsCredential(stub.records) };
  }

  async function startRust(name) {
    const dir = NodePath.join(root, name);
    const project = scratchProject(dir);
    const state = NodePath.join(dir, "state");
    NodeFS.mkdirSync(state, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(state, "settings.json"), JSON.stringify(SETTINGS));
    const port = await freePort();
    const capture = NodePath.join(state, "mcp-capture.json");
    const { origin, code } = await start(
      rustBinary,
      ["--listen", `${host}:${port}`, "--state-dir", state, "--project", project],
      { env: { ...sealedEnv(dir), REPLAY_MCP_CAPTURE: capture } },
      port,
    );
    const bearer = await pairBearer(origin, code);
    const forget = () => NodeFS.rmSync(capture, { force: true });
    const cli = (args) => runCli(rustBinary, [...args, "--state-dir", state], { env: sealedEnv(dir) });
    return {
      kind: "Conn", name, origin, bearer, mcp: `Bearer ${bearer}`, forget, cli,
      credential: () => rustCredential(capture),
    };
  }

  /** One RPC call over `/ws`; resolves with the raw `Exit`. */
  async function rpc(server, tag, payload) {
    const response = await fetch(`${server.origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.bearer}` },
    });
    if (!response.ok) throw new Error(`ticket: ${response.status}`);
    const { ticket } = await response.json();
    const url = new URL(server.origin);
    url.protocol = "ws:";
    url.pathname = "/ws";
    url.search = new URLSearchParams({ orchestrationProtocol: "2", wsTicket: ticket }).toString();
    const socket = new WebSocket(url);
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${tag}: no answer in 60 s`)), 60_000);
        socket.onerror = () => reject(new Error(`${tag}: socket failed`));
        socket.onopen = () =>
          socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, headers: [], payload }));
        socket.onmessage = ({ data }) => {
          for (const line of String(data).split("\n").filter(Boolean)) {
            const parsed = JSON.parse(line);
            for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
              if (message._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
              if (message._tag === "Exit" && message.requestId === "1") {
                clearTimeout(timer);
                resolve(message.exit);
              }
            }
          }
        };
      });
    } finally {
      socket.close();
    }
  }

  async function post(server, path, body) {
    const response = await fetch(`${server.origin}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(`${path} ${response.status}: ${JSON.stringify(json)}`);
    return json;
  }

  const descriptor = async (server) => (await fetch(`${server.origin}/.well-known/t3/environment`)).json();

  /** A tool result as the agent sees it: the structured value, or the failure code and text. */
  function outcome(reply) {
    if (reply.error !== undefined) return { rpcError: reply.error.code, message: reply.error.message };
    if (reply.result.isError) {
      const text = reply.result.content?.[0]?.text ?? "";
      try {
        const failure = JSON.parse(text);
        return { failure: failure.code, message: failure.message };
      } catch {
        return { failure: text };
      }
    }
    return { ok: reply.result.structuredContent };
  }

  /** A value's shape: types, sorted keys, the first array item's shape. */
  const shapeOf = (value) =>
    value === null
      ? "null"
      : Array.isArray(value)
        ? value.length === 0 ? [] : [shapeOf(value[0])]
        : typeof value === "object"
          ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf(value[k])]))
          : typeof value;

  /** JSON with sorted keys and placeholders for what differs between servers. */
  function normalize(value, names) {
    let text = JSON.stringify(value ?? "<missing>", (_, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
        : v,
    );
    for (const [from, to] of names) text = text.split(from).join(to);
    return text
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>")
      .replace(/"traceId":"[^"]*"/g, '"traceId":"<trace>"');
  }

  return { root, startTs, startRust, rpc, post, descriptor, outcome, shapeOf, normalize };
}
