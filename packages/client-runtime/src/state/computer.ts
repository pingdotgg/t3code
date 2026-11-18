import {
  type ComputerAction,
  type ComputerApproval,
  type ComputerHostView,
  type ComputerSnapshot,
  type ComputerTaskView,
  type EnvironmentId,
  type ServerConfig,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
} from "./runtime.ts";

type ComputerServerConfigs = ReadonlyMap<
  EnvironmentId,
  Pick<ServerConfig, "environment" | "settings">
>;

/** One running task, with the environment it belongs to and the taps it waits for. */
export interface ComputerActivityEntry {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly task: ComputerTaskView;
  readonly approvals: ReadonlyArray<ComputerApproval>;
}

/** A computer one environment can use, labelled with that environment. */
interface ComputerHostEntry {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly host: ComputerHostView;
}

/** What one thread's screen shows of computer use: its running task and the taps it waits for. */
export interface ComputerThreadView {
  readonly task: ComputerTaskView | null;
  readonly approvals: ReadonlyArray<ComputerApproval>;
}

const EMPTY_ACTIVITY: ReadonlyArray<ComputerActivityEntry> = [];
const EMPTY_HOSTS: ReadonlyArray<ComputerHostEntry> = [];
const EMPTY_THREAD_VIEW: ComputerThreadView = { task: null, approvals: [] };

const pendingApprovals = (snapshot: ComputerSnapshot, taskIds: ReadonlySet<string>) =>
  snapshot.approvals.filter(
    (approval) => approval.state === "pending" && taskIds.has(approval.binding.taskId),
  );

const sameIds = (left: ReadonlyArray<ComputerApproval>, right: ReadonlyArray<ComputerApproval>) =>
  left.length === right.length && left.every((approval, index) => approval.id === right[index]?.id);

// A thread's screen redraws only when what it shows changes, not on every step of another thread.
const sameThreadView = (left: ComputerThreadView, right: ComputerThreadView) =>
  sameIds(left.approvals, right.approvals) &&
  (left.task === right.task ||
    (left.task !== null &&
      right.task !== null &&
      left.task.taskId === right.task.taskId &&
      left.task.goal === right.task.goal &&
      left.task.approvalsMode === right.task.approvalsMode));

/**
 * What every client draws of computer use: the hosts each environment can use, the tasks running
 * there, and the approvals still answerable. One `computer.subscribe` per environment feeds every
 * view; a server without the capability is skipped, since it has no computer RPC to answer.
 */
export function createComputerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  serverConfigsAtom: () => Atom.Atom<ComputerServerConfigs>,
) {
  const state = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:computer:state",
    tag: WS_METHODS.computerSubscribe,
  });

  const snapshotOf = (
    get: Atom.AtomContext,
    environmentId: EnvironmentId,
    configs: ComputerServerConfigs,
  ): ComputerSnapshot | null => {
    if (configs.get(environmentId)?.environment.capabilities.computerUse !== true) return null;
    return Option.getOrNull(AsyncResult.value(get(state({ environmentId, input: {} }))));
  };

  const labelOf = (config: Pick<ServerConfig, "environment" | "settings">) =>
    config.settings.environmentLabel ?? config.environment.label;

  const activity = Atom.make((get): ReadonlyArray<ComputerActivityEntry> => {
    const configs = get(serverConfigsAtom());
    const entries: ComputerActivityEntry[] = [];
    for (const [environmentId, config] of configs) {
      const snapshot = snapshotOf(get, environmentId, configs);
      if (snapshot === null) continue;
      for (const task of snapshot.tasks) {
        if (task.status !== "running") continue;
        entries.push({
          environmentId,
          environmentLabel: labelOf(config),
          task,
          approvals: pendingApprovals(snapshot, new Set([task.taskId])),
        });
      }
    }
    return entries.length === 0 ? EMPTY_ACTIVITY : entries;
  }).pipe(Atom.withLabel("computer-activity"));

  const hosts = Atom.make((get): ReadonlyArray<ComputerHostEntry> => {
    const configs = get(serverConfigsAtom());
    const entries: ComputerHostEntry[] = [];
    for (const [environmentId, config] of configs) {
      for (const host of snapshotOf(get, environmentId, configs)?.hosts ?? []) {
        entries.push({ environmentId, environmentLabel: labelOf(config), host });
      }
    }
    return entries.length === 0 ? EMPTY_HOSTS : entries;
  }).pipe(Atom.withLabel("computer-hosts"));

  const threadFamily = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
    return Atom.make((get): ComputerThreadView => {
      const snapshot = snapshotOf(get, environmentId, get(serverConfigsAtom()));
      if (snapshot === null) return EMPTY_THREAD_VIEW;
      const taskIds = new Set<string>();
      let task: ComputerTaskView | null = null;
      for (const candidate of snapshot.tasks) {
        if (candidate.threadId !== threadId) continue;
        taskIds.add(candidate.taskId);
        if (candidate.status === "running") task = candidate;
      }
      if (taskIds.size === 0) return EMPTY_THREAD_VIEW;
      return { task, approvals: pendingApprovals(snapshot, taskIds) };
    }).pipe(Atom.withEquality(sameThreadView), Atom.withLabel("computer-thread"));
  });

  return {
    state,
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:stop",
      tag: WS_METHODS.computerStop,
    }),
    respondToApproval: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:respond-to-approval",
      tag: WS_METHODS.computerRespondToApproval,
    }),
    /** The newest audit lines, oldest first, for Settings. */
    audit: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:computer:audit",
      tag: WS_METHODS.computerAuditTail,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    /** Every environment's running tasks, for a global strip and Stop. */
    activity,
    /** Every environment's connected computers, for Settings. */
    hosts,
    /** One thread's running task and pending taps; equal views keep their identity. */
    thread: (environmentId: EnvironmentId, threadId: ThreadId) =>
      threadFamily(JSON.stringify([environmentId, threadId])),
  };
}

