import type {
  GitActionProgressEvent,
  GitCreateBranchInput,
  GitCreateBranchResult,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitCheckoutInput,
  GitCheckoutResult,
  GitPullInput,
  GitPullResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStackedAction,
  GitStatusResult,
} from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { buildGitActionProgressStages } from "./gitActions";
import type { WsRpcClient } from "./wsRpcClient";

export type GitActionOperation =
  | "refresh_status"
  | "run_stacked_action"
  | "pull"
  | "checkout"
  | "create_branch"
  | "create_worktree"
  | "init";

export interface GitActionState {
  readonly isRunning: boolean;
  readonly operation: GitActionOperation | null;
  readonly actionId: string | null;
  readonly action: GitStackedAction | null;
  readonly currentLabel: string | null;
  readonly currentPhaseLabel: string | null;
  readonly hookName: string | null;
  readonly lastOutputLine: string | null;
  readonly phaseStartedAtMs: number | null;
  readonly hookStartedAtMs: number | null;
  readonly error: string | null;
}

export interface GitActionTarget {
  readonly environmentId: string | null;
  readonly cwd: string | null;
}

export type GitActionClient = Pick<
  WsRpcClient["git"],
  | "refreshStatus"
  | "runStackedAction"
  | "pull"
  | "checkout"
  | "createBranch"
  | "createWorktree"
  | "init"
>;

export const EMPTY_GIT_ACTION_STATE = Object.freeze<GitActionState>({
  isRunning: false,
  operation: null,
  actionId: null,
  action: null,
  currentLabel: null,
  currentPhaseLabel: null,
  hookName: null,
  lastOutputLine: null,
  phaseStartedAtMs: null,
  hookStartedAtMs: null,
  error: null,
});

const knownGitActionKeys = new Set<string>();

export const gitActionStateAtom = Atom.family((key: string) => {
  knownGitActionKeys.add(key);
  return Atom.make(EMPTY_GIT_ACTION_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`git-action:${key}`),
  );
});

export const EMPTY_GIT_ACTION_ATOM = Atom.make(EMPTY_GIT_ACTION_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("git-action:null"),
);

export function getGitActionTargetKey(target: GitActionTarget): string | null {
  if (target.environmentId === null || target.cwd === null) {
    return null;
  }
  return `${target.environmentId}:${target.cwd}`;
}

export function applyGitActionProgressEvent(
  current: GitActionState,
  event: GitActionProgressEvent,
): GitActionState {
  const now = Date.now();

  switch (event.kind) {
    case "action_started":
      return {
        ...current,
        isRunning: true,
        actionId: event.actionId,
        action: event.action,
        operation: "run_stacked_action",
        phaseStartedAtMs: now,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        error: null,
      };
    case "phase_started":
      return {
        ...current,
        isRunning: true,
        actionId: event.actionId,
        action: event.action,
        operation: "run_stacked_action",
        currentLabel: event.label,
        currentPhaseLabel: event.label,
        phaseStartedAtMs: now,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        error: null,
      };
    case "hook_started":
      return {
        ...current,
        isRunning: true,
        actionId: event.actionId,
        action: event.action,
        operation: "run_stacked_action",
        currentLabel: `Running ${event.hookName}...`,
        hookName: event.hookName,
        hookStartedAtMs: now,
        lastOutputLine: null,
        error: null,
      };
    case "hook_output":
      return {
        ...current,
        isRunning: true,
        actionId: event.actionId,
        action: event.action,
        operation: "run_stacked_action",
        lastOutputLine: event.text,
        error: null,
      };
    case "hook_finished":
      return {
        ...current,
        isRunning: true,
        actionId: event.actionId,
        action: event.action,
        operation: "run_stacked_action",
        currentLabel: current.currentPhaseLabel,
        hookName: null,
        hookStartedAtMs: null,
        lastOutputLine: null,
        error: null,
      };
    case "action_finished":
      return {
        ...current,
        isRunning: false,
        actionId: event.actionId,
        action: event.action,
        operation: "run_stacked_action",
        error: null,
      };
    case "action_failed":
      return {
        ...EMPTY_GIT_ACTION_STATE,
        actionId: event.actionId,
        action: event.action,
        operation: "run_stacked_action",
        error: event.message,
      };
  }
}

