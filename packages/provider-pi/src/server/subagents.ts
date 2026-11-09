import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  piContentText as contentText,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcRecord,
} from "./rpc.ts";

export type PiSubagentStatus = "pending" | "running" | "completed" | "failed" | "interrupted";

export const isPiSubagentSettled = (status: PiSubagentStatus) =>
  status !== "pending" && status !== "running";

/** One pi-subagents child, as a row on the turn whose `subagent` call launched it. */
export interface PiSubagentMember<Owner> {
  readonly owner: Owner;
  readonly toolCallId: string;
  /** Stable across every frame that describes this child. */
  readonly nativeTaskId: string;
  readonly title: string;
  readonly prompt: string;
  readonly model: string | null;
  readonly status: PiSubagentStatus;
  readonly progress?: string;
  readonly result: string | null;
}

interface BackgroundRun<Owner> {
  readonly owner: Owner;
  readonly toolCallId: string;
  readonly asyncId: string;
  /** Single runs have one child; workflow steps are keyed by workflow key; chain and parallel by position. */
  readonly shape: "single" | "workflow" | "steps";
  readonly members: Map<string, PiSubagentMember<Owner>>;
  /** A chain or parallel step's id changes from `step:<index>` to its child run id at launch. */
  readonly stepIds: Map<string, string>;
}

const ASYNC_WIDGET_KEY = "subagent-async";
const ASYNC_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";

const SnapshotNode = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  state: Schema.String,
  label: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});
const decodeAsyncStatusSnapshot = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.Literal("pi-subagents.async-status-snapshot"),
      version: Schema.Literal(1),
      generatedAt: Schema.Number,
      runs: Schema.Array(
        Schema.Struct({
          ...SnapshotNode.fields,
          children: Schema.optional(Schema.Array(SnapshotNode)),
        }),
      ),
    }),
  ),
);
type AsyncStatusSnapshot = Option.Option.Value<ReturnType<typeof decodeAsyncStatusSnapshot>>;

const decodeChildNotice = Schema.decodeUnknownOption(
  Schema.Struct({ childKey: Schema.String, outcome: Schema.String }),
);
const decodeCompletionNotice = Schema.decodeUnknownOption(
  Schema.Struct({
    runs: Schema.Array(
      Schema.Struct({
        runId: Schema.optional(Schema.String),
        workflowRunId: Schema.optional(Schema.String),
        agent: Schema.optional(Schema.String),
        status: Schema.String,
        childRuns: Schema.optional(
          Schema.Array(
            Schema.Struct({
              runId: Schema.optional(Schema.String),
              workflowKey: Schema.optional(Schema.String),
              agent: Schema.optional(Schema.String),
              status: Schema.String,
            }),
          ),
        ),
      }),
    ),
  }),
);

/** Paused, partial and detached children may still continue, so they do not settle a row. */
function memberStatus(state: string | undefined): PiSubagentStatus | undefined {
  switch (state) {
    case "queued":
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "complete":
    case "completed":
      return "completed";
    case "failed":
    case "rejected":
      return "failed";
    case "stopped":
      return "interrupted";
    default:
      return undefined;
  }
}

function subagentOutput(result: unknown): string {
  const stopReason = recordString(result, "stopReason");
  const failed =
    (recordNumber(result, "exitCode") ?? 0) !== 0 ||
    stopReason === "error" ||
    stopReason === "aborted";
  if (failed) {
    const failure = recordString(result, "errorMessage") || recordString(result, "stderr");
    if (failure !== undefined && failure.length > 0) return failure;
  }
  const messages = recordField(result, "messages");
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (recordString(message, "role") !== "assistant") continue;
    const text = contentText(recordField(message, "content"));
    if (text.length > 0) return text;
  }
  return "";
}

function recordArray(input: unknown, key: string): ReadonlyArray<unknown> {
  const value = recordField(input, key);
  return Array.isArray(value) ? value : [];
}

/**
 * Projects pi-subagents children from the frames the extension sends about them: the `subagent`
 * tool's foreground results, its detached launch receipt, the `subagent-async` status widget and
 * the completion notices. Each child stays on the turn (`Owner`) whose call launched it, however
 * late its frames arrive. Frames from any other extension are not lifecycle frames.
 */
