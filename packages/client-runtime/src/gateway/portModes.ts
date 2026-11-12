import {
  isRuntimeModeAbove,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScheduledTask,
} from "@t3tools/contracts";

import type { GatewayProfile, GatewayRuntimePort, GatewayThreadControlAction } from "./port.ts";

// Depends only on contracts and the port's types, so the app that answers a relayed call can
// apply the same table to the `modeCeiling` the call carries (see McpGatewayRelayEvent).

export interface ModeLimit {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** What a chat needs to make an edit, or anything else, without the user approving it. */
const EDITS: ModeLimit = { runtimeMode: "auto-accept-edits", interactionMode: "default" };
const ANYTHING: ModeLimit = { runtimeMode: "full-access", interactionMode: "default" };

const RUNTIME_MODES: ReadonlySet<unknown> = new Set<RuntimeMode>([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
const isModes = (modes: {
  readonly runtimeMode?: unknown;
  readonly interactionMode?: unknown;
}): modes is ModeLimit =>
  RUNTIME_MODES.has(modes.runtimeMode) &&
  (modes.interactionMode === "default" || modes.interactionMode === "plan");

const exceeded = (limit: ModeLimit, modes: ModeLimit) =>
  isRuntimeModeAbove(modes.runtimeMode, limit.runtimeMode)
    ? "runtime"
    : modes.interactionMode === "default" && limit.interactionMode === "plan"
      ? "interaction"
      : undefined;

const profileModes = (profile: Pick<GatewayProfile, "runtimeMode" | "interactionMode">) => ({
  runtimeMode: profile.runtimeMode === "read-only" ? "approval-required" : profile.runtimeMode,
  interactionMode: profile.interactionMode,
});

interface ThreadRef {
  readonly environmentId: string;
  readonly threadId: string;
}

/** The checks a policy runs, against the port it guards and the caller's limit. */
class Guard {
  readonly port: GatewayRuntimePort;
  readonly limit: ModeLimit;
  readonly refuse: (message: string) => Error;
  constructor(port: GatewayRuntimePort, limit: ModeLimit, refuse: (message: string) => Error) {
    this.port = port;
    this.limit = limit;
    this.refuse = refuse;
  }

  /** `modes` are within the caller's. */
  within(
    what: string,
    modes: { readonly runtimeMode?: unknown; readonly interactionMode?: unknown },
  ) {
    if (!isModes(modes)) {
      throw this.refuse(
        `${what} does not report its modes, so they cannot be checked against this chat's.`,
      );
    }
    const over = exceeded(this.limit, modes);
    if (over !== undefined) {
      throw this.refuse(
        over === "runtime"
          ? `${what} runs in ${modes.runtimeMode}, broader than this chat's ${this.limit.runtimeMode}.`
          : `${what} runs in ${modes.interactionMode} mode, broader than this chat's ${this.limit.interactionMode} mode.`,
      );
    }
  }

  /** The caller's own mode covers `required`: what runs here with no approval prompt. */
  needs(what: string, required: ModeLimit) {
    const over = exceeded(this.limit, required);
    if (over !== undefined) {
      throw this.refuse(
        over === "runtime"
          ? `${what} needs ${required.runtimeMode}, broader than this chat's ${this.limit.runtimeMode}.`
          : `${what} is not open to a chat in ${this.limit.interactionMode} mode.`,
      );
    }
  }

  async threads(targets: ReadonlyArray<ThreadRef | undefined>) {
    for (const target of targets) {
      if (target === undefined) continue;
      this.within(
        `Thread ${target.threadId}`,
        await this.port.getThread(target.environmentId, target.threadId),
      );
    }
  }

  async profiles(environmentId: string) {
    return (await this.port.listProfiles?.(environmentId)) ?? [];
  }

  async profile(environmentId: string, profileId: string) {
    const profile = (await this.profiles(environmentId)).find(
      (candidate) => candidate.profileId === profileId,
    );
    if (profile === undefined) {
      throw this.refuse(`Agent ${profileId} was not found on environment ${environmentId}.`);
    }
    this.within(`Agent ${profileId}`, profileModes(profile));
    return profile;
  }

  /** A task runs at its stored modes, or its bound thread's (ScheduledTaskService.dispatchRun). */
  async scheduledTask(environmentId: string, taskId: string) {
    const listed = (await this.port.scheduledTask?.(environmentId, { action: "list" })) as
      | { readonly tasks?: ReadonlyArray<ScheduledTask> }
      | undefined;
    const task = listed?.tasks?.find((candidate) => candidate.id === taskId);
    if (task === undefined) {
      throw this.refuse(`Scheduled task ${taskId} was not found on environment ${environmentId}.`);
    }
    this.within(`Scheduled task ${taskId}`, task);
    if (task.threadId === null) return;
    // A deleted bound thread is replaced at the task's own modes, checked above.
    const bound = await this.port.getThread(environmentId, task.threadId).catch(() => undefined);
    if (bound !== undefined)
      this.within(`Scheduled task ${taskId}'s thread ${task.threadId}`, bound);
  }
}

type Policy<A extends ReadonlyArray<unknown>> = (guard: Guard, ...args: A) => unknown;

/* The vocabulary McpToolAccess declares server tools with, for port calls. */

/** Changes nothing. */
const reads: Policy<ReadonlyArray<unknown>> = () => undefined;

/** Changes threads, each of which must run within the caller's modes. */
const writesThreads =
  <A extends ReadonlyArray<unknown>>(
    targets: (...args: A) => ReadonlyArray<ThreadRef | undefined>,
  ): Policy<A> =>
  (guard, ...args) =>
    guard.threads(targets(...args));

/** Changes what belongs to no thread and starts nothing: only a full-access/default caller. */
const writesEnvironment =
  (what: string): Policy<ReadonlyArray<unknown>> =>
  (guard) =>
    guard.needs(what, ANYTHING);

const writesLibrary = writesEnvironment("Changing the shared agent library");

/** Like a file edit: a caller that edits without asking. */
const edits =
  (what: string): Policy<ReadonlyArray<unknown>> =>
  (guard) =>
    guard.needs(what, EDITS);

const thread = (environmentId: string, threadId: string | undefined) =>
  threadId === undefined ? undefined : { environmentId, threadId };

const STARTS_WORK: ReadonlySet<GatewayThreadControlAction> = new Set([
  "resume",
  "retry",
  "restart",
]);

type PortPolicies = {
  readonly [M in keyof GatewayRuntimePort]-?: Policy<
    Parameters<NonNullable<GatewayRuntimePort[M]>>
  >;
};

/**
 * Every port method, classified. A new method fails typecheck here until it is. Stopping work,
 * declining an approval and withdrawing a settle request stay open: they are the way back out.
 */
export const PORT_MODE_POLICIES = {
  listEnvironments: reads,
  getEnvironmentStatus: reads,
  getPresence: reads,
  listDevices: reads,
  listProjects: reads,
  listThreads: reads,
  getThread: reads,
  hasThreadMessage: reads,
  getCommandReceipts: reads,
  getPullRequest: reads,
  getPullRequestActivity: reads,
  listProfiles: reads,
  resolveProfileModelSelection: reads,
  listSkills: reads,
  // The Agents board shows no one thread.
  openAgents: reads,
  // Putting a thread on someone's screen acts on it, as messaging it would.
  openThread: writesThreads((environmentId, threadId) => [thread(environmentId, threadId)]),
  focusDevice: writesThreads((environmentId, _device, target) => [
    target.type === "agents" ? undefined : thread(environmentId, target.threadId),
  ]),

  createThread: (guard, input) => guard.within(`The new thread ${input.threadId}`, input),
  sendMessage: writesThreads((input) => [input]),
  controlThread: writesThreads((input) => [STARTS_WORK.has(input.action) ? input : undefined]),
  respondToUserInput: writesThreads((input) => [input]),
  // An approval lets the thread act now, so the caller must be able to take that action itself.
  respondToApproval: async (guard, input) => {
    if (input.decision !== "accept" && input.decision !== "acceptForSession") return;
    const target = await guard.port.getThread(input.environmentId, input.threadId);
    const pending: ReadonlyArray<{ readonly requestId?: unknown; readonly requestKind?: unknown }> =
      Array.isArray(target.pendingApprovals) ? target.pendingApprovals : [];
    const kind = pending.find(
      (candidate) => candidate?.requestId === input.approvalRequestId,
    )?.requestKind;
    const named = typeof kind === "string" ? kind : "command";
    guard.needs(
      `Approving this ${named} request`,
      named === "file-change" || named === "file-read" ? EDITS : ANYTHING,
    );
  },
  settleThread: writesThreads((environmentId, threadId) => [thread(environmentId, threadId)]),
  unsettleThread: writesThreads((environmentId, threadId) => [thread(environmentId, threadId)]),
  setThreadParent: writesThreads((environmentId, threadId, parentThreadId, parentEnvironmentId) => [
    thread(environmentId, threadId),
    thread(parentEnvironmentId ?? environmentId, parentThreadId ?? undefined),
  ]),
  handoffThread: (guard, input) => guard.profile(input.environmentId, input.profileId),
  threadTask: async (guard, environmentId, request) => {
    switch (request.action) {
      case "read":
      case "watch":
      case "board":
      case "projectSnapshot":
        return;
      case "assign":
        return guard.threads([thread(environmentId, request.input.threadId)]);
      // No threadId: the caller's own task.
      case "update":
        return guard.threads([thread(environmentId, request.input.threadId)]);
      case "settleAfterTurn":
        if (request.input.cancel === true) return;
        return guard.threads([thread(environmentId, request.input.threadId)]);
      // A chat's assignment or owner action, relayed by its server with the chat's modes.
      case "remoteAssign":
        return guard.threads([thread(environmentId, request.input.workerThreadId)]);
      case "remoteOwnerAction":
        return guard.threads([thread(environmentId, request.input.update.threadId)]);
      // Server-to-server deliveries for a task split across machines; no chat makes them.
      default:
        return writesEnvironment(`The task call ${request.action}`)(guard);
    }
  },
  scheduledTask: async (guard, environmentId, request) => {
    switch (request.action) {
      case "list":
        return;
      case "create":
        return guard.profile(environmentId, request.input.profileId);
      case "update":
        await guard.scheduledTask(environmentId, request.taskId);
        if (request.patch.profileId !== undefined) {
          await guard.profile(environmentId, request.patch.profileId);
        }
        return;
      // Delete matches the orchestrator's delete_scheduled_task, which refuses broader tasks.
      case "run":
      case "delete":
        return guard.scheduledTask(environmentId, request.taskId);
    }
  },
  // Project records that start nothing, written like a file in the project.
  todo: (guard, _environmentId, request) =>
    request.action === "list" ? undefined : edits("Changing todos")(guard),

  // Every machine syncs the shared library to every agent there, whoever asks it to and at any
  // modes, so only a full-access/default chat may change it.
  createProfile: writesLibrary,
  updateProfile: writesLibrary,
  deleteProfile: writesLibrary,
  replicateProfiles: writesLibrary,
  // Merges the user's own library from their machines, as their app does before each use; it
  // carries nothing the caller chose, and every agent start runs it.
  syncAgentLibrary: reads,
  createSkill: writesLibrary,
  updateSkill: writesLibrary,
  deleteSkill: writesLibrary,
  executeOperation: async (guard, input) => {
    const { operation, payload } = input;
    if (operation === "git.status" || operation === "git.diff") return;
    if (operation === "worktree.reclaim" && payload.dryRun === true) return;
    // Queues a turn in that thread, at that thread's modes.
    if (operation === "pr.apply_review_fixes") {
      return guard.threads([thread(input.environmentId, String(payload.threadId))]);
    }
    // These run with no approval prompt.
    guard.needs(`Running ${operation}`, operation === "git.apply_patch" ? EDITS : ANYTHING);
  },
} satisfies PortPolicies;

/**
 * A port that runs each call only when PORT_MODE_POLICIES allows it at `limit`, on any environment.
 * Its checks read through `port`, so they are only as true as `port`'s answers: a relayed target
 * must apply the same table itself, with the call's `modeCeiling`.
 */
export const withinModes = (
  port: GatewayRuntimePort,
  limit: ModeLimit | undefined,
  refuse: (message: string) => Error = (message) => new Error(message),
): GatewayRuntimePort => {
  if (limit === undefined || exceeded(limit, ANYTHING) === undefined) return port;
  const guard = new Guard(port, limit, refuse);
  const guarded: Record<string, unknown> = {};
  for (const method of Object.keys(PORT_MODE_POLICIES) as Array<keyof GatewayRuntimePort>) {
    const run = port[method] as ((...args: ReadonlyArray<unknown>) => Promise<unknown>) | undefined;
    if (run === undefined) continue;
    const policy = PORT_MODE_POLICIES[method] as Policy<ReadonlyArray<unknown>>;
    guarded[method] = async (...args: ReadonlyArray<unknown>) => {
      await policy(guard, ...args);
      return run.call(port, ...args);
    };
  }
  return guarded as unknown as GatewayRuntimePort;
};