export interface GitActionManagerConfig {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly getClient: (environmentId: string) => GitActionClient | null;
  readonly getActionId?: () => string;
}

export function createGitActionManager(config: GitActionManagerConfig) {
  function setState(targetKey: string, nextState: GitActionState): void {
    config.getRegistry().set(gitActionStateAtom(targetKey), nextState);
  }

  function startOperation(
    targetKey: string,
    input: {
      readonly operation: GitActionOperation;
      readonly actionId?: string;
      readonly action?: GitStackedAction;
      readonly label: string;
    },
  ): void {
    setState(targetKey, {
      isRunning: true,
      operation: input.operation,
      actionId: input.actionId ?? null,
      action: input.action ?? null,
      currentLabel: input.label,
      currentPhaseLabel: input.label,
      hookName: null,
      lastOutputLine: null,
      phaseStartedAtMs: Date.now(),
      hookStartedAtMs: null,
      error: null,
    });
  }

  function finishOperation(targetKey: string): void {
    setState(targetKey, EMPTY_GIT_ACTION_STATE);
  }

  function failOperation(
    targetKey: string,
    error: unknown,
    input: {
      readonly operation: GitActionOperation;
      readonly actionId?: string;
      readonly action?: GitStackedAction;
    },
  ): void {
    setState(targetKey, {
      ...EMPTY_GIT_ACTION_STATE,
      operation: input.operation,
      actionId: input.actionId ?? null,
      action: input.action ?? null,
      error: error instanceof Error ? error.message : "Git action failed.",
    });
  }

  async function runOperation<TResult>(
    target: GitActionTarget,
    input: {
      readonly operation: GitActionOperation;
      readonly label: string;
      readonly actionId?: string;
      readonly action?: GitStackedAction;
      readonly client?: GitActionClient | undefined;
      readonly execute: (client: GitActionClient) => Promise<TResult>;
    },
  ): Promise<TResult | null> {
    const targetKey = getGitActionTargetKey(target);
    if (targetKey === null || target.environmentId === null || target.cwd === null) {
      return null;
    }

    const resolved = input.client ?? config.getClient(target.environmentId);
    if (!resolved) {
      return null;
    }

    startOperation(targetKey, input);
    try {
      const result = await input.execute(resolved);
      finishOperation(targetKey);
      return result;
    } catch (error) {
      failOperation(targetKey, error, input);
      throw error;
    }
  }

  function getSnapshot(target: GitActionTarget): GitActionState {
    const targetKey = getGitActionTargetKey(target);
    if (targetKey === null) {
      return EMPTY_GIT_ACTION_STATE;
    }

    return config.getRegistry().get(gitActionStateAtom(targetKey));
  }

  async function refreshStatus(
    target: GitActionTarget,
    client?: GitActionClient,
    options?: { readonly quiet?: boolean },
  ): Promise<Awaited<ReturnType<GitActionClient["refreshStatus"]>> | null> {
    if (options?.quiet) {
      if (target.environmentId === null || target.cwd === null) {
        return null;
      }
      const resolved = client ?? config.getClient(target.environmentId);
      return resolved ? resolved.refreshStatus({ cwd: target.cwd }) : null;
    }

    return runOperation(target, {
      operation: "refresh_status",
      label: "Refreshing git status",
      client,
      execute: (resolved) => resolved.refreshStatus({ cwd: target.cwd! }),
    });
  }

  async function pull(
    target: GitActionTarget,
    client?: GitActionClient,
    options?: { readonly label?: string },
  ): Promise<GitPullResult | null> {
    return runOperation(target, {
      operation: "pull",
      label: options?.label ?? "Pulling latest changes",
      client,
      execute: (resolved) => resolved.pull({ cwd: target.cwd! } satisfies GitPullInput),
    });
  }

  async function checkout(
    target: GitActionTarget,
    input: Omit<GitCheckoutInput, "cwd">,
    client?: GitActionClient,
    options?: { readonly label?: string },
  ): Promise<GitCheckoutResult | null> {
    return runOperation(target, {
      operation: "checkout",
      label: options?.label ?? "Checking out branch",
      client,
      execute: (resolved) => resolved.checkout({ cwd: target.cwd!, ...input }),
    });
  }

  async function createBranch(
    target: GitActionTarget,
    input: Omit<GitCreateBranchInput, "cwd">,
    client?: GitActionClient,
    options?: { readonly label?: string },
  ): Promise<GitCreateBranchResult | null> {
    return runOperation(target, {
      operation: "create_branch",
      label: options?.label ?? "Creating branch",
      client,
      execute: (resolved) => resolved.createBranch({ cwd: target.cwd!, ...input }),
    });
  }

  async function createWorktree(
    target: GitActionTarget,
    input: Omit<GitCreateWorktreeInput, "cwd">,
    client?: GitActionClient,
    options?: { readonly label?: string },
  ): Promise<GitCreateWorktreeResult | null> {
    return runOperation(target, {
      operation: "create_worktree",
      label: options?.label ?? "Creating worktree",
      client,
      execute: (resolved) => resolved.createWorktree({ cwd: target.cwd!, ...input }),
    });
  }

  async function init(
    target: GitActionTarget,
    client?: GitActionClient,
    options?: { readonly label?: string },
  ): Promise<Awaited<ReturnType<GitActionClient["init"]>> | null> {
    return runOperation(target, {
      operation: "init",
      label: options?.label ?? "Initializing git repository",
      client,
      execute: (resolved) => resolved.init({ cwd: target.cwd! }),
    });
  }

  async function runStackedAction(
    target: GitActionTarget,
    input: Omit<GitRunStackedActionInput, "cwd" | "actionId"> & { readonly actionId?: string },
    options?: {
      readonly client?: GitActionClient;
      readonly gitStatus?: GitStatusResult | null;
      readonly onProgress?: (event: GitActionProgressEvent) => void;
    },
  ): Promise<GitRunStackedActionResult | null> {
    const actionId =
      input.actionId ??
      config.getActionId?.() ??
      `git-action-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const targetKey = getGitActionTargetKey(target);

    return runOperation(target, {
      operation: "run_stacked_action",
      label:
        buildGitActionProgressStages({
          action: input.action,
          hasCustomCommitMessage: Boolean(input.commitMessage?.trim()),
          hasWorkingTreeChanges: options?.gitStatus?.hasWorkingTreeChanges ?? false,
          featureBranch: input.featureBranch ?? false,
          shouldPushBeforePr:
            input.action === "create_pr" &&
            (!(options?.gitStatus?.hasUpstream ?? false) ||
              (options?.gitStatus?.aheadCount ?? 0) > 0),
        })[0] ?? "Running git action",
      actionId,
      action: input.action,
      client: options?.client,
      execute: async (resolved) => {
        const result = await resolved.runStackedAction(
          {
            cwd: target.cwd!,
            actionId,
            ...input,
          },
          {
            onProgress: (event) => {
              if (targetKey !== null) {
                const current = getSnapshot(target);
                setState(targetKey, applyGitActionProgressEvent(current, event));
              }
              options?.onProgress?.(event);
            },
          },
        );
        return result;
      },
    });
  }

  function reset(): void {
    for (const key of knownGitActionKeys) {
      setState(key, EMPTY_GIT_ACTION_STATE);
    }
  }

  return {
    getSnapshot,
    refreshStatus,
    pull,
    checkout,
    createBranch,
    createWorktree,
    init,
    runStackedAction,
    reset,
  };
}
