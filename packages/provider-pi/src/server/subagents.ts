import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  piRecordField as recordField,
  piRecordString as recordString,
  type PiRpcRecord,
} from "./rpc.ts";

export type PiBackgroundSubagentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

const isSettled = (status: PiBackgroundSubagentStatus) =>
  status !== "pending" && status !== "running";

/** One child of a detached pi-subagents run, as a row on the turn (`Owner`) that launched it. */
export interface PiBackgroundSubagent<Owner> {
  readonly owner: Owner;
  readonly toolCallId: string;
  /** Stable across every frame that describes this child. */
  readonly nativeTaskId: string;
  readonly title: string;
  readonly prompt: string;
  readonly model: string | null;
  /** When the child itself started, in epoch milliseconds; null until pi-subagents says. */
  readonly startedAt: number | null;
  readonly status: PiBackgroundSubagentStatus;
}

interface BackgroundRun<Owner> {
  readonly owner: Owner;
  readonly toolCallId: string;
  readonly asyncId: string;
  readonly workflow: boolean;
  readonly members: Map<string, PiBackgroundSubagent<Owner>>;
  /** Chain and parallel steps' positions by the run id the widget gave them, which is how a notice names them. */
  readonly stepKeys: Map<string, string>;
  stopRequested: boolean;
}

const ASYNC_WIDGET_KEY = "subagent-async";
const ASYNC_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const PLACEHOLDER_STEP_ID = /^step:(\d+)$/;

