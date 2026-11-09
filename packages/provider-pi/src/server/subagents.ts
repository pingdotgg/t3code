import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  piContentText as contentText,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcRecord,
} from "./rpc.ts";

export type PiSubagentStatus =
  | "pending"
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "interrupted";

export const isPiSubagentSettled = (status: PiSubagentStatus) =>
  status !== "pending" && status !== "running" && status !== "idle";

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
  /** Single runs have one child; workflow steps are keyed by workflow key; chain and parallel by child run ID. */
  readonly shape: "single" | "workflow" | "steps";
  readonly members: Map<string, PiSubagentMember<Owner>>;
  status: PiSubagentStatus;
  // Decoded live states track pending work; unknown states never establish child rows or outcomes.
  childStates: ReadonlyMap<string, PiSubagentStatus | undefined>;
}

const reconcileStatus = (previous: PiSubagentStatus, next: PiSubagentStatus | undefined) =>
  isPiSubagentSettled(previous) ? previous : (next ?? previous);

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
              status: Schema.optional(Schema.String),
            }),
          ),
        ),
      }),
    ),
  }),
);

/** Detached children have no outcome yet; paused children can resume. */
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
    case "paused":
      return "idle";
    case "partial":
    case "failed":
    case "rejected":
      return "failed";
    case "interrupted":
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
  const earlyNotices = new Map<string, unknown>();
  const isPending = (run: BackgroundRun<Owner>) =>
    run.status !== "idle" &&
    (!isPiSubagentSettled(run.status) ||
      [...run.childStates.values()].some(
        (status) => status !== undefined && !isPiSubagentSettled(status),
      ));
  // A snapshot can list a run before the tool call that launched it has returned its receipt.
  let latestSnapshot: AsyncStatusSnapshot | null = null;

  /** Terminal outcomes are immutable; later structured frames can still enrich metadata. */
  const updateMember = (
    run: BackgroundRun<Owner>,
    key: string,
    status: PiSubagentStatus | undefined,
    fields: { readonly title?: string | undefined; readonly model?: string | undefined },
  ): PiSubagentMember<Owner> | undefined => {
    const previous = run.members.get(key);

    const title = fields.title ?? previous?.title;
    const nextStatus =
      run.status === "idle"
        ? previous?.status
        : previous === undefined
          ? status
          : reconcileStatus(previous.status, status);
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
    // A paused root ends this async generation; upstream resume launches a new async ID.
    if (run.status === "idle") return [];
    const terminalRoot = isPiSubagentSettled(run.status);
    const steps = (node.children ?? []).filter((child) => child.kind === "step");
    const changed =
      run.shape === "single"
        ? [
            updateMember(run, "0", memberStatus(node.state), {
              title: steps[0]?.agent,
              model: steps[0]?.model,
            }),
          ].filter((member) => member !== undefined)
        : steps.flatMap((step) => {
            // Positional planning slots become run IDs at launch; capped snapshots cannot prove that join.
            if (run.shape === "steps" && step.id.startsWith("step:")) return [];
            // Widget IDs are sanitized/capped upstream; only exact structural IDs can join notice children.
            const key = step.id;
            const changed = updateMember(run, key, memberStatus(step.state), {
              title: step.agent ?? run.members.get(key)?.title ?? step.label ?? step.id,
              model: step.model,
            });
            return changed === undefined ? [] : [changed];
          });
    run.status = reconcileStatus(run.status, memberStatus(node.state));
    // After a root outcome, widgets may settle evidenced live children but cannot add pending work.
    run.childStates = terminalRoot
      ? new Map(
          [...run.childStates].map(([key, status]) => [
            key,
            status === undefined
              ? undefined
              : reconcileStatus(status, run.members.get(key)?.status),
          ]),
        )
      : new Map([...run.members].map(([key, member]) => [key, member.status]));
    return changed;
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

  const observeCompletionNotice = (details: unknown): Array<PiSubagentMember<Owner>> => {
    const notice = Option.getOrUndefined(decodeCompletionNotice(details));
    if (notice === undefined) return [];
    return notice.runs.flatMap((notified) => {
      const asyncId = notified.workflowRunId ?? notified.runId;
      const run = asyncId === undefined ? undefined : background.get(asyncId);
      if (run === undefined) {
        // Structured settlement requires pi-subagents >= 0.77; never infer IDs from notice prose.
        if (asyncId !== undefined) {
          earlyNotices.set(asyncId, { runs: [notified] });
          if (earlyNotices.size > 128) earlyNotices.delete(earlyNotices.keys().next().value!);
        }
        return [];
      }
      const changed: Array<PiSubagentMember<Owner>> = [];
      const childRuns = notified.childRuns ?? [];
      for (const child of childRuns) {
        const key =
          run.shape === "workflow" ? child.workflowKey : run.shape === "single" ? "0" : child.runId;
        if (key === undefined) continue;
        const member = updateMember(run, key, memberStatus(child.status), {
          title: child.agent ?? run.members.get(key)?.title ?? child.workflowKey,
        });
        if (member !== undefined) changed.push(member);
      }
      const runStatus = memberStatus(notified.status);
      if (run.shape === "single" && childRuns.length === 0 && runStatus !== undefined) {
        const member = updateMember(run, "0", runStatus, { title: notified.agent });
        if (member !== undefined) changed.push(member);
      }
      if (run.status === "idle") return changed;
      if (runStatus === "idle" && !isPiSubagentSettled(run.status)) {
        run.status = runStatus;
        return changed;
      }
      if (runStatus !== undefined && isPiSubagentSettled(runStatus)) {
        run.status = reconcileStatus(run.status, runStatus);
        // Unknown notice statuses supply no evidence that a child is still live.
        run.childStates =
          run.status === "completed"
            ? new Map(
                childRuns.flatMap((child) => {
                  const key =
                    run.shape === "workflow"
                      ? child.workflowKey
                      : run.shape === "single"
                        ? "0"
                        : child.runId;
                  if (key === undefined) return [];
                  const previous = run.members.get(key)?.status;
                  const status = memberStatus(child.status);
                  return [
                    [
                      key,
                      previous !== undefined && isPiSubagentSettled(previous) ? previous : status,
                    ] as const,
                  ];
                }),
              )
            : new Map();
        for (const [key, member] of run.members) {
          if (isPiSubagentSettled(member.status) || runStatus === "completed") continue;
          const settled = updateMember(run, key, runStatus, {});
          if (settled !== undefined) changed.push(settled);
        }
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
      const explicitlyFinished = recordField(result, "finished") === true;
      const finished = toolFinished || explicitlyFinished;
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
            : toolFinished && !explicitlyFinished
              ? toolStatus
              : finished
                ? "completed"
                : "running",
        ...(!finished && outputText.length > 0 ? { progress: outputText.slice(0, 200) } : {}),
        result: finished && outputText.length > 0 ? outputText.slice(0, 10_000) : null,
      });
    }
    for (const [key, member] of frame) {
      const previous = members.get(key);
      const status =
        previous !== undefined && isPiSubagentSettled(previous.status)
          ? previous.status
          : toolFinished && !isPiSubagentSettled(member.status)
            ? toolStatus
            : member.status;
      const reconciled = { ...member, status };
      frame.set(key, reconciled);
      members.set(key, reconciled);
    }
    if (!toolFinished) {
      if (members.size > 0) foreground.set(toolCallId, members);
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
    foreground.delete(toolCallId);
    if (background.has(asyncId)) return [];
    const mode = recordString(details, "mode");
    const run: BackgroundRun<Owner> = {
      owner,
      toolCallId,
      asyncId,
      shape: mode === "workflow" ? "workflow" : mode === "single" ? "single" : "steps",
      members: new Map(),
      status: "running",
      childStates: new Map(),
    };
    background.set(asyncId, run);
    const changed: Array<PiSubagentMember<Owner>> = [];
    // Bound unresolved owners and terminal metadata even when no final notice ever arrives.
    if (background.size > 128) {
      const oldest =
        [...background.values()].find((candidate) => !isPending(candidate)) ??
        background.values().next().value!;
      background.delete(oldest.asyncId);
      for (const member of oldest.members.values()) {
        if (!isPiSubagentSettled(member.status)) changed.push({ ...member, status: "interrupted" });
      }
    }
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
    const early = earlyNotices.get(asyncId);
    earlyNotices.delete(asyncId);
    if (early !== undefined) changed.push(...observeCompletionNotice(early));
    return changed;
  };

  return {
    pendingOwners: () =>
      new Set([...background.values()].filter(isPending).map((run) => run.owner)),
    finishForeground: (
      owner: Owner,
      status: PiSubagentStatus,
    ): ReadonlyArray<PiSubagentMember<Owner>> => {
      const changed: Array<PiSubagentMember<Owner>> = [];
      for (const [id, members] of foreground) {
        if ([...members.values()][0]?.owner !== owner) continue;
        foreground.delete(id);
        for (const member of members.values()) {
          if (!isPiSubagentSettled(member.status)) changed.push({ ...member, status });
        }
      }
      return changed;
    },
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
        ["single", "workflow", "chain", "parallel"].includes(
          recordString(input.details, "mode") ?? "",
        ) &&
        recordString(input.args, "action") === undefined &&
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
          // childKey alone cannot identify a workflow in a capped snapshot.
          return [];
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
      earlyNotices.clear();
      return running.map((member) => ({ ...member, status: "interrupted" as const }));
    },
  };
}
