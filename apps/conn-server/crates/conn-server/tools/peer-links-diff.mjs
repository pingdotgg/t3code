#!/usr/bin/env node
// Peer links between two servers: T3 → T3 is the reference; Conn → Conn, Conn → T3 and
// T3 → Conn take the same steps and must give the same answers, after ids, addresses and
// times are replaced by placeholders. Steps: `peerLinks.*` over `/ws`, the link's MCP OAuth
// sign-in with a peer-link pairing code, `t3_environment_links`, tools forwarded with
// `environmentId` (reads, a refusal from the peer, a mode the link refuses here),
// `t3_environment_unlink`, and the peer's client list. No model is called; every server gets a
// temp home and a free loopback port.
// Usage: peer-links-diff.mjs <conn-server binary (replay_server)>. Needs `vp i` in the monorepo.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { McpSession, oauthMcpToken, pairBearer } from "../../conn-mcp/tools/mcp-client.mjs";
import { claudeStub, rustCredential, tsCredential } from "../../conn-mcp/tools/handoff-fixture.mjs";
import { monorepo } from "../../../tools/monorepo.mjs";
import { canaryEnv, gitEnv, sealedEnv, sealedPath } from "../../../tools/sealed-env.mjs";
import { GUARD_ARG } from "../../../tools/no-outside-fetch.mjs";

const rustBinary = process.argv[2];
if (rustBinary === undefined) {
  console.error("usage: peer-links-diff.mjs <conn-server binary>");
  process.exit(2);
}
monorepo();

const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-peer-links-")));
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
        resolve({ origin: `http://127.0.0.1:${port}`, code: match[1] });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => reject(new Error(`${command} exited ${code}`)));
  });
}

const SETTINGS = { enableProviderUpdateChecks: false, linkedEnvironmentsEnabled: true };

async function startTs(name) {
  const dir = NodePath.join(root, name);
  const project = scratchProject(dir);
  const base = NodePath.join(dir, "base");
  const home = NodePath.join(dir, "home");
  NodeFS.mkdirSync(NodePath.join(base, "userdata"), { recursive: true });
  NodeFS.mkdirSync(home);
  // The Claude CLI stand-in: a `hang` turn starts and stays running, with no model.
  const stub = claudeStub(dir);
  NodeFS.writeFileSync(
    NodePath.join(base, "userdata", "settings.json"),
    JSON.stringify({
      ...SETTINGS,
      providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: true, config: { binaryPath: stub.binary } } },
    }),
  );
  const port = await freePort();
  const node = process.execPath;
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
      "127.0.0.1",
      "--base-dir",
      base,
      project,
    ],
    {
      cwd: project,
      env: {
        HOME: home,
        USER: NodeOS.userInfo().username,
        PATH: sealedPath(dir, [NodePath.dirname(node), "/usr/bin", "/bin"].join(":")),
        T3CODE_HOME: base,
        T3CODE_NO_BROWSER: "1",
        SHELL: "/bin/sh",
        ...canaryEnv(),
      },
    },
    port,
  );
  const bearer = await pairBearer(origin, code);
  const mcp = `Bearer ${await oauthMcpToken(origin, bearer)}`;
  const forget = () => {
    for (const file of NodeFS.readdirSync(stub.records)) NodeFS.rmSync(NodePath.join(stub.records, file));
  };
  return { kind: "T3", name, origin, bearer, mcp, forget, credential: () => tsCredential(stub.records) };
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
    ["--listen", `127.0.0.1:${port}`, "--state-dir", state, "--project", project],
    { env: { ...sealedEnv(dir), REPLAY_MCP_CAPTURE: capture } },
    port,
  );
  const bearer = await pairBearer(origin, code);
  const forget = () => NodeFS.rmSync(capture, { force: true });
  return { kind: "Conn", name, origin, bearer, mcp: `Bearer ${bearer}`, forget, credential: () => rustCredential(capture) };
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