const SnapshotNode = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  state: Schema.String,
  label: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
});
const decodeStatusSnapshot = Schema.decodeUnknownOption(
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
type StatusSnapshot = Option.Option.Value<ReturnType<typeof decodeStatusSnapshot>>;
type SnapshotRun = StatusSnapshot["runs"][number];

// Completion notices name their run from pi-subagents 0.77; older ones settle through the widget.
const decodeCompletionNotice = Schema.decodeUnknownOption(
  Schema.Struct({
    runs: Schema.Array(
      Schema.Struct({
        runId: Schema.optional(Schema.String),
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

/** A paused child is not running and resumes as a new run; `detached` and unknown states say nothing. */
function backgroundStatus(state: string | undefined): PiBackgroundSubagentStatus | undefined {
  switch (state) {
    case "queued":
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "complete":
    case "completed":
      return "completed";
    case "partial":
    case "failed":
    case "rejected":
      return "failed";
    case "paused":
    case "stopped":
      return "interrupted";
    default:
      return undefined;
  }
}

/**
 * Tracks detached pi-subagents runs from the frames the extension sends about them: the
 * `subagent` tool's launch receipt, the `subagent-async` status widget and the `subagent-notify`
 * completion notice. A run stays with the turn (`Owner`) whose call launched it, however late its
 * frames arrive, and is forgotten once every child has an outcome.
 */
export function makePiBackgroundSubagents<Owner>() {
  const runs = new Map<string, BackgroundRun<Owner>>();
  // The widget can list a run before the tool call that launched it returns its receipt.
  let latestSnapshot: StatusSnapshot | null = null;

  const update = (
    run: BackgroundRun<Owner>,
    key: string,
    status: PiBackgroundSubagentStatus | undefined,
    fields: {
      readonly title?: string | undefined;
      readonly model?: string | undefined;
      readonly startedAt?: number | undefined;
    } = {},
  ): ReadonlyArray<PiBackgroundSubagent<Owner>> => {
    const previous = run.members.get(key);
    // An outcome is final, and a run asked to stop takes nothing but outcomes.
    const nextStatus =
      previous !== undefined && isSettled(previous.status)
        ? previous.status
        : status !== undefined && (!run.stopRequested || isSettled(status))
          ? status
          : previous?.status;
    const title = fields.title ?? previous?.title;
    if (nextStatus === undefined || title === undefined) return [];
    const next: PiBackgroundSubagent<Owner> = {
      owner: run.owner,
      toolCallId: run.toolCallId,
      nativeTaskId: `${run.asyncId}:subagent:${key}`,
      title,
      prompt: previous?.prompt ?? "",
      model: fields.model ?? previous?.model ?? null,
      // Later snapshots restate a step's start by a few milliseconds; the first report stands.
      startedAt: previous?.startedAt ?? fields.startedAt ?? null,
      status: nextStatus,
    };
    if (
      previous !== undefined &&
      previous.title === next.title &&
      previous.model === next.model &&
      previous.startedAt === next.startedAt &&
      previous.status === next.status
    ) {
      return [];
    }
    run.members.set(key, next);
    return [next];
  };

  /**
   * Children the run's own outcome did not name end with the run. A workflow can finish its
   * dispatch while children it names as running go on, so those keep the run tracked.
   */
  const settleRun = (
    run: BackgroundRun<Owner>,
    status: PiBackgroundSubagentStatus | undefined,
    running: ReadonlySet<string> = new Set(),
  ): ReadonlyArray<PiBackgroundSubagent<Owner>> => {
    if (status === undefined || !isSettled(status)) return [];
    const keys = [...run.members.keys()];
    if (!run.workflow || !keys.some((key) => running.has(key))) runs.delete(run.asyncId);
    return keys.flatMap((key) =>
      run.workflow && running.has(key) ? [] : update(run, key, status),
    );
  };

  const applySnapshot = (
    run: BackgroundRun<Owner>,
    node: SnapshotRun,
  ): ReadonlyArray<PiBackgroundSubagent<Owner>> => {
    const steps = (node.children ?? []).filter((child) => child.kind === "step");
    // Workflow steps are named by their key. Chain and parallel steps trade a `step:<position>`
    // placeholder for a run id once they start, and the widget lists only the active parallel
    // group: a new run id sits relative to a listed step of known position, else after the last taken.
    const positions = steps.map((step) => {
      const placeholder = PLACEHOLDER_STEP_ID.exec(step.id)?.[1];
      const known = placeholder ?? run.stepKeys.get(step.id);
      return known === undefined ? undefined : Number(known);
    });
    const anchor = positions.findIndex((position) => position !== undefined);
    // A row with an outcome is never the step a new run id names, even if it ended on a placeholder.
    const taken = [...run.members]
      .filter(([, member]) => isSettled(member.status))
      .map(([key]) => key);
    const first =
      anchor === -1
        ? Math.max(-1, ...[...run.stepKeys.values(), ...taken].map(Number)) + 1
        : positions[anchor]! - anchor;
    const running = new Set<string>();
    const changed = steps.flatMap((step, index) => {
      const key = run.workflow ? step.id : String(first + index);
      if (!PLACEHOLDER_STEP_ID.test(step.id)) run.stepKeys.set(step.id, key);
      const status = backgroundStatus(step.state);
      if (status === "running") running.add(key);
      return update(run, key, status, {
        title: step.agent ?? run.members.get(key)?.title ?? step.label ?? step.id,
        model: step.model,
        startedAt: step.startedAt,
      });
    });
    const rootStatus = backgroundStatus(node.state);
    const single = steps.length === 0 && !run.workflow ? update(run, "0", rootStatus) : [];
    return [...changed, ...single, ...settleRun(run, rootStatus, running)];
  };

  const observeWidget = (frame: PiRpcRecord): ReadonlyArray<PiBackgroundSubagent<Owner>> => {
    const lines = frame["widgetLines"];
    const line = Array.isArray(lines)
      ? lines.find(
          (entry): entry is string =>
            typeof entry === "string" && entry.startsWith(ASYNC_WIDGET_PREFIX),
        )
      : undefined;
    if (line === undefined) return [];
    const snapshot = Option.getOrUndefined(
      decodeStatusSnapshot(line.slice(ASYNC_WIDGET_PREFIX.length)),
    );
    if (snapshot === undefined) return [];
    if (latestSnapshot !== null && snapshot.generatedAt < latestSnapshot.generatedAt) return [];
    latestSnapshot = snapshot;
    return snapshot.runs.flatMap((node) => {
      const run = runs.get(node.id);
      return run === undefined ? [] : applySnapshot(run, node);
    });
  };

  const observeNotice = (details: unknown): ReadonlyArray<PiBackgroundSubagent<Owner>> => {
    const notice = Option.getOrUndefined(decodeCompletionNotice(details));
    if (notice === undefined) return [];
    return notice.runs.flatMap((notified) => {
      const run = notified.runId === undefined ? undefined : runs.get(notified.runId);
      if (run === undefined) return [];
      const running = new Set<string>();
      const children = (notified.childRuns ?? []).flatMap((child) => {
        const key = run.workflow
          ? child.workflowKey
          : child.runId === undefined
            ? undefined
            : run.stepKeys.get(child.runId);
        if (key === undefined) return [];
        const status = backgroundStatus(child.status);
        if (status === "running") running.add(key);
        return update(run, key, status, {
          title: child.agent ?? run.members.get(key)?.title ?? key,
        });
      });
      return [...children, ...settleRun(run, backgroundStatus(notified.status), running)];
    });
  };

  return {
    /** Turns whose detached runs still have a child without an outcome. */
    pendingOwners: (): ReadonlySet<Owner> => new Set([...runs.values()].map((run) => run.owner)),
    /**
     * A finished `subagent` tool call. A detached launch answers with the run's id and no
     * results; a foreground run fills `results`, and a management action is not a launch.
     */
    observeLaunch: (input: {
      readonly owner: Owner;
      readonly toolCallId: string;
      readonly args: unknown;
      readonly details: unknown;
    }): ReadonlyArray<PiBackgroundSubagent<Owner>> => {
      const asyncId = recordString(input.details, "asyncId");
      const mode = recordString(input.details, "mode");
      const results = recordField(input.details, "results");
      if (
        asyncId === undefined ||
        mode === undefined ||
        !["single", "workflow", "chain", "parallel"].includes(mode) ||
        recordString(input.args, "action") !== undefined ||
        (Array.isArray(results) && results.length > 0) ||
        runs.has(asyncId)
      ) {
        return [];
      }
      const run: BackgroundRun<Owner> = {
        owner: input.owner,
        toolCallId: input.toolCallId,
        asyncId,
        workflow: mode === "workflow",
        members: new Map(),
        stepKeys: new Map(),
        stopRequested: false,
      };
      runs.set(asyncId, run);
      const emitted = new Map<string, PiBackgroundSubagent<Owner>>();
      const agent = recordString(input.args, "agent");
      if (mode === "single" && agent !== undefined) {
        const launched: PiBackgroundSubagent<Owner> = {
          owner: run.owner,
          toolCallId: run.toolCallId,
          nativeTaskId: `${asyncId}:subagent:0`,
          title: agent,
          prompt: recordString(input.args, "task") ?? "",
          model: recordString(input.args, "model") ?? null,
          startedAt: null,
          status: "running",
        };
        run.members.set("0", launched);
        emitted.set(launched.nativeTaskId, launched);
      }
      const node = latestSnapshot?.runs.find((candidate) => candidate.id === asyncId);
      for (const member of node === undefined ? [] : applySnapshot(run, node)) {
        emitted.set(member.nativeTaskId, member);
      }
      return [...emitted.values()];
    },
    /** Returns undefined when the frame is not a pi-subagents status widget or completion notice. */
    observeSessionFrame: (
      frame: PiRpcRecord,
    ): ReadonlyArray<PiBackgroundSubagent<Owner>> | undefined => {
      if (frame["type"] === "extension_ui_request") {
        return frame["method"] === "setWidget" && frame["widgetKey"] === ASYNC_WIDGET_KEY
          ? observeWidget(frame)
          : undefined;
      }
      if (frame["type"] !== "message_end") return undefined;
      const message = frame["message"];
      return recordString(message, "role") === "custom" &&
        recordString(message, "customType") === "subagent-notify"
        ? observeNotice(recordField(message, "details"))
        : undefined;
    },
    /**
     * Marks the matching owners' live runs as asked to stop and returns their ids. The runs stay
     * tracked: their rows change only when pi-subagents reports each child's real outcome.
     */
    requestStop: (matches: (owner: Owner) => boolean): ReadonlyArray<string> =>
      [...runs.values()].flatMap((run) => {
        if (!matches(run.owner)) return [];
        run.stopRequested = true;
        return [run.asyncId];
      }),
    /** The session can no longer observe its runs, so every child without an outcome ends here. */
    close: (): ReadonlyArray<PiBackgroundSubagent<Owner>> => {
      const open = [...runs.values()].flatMap((run) =>
        [...run.members.values()]
          .filter((member) => !isSettled(member.status))
          .map((member) => ({ ...member, status: "interrupted" as const })),
      );
      runs.clear();
      latestSnapshot = null;
      return open;
    },
  };
}
