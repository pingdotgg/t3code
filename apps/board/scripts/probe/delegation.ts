import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";

import { type ProbeContext, waitFor } from "./connection.ts";
import { clip, describeError, short } from "./format.ts";
import {
  ACTIVE_TASK,
  awaitChild,
  awaitRunEnd,
  createProject,
  DELEGATE,
  dispatch,
  id,
  lastAssistantText,
  launchThread,
  projectionOf,
  threadIdOf,
  type Thread,
  threadSummary,
} from "./helpers.ts";

export async function checkB(
  ctx: ProbeContext,
  evidence: (line: string) => void,
): Promise<boolean> {
  const project = await createProject(ctx, "check-b");
  const parentId = await launchThread(ctx, project, {
    title: "probe B parent",
    message: `Use ${DELEGATE} exactly once with isolation "worktree", mode "wait", title "probe B child" and task "Run \`pwd\` with the Bash tool and reply with exactly CWD=<output>". When it returns, reply with exactly: DONE <the child's reply>.`,
  });
  const [childId] = await awaitChild(ctx, parentId);
  if (childId === undefined) return false;
  const projection = await awaitRunEnd(ctx, parentId);
  const child = (await projectionOf(ctx, childId)).thread;
  const worktree = child.worktreePath;
  const listed =
    worktree !== null &&
    NodeChildProcess.execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: project.root,
      encoding: "utf8",
    }).includes(`worktree ${worktree}`);
  evidence(`parent ${short(parentId)} delegated child ${short(childId)}`);
  evidence(
    `child worktree path ${worktree ?? "none"}; on disk ${worktree !== null && NodeFS.existsSync(worktree)}; listed by \`git worktree list\` ${listed}`,
  );
  evidence(
    `child lineage.parentThreadId = ${short(child.lineage.parentThreadId ?? "null")} (parent is ${short(parentId)}), relationship ${child.lineage.relationshipToParent ?? "null"}`,
  );
  evidence(`parent reply: ${clip(lastAssistantText(projection), 160)}`);
  return worktree !== null && listed && child.lineage.parentThreadId === parentId;
}

export async function checkC(
  ctx: ProbeContext,
  evidence: (line: string) => void,
): Promise<boolean> {
  const project = await createProject(ctx, "check-c");
  const parentId = await launchThread(ctx, project, {
    title: "probe C parent",
    message: `Use ${DELEGATE} exactly once with mode "wait", title "probe C child" and this task: "Use the t3-code MCP tool delegate_task exactly once with mode wait, title probe C grandchild and task 'Reply with exactly GRANDCHILD-OK'. Then reply with exactly: CHILD-DONE <the grandchild's reply>". When it returns, reply with exactly: DONE <the child's reply>.`,
  });
  const [childId] = await awaitChild(ctx, parentId);
  if (childId === undefined) return false;
  const [grandchildId] = await awaitChild(ctx, childId);
  if (grandchildId === undefined) return false;
  const projection = await awaitRunEnd(ctx, parentId);
  const grandchild = (await projectionOf(ctx, grandchildId)).thread;
  evidence(
    `parent ${short(parentId)} -> child ${short(childId)} -> grandchild ${short(grandchildId)}`,
  );
  evidence(
    `grandchild lineage.parentThreadId = ${short(grandchild.lineage.parentThreadId ?? "null")}, rootThreadId = ${short(grandchild.lineage.rootThreadId)}`,
  );
  evidence(`parent reply: ${clip(lastAssistantText(projection), 160)}`);
  return (
    grandchild.lineage.parentThreadId === childId && grandchild.lineage.rootThreadId === parentId
  );
}

async function findPendingRequest(ctx: ProbeContext, parentId: string, childId: string) {
  return waitFor(`a pending runtime request on ${childId}`, 120_000, async () => {
    const family = await ctx.rpc.run((client) =>
      client[ORCHESTRATION_V2_WS_METHODS.getThreadFamily]({
        threadId: threadIdOf(parentId),
      }),
    );
    return family.threads.find((shell) => shell.id === childId)?.pendingRuntimeRequest ?? null;
  });
}

export async function checkD(
  ctx: ProbeContext,
  evidence: (line: string) => void,
): Promise<boolean> {
  const project = await createProject(ctx, "check-d");
  const parentId = await launchThread(ctx, project, {
    title: "probe D parent",
    message: `Use ${DELEGATE} exactly once with runtimeMode "approval-required", mode "async", title "probe D child" and task "Run \`echo approved > approval-probe.txt\` with the Bash tool, then reply DONE". After it returns, end your turn at once without waiting or polling.`,
  });
  const [childId] = await awaitChild(ctx, parentId);
  if (childId === undefined) return false;
  const child = (await projectionOf(ctx, childId)).thread;
  evidence(`child ${short(childId)} runtimeMode ${child.runtimeMode}`);
  const pending = await findPendingRequest(ctx, parentId, childId);
  evidence(`before: pendingRuntimeRequest id ${short(pending.id)} kind ${pending.kind}`);
  await dispatch(ctx, {
    type: "runtime-request.respond",
    commandId: id(),
    threadId: childId,
    requestId: pending.id,
    decision: "accept",
  });
  const resolved = await waitFor("the request to resolve", 60_000, async () => {
    const request = (await projectionOf(ctx, childId)).runtimeRequests.find(
      (entry) => entry.id === pending.id,
    );
    return request !== undefined && request.status !== "pending" ? request : null;
  });
  evidence(
    `after: request ${short(resolved.id)} status ${resolved.status} decision ${resolved.decision ?? "none"}`,
  );
  const file = NodePath.join(project.root, "approval-probe.txt");
  const ran = await waitFor("the approved command to run", 60_000, async () =>
    NodeFS.existsSync(file),
  );
  evidence(`approved command ran: ${file} exists ${ran}`);
  return resolved.status === "resolved" && ran;
}

