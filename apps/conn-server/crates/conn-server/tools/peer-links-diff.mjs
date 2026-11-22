#!/usr/bin/env node
// Peer links between two servers: T3 → T3 is the reference; Conn → Conn, Conn → T3 and
// T3 → Conn take the same steps and must give the same answers, after ids, addresses and
// times are replaced by placeholders. Steps: `peerLinks.*` over `/ws`, the link's MCP OAuth
// sign-in with a peer-link pairing code, `conn_environment_links`, tools forwarded with
// `environmentId` (reads, a refusal from the peer, a mode the link refuses here),
// `conn_environment_unlink`, and the peer's client list. No model is called; every server gets a
// temp home and a free loopback port.
// Usage: peer-links-diff.mjs <conn-server binary (replay_server)>. Needs `vp i` in the monorepo.
import { McpSession } from "../../conn-mcp/tools/mcp-client.mjs";
import { monorepo } from "../../../tools/monorepo.mjs";
import { peerFixture } from "./peer-fixture.mjs";

const rustBinary = process.argv[2];
if (rustBinary === undefined) {
  console.error("usage: peer-links-diff.mjs <conn-server binary>");
  process.exit(2);
}
monorepo();

const { startTs, startRust, rpc, post, descriptor, outcome, shapeOf, normalize } = peerFixture(
  rustBinary,
  "conn-peer-links-",
);

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
    outcome(await session.callTool("conn_project_list", {})).ok?.projects?.[0]?.id;

  // The fence: work the link starts there carries its session; below full access the link
  // changes only that work.
  const bSession = new McpSession(b.origin, b.mcp);
  await bSession.initialize();
  const bProject = await projectOf(bSession);
  const own = outcome(
    await bSession.callTool("conn_thread_launch", {
      projectId: bProject, title: "B's own", message: "hang", modelSelection: model,
      runtimeMode: "auto", workspaceStrategy: { type: "root" }, clientRequestId: `b-own-${run}`,
    }),
  );
  const launched = await tool("conn_thread_launch", {
    environmentId: b.id, projectId: bProject, title: "From the link", message: "hang",
    modelSelection: model, runtimeMode: "auto", workspaceStrategy: { type: "root" },
    clientRequestId: `peer-launch-${run}`,
  });
  record("conn_thread_launch there", shapeOf(launched));
  const again = await tool("conn_thread_launch", {
    environmentId: b.id, projectId: bProject, title: "From the link", message: "hang",
    modelSelection: model, runtimeMode: "auto", workspaceStrategy: { type: "root" },
    clientRequestId: `peer-launch-${run}`,
  });
  record("conn_thread_launch there, retried: same thread", again.ok?.threadId === launched.ok?.threadId);
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
    "conn_thread_send there to the peer's own thread: fenced",
    await tool("conn_thread_send", { environmentId: b.id, threadId: own.ok?.threadId, message: "x", mode: "queue" }),
  );
  record(
    "conn_thread_send there to the link's thread",
    shapeOf(await tool("conn_thread_send", {
      environmentId: b.id, threadId: launched.ok?.threadId, message: "x", mode: "queue", clientRequestId: `peer-send-${run}`,
    })),
  );
  record(
    "conn_thread_read there",
    shapeOf((await tool("conn_thread_read", { environmentId: b.id, threadId: launched.ok?.threadId })).ok?.thread ?? null),
  );
  record(
    "conn_thread_interrupt there",
    (await tool("conn_thread_interrupt", { environmentId: b.id, threadId: launched.ok?.threadId, stop: true })).ok?.threadId ===
      launched.ok?.threadId,
  );
  await bSession.close();

  // An agent here: the link tools as a thread sees them, and a link card answered by the user.
  const aProject = await projectOf(session);
  a.forget();
  const agentThread = outcome(
    await session.callTool("conn_thread_launch", {
      projectId: aProject, title: "Agent", message: "hang", modelSelection: model,
      runtimeMode: "full-access", workspaceStrategy: { type: "root" }, clientRequestId: `agent-${run}`,
    }),
  ).ok?.threadId;
  const credential = await a.credential();
  const agent = new McpSession(new URL(credential.url).origin, credential.headers.Authorization);
  await agent.initialize();
  const ask = async (args) => outcome(await agent.callTool("conn_environment_link", args));
  const cardShape = (value) => normalize(value, []).replace(/turn-item:link-request:[^"]+/g, "<card>");
  record("agent conn_environment_links", await outcome(await agent.callTool("conn_environment_links", {})));
  const listed = outcome(await agent.callTool("conn_thread_list", { environmentId: b.id, allProjects: true }));
  record(
    "agent conn_thread_list there: the link's thread, as a chip",
    listed.ok
      ? listed.ok.threads
          .filter((t) => t.threadId === launched.ok?.threadId)
          .map((t) => ({ title: t.title, chip: t.link.startsWith("[From the link](t3-thread://v2/") }))
      : listed,
  );
  record("agent conn_environment_link: both url and environmentId", await ask({ url: b.origin, environmentId: b.id }));
  record("agent conn_environment_link: a linked machine", await ask({ environmentId: b.id }));
  const card = await ask({ hint: "the other box", reason: "parity", clientRequestId: "card-1" });
  record("agent conn_environment_link: a card", cardShape(card));
  const cardAgain = await ask({ hint: "the other box", reason: "parity", clientRequestId: "card-1" });
  record("agent conn_environment_link: the same card again", cardAgain.ok?.turnItemId === card.ok?.turnItemId);
  record(
    "answerRequest: decline",
    await rpc(a, "peerLinks.answerRequest", { threadId: agentThread, turnItemId: card.ok?.turnItemId, answer: { type: "decline" } }),
  );
  record(
    "answerRequest: answered twice",
    await rpc(a, "peerLinks.answerRequest", { threadId: agentThread, turnItemId: card.ok?.turnItemId, answer: { type: "decline" } }),
  );
  record("agent conn_environment_link: the declined card", await ask({ hint: "the other box", reason: "parity", clientRequestId: "card-1" }));
  const second = await ask({ hint: "x", reason: "parity", clientRequestId: "card-2", requestedAccess: "auto" });
  record(
    "answerRequest: use an existing link",
    await rpc(a, "peerLinks.answerRequest", {
      threadId: agentThread, turnItemId: second.ok?.turnItemId, answer: { type: "use-existing", environmentId: b.id },
    }),
  );
  record("agent conn_environment_link: the card that linked", await ask({ hint: "x", reason: "parity", clientRequestId: "card-2", requestedAccess: "auto" }));
  const third = await ask({ url: b.origin, reason: "parity", clientRequestId: "card-3" });
  record(
    "answerRequest: link with a spent code",
    await rpc(a, "peerLinks.answerRequest", {
      threadId: agentThread, turnItemId: third.ok?.turnItemId,
      answer: { type: "link", urls: [b.origin], access: "auto", pairingCode: code },
    }),
  );
  record("agent conn_environment_link: the card that failed", await ask({ url: b.origin, reason: "parity", clientRequestId: "card-3" }));
  const fresh = await mint("auto");
  const fourth = await ask({ url: b.origin, reason: "parity", clientRequestId: "card-4" });
  record(
    "answerRequest: link with a fresh code",
    await rpc(a, "peerLinks.answerRequest", {
      threadId: agentThread, turnItemId: fourth.ok?.turnItemId,
      answer: { type: "link", urls: [b.origin], access: "auto", pairingCode: fresh },
    }),
  );
  record("agent conn_environment_link: the card that relinked", await ask({ url: b.origin, reason: "parity", clientRequestId: "card-4" }));
  record("agent conn_environment_unlink", await outcome(await agent.callTool("conn_environment_unlink", { environmentId: "environment:none" })));
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
  await session.callTool("conn_thread_interrupt", { threadId: agentThread, stop: true });
  record("conn_environment_links", await tool("conn_environment_links", {}));
  // Known: the descriptor here does not detect `platform.machine` (parity.mjs accepts it too).
  const read = await tool("conn_environment_read", { environmentId: b.id });
  if (read.ok?.platform) delete read.ok.platform.machine;
  record("conn_environment_read there", read);
  const projects = await tool("conn_project_list", { environmentId: b.id });
  const project = projects.ok?.projects?.[0];
  record("conn_project_list there", {
    ...projects,
    ok: projects.ok && {
      ...projects.ok,
      projects: projects.ok.projects.map((p) => ({ ...p, id: "<p>", workspaceRoot: "<root>", title: "<title>" })),
    },
  });
  record("conn_thread_list there, no project", await tool("conn_thread_list", { environmentId: b.id }));
  // Thread lists hold each server's own threads; compare one entry's shape.
  const threads = await tool("conn_thread_list", { environmentId: b.id, allProjects: true });
  record("conn_thread_list there", threads.ok ? shapeOf({ ...threads.ok, threads: threads.ok.threads.slice(0, 1) }) : threads);
  record(
    "conn_thread_read there: unknown thread",
    await tool("conn_thread_read", { environmentId: b.id, threadId: "thread:missing" }),
  );
  record(
    "conn_thread_launch there above the link's access",
    await tool("conn_thread_launch", {
      environmentId: b.id,
      projectId: project?.id ?? "p",
      title: "x",
      message: "x",
      runtimeMode: "full-access",
      workspaceStrategy: { type: "root" },
    }),
  );
  record(
    "conn_thread_interrupt there: unknown thread",
    await tool("conn_thread_interrupt", { environmentId: b.id, threadId: "thread:missing" }),
  );
  record(
    "conn_thread_wait there: unknown thread",
    await tool("conn_thread_wait", { environmentId: b.id, threadId: "thread:missing", timeoutMs: 10 }),
  );
  // The peer lists the link as a bot client named after this environment.
  const clients = await (
    await fetch(`${b.origin}/api/auth/clients`, { headers: { authorization: `Bearer ${b.bearer}` } })
  ).json();
  const linked = (Array.isArray(clients) ? clients : clients.clients ?? []).filter(
    (c) => c.subject === "mcp-client" && [`T3 Code · ${a.label}`, `Conn · ${a.label}`].includes(c.client?.label),
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
  record("conn_environment_unlink", await tool("conn_environment_unlink", { environmentId: b.id }));
  record(
    "conn_thread_list there after unlink",
    await tool("conn_thread_list", { environmentId: b.id }),
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
  // T3's `conn_thread_wait` on an unknown thread answers from its projection store; ours from the
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
