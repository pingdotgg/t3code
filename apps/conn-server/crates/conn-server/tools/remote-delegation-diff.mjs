#!/usr/bin/env node
// Remote delegation between two linked servers: T3 → T3 is the reference; Conn → Conn,
// Conn → T3 and T3 → Conn take the same steps and must give the same answers, after ids, times
// and reply texts are replaced by placeholders. An agent in A (a turn that stays running)
// delegates a task with `target.environmentId` B; the child runs there as an ordinary thread
// with `delegatedFrom`, and its end completes the task in A, which wakes the agent. A forwarded
// `t3_thread_send` to that thread is a follow-up: a new task in A, completed the same way.
// Then the refusals, a cancel of a finished task, a send to a thread that is no task, and a
// retry. No model is called: T3's Claude CLI stand-in replays a two-turn transcript on B, Conn
// runs the fake provider.
// Usage: remote-delegation-diff.mjs <conn-server binary (replay_server)>. Needs `vp i`.
import * as NodeFS from "node:fs";

import { McpSession } from "../../conn-mcp/tools/mcp-client.mjs";
import { monorepo } from "../../../tools/monorepo.mjs";
import { peerFixture } from "./peer-fixture.mjs";

const rustBinary = process.argv[2];
if (rustBinary === undefined) {
  console.error("usage: remote-delegation-diff.mjs <conn-server binary>");
  process.exit(2);
}
monorepo();

const { startTs, startRust, rpc, post, descriptor, outcome, shapeOf, normalize } = peerFixture(
  rustBinary,
  "conn-remote-delegation-",
);

