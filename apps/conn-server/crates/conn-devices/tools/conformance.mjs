#!/usr/bin/env node
// Device conformance: the T3 server and the Conn Server (`examples/replay_server`) get the same
// device calls with stand-in `ssh` and `npm` first on PATH (tools/stubs). The stand-in ssh plays
// a Mac with Xcode, its forward serves a stand-in hub and agent-device daemon, and every run is
// recorded. The check compares, after normalising ids, ports, paths and times:
// - the answer of each `device.*` call and the first `subscribeDeviceState` value;
// - the hub proxy's answers (device list, screenshot, an MJPEG stream with its still-frame repeat);
// - the four device tools of a thread with device access, and the agent-device runs of the
//   command `device_open` returns;
// - every distinct ssh argv and stdin, npm run and agent-device run, and every hub request.
// This machine's xcrun is off PATH for both, so the local host offers nothing on either.
//
//   node crates/conn-devices/tools/conformance.mjs target/release/examples/replay_server
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { McpSession, oauthMcpToken, pairBearer } from "../../conn-mcp/tools/mcp-client.mjs";
import { claudeStub, rustCredential, tsCredential } from "../../conn-mcp/tools/handoff-fixture.mjs";
import { importSource, monorepo, packageImporter } from "../../../tools/monorepo.mjs";
import { canaryEnv, gitEnv, sealedEnv, standInShell, HOST_CLIS } from "../../../tools/sealed-env.mjs";
import { GUARD_ARG } from "../../../tools/no-outside-fetch.mjs";

const rustBinary = process.argv[2] && NodePath.resolve(process.argv[2]);
if (!rustBinary) {
  console.error("usage: conformance.mjs <replay_server>");
  process.exit(2);
}
monorepo();

const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-devices-conf-")));
const children = [];
process.once("exit", () => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  NodeFS.rmSync(root, { recursive: true, force: true });
});

const STUBS = NodePath.join(NodePath.dirname(new URL(import.meta.url).pathname), "stubs");
const node = process.execPath;

/** A folder of executables that run the stand-ins with this Node. */
function stubBin(dir) {
  NodeFS.mkdirSync(dir, { recursive: true });
  for (const name of ["ssh", "npm"]) {
    NodeFS.writeFileSync(
      NodePath.join(dir, name),
      `#!/bin/sh\nexec '${node}' '${NodePath.join(STUBS, `${name}.mjs`)}' "$@"\n`,
      { mode: 0o755 },
    );
  }
  return dir;
}

/** `PATH` folders with links to everything but xcrun and the provider and host CLIs. */
function pathWithout(dir, path) {
  const hidden = new Set([...HOST_CLIS, "xcrun", "ssh", "npm", "pnpm"]);
  return path
    .split(":")
    .filter(Boolean)
    .map((folder, index) => {
      let names;
      try {
        names = NodeFS.readdirSync(folder);
      } catch {
        return null;
      }
      if (!names.some((name) => hidden.has(name))) return folder;
      const links = NodePath.join(dir, "path", String(index));
      NodeFS.mkdirSync(links, { recursive: true });
      for (const name of names) {
        if (hidden.has(name)) continue;
        try {
          NodeFS.symlinkSync(NodePath.join(folder, name), NodePath.join(links, name));
        } catch {}
      }
      return links;
    })
    .filter(Boolean)
    .join(":");
}

function scratchProject(side) {
  const dir = NodePath.join(root, side, "parity");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir, env: gitEnv() });
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=p", "-c", "user.email=p@p", "commit", "-q", "--allow-empty", "-m", "init"],
    { cwd: dir, env: gitEnv() },
  );
  return dir;
}

const freePort = () =>
  new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

function start(command, args, options, port) {
  const child = NodeChildProcess.spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`${command}: no pairing code in 90 s\n${out}`)), 90_000);
    const onData = (data) => {
      out += data;
      const match = out.match(/pair#token=([A-Za-z0-9]+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ origin: `http://127.0.0.1:${port}`, code: match[1] });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => reject(new Error(`${command} exited ${code}\n${out}`)));
  });
}

const SETTINGS = {
  enableDeviceSupport: true,
  enableAgentDeviceAccess: true,
  deviceOnboardingCompleted: true,
  deviceHosts: [{ kind: "ssh", id: "mac", label: "Studio", target: "192.0.2.10" }],
};