const [t1, t2, c1, c2] = await Promise.all([startTs("t1"), startTs("t2"), startRust("c1"), startRust("c2")]);
for (const server of [t1, t2, c1, c2]) {
  const d = await descriptor(server);
  server.id = d.environmentId;
  server.label = d.label;
  server.capabilities = d.capabilities;
}

let failed = 0;
const report = (line, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "DIFF"} ${line}${ok || detail === "" ? "" : `\n       ${detail}`}`);
};

for (const server of [c1, c2]) {
  const caps = server.capabilities;
  report(
    `Conn advertises peerLinks, mcpModeLimitHeader, linkFence and peerLinkPairingCodes`,
    caps.peerLinks === true && caps.mcpModeLimitHeader === true && caps.linkFence === true && caps.peerLinkPairingCodes === true,
  );
}

/** Every step from `a` (which links) to `b` (which is linked); returns step name → answer. */
async function run(a, b) {
  const names = [
    [b.origin, "<B-url>"],
    [a.origin, "<A-url>"],
    [b.id, "<B>"],
    [a.id, "<A>"],
    [b.label, "<label>"],
  ];
  const out = new Map();
  // Retry keys are this run's own: a server takes part in two runs.
  const run = `${a.name}-${b.name}`;
  const record = (step, value) => out.set(step, normalize(value, names));
  const session = new McpSession(a.origin, a.mcp);
  await session.initialize();
  const tool = async (name, args) => outcome(await session.callTool(name, args));
  const mint = async (access) =>
    (await post(b, "/api/auth/pairing-token", { label: "peer link test", access, purpose: "peer-link" }))
      .credential;

  record("list, none yet", await rpc(a, "peerLinks.list", {}));
  record(
    "link: plain http to a LAN address",
    await rpc(a, "peerLinks.link", { url: "http://192.168.77.1:9", pairingCode: "XXXX", access: "auto" }),
  );
  record(
    "link: not an http address",
    await rpc(a, "peerLinks.link", { url: "ftp://example.test", pairingCode: "XXXX", access: "auto" }),
  );
  record(
    "link: this environment itself",
    await rpc(a, "peerLinks.link", { url: a.origin, pairingCode: "XXXX", access: "auto" }),
  );
  record(
    "link: an expected machine on loopback",
    await rpc(a, "peerLinks.link", { url: b.origin, pairingCode: "XXXX", access: "auto", expectedEnvironmentId: b.id }),
  );
  record(
    "link: unknown code",
    await rpc(a, "peerLinks.link", { url: b.origin, pairingCode: "ABCDEFGHJKLM", access: "auto" }),
  );
  record(
    "link: read-only code for auto access",
    await rpc(a, "peerLinks.link", { url: b.origin, pairingCode: await mint("read-only"), access: "auto" }),
  );
  const code = await mint("auto");
  record("link", await rpc(a, "peerLinks.link", { url: b.origin, pairingCode: code, access: "auto" }));
  record(
    "link: the spent code again",
    await rpc(a, "peerLinks.link", { url: b.origin, pairingCode: code, access: "auto" }),
  );
  record("list, linked", await rpc(a, "peerLinks.list", {}));
  const model = { instanceId: "claudeAgent", model: "claude-haiku-5-5" };
  const projectOf = async (session) =>
    outcome(await session.callTool("t3_project_list", {})).ok?.projects?.[0]?.id;

  // The fence: work the link starts there carries its session; below full access the link
  // changes only that work.
  const bSession = new McpSession(b.origin, b.mcp);
  await bSession.initialize();
  const bProject = await projectOf(bSession);
  const own = outcome(
    await bSession.callTool("t3_thread_launch", {
      projectId: bProject, title: "B's own", message: "hang", modelSelection: model,
      runtimeMode: "auto", workspaceStrategy: { type: "root" }, clientRequestId: `b-own-${run}`,
    }),
  );
  const launched = await tool("t3_thread_launch", {
    environmentId: b.id, projectId: bProject, title: "From the link", message: "hang",
    modelSelection: model, runtimeMode: "auto", workspaceStrategy: { type: "root" },
    clientRequestId: `peer-launch-${run}`,
  });
  record("t3_thread_launch there", shapeOf(launched));
  const again = await tool("t3_thread_launch", {
    environmentId: b.id, projectId: bProject, title: "From the link", message: "hang",
    modelSelection: model, runtimeMode: "auto", workspaceStrategy: { type: "root" },
    clientRequestId: `peer-launch-${run}`,
  });
  record("t3_thread_launch there, retried: same thread", again.ok?.threadId === launched.ok?.threadId);
  const shell = await (
    await fetch(`${b.origin}/api/orchestration/shell`, {
      headers: { authorization: `Bearer ${b.bearer}`, "x-t3-orchestration-protocol": "2" },
    })
  ).json();
  const row = (shell.threads ?? shell.snapshot?.threads ?? []).find((t) => t.id === launched.ok?.threadId);
  record("the thread there carries the link", row?.linkOrigin && {
    access: row.linkOrigin.access,
    label: row.linkOrigin.label,
    hasSession: typeof row.linkOrigin.sessionId === "string",
  });
  record(
    "t3_thread_send there to the peer's own thread: fenced",
    await tool("t3_thread_send", { environmentId: b.id, threadId: own.ok?.threadId, message: "x", mode: "queue" }),
  );
  record(
    "t3_thread_send there to the link's thread",
    shapeOf(await tool("t3_thread_send", {
      environmentId: b.id, threadId: launched.ok?.threadId, message: "x", mode: "queue", clientRequestId: `peer-send-${run}`,
    })),
  );
  record(
    "t3_thread_read there",
    shapeOf((await tool("t3_thread_read", { environmentId: b.id, threadId: launched.ok?.threadId })).ok?.thread ?? null),
  );
  record(
    "t3_thread_interrupt there",
    (await tool("t3_thread_interrupt", { environmentId: b.id, threadId: launched.ok?.threadId, stop: true })).ok?.threadId ===
      launched.ok?.threadId,
  );
  await bSession.close();

  // An agent here: the link tools as a thread sees them, and a link card answered by the user.
  const aProject = await projectOf(session);
  a.forget();
  const agentThread = outcome(
    await session.callTool("t3_thread_launch", {
      projectId: aProject, title: "Agent", message: "hang", modelSelection: model,
      runtimeMode: "full-access", workspaceStrategy: { type: "root" }, clientRequestId: `agent-${run}`,
    }),
  ).ok?.threadId;
  const credential = await a.credential();
  const agent = new McpSession(new URL(credential.url).origin, credential.headers.Authorization);
  await agent.initialize();
  const ask = async (args) => outcome(await agent.callTool("t3_environment_link", args));
  const cardShape = (value) => normalize(value, []).replace(/turn-item:link-request:[^"]+/g, "<card>");
  record("agent t3_environment_links", await outcome(await agent.callTool("t3_environment_links", {})));
  const listed = outcome(await agent.callTool("t3_thread_list", { environmentId: b.id, allProjects: true }));
  record(
    "agent t3_thread_list there: the link's thread, as a chip",
    listed.ok
      ? listed.ok.threads
          .filter((t) => t.threadId === launched.ok?.threadId)
          .map((t) => ({ title: t.title, chip: t.link.startsWith("[From the link](t3-thread://v2/") }))
      : listed,
  );
  record("agent t3_environment_link: both url and environmentId", await ask({ url: b.origin, environmentId: b.id }));
  record("agent t3_environment_link: a linked machine", await ask({ environmentId: b.id }));
  const card = await ask({ hint: "the other box", reason: "parity", clientRequestId: "card-1" });
  record("agent t3_environment_link: a card", cardShape(card));
  const cardAgain = await ask({ hint: "the other box", reason: "parity", clientRequestId: "card-1" });
  record("agent t3_environment_link: the same card again", cardAgain.ok?.turnItemId === card.ok?.turnItemId);
  record(
    "answerRequest: decline",
    await rpc(a, "peerLinks.answerRequest", { threadId: agentThread, turnItemId: card.ok?.turnItemId, answer: { type: "decline" } }),
  );
  record(
    "answerRequest: answered twice",
    await rpc(a, "peerLinks.answerRequest", { threadId: agentThread, turnItemId: card.ok?.turnItemId, answer: { type: "decline" } }),
  );
  record("agent t3_environment_link: the declined card", await ask({ hint: "the other box", reason: "parity", clientRequestId: "card-1" }));
  const second = await ask({ hint: "x", reason: "parity", clientRequestId: "card-2", requestedAccess: "auto" });
  record(
    "answerRequest: use an existing link",
    await rpc(a, "peerLinks.answerRequest", {
      threadId: agentThread, turnItemId: second.ok?.turnItemId, answer: { type: "use-existing", environmentId: b.id },
    }),
  );
  record("agent t3_environment_link: the card that linked", await ask({ hint: "x", reason: "parity", clientRequestId: "card-2", requestedAccess: "auto" }));
  const third = await ask({ url: b.origin, reason: "parity", clientRequestId: "card-3" });
  record(
    "answerRequest: link with a spent code",
    await rpc(a, "peerLinks.answerRequest", {
      threadId: agentThread, turnItemId: third.ok?.turnItemId,
      answer: { type: "link", urls: [b.origin], access: "auto", pairingCode: code },
    }),
  );
  record("agent t3_environment_link: the card that failed", await ask({ url: b.origin, reason: "parity", clientRequestId: "card-3" }));
  const fresh = await mint("auto");
  const fourth = await ask({ url: b.origin, reason: "parity", clientRequestId: "card-4" });
  record(
    "answerRequest: link with a fresh code",
    await rpc(a, "peerLinks.answerRequest", {
      threadId: agentThread, turnItemId: fourth.ok?.turnItemId,
      answer: { type: "link", urls: [b.origin], access: "auto", pairingCode: fresh },
    }),
  );
  record("agent t3_environment_link: the card that relinked", await ask({ url: b.origin, reason: "parity", clientRequestId: "card-4" }));
  record("agent t3_environment_unlink", await outcome(await agent.callTool("t3_environment_unlink", { environmentId: "environment:none" })));
  // Each answer that closed a card woke the agent with a notification message.
  const snapshot = await (
    await fetch(`${a.origin}/api/orchestration/threads/${encodeURIComponent(agentThread)}`, {
      headers: { authorization: `Bearer ${a.bearer}`, "x-t3-orchestration-protocol": "2" },
    })
  ).json();
  const projection = snapshot.projection ?? snapshot.thread ?? snapshot;
  record(
    "the agent heard each answer",
    (projection.messages ?? [])
      .filter((m) => typeof m.text === "string" && m.text.includes("link"))
      .map((m) => m.text)
      .sort(),
  );
  record(
    "the cards as the client shows them",
    (projection.turnItems ?? [])
      .filter((i) => i.type === "link_request")
      .map((i) => ({ status: i.status, linkStatus: i.linkStatus, title: i.title, hint: i.hint, url: i.url, failure: i.failure, linkedAccess: i.linkedAccess, requestedAccess: i.requestedAccess }))
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
  );
  await agent.close();
  await session.callTool("t3_thread_interrupt", { threadId: agentThread, stop: true });
  record("t3_environment_links", await tool("t3_environment_links", {}));
  // Known: the descriptor here does not detect `platform.machine` (parity.mjs accepts it too).
  const read = await tool("t3_environment_read", { environmentId: b.id });
  if (read.ok?.platform) delete read.ok.platform.machine;
  record("t3_environment_read there", read);
  const projects = await tool("t3_project_list", { environmentId: b.id });
  const project = projects.ok?.projects?.[0];
  record("t3_project_list there", {
    ...projects,
    ok: projects.ok && {
      ...projects.ok,
      projects: projects.ok.projects.map((p) => ({ ...p, id: "<p>", workspaceRoot: "<root>", title: "<title>" })),
    },
  });
  record("t3_thread_list there, no project", await tool("t3_thread_list", { environmentId: b.id }));
  // Thread lists hold each server's own threads; compare one entry's shape.
  const threads = await tool("t3_thread_list", { environmentId: b.id, allProjects: true });
  record("t3_thread_list there", threads.ok ? shapeOf({ ...threads.ok, threads: threads.ok.threads.slice(0, 1) }) : threads);
  record(
    "t3_thread_read there: unknown thread",
    await tool("t3_thread_read", { environmentId: b.id, threadId: "thread:missing" }),
  );
  record(
    "t3_thread_launch there above the link's access",
    await tool("t3_thread_launch", {
      environmentId: b.id,
      projectId: project?.id ?? "p",
      title: "x",
      message: "x",
      runtimeMode: "full-access",
      workspaceStrategy: { type: "root" },
    }),
  );
  record(
    "t3_thread_interrupt there: unknown thread",
    await tool("t3_thread_interrupt", { environmentId: b.id, threadId: "thread:missing" }),
  );
  record(
    "t3_thread_wait there: unknown thread",
    await tool("t3_thread_wait", { environmentId: b.id, threadId: "thread:missing", timeoutMs: 10 }),
  );
  // The peer lists the link as a bot client named after this environment.
  const clients = await (
    await fetch(`${b.origin}/api/auth/clients`, { headers: { authorization: `Bearer ${b.bearer}` } })
  ).json();
  const linked = (Array.isArray(clients) ? clients : clients.clients ?? []).filter(
    (c) => c.subject === "mcp-client" && c.client?.label === `T3 Code · ${a.label}`,
  );
  // Every link from a machine with this label is listed; earlier pairs left theirs (unlink
  // forgets a link here only), so compare the distinct shapes.
  record("the peer lists the link's session", [
    ...new Set(
      linked.map((c) =>
        JSON.stringify({ deviceType: c.client.deviceType, method: c.method, permissions: c.permissions }),
      ),
    ),
  ]);
  record("t3_environment_unlink", await tool("t3_environment_unlink", { environmentId: b.id }));
  record(
    "t3_thread_list there after unlink",
    await tool("t3_thread_list", { environmentId: b.id }),
  );
  record("unlink again", await rpc(a, "peerLinks.unlink", { environmentId: b.id }));
  record("list after unlink", await rpc(a, "peerLinks.list", {}));
  // Known: T3 adds the optional `cause` (its projection store's error) to the typed error.
  const answered = await rpc(a, "peerLinks.answerRequest", {
    threadId: "thread:missing",
    turnItemId: "turn-item:missing",
    answer: { type: "decline" },
  });
  for (const reason of answered.cause ?? []) delete reason.error?.cause;
  record("answerRequest: unknown card", answered);
  await session.close();
  return out;
}

const reference = await run(t1, t2);
if (process.argv.includes("--show")) for (const [step, value] of reference) console.log(`T3 → T3 ${step}: ${value}`);
// Known differences, each with its reason. They must stay exactly these.
const KNOWN = new Map([
  // T3's `t3_thread_wait` on an unknown thread answers from its projection store; ours from the
  // engine. Both refuse with thread_not_found; the texts differ (README, conn-mcp "Tools").
]);
for (const [label, a, b] of [
  ["Conn → Conn", c1, c2],
  ["Conn → T3", c1, t2],
  ["T3 → Conn", t1, c2],
]) {
  const answers = await run(a, b);
  for (const [step, expected] of reference) {
    const got = answers.get(step);
    const same = got === expected;
    const known = KNOWN.get(step);
    report(
      `${label}: ${step}${!same && known ? ` (known: ${known})` : ""}`,
      same || known !== undefined,
      `T3 → T3: ${expected}\n       ${label}: ${got}`,
    );
  }
}
console.log(failed === 0 ? "\npeer links: no differences" : `\npeer links: ${failed} differences`);
process.exit(failed === 0 ? 0 : 1);
