import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type OrchestrationV2ThreadProjection,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2Command,
  OrchestrationV2ThreadLaunchInput,
  ProjectMutation,
  type RuntimeMode,
  ThreadId,
  TurnItemId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { type ProbeContext, waitFor } from "./connection.ts";
import { clip, short } from "./format.ts";

export type Projection = OrchestrationV2ThreadProjection;
export type Thread = Projection["thread"];

export const id = () => NodeCrypto.randomUUID();
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeLaunch = Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput);
const decodeMutation = Schema.decodeUnknownSync(ProjectMutation);
export const threadIdOf = Schema.decodeUnknownSync(ThreadId);
const turnItemIdOf = Schema.decodeUnknownSync(TurnItemId);

export const TERMINAL_RUN = ["completed", "failed", "cancelled", "interrupted", "rolled_back"];
export const ACTIVE_TASK = ["idle", "pending", "running", "waiting"];

export interface ProbeProject {
  readonly id: string;
  readonly root: string;
}

export async function createProject(ctx: ProbeContext, name: string): Promise<ProbeProject> {
  const root = NodePath.join(ctx.runDir, "projects", name);
  NodeFS.mkdirSync(root, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), `# ${name}\n`);
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.email=probe@example.invalid", "-c", "user.name=probe", ...args],
      { cwd: root, stdio: "ignore" },
    );
  git("init", "-q");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  const projectId = id();
  await ctx.rpc.run((client) =>
    client[WS_METHODS.projectsMutate](
      decodeMutation({
        type: "project.create",
        commandId: id(),
        projectId,
        title: `probe-${name}`,
        workspaceRoot: root,
      }),
    ),
  );
  return { id: projectId, root };
}

export interface LaunchOptions {
  readonly title: string;
  readonly message?: string;
  readonly runtimeMode?: RuntimeMode;
}

export async function launchThread(
  ctx: ProbeContext,
  project: ProbeProject,
  options: LaunchOptions,
): Promise<string> {
  const result = await ctx.rpc.run((client) =>
    client[ORCHESTRATION_V2_WS_METHODS.launchThread](
      decodeLaunch({
        commandId: id(),
        projectId: project.id,
        title: options.title,
        modelSelection: { instanceId: ctx.providerInstance, model: ctx.model },
        runtimeMode: options.runtimeMode ?? "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        ...(options.message === undefined
          ? {}
          : { initialMessage: { text: options.message, attachments: [] } }),
      }),
    ),
  );
  return result.threadId;
}

export const projectionOf = (ctx: ProbeContext, threadId: string): Promise<Projection> =>
  ctx.rpc.run((client) =>
    client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
      threadId: threadIdOf(threadId),
    }),
  );

export const dispatch = (ctx: ProbeContext, command: typeof OrchestrationV2Command.Encoded) =>
  ctx.rpc.run((client) =>
    client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](decodeCommand(command)),
  );

export async function awaitRunEnd(
  ctx: ProbeContext,
  threadId: string,
  timeoutMs = 150_000,
): Promise<Projection> {
  return waitFor(`a run of ${threadId} to end`, timeoutMs, async () => {
    const projection = await projectionOf(ctx, threadId);
    const last = projection.runs.at(-1);
    return last !== undefined && TERMINAL_RUN.includes(last.status) ? projection : null;
  });
}

export const lastAssistantText = (projection: Projection): string =>
  projection.messages.findLast((message) => message.role === "assistant")?.text ?? "";

export const childIds = (projection: Projection): ReadonlyArray<string> =>
  projection.subagents.flatMap((task) => (task.childThreadId === null ? [] : [task.childThreadId]));

export async function awaitChild(
  ctx: ProbeContext,
  parentId: string,
  count = 1,
): Promise<ReadonlyArray<string>> {
  return waitFor(`${count} delegated child thread(s) of ${parentId}`, 120_000, async () => {
    const ids = childIds(await projectionOf(ctx, parentId));
    return ids.length >= count ? ids : null;
  });
}

/** Tool results arrive withheld from the projection, so each is fetched as its own turn item. */
export async function toolOutputs(
  ctx: ProbeContext,
  threadId: string,
  projection: Projection,
  name: RegExp,
): Promise<ReadonlyArray<string>> {
  const tools = projection.turnItems.flatMap((item) =>
    item.type === "dynamic_tool" && item.toolName !== null && name.test(item.toolName)
      ? [{ id: item.id, toolName: item.toolName, input: item.input }]
      : [],
  );
  const outputs: string[] = [];
  for (const tool of tools) {
    const { item } = await ctx.rpc.run((client) =>
      client[ORCHESTRATION_V2_WS_METHODS.getTurnItem]({
        threadId: threadIdOf(threadId),
        itemId: turnItemIdOf(tool.id),
      }),
    );
    const output = item?.type === "dynamic_tool" ? item.output : undefined;
    outputs.push(
      `${tool.toolName}(${clip(JSON.stringify(tool.input), 100)}) -> ${clip(JSON.stringify(output ?? null), 360)}`,
    );
  }
  return outputs;
}

export const threadSummary = (thread: Thread) =>
  `thread ${short(thread.id)} parent=${short(thread.lineage.parentThreadId ?? "none")} worktree=${thread.worktreePath ?? "none"} archivedAt=${thread.archivedAt ?? "null"}`;

export const DELEGATE = "the t3-code MCP tool `delegate_task`";