async function startTs() {
  const side = NodePath.join(root, "ts");
  const project = scratchProject("ts");
  const base = NodePath.join(side, "base");
  const home = NodePath.join(side, "home");
  NodeFS.mkdirSync(NodePath.join(base, "userdata"), { recursive: true });
  NodeFS.mkdirSync(home, { recursive: true });
  const stub = claudeStub(side);
  NodeFS.writeFileSync(
    NodePath.join(base, "userdata", "settings.json"),
    JSON.stringify({
      enableProviderUpdateChecks: false,
      providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: true, config: { binaryPath: stub.binary } } },
      ...SETTINGS,
    }),
  );
  const port = await freePort();
  const records = NodePath.join(side, "records");
  const path = `${stubBin(NodePath.join(side, "stubs"))}:${pathWithout(side, `${NodePath.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`)}`;
  const { origin, code } = await start(
    node,
    [GUARD_ARG, NodePath.join(monorepo(), "apps/server/src/bin.ts"), "--no-browser", "--auto-bootstrap-project-from-cwd",
      "--port", String(port), "--host", "127.0.0.1", "--base-dir", base, project],
    {
      cwd: project,
      env: {
        HOME: home,
        USER: NodeOS.userInfo().username,
        PATH: path,
        T3CODE_HOME: base,
        T3CODE_NO_BROWSER: "1",
        // A stand-in login shell: a real one would put /usr/bin first again (path_helper).
        SHELL: standInShell(side),
        DEVICE_STUB_RECORDS: records,
        ...canaryEnv(),
      },
    },
    port,
  );
  const bearer = await pairBearer(origin, code);
  return {
    name: "T3 server", side, origin, bearer, records, path, threadRecords: stub.records, project,
    stateDir: NodePath.join(base, "userdata"), baseDir: base,
    mcpAuthorization: `Bearer ${await oauthMcpToken(origin, bearer)}`,
  };
}

async function startRust() {
  const side = NodePath.join(root, "rust");
  const project = scratchProject("rust");
  const base = NodePath.join(side, "base");
  const state = NodePath.join(base, "userdata");
  NodeFS.mkdirSync(state, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(state, "settings.json"), JSON.stringify(SETTINGS));
  const port = await freePort();
  const records = NodePath.join(side, "records");
  const capture = NodePath.join(state, "mcp-capture.json");
  const env = sealedEnv(side);
  const path = `${stubBin(NodePath.join(side, "stubs"))}:${pathWithout(side, `${NodePath.dirname(node)}:${env.PATH}`)}`;
  const { origin, code } = await start(
    rustBinary,
    ["--listen", `127.0.0.1:${port}`, "--state-dir", state, "--project", project],
    { cwd: project, env: { ...env, PATH: path, DEVICE_STUB_RECORDS: records, REPLAY_MCP_CAPTURE: capture } },
    port,
  );
  const bearer = await pairBearer(origin, code);
  return {
    name: "Conn Server", side, origin, bearer, records, path, capture, project, stateDir: state, baseDir: base,
    mcpAuthorization: `Bearer ${bearer}`,
  };
}

/** One RPC over `/ws`; resolves with the exit, or the first chunk of a stream. */
async function rpc(server, tag, payload) {
  const answer = await rpcRaw(server, tag, payload);
  decodeCheck(`${server.name === "Conn Server" ? "" : "T3 "}${tag}`, answer);
  if (server.name === "Conn Server") decodedTags.add(tag);
  return answer;
}