// The recorded `pong` turn, twice in one CLI start: a task and its follow-up each get a reply.
const turn = NodeFS.readFileSync(
  new URL("../../conn-provider-claude/testdata/cli/e01_turn.ndjson", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter(Boolean);
const twoTurns = `${[...turn, ...turn.slice(2)].join("\n")}\n`;

const [t1, t2, c1, c2] = await Promise.all([
  startTs("t1"),
  startTs("t2", { script: twoTurns }),
  startRust("c1"),
  startRust("c2"),
]);
for (const server of [t1, t2, c1, c2]) {
  const d = await descriptor(server);
  server.id = d.environmentId;
  server.label = d.label;
}

let failed = 0;
const report = (line, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "DIFF"} ${line}${ok || detail === "" ? "" : `\n       ${detail}`}`);
};

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** Every step from `a` (where the agent delegates) to `b` (where the task runs). */
async function run(a, b) {
  const out = new Map();
  const run = `${a.name}-${b.name}`;
  const ids = [];
  // Longer ids first: a run id contains its thread's id.
  const names = () => [
    ...ids.filter(([from]) => typeof from === "string" && from !== "").sort(([x], [y]) => y.length - x.length),
    [b.origin, "<B-url>"],
    [a.origin, "<A-url>"],
    [b.id, "<B>"],
    [a.id, "<A>"],
    [b.label, "<label>"],
  ];
  const record = (step, value) => out.set(step, normalize(value, names()));
  const session = new McpSession(a.origin, a.mcp);
  await session.initialize();
  const bSession = new McpSession(b.origin, b.mcp);
  await bSession.initialize();
  const projectOf = async (s) => outcome(await s.callTool("t3_project_list", {})).ok?.projects?.[0]?.id;
  const model = { instanceId: "claudeAgent", model: "claude-haiku-5-5" };

  const code = (await post(b, "/api/auth/pairing-token", { label: "delegation", access: "auto", purpose: "peer-link" }))
    .credential;
  const linked = await rpc(a, "peerLinks.link", { url: b.origin, pairingCode: code, access: "auto" });
  record("link", linked._tag);
  const bProject = await projectOf(bSession);
  ids.push([bProject, "<B-project>"]);

  // The agent in A: its turn starts and stays running, so it can delegate.
  a.forget();
  const agentThread = outcome(
    await session.callTool("t3_thread_launch", {
      projectId: await projectOf(session), title: "Agent", message: "hang", modelSelection: model,
      runtimeMode: "full-access", workspaceStrategy: { type: "root" }, clientRequestId: `agent-${run}`,
    }),
  ).ok?.threadId;
  ids.push([agentThread, "<agent>"]);
  const credential = await a.credential();
  const agent = new McpSession(new URL(credential.url).origin, credential.headers.Authorization);
  await agent.initialize();
  const tool = async (name, args) => outcome(await agent.callTool(name, args));
  const parentProjection = async () => {
    const snapshot = await (
      await fetch(`${a.origin}/api/orchestration/threads/${encodeURIComponent(agentThread)}`, {
        headers: { authorization: `Bearer ${a.bearer}`, "x-t3-orchestration-protocol": "2" },
      })
    ).json();
    return snapshot.projection ?? snapshot.thread ?? snapshot;
  };
  // Waits for the task's result in the parent's row, then for its wake message: `task_status`
  // acknowledges a result, which would cancel the wake. Returns whether the agent was woken.
  const until = async (taskId) => {
    for (let i = 0; i < 480; i++) {
      const projection = await parentProjection();
      const row = (projection.subagents ?? []).find((s) => s.id === taskId);
      const woken = (projection.messages ?? []).some((m) => typeof m.text === "string" && m.text.includes(taskId));
      if (row !== undefined && typeof row.result === "string" && woken) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  };
  // Reply texts differ (the stand-in says `pong`, the fake provider echoes); their presence counts.
  // `executedModel` is what B's provider reported: the Claude stand-in names one, the fake
  // provider none. Conn → T3 shows that A carries it over.
  const task = (read) =>
    read.ok
      ? {
          ...read.ok,
          executedModel: b.kind === "T3" ? read.ok.executedModel : "claude-haiku-5-5",
          summary: typeof read.ok.summary === "string" && read.ok.summary.length > 0 ? "<reply>" : read.ok.summary,
          latestTerminalSummary:
            typeof read.ok.latestTerminalSummary === "string" && read.ok.latestTerminalSummary.length > 0
              ? "<reply>"
              : read.ok.latestTerminalSummary,
        }
      : read;

  record(
    "delegate_task there: no repository to match",
    await tool("delegate_task", { task: "x", target: { environmentId: b.id } }),
  );
  record(
    "delegate_task there: a worktree",
    await tool("delegate_task", { task: "x", isolation: "worktree", target: { environmentId: b.id, projectId: bProject } }),
  );
  record(
    "delegate_task there: an unknown link",
    await tool("delegate_task", { task: "x", target: { environmentId: "environment:none", projectId: "p" } }),
  );
  record(
    "delegate_task there: a mode above the link's access",
    await tool("delegate_task", { task: "x", runtimeMode: "full-access", target: { environmentId: b.id, projectId: bProject } }),
  );
  record(
    "delegate_task there: an unknown driver",
    await tool("delegate_task", { task: "x", target: { environmentId: b.id, projectId: bProject, driverKind: "nobody" } }),
  );

  const delegated = await tool("delegate_task", {
    task: "Reply with pong.", title: "Remote task",
    target: { environmentId: b.id, projectId: bProject }, clientRequestId: `remote-${run}`,
  });
  const taskId = delegated.ok?.taskId;
  const child = delegated.ok?.remoteChild?.threadId;
  ids.push([taskId, "<task>"], [child, "<child>"], [delegated.ok?.remoteChild?.runId, "<child-run>"]);
  record("delegate_task there", {
    ...delegated,
    ok: delegated.ok && { ...delegated.ok, status: delegated.ok.status === "starting" ? "running" : delegated.ok.status },
  });
  const retried = await tool("delegate_task", {
    task: "Reply with pong.", title: "Remote task",
    target: { environmentId: b.id, projectId: bProject }, clientRequestId: `remote-${run}`,
  });
  record("delegate_task there, retried: the same task", retried.ok?.taskId === taskId);

  const shell = await (
    await fetch(`${b.origin}/api/orchestration/shell`, {
      headers: { authorization: `Bearer ${b.bearer}`, "x-t3-orchestration-protocol": "2" },
    })
  ).json();
  const row = (shell.threads ?? shell.snapshot?.threads ?? []).find((t) => t.id === child);
  record("the thread there names its parent", row?.delegatedFrom ?? null);

  record("the task ends there and wakes the agent here", await until(taskId));
  record("the task finishes", task(await tool("task_status", { taskId })));
  const projection = await parentProjection();
  for (const row of projection.subagents ?? []) {
    if (row.id === taskId) ids.push([row.remoteChild?.runId, "<child-run>"]);
  }
  record(
    "the parent's task row",
    (projection.subagents ?? [])
      .filter((s) => s.id === taskId)
      .map((s) => ({
        origin: s.origin, driver: s.driver, childThreadId: s.childThreadId, status: s.status,
        remoteChild: s.remoteChild, hasResult: typeof s.result === "string", title: s.title,
      })),
  );

  // A follow-up: a send there to the finished task's thread is a new task here.
  const sent = await tool("t3_thread_send", {
    environmentId: b.id, threadId: child, message: "Again.", mode: "queue", clientRequestId: `again-${run}`,
  });
  const followUp = sent.ok?.taskId;
  ids.push([followUp, "<follow-up>"], [sent.ok?.runId, "<follow-up-run>"], [sent.ok?.messageId, "<message>"]);
  record("t3_thread_send there to the task's thread: a follow-up task", {
    ...sent,
    ok: sent.ok && { ...sent.ok, status: sent.ok.status === "starting" ? "running" : sent.ok.status },
  });
  const resent = await tool("t3_thread_send", {
    environmentId: b.id, threadId: child, message: "Again.", mode: "queue", clientRequestId: `again-${run}`,
  });
  record("t3_thread_send there, retried: the same follow-up", resent.ok?.taskId === followUp);
  record("the follow-up ends there and wakes the agent here", await until(followUp));
  record("the follow-up finishes", task(await tool("task_status", { taskId: followUp })));
  const recorded = outcome(await agent.callTool("t3_thread_read", { threadId: agentThread, view: "activity", limit: 100 }));
  record(
    "the follow-up record in the parent",
    (recorded.ok?.items ?? [])
      .filter((i) => i.type === "subagent")
      .map((i) => ({ title: i.title, status: i.status, remote: i.remoteChild !== undefined || i.link?.includes("<B>") }))
      .length,
  );

  // A send to a thread there that is no task stays a plain send.
  const plain = (
    await tool("t3_thread_launch", {
      environmentId: b.id, projectId: bProject, title: "Not a task", modelSelection: model,
      workspaceStrategy: { type: "root" }, clientRequestId: `plain-${run}`,
    })
  ).ok?.threadId;
  const plainSend = await tool("t3_thread_send", { environmentId: b.id, threadId: plain, message: "hi", mode: "queue" });
  record("t3_thread_send there to a thread that is no task", plainSend.ok ? "taskId" in plainSend.ok : plainSend);

  record("task_cancel of a finished task", await tool("task_cancel", { taskId, clientRequestId: `cancel-${run}` }));
  record("task_status after the cancel", task(await tool("task_status", { taskId })));

  await agent.close();
  await session.callTool("t3_thread_interrupt", { threadId: agentThread, stop: true });
  await rpc(a, "peerLinks.unlink", { environmentId: b.id });
  await session.close();
  await bSession.close();
  return out;
}

const reference = await run(t1, t2);
if (process.argv.includes("--reference-only")) {
  for (const [step, value] of reference) console.log(`T3 → T3 ${step}: ${value}`);
  process.exit(0);
}
if (process.argv.includes("--show")) for (const [step, value] of reference) console.log(`T3 → T3 ${step}: ${value}`);
// Known differences, each with its reason. They must stay exactly these.
const KNOWN = new Map([]);
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
console.log(failed === 0 ? "\nremote delegation: no differences" : `\nremote delegation: ${failed} differences`);
process.exit(failed === 0 ? 0 : 1);