/**
 * The strip's rows while `viewing` is on screen. That thread's taps sit above its own composer, so
 * its row keeps Stop and drops the card; taps from every other thread stay in the strip.
 */
export function computerStripEntries(
  activity: ReadonlyArray<ComputerActivityEntry>,
  viewing: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
): ReadonlyArray<ComputerActivityEntry> {
  if (viewing === null) return activity;
  const owns = (entry: ComputerActivityEntry) =>
    entry.environmentId === viewing.environmentId &&
    entry.task.threadId === viewing.threadId &&
    entry.approvals.length > 0;
  if (!activity.some(owns)) return activity;
  return activity.map((entry) => (owns(entry) ? { ...entry, approvals: [] } : entry));
}

type ComputerEnvironmentAtoms = ReturnType<typeof createComputerEnvironmentAtoms>;

/**
 * Stops every running task in one environment, or only `taskId`. Resolves to null on success, or
 * the sentence to show when the request failed.
 */
export async function stopComputerTasks(
  registry: AtomRegistry.AtomRegistry,
  atoms: Pick<ComputerEnvironmentAtoms, "stop">,
  input: { readonly environmentId: EnvironmentId; readonly taskId?: string },
): Promise<string | null> {
  const result = await runAtomCommand(
    registry,
    atoms.stop,
    {
      environmentId: input.environmentId,
      input: input.taskId === undefined ? {} : { taskId: input.taskId },
    },
    { reportFailure: false },
  );
  if (result._tag === "Success") return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message.trim().length > 0
    ? failure.message
    : "Could not stop computer use.";
}

/** The approvals still answerable at `nowMs`: each lasts until its own deadline. */
export function computerLiveApprovals(
  approvals: ReadonlyArray<ComputerApproval>,
  nowMs: number,
): ReadonlyArray<ComputerApproval> {
  return approvals.filter((approval) => DateTime.toEpochMillis(approval.expiresAt) > nowMs);
}

/**
 * When the next of these approvals lapses, so a view re-renders once at that moment instead of on
 * a timer. Null when nothing waits.
 */
export function nextComputerApprovalDeadline(
  approvals: ReadonlyArray<ComputerApproval>,
): number | null {
  let next: number | null = null;
  for (const approval of approvals) {
    const expiresAtMs = DateTime.toEpochMillis(approval.expiresAt);
    if (next === null || expiresAtMs < next) next = expiresAtMs;
  }
  return next;
}

function clipped(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

const quoted = (value: string) => `“${clipped(value, 120)}”`;

/**
 * One line for the step an approval covers. Screen text is data: it is quoted, clipped and never
 * read as an instruction.
 */
export function computerActionSentence(action: ComputerAction): string {
  const where = action.role && action.label ? `${action.role} ${quoted(action.label)}` : null;
  switch (action.kind) {
    case "click":
      return where === null ? "Click an element" : `Click ${where}`;
    case "type":
      return action.text === undefined
        ? "Type text"
        : `Type ${action.text.length} characters${where === null ? "" : ` into ${where}`}`;
    case "press":
      return action.key === undefined ? "Press a key" : `Press ${action.key}`;
    case "scroll":
      return action.direction === undefined
        ? "Scroll"
        : `Scroll ${action.direction}${where === null ? "" : ` on ${where}`}`;
    case "surface":
      return action.name === undefined
        ? `Bring the ${action.what ?? "app"} forward`
        : `Bring ${action.what ?? "app"} ${quoted(action.name)} forward`;
    case "pointer":
      return action.why === undefined ? "Use your mouse" : clipped(action.why, 160);
    default:
      return action.kind;
  }
}

/** The exact text a step types. Only a `type` step carries one, and it is the only text typed. */
export function computerApprovalTypedText(approval: ComputerApproval): string | null {
  return approval.binding.action.kind === "type" ? (approval.binding.action.text ?? null) : null;
}

/** Where the step happens: the app, the window and the page, when the helper knows them. */
export function computerApprovalSurface(approval: ComputerApproval): string {
  const { app, title, url } = approval.binding;
  const parts = [app, title]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => clipped(part, 160));
  const page = url.trim();
  if (page.length > 0) {
    const shown = clipped(page, 200);
    if (!parts.includes(shown)) parts.push(shown);
  }
  return parts.join(" · ");
}

/** The last step a running task took, for a strip row. */
export function computerTaskLastStep(task: ComputerTaskView): string | null {
  const last = task.steps[task.steps.length - 1];
  return last === undefined || last.trim().length === 0 ? null : clipped(last, 160);
}