async function rpcRaw(server, tag, payload) {
  const ticket = await fetch(`${server.origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.bearer}` },
  }).then((r) => r.json());
  const url = new URL(server.origin);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.search = new URLSearchParams({ orchestrationProtocol: "2", wsTicket: ticket.ticket }).toString();
  const socket = new WebSocket(url);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${server.name} ${tag}: no answer in 120 s`)), 120_000);
      const finish = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      socket.onerror = () => reject(new Error(`${server.name} ${tag}: socket failed`));
      socket.onopen = () => socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, headers: [], payload }));
      socket.onmessage = ({ data }) => {
        for (const line of String(data).split("\n").filter(Boolean)) {
          const parsed = JSON.parse(line);
          for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
            if (message._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
            if (message._tag === "Chunk" && message.requestId === "1") finish({ chunk: message.values[0] });
            if (message._tag === "Exit" && message.requestId === "1") {
              const exit = message.exit;
              if (exit._tag === "Success") finish({ ok: exit.value ?? null });
              else {
                const reasons = Array.isArray(exit.cause) ? exit.cause : [exit.cause];
                const failure = reasons.find((r) => r?._tag === "Fail")?.error;
                finish({ error: failure ?? { defect: reasons } });
              }
            }
          }
        }
      };
    });
  } finally {
    socket.close();
  }
}

// Every answer of the Conn Server also goes through the contract's own decoders.
const load = packageImporter("packages/contracts");
const Schema = await load("effect/Schema");
const Exit = await load("effect/Exit");
const { WsRpcGroup } = await importSource("packages/contracts/src/rpc.ts");
const contracts = await importSource("packages/contracts/src/device.ts");
const undecoded = [];
function decodeCheck(label, answer) {
  const tag = label.replace(/^T3 /, "");
  const rpc = WsRpcGroup.requests.get(tag);
  if (!rpc) return;
  // A payload that failed to decode is a defect, not a typed error: nothing to decode.
  if (answer.error?.defect) return;
  const [schema, value] =
    "chunk" in answer
      ? [contracts.DeviceServiceState, answer.chunk]
      : "ok" in answer
        ? [rpc.successSchema, answer.ok ?? undefined]
        : [rpc.errorSchema, answer.error];
  // Both servers send `null` for a detail T3 set to undefined (`hostStatusDetail`, a host's
  // `detail`); the real client reads it as absent (effect-client.mjs decodes such a state).
  const exit = Schema.decodeUnknownExit(schema)(withoutNulls(value));
  if (Exit.isFailure(exit)) undecoded.push(`${label}: ${String(exit.cause).split("\n").slice(0, 3).join(" ")}`);
}
const decodedTags = new Set();
const withoutNulls = (value) =>
  Array.isArray(value)
    ? value.map(withoutNulls)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([k, v]) => !(v === null && (k === "hostStatusDetail" || k === "detail")))
            .map(([k, v]) => [k, withoutNulls(v)]),
        )
      : value;

const servers = await Promise.all([startTs(), startRust()]);

/** Replaces what differs by server only: ports, paths, ids, hashes, times. */
function normalise(server, value) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  const replace = (from, to) => {
    if (from) text = text.split(from).join(to);
  };
  replace(server.stateDir, "<state>");
  replace(server.baseDir, "<base>");
  replace(server.side, "<side>");
  replace(root, "<root>");
  replace(NodeFS.realpathSync(node), "<node>");
  replace(node, "<node>");
  text = text
    .replace(/t3-[0-9a-f]{24}/g, "t3-<session>")
    .replace(/hosts\/[0-9a-f]{24}/g, "hosts/<owner>")
    .replace(/const owner = \\?"[0-9a-f]{24}\\?";/g, "const owner = <owner>;")
    .replace(/"owner":"[0-9a-f]{24}"/g, '"owner":"<owner>"')
    .replace(/hosts\/[0-9a-f]{24}\.json/g, "hosts/<config>.json")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>")
    .replace(/"revision":\d+/g, '"revision":"<n>"')
    .replace(/thread-[a-z]+-[0-9a-f-]+|thread:[^"\\ ]+/g, "<thread>")
    .replace(/\.staging-[^/"\\]+/g, ".staging-<x>");
  return typeof value === "string" ? text : JSON.parse(text);
}

function canonical(value) {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );
}

let failed = 0;
const report = (line, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "DIFF"} ${line}`);
  if (!ok && detail) console.log(`       ${detail}`);
};

// Known differences, each with its reason. They must stay exactly these.
const KNOWN = {
  // T3 offers Expo and Simlock hosts; this server serves neither and leaves both flags out.
  "subscribeDeviceState first value": true,
  // T3 with its Expo and Simlock services reads EXPO_TOKEN or `eas login`, and this machine's
  // agent-device gateway; this server serves neither kind of host and answers with the T3
  // device service's own error for that case.
  "device.easAccount": true,
  "device.simlockIdentity": true,
};

async function compare(label, call, view = (v) => v) {
  const values = await Promise.all(servers.map(async (server) => normalise(server, view(await call(server)))));
  const [ts, rust] = values.map(canonical);
  if (label === "subscribeDeviceState first value") {
    const only = values[0].filter((k) => !values[1].includes(k));
    const extra = values[1].filter((k) => !values[0].includes(k));
    const ok = extra.length === 0 && canonical(only) === canonical(["supportsEasHosts", "supportsSimlockHosts"]);
    report(`${label}: same keys but T3's supportsEasHosts and supportsSimlockHosts (known)`, ok, ok ? undefined : `only T3 ${only} / only Conn ${extra}`);
    return values;
  }
  if (KNOWN[label]) {
    report(`${label}: known difference (both answer an error)`, values.every((v) => v?.error));
    return values;
  }
  report(label, ts === rust, ts === rust ? undefined : `T3   ${ts}\n       Conn ${rust}`);
  return values;
}