export function makePiSubagentLifecycle<Owner>() {
  const foreground = new Map<string, Map<string, PiSubagentMember<Owner>>>();
  const background = new Map<string, BackgroundRun<Owner>>();
  // A snapshot can list a run before the tool call that launched it has returned its receipt.
  let latestSnapshot: AsyncStatusSnapshot | null = null;

  /** Returns the member when the frame changed it; settled members ignore stale frames. */
  const updateMember = (
    run: BackgroundRun<Owner>,
    key: string,
    status: PiSubagentStatus | undefined,
    fields: { readonly title?: string | undefined; readonly model?: string | undefined },
  ): PiSubagentMember<Owner> | undefined => {
    const previous = run.members.get(key);
    if (previous !== undefined && isPiSubagentSettled(previous.status)) return undefined;
    const title = fields.title ?? previous?.title;
    const nextStatus = status ?? previous?.status;
    if (title === undefined || nextStatus === undefined) return undefined;
    const next: PiSubagentMember<Owner> = {
      owner: run.owner,
      toolCallId: run.toolCallId,
      nativeTaskId: `${run.asyncId}:subagent:${key}`,
      title,
      prompt: previous?.prompt ?? "",
      model: fields.model ?? previous?.model ?? null,
      status: nextStatus,
      result: null,
    };
    if (
      previous !== undefined &&
      previous.title === next.title &&
      previous.model === next.model &&
      previous.status === next.status
    ) {
      return undefined;
    }
    run.members.set(key, next);
    return next;
  };

  const applySnapshotRun = (
    run: BackgroundRun<Owner>,
    node: AsyncStatusSnapshot["runs"][number],
  ): Array<PiSubagentMember<Owner>> => {
    const steps = (node.children ?? []).filter((child) => child.kind === "step");
    if (run.shape === "single") {
      const step = steps[0];
      const changed = updateMember(run, "0", memberStatus(node.state), {
        title: step?.agent,
        model: step?.model,
      });
      return changed === undefined ? [] : [changed];
    }
    return steps.flatMap((step, index) => {
      const key = run.shape === "workflow" ? step.id : String(index);
      if (run.shape === "steps") run.stepIds.set(key, step.id);
      const changed = updateMember(run, key, memberStatus(step.state), {
        title: step.agent ?? step.label ?? step.id,
        model: step.model,
      });
      return changed === undefined ? [] : [changed];
    });
  };

  const observeWidget = (frame: PiRpcRecord): Array<PiSubagentMember<Owner>> => {
    const line = recordArray(frame, "widgetLines").find(
      (entry): entry is string =>
        typeof entry === "string" && entry.startsWith(ASYNC_WIDGET_PREFIX),
    );
    if (line === undefined) return [];
    const snapshot = Option.getOrUndefined(
      decodeAsyncStatusSnapshot(line.slice(ASYNC_WIDGET_PREFIX.length)),
    );
    if (snapshot === undefined) return [];
    if (latestSnapshot !== null && snapshot.generatedAt < latestSnapshot.generatedAt) return [];
    latestSnapshot = snapshot;
    return snapshot.runs.flatMap((node) => {
      const run = background.get(node.id);
      return run === undefined ? [] : applySnapshotRun(run, node);
    });
  };

  const observeChildNotice = (details: unknown): Array<PiSubagentMember<Owner>> => {
    const notice = Option.getOrUndefined(decodeChildNotice(details));
    if (notice === undefined) return [];
    // The notice names its workflow only in prose; settle the child only when its key is unambiguous.
    const owners = [...background.values()].filter((run) => {
      const member = run.shape === "workflow" ? run.members.get(notice.childKey) : undefined;
      return member !== undefined && !isPiSubagentSettled(member.status);
    });
    const run = owners.length === 1 ? owners[0] : undefined;
    const changed =
      run === undefined
        ? undefined
        : updateMember(run, notice.childKey, memberStatus(notice.outcome), {});
    return changed === undefined ? [] : [changed];
  };

  const observeCompletionNotice = (details: unknown): Array<PiSubagentMember<Owner>> => {
    const notice = Option.getOrUndefined(decodeCompletionNotice(details));
    if (notice === undefined) return [];
    return notice.runs.flatMap((notified) => {
      const asyncId = notified.workflowRunId ?? notified.runId;
      const run = asyncId === undefined ? undefined : background.get(asyncId);
      if (run === undefined) return [];
      const changed: Array<PiSubagentMember<Owner>> = [];
      const childRuns = notified.childRuns ?? [];
      for (const child of childRuns) {
        const key =
          run.shape === "workflow"
            ? child.workflowKey
            : run.shape === "single"
              ? "0"
              : [...run.stepIds].find(([, stepId]) => stepId === child.runId)?.[0];
        if (key === undefined) continue;
        const member = updateMember(run, key, memberStatus(child.status), {
          title: child.agent ?? child.workflowKey,
        });
        if (member !== undefined) changed.push(member);
      }
      const runStatus = memberStatus(notified.status);
      if (runStatus !== undefined && isPiSubagentSettled(runStatus)) {
        if (run.shape === "single") {
          const member = updateMember(run, "0", runStatus, { title: notified.agent });
          if (member !== undefined) changed.push(member);
        }
        for (const [key, member] of run.members) {
          if (isPiSubagentSettled(member.status)) continue;
          const settled = updateMember(run, key, runStatus, {});
          if (settled !== undefined) changed.push(settled);
        }
        background.delete(run.asyncId);
      }
      return changed;
    });
  };

  const observeForeground = (
    owner: Owner,
    toolCallId: string,
    details: unknown,
    toolStatus: PiSubagentStatus,
  ): Array<PiSubagentMember<Owner>> => {
    const toolFinished = isPiSubagentSettled(toolStatus);
    const members = foreground.get(toolCallId) ?? new Map<string, PiSubagentMember<Owner>>();
    const frame = new Map<string, PiSubagentMember<Owner>>();
    const traceAgents = new Map(
      recordArray(recordField(details, "workflow"), "trace").flatMap((entry) => {
        const key = recordString(entry, "key");
        const agent = recordString(entry, "agent");
        return key === undefined || agent === undefined ? [] : [[key, agent] as const];
      }),
    );
    // Foreground workflows report running children before results carry their agent and task.
    for (const child of recordArray(recordField(details, "workflowChildren"), "children")) {
      const key = recordString(child, "childId");
      const status = memberStatus(recordString(child, "state"));
      if (key === undefined || status === undefined) continue;
      const previous = members.get(key);
      frame.set(key, {
        owner,
        toolCallId,
        nativeTaskId: `${toolCallId}:subagent:${key}`,
        title: recordString(child, "agent") ?? traceAgents.get(key) ?? previous?.title ?? key,
        prompt: previous?.prompt ?? "",
        model: recordString(child, "model") ?? previous?.model ?? null,
        status,
        result: null,
      });
    }
    for (const [index, result] of recordArray(details, "results").entries()) {
      const agent = recordString(result, "agent");
      const task = recordString(result, "task");
      if (agent === undefined || task === undefined) continue;
      const key =
        recordString(result, "workflowKey") ?? String(recordNumber(result, "step") ?? index);
      const finished = toolFinished || recordField(result, "finished") === true;
      const stopReason = recordString(result, "stopReason");
      const interrupted = finished && stopReason === "aborted";
      const failed =
        finished &&
        !interrupted &&
        ((recordNumber(result, "exitCode") ?? 0) !== 0 || stopReason === "error");
      const outputText = subagentOutput(result);
      frame.set(key, {
        owner,
        toolCallId,
        nativeTaskId: `${toolCallId}:subagent:${key}`,
        title: agent,
        prompt: task,
        model: recordString(result, "model") ?? null,
        status: interrupted
          ? "interrupted"
          : failed
            ? "failed"
            : finished
              ? "completed"
              : "running",
        ...(!finished && outputText.length > 0 ? { progress: outputText.slice(0, 200) } : {}),
        result: finished && outputText.length > 0 ? outputText.slice(0, 10_000) : null,
      });
    }
    for (const [key, member] of frame) members.set(key, member);
    if (!toolFinished) {
      foreground.set(toolCallId, members);
      return [...frame.values()];
    }
    foreground.delete(toolCallId);
    const leftovers = [...members].flatMap(([key, member]) =>
      frame.has(key) || isPiSubagentSettled(member.status)
        ? []
        : [{ ...member, status: toolStatus }],
    );
    return [...frame.values(), ...leftovers];
  };

  const registerLaunch = (
    owner: Owner,
    toolCallId: string,
    args: unknown,
    details: unknown,
    asyncId: string,
  ): Array<PiSubagentMember<Owner>> => {
    if (background.has(asyncId)) return [];
    const mode = recordString(details, "mode");
    const run: BackgroundRun<Owner> = {
      owner,
      toolCallId,
      asyncId,
      shape: mode === "workflow" ? "workflow" : mode === "single" ? "single" : "steps",
      members: new Map(),
      stepIds: new Map(),
    };
    background.set(asyncId, run);
    const changed: Array<PiSubagentMember<Owner>> = [];
    const agent = recordString(args, "agent");
    if (run.shape === "single" && agent !== undefined) {
      const member: PiSubagentMember<Owner> = {
        owner,
        toolCallId,
        nativeTaskId: `${asyncId}:subagent:0`,
        title: agent,
        prompt: recordString(args, "task") ?? "",
        model: recordString(args, "model") ?? null,
        status: "running",
        result: null,
      };
      run.members.set("0", member);
      changed.push(member);
    }
    const node = latestSnapshot?.runs.find((candidate) => candidate.id === asyncId);
    if (node !== undefined) changed.push(...applySnapshotRun(run, node));
    return changed;
  };

  return {
    /** A `subagent` tool update or end; `toolStatus` is the tool row's own status. */
    observeTool: (input: {
      readonly owner: Owner;
      readonly toolCallId: string;
      readonly args: unknown;
      readonly details: unknown;
      readonly toolStatus: PiSubagentStatus;
    }): ReadonlyArray<PiSubagentMember<Owner>> => {
      // A detached launch returns its run id and no results; a foreground run fills results.
      const asyncId = recordString(input.details, "asyncId");
      if (
        asyncId !== undefined &&
        input.toolStatus === "completed" &&
        recordArray(input.details, "results").length === 0
      ) {
        return registerLaunch(input.owner, input.toolCallId, input.args, input.details, asyncId);
      }
      return observeForeground(input.owner, input.toolCallId, input.details, input.toolStatus);
    },
    /** Returns undefined when the frame is not a pi-subagents lifecycle frame. */
    observeSessionFrame: (
      frame: PiRpcRecord,
    ): ReadonlyArray<PiSubagentMember<Owner>> | undefined => {
      if (frame["type"] === "extension_ui_request") {
        return frame["method"] === "setWidget" && frame["widgetKey"] === ASYNC_WIDGET_KEY
          ? observeWidget(frame)
          : undefined;
      }
      if (frame["type"] !== "message_end") return undefined;
      const message = frame["message"];
      if (recordString(message, "role") !== "custom") return undefined;
      switch (recordString(message, "customType")) {
        case "subagent-incremental-child-notify":
          return observeChildNotice(recordField(message, "details"));
        case "subagent-notify":
          return observeCompletionNotice(recordField(message, "details"));
        default:
          return undefined;
      }
    },
    /** Settles every running child once the session can no longer observe it. */
    close: (): ReadonlyArray<PiSubagentMember<Owner>> => {
      const running = [
        ...[...foreground.values()].flatMap((members) => [...members.values()]),
        ...[...background.values()].flatMap((run) => [...run.members.values()]),
      ].filter((member) => !isPiSubagentSettled(member.status));
      foreground.clear();
      background.clear();
      latestSnapshot = null;
      return running.map((member) => ({ ...member, status: "interrupted" as const }));
    },
  };
}