export async function checkE(
  ctx: ProbeContext,
  evidence: (line: string) => void,
): Promise<boolean> {
  const project = await createProject(ctx, "check-e");
  const parentId = await launchThread(ctx, project, {
    title: "probe E parent",
    message: `Use ${DELEGATE} exactly once with mode "async", title "probe E child" and task "Use the AskUserQuestion tool to ask the user which color to use, with the options red and blue. Wait for the answer, then reply DONE". After it returns, end your turn at once without waiting or polling.`,
  });
  const [childId] = await awaitChild(ctx, parentId);
  if (childId === undefined) return false;
  evidence(
    `parent ${short(parentId)} delegated child ${short(childId)} asynchronously; the child asks the user a question`,
  );
  const findWake = async () => {
    const projection = await projectionOf(ctx, parentId);
    return (
      projection.messages.find(
        (message) =>
          message.role === "user" &&
          message.notification !== undefined &&
          /question|input|answer/i.test(`${message.text} ${message.notification.summary}`),
      ) ?? null
    );
  };
  let wake: Awaited<ReturnType<typeof findWake>> = null;
  try {
    wake = await waitFor("the parent to be woken by the child's question", 90_000, findWake);
  } catch (error) {
    const parent = await projectionOf(ctx, parentId);
    const child = await projectionOf(ctx, childId);
    for (const message of parent.messages) {
      evidence(
        `parent message ${message.role} notification=${message.notification?.source.kind ?? "none"}: ${clip(message.text, 140)}`,
      );
    }
    evidence(`parent run statuses ${parent.runs.map((run) => run.status).join(",")}`);
    evidence(
      `child run statuses ${child.runs.map((run) => run.status).join(",")}; items ${child.turnItems.map((item) => item.type).join(",")}; requests ${child.runtimeRequests.map((request) => `${request.kind}:${request.status}`).join(",")}`,
    );
    throw error;
  }
  evidence(
    `parent wake message (source ${wake.notification?.source.kind ?? "?"}): ${clip(wake.text, 300)}`,
  );
  const pending = await ctx.rpc
    .run((client) =>
      client[ORCHESTRATION_V2_WS_METHODS.getThreadFamily]({
        threadId: threadIdOf(parentId),
      }),
    )
    .then(
      (family) =>
        family.threads.find((shell) => shell.id === childId)?.pendingRuntimeRequest ?? null,
    );
  evidence(
    `child pendingRuntimeRequest: ${pending === null ? "none" : `${short(pending.id)} kind ${pending.kind}`}`,
  );
  return true;
}

export async function checkH(
  ctx: ProbeContext,
  evidence: (line: string) => void,
): Promise<boolean> {
  const project = await createProject(ctx, "check-h");
  const parentId = await launchThread(ctx, project, {
    title: "probe H parent",
    message: `Use ${DELEGATE} exactly twice, each with mode "async" and a different title ("probe H child 1", "probe H child 2"). Each task is "Run \`sleep 120\` with the Bash tool, then reply DONE". After both calls return, end your turn at once without waiting or polling.`,
  });
  const children = await awaitChild(ctx, parentId, 2);
  evidence(`parent ${short(parentId)} has running children ${children.map(short).join(", ")}`);
  let refused = "";
  try {
    await dispatch(ctx, { type: "thread.archive", commandId: id(), threadId: parentId });
    evidence("archive while children run: ACCEPTED");
  } catch (error) {
    refused = describeError(error instanceof Error ? error : new Error(String(error)));
    evidence(`archive while children run: refused: ${clip(refused, 260)}`);
  }
  await dispatch(ctx, { type: "thread.stop", commandId: id(), threadId: parentId });
  await waitFor("every child task to stop", 90_000, async () => {
    const projection = await projectionOf(ctx, parentId);
    return projection.subagents.every((task) => !ACTIVE_TASK.includes(task.status))
      ? projection
      : null;
  });
  await dispatch(ctx, { type: "thread.archive", commandId: id(), threadId: parentId });
  const parent = (await projectionOf(ctx, parentId)).thread;
  const kids: Thread[] = [];
  for (const childId of children) kids.push((await projectionOf(ctx, childId)).thread);
  evidence(
    `after stopping the children, archive parent: archivedAt ${parent.archivedAt ?? "null"}`,
  );
  for (const kid of kids) evidence(`child ${threadSummary(kid)}`);
  return (
    refused !== "" && parent.archivedAt !== null && kids.every((kid) => kid.archivedAt === null)
  );
}