// The state without what depends on timing: listing order of statuses is a map.
// T3 offers Expo and Simlock hosts (`supportsEasHosts`, `supportsSimlockHosts`); this server
// serves neither and leaves the flags out (known, checked on the first subscribed value).
const stateView = (v) => {
  const value = v.ok ?? v.chunk;
  if (!value || typeof value !== "object" || !("hostStatus" in value)) return v;
  const { supportsEasHosts, supportsSimlockHosts, ...rest } = value;
  void supportsEasHosts;
  void supportsSimlockHosts;
  return { ...v, [v.ok ? "ok" : "chunk"]: rest };
};

// Wait until both servers follow the SSH host in the settings.
for (const server of servers) {
  for (let i = 0; i < 100; i++) {
    const state = await rpc(server, "device.list", { inspectOnly: true });
    if ((state.ok?.hosts ?? []).some((h) => h.id === "mac")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}

await compare("subscribeDeviceState first value", (s) => rpc(s, "subscribeDeviceState", {}), (v) => {
  // The first value may arrive before or after the host summary is in; compare its keys.
  const value = v.chunk ?? {};
  return Object.keys(value).sort();
});
await compare("device.testHost", (s) => rpc(s, "device.testHost", { id: "probe", label: "Probe", target: "192.0.2.10" }));
await compare("device.testHost (bad target)", (s) => rpc(s, "device.testHost", { id: "local", label: "x", target: "192.0.2.10" }), (v) => ({ failed: v.ok === undefined }));
await compare("device.list", (s) => rpc(s, "device.list", {}), stateView);
await compare("device.list inspectOnly", (s) => rpc(s, "device.list", { inspectOnly: true }), stateView);
await compare("device.open boots SIM-OFF", (s) => rpc(s, "device.open", { threadId: "thread-panel", hostId: "mac", deviceId: "SIM-OFF", platform: "ios" }));
await compare("device.open attaches SIM-ON", (s) => rpc(s, "device.open", { threadId: "thread-panel", hostId: "mac", deviceId: "SIM-ON", platform: "ios" }));
await compare("device.open unknown device", (s) => rpc(s, "device.open", { threadId: "thread-panel", hostId: "mac", deviceId: "NOPE", platform: "ios" }));
await compare("device.open android", (s) => rpc(s, "device.open", { threadId: "thread-panel", hostId: "mac", deviceId: "emulator-5554", platform: "android" }));
await compare("device.open unknown host", (s) => rpc(s, "device.open", { threadId: "thread-panel", hostId: "elsewhere", deviceId: "SIM-ON", platform: "ios" }));
await compare("device.list after open", (s) => rpc(s, "device.list", {}), stateView);
await compare("device.detail", (s) => rpc(s, "device.detail", { hostId: "mac", deviceId: "SIM-ON" }));
for (const action of [
  { type: "setAppearance", value: "light" },
  { type: "setTextSize", value: "large" },
  { type: "setToggle", setting: "increaseContrast", value: true },
  { type: "setToggle", setting: "reduceMotion", value: false },
  { type: "setLiquidGlass", value: "clear" },
  { type: "setLocation", latitude: 52.37, longitude: 4 },
  { type: "setPermission", appId: "com.example", permission: "camera", decision: "grant" },
  { type: "setPermission", appId: "com.example", permission: "notifications", decision: "revoke" },
  { type: "openUrl", url: "https://example.test/a b" },
  { type: "sendPush", appId: "com.example", payload: "Hello" },
  { type: "setOrientation", value: "landscape_left" },
  { type: "shake" },
]) {
  await compare(`device.action ${action.type}${action.setting ? ` ${action.setting}` : ""}`, (s) => rpc(s, "device.action", { hostId: "mac", deviceId: "SIM-ON", ...action }));
}
await compare("device.detail unknown device", (s) => rpc(s, "device.detail", { hostId: "mac", deviceId: "NOPE" }));
await compare("device.easAccount", (s) => rpc(s, "device.easAccount", {}));
await compare("device.simlockIdentity", (s) => rpc(s, "device.simlockIdentity", {}));

// The hub proxy, with the server's own bearer.
const hubGet = async (server, path, init = {}) => {
  const response = await fetch(`${server.origin}/api/device-hub${path}`, {
    ...init,
    headers: { authorization: `Bearer ${server.bearer}`, ...(init.headers ?? {}) },
  });
  return { status: response.status, type: response.headers.get("content-type"), cookie: response.headers.get("set-cookie"), cache: response.headers.get("cache-control"), body: await response.text() };
};
await compare("hub proxy GET /api/devices", (s) => hubGet(s, "/api/devices?hostId=mac"), (v) => ({ ...v, body: JSON.parse(v.body) }));
await compare("hub proxy refuses /api/devices/boot", (s) => hubGet(s, "/api/devices/boot?hostId=mac", { method: "POST" }));
await compare("hub proxy refuses POST /api/devices", (s) => hubGet(s, "/api/devices?hostId=mac", { method: "POST" }));
await compare("hub proxy without a credential", (s) => fetch(`${s.origin}/api/device-hub/api/devices`).then((r) => r.status));
await compare("hub proxy screenshot", async (s) => {
  const response = await fetch(`${s.origin}/api/device-hub/vendor/serve-sim/api/screenshot?device=SIM-ON&hostId=mac`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.bearer}` },
  });
  return { status: response.status, type: response.headers.get("content-type"), bytes: Buffer.from(await response.arrayBuffer()).toString("hex") };
});
await compare("hub proxy MJPEG still frame", async (s) => {
  const controller = new AbortController();
  const response = await fetch(`${s.origin}/api/device-hub/vendor/serve-sim/helper/SIM-ON/stream.mjpeg?hostId=mac`, {
    headers: { authorization: `Bearer ${s.bearer}` },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  let text = "";
  const deadline = Date.now() + 600;
  while (Date.now() < deadline) {
    const next = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), deadline - Date.now()))]);
    if (!next || next.done) break;
    text += Buffer.from(next.value).toString("latin1");
  }
  controller.abort();
  return { status: response.status, cookie: response.headers.get("set-cookie"), cache: response.headers.get("cache-control"), frames: text.split("--frame").length - 1 };
});

// The device tools, from a thread that started with device access.
const launched = await Promise.all(servers.map(async (server) => {
  const session = new McpSession(server.origin, server.mcpAuthorization);
  await session.initialize();
  const projects = await session.callTool("t3_project_list", {});
  const projectId = projects.result.structuredContent.projects.find((p) => p.title === "parity")?.id
    ?? projects.result.structuredContent.projects[0].id;
  const reply = await session.callTool("t3_thread_launch", {
    projectId, title: "Devices", message: "hang",
    modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" }, runtimeMode: "full-access",
    workspaceStrategy: { type: "root" }, clientRequestId: "devices",
  });
  if (reply.result?.isError || reply.error) throw new Error(`${server.name} launch: ${JSON.stringify(reply)}`);
  return reply.result.structuredContent;
}));
const credentials = await Promise.all([tsCredential(servers[0].threadRecords), rustCredential(servers[1].capture)]);
const agents = credentials.map((entry) => new McpSession(new URL(entry.url).origin, entry.headers.Authorization));
await Promise.all(agents.map((agent) => agent.initialize()));

const toolOutcome = (reply) => {
  if (reply.error) return { rpcError: reply.error.code, message: reply.error.message };
  const result = reply.result;
  const content = (result.content ?? []).map((c) => (c.type === "image" ? { type: "image", mimeType: c.mimeType, bytes: c.data.length } : { type: c.type, text: c.type === "text" ? (safeJson(c.text) ?? c.text) : undefined }));
  return { isError: result.isError, structured: result.structuredContent ?? null, content };
};
const safeJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const opened = [];
const tool = async (label, name, args, keep) => {
  const values = await Promise.all(agents.map(async (agent, i) => {
    const reply = await agent.callTool(name, args);
    if (keep) keep(i, reply);
    return normalise(servers[i], toolOutcome(reply));
  }));
  const [ts, rust] = values.map(canonical);
  report(`tool ${label}`, ts === rust, ts === rust ? undefined : `T3   ${ts}\n       Conn ${rust}`);
};
await tool("device_list", "device_list", {});
await tool("device_list hostId by label", "device_list", { hostId: "studio" });
await tool("device_list unknown host", "device_list", { hostId: "nowhere" });
await tool("device_open SIM-ON", "device_open", { hostId: "mac", deviceId: "SIM-ON" }, (i, reply) => (opened[i] = reply.result?.structuredContent));
await tool("device_open both platforms default", "device_open", { hostId: "mac", platform: "android" });
await tool("device_screenshot", "device_screenshot", {});
await tool("device_screenshot not open", "device_screenshot", { deviceId: "SIM-OFF" });
// The returned command, run as an agent runs it, and a refused subcommand.
for (const args of [["snapshot", "-i"], ["daemon", "stop"], ["help"]]) {
  const runs = servers.map((server, i) => {
    const command = opened[i]?.agentDevice?.command;
    if (!command) return { missing: true };
    const result = NodeChildProcess.spawnSync(command, args, {
      env: { PATH: server.path, HOME: NodePath.join(server.side, "home"), DEVICE_STUB_RECORDS: server.records },
      encoding: "utf8",
      timeout: 30_000,
    });
    return normalise(server, { status: result.status, stdout: result.stdout, stderr: result.stderr });
  });
  const [ts, rust] = runs.map(canonical);
  report(`agent-device ${args.join(" ")} through the launcher`, ts === rust, ts === rust ? undefined : `T3   ${ts}\n       Conn ${rust}`);
}
await tool("device_close", "device_close", { deviceId: "SIM-ON", shutdown: true });
await tool("device_close nothing open", "device_close", {});

await compare("device.close", (s) => rpc(s, "device.close", { threadId: "thread-panel", hostId: "mac", deviceId: "SIM-ON" }));
await compare("device.shutdown", (s) => rpc(s, "device.shutdown", { hostId: "mac", deviceId: "SIM-OFF", platform: "ios" }));
await compare("device.list after shutdown", (s) => rpc(s, "device.list", {}), stateView);
await compare("device.configure off", (s) => rpc(s, "device.configure", { enabled: false }), stateView);
await compare("device.list while off", (s) => rpc(s, "device.list", {}), stateView);
await compare("device.open while off", (s) => rpc(s, "device.open", { threadId: "thread-panel", hostId: "mac", deviceId: "SIM-ON", platform: "ios" }));

report(
  `the Conn Server's answers decode with the contract (${decodedTags.size} methods)`,
  undecoded.length === 0,
  undecoded.join("\n       "),
);
for (const [name, schema] of [["device_list", contracts.DeviceToolListResult], ["device_open", contracts.DeviceToolOpenResult]]) {
  const reply = await agents[1].callTool(name, name === "device_open" ? { hostId: "mac", deviceId: "SIM-ON" } : {});
  const exit = Schema.decodeUnknownExit(schema)(reply.result?.structuredContent);
  report(`tool ${name} result decodes with the contract`, Exit.isSuccess(exit) || reply.result?.isError === true, Exit.isFailure(exit) ? String(exit.cause).split("\n")[0] : undefined);
}

// What both servers ran: every distinct record, normalised.
await new Promise((r) => setTimeout(r, 500));
const recordsOf = (server) => {
  const out = new Map();
  for (const name of NodeFS.existsSync(server.records) ? NodeFS.readdirSync(server.records) : []) {
    const record = JSON.parse(NodeFS.readFileSync(NodePath.join(server.records, name), "utf8"));
    if (record.kind === "hub" && record.path === "/readyz") continue;
    if (record.kind === "hub" && record.path === "/health") continue;
    // Key order in a JSON body carries no meaning.
    if (typeof record.body === "string" && record.body.startsWith("{")) record.body = JSON.parse(record.body);
    const key = canonical(normalise(server, record));
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
};
const [tsRecords, rustRecords] = servers.map(recordsOf);
const kinds = new Set([...tsRecords.keys(), ...rustRecords.keys()].map((k) => JSON.parse(k).kind));
for (const kind of [...kinds].sort()) {
  const pick = (records) => [...records.keys()].filter((k) => JSON.parse(k).kind === kind).sort();
  const [a, b] = [pick(tsRecords), pick(rustRecords)];
  const onlyTs = a.filter((k) => !b.includes(k));
  const onlyRust = b.filter((k) => !a.includes(k));
  report(
    `stub runs: ${kind} (${a.length} distinct)`,
    onlyTs.length === 0 && onlyRust.length === 0,
    [...onlyTs.map((k) => `only T3:   ${k.slice(0, 600)}`), ...onlyRust.map((k) => `only Conn: ${k.slice(0, 600)}`)].join("\n       "),
  );
}
void launched;
console.log(failed === 0 ? "\ndevice conformance: no differences" : `\ndevice conformance: ${failed} differences`);
process.exit(failed === 0 ? 0 : 1);
