import type {
  GitActionProgressEvent,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStackedAction,
  EnvironmentId,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsPullInput,
  VcsPullResult,
  VcsStatusResult,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { buildGitActionProgressStages } from "./gitActions.ts";
import type { WsRpcClient } from "./wsRpcClient.ts";

export type VcsActionOperation =
  | "refresh_status"
  | "run_change_request"
  | "pull"
  | "switch_ref"
  | "create_ref"
  | "create_worktree"
  | "init";

export interface VcsActionState {
  readonly isRunning: boolean;
  readonly operation: VcsActionOperation | null;
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

export interface VcsActionTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

export type VcsActionClient = Pick<
  WsRpcClient["vcs"],
  "refreshStatus" | "pull" | "switchRef" | "createRef" | "createWorktree" | "init"
> & {
  readonly runChangeRequest: WsRpcClient["git"]["runStackedAction"];
};

export const EMPTY_VCS_ACTION_STATE = Object.freeze<VcsActionState>({
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

const knownVcsActionKeys = new Set<string>();
let nextGeneratedActionId = 0;
const nowMs = () => DateTime.toEpochMillis(DateTime.nowUnsafe());

export const vcsActionStateAtom = Atom.family((key: string) => {
  knownVcsActionKeys.add(key);
  return Atom.make(EMPTY_VCS_ACTION_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`vcs-action:${key}`),
  );
});

export const EMPTY_VCS_ACTION_ATOM = Atom.make(EMPTY_VCS_ACTION_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("vcs-action:null"),
);

export function getVcsActionTargetKey(target: VcsActionTarget): string | null {
  if (target.environmentId === null || target.cwd === null) {
    return null;
  }
  return `${target.environmentId}:${target.cwd}`;
}

export function applyVcsActionProgressEvent(
  current: VcsActionState,
  event: GitActionProgressEvent,
): VcsActionState {
  const now = nowMs();

  switch (event.kind) {
    case "action_started":
      return {
        ...current,
        isRunning: true,
        actionId: event.actionId,
        action: event.action,
        operation: "run_change_request",
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
        operation: "run_change_request",
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
        operation: "run_change_request",
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
        operation: "run_change_request",
        lastOutputLine: event.text,
        error: null,
      };
    case "hook_finished":
      return {
        ...current,
        isRunning: true,
        actionId: event.actionId,
        action: event.action,
        operation: "run_change_request",
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
        operation: "run_change_request",
        error: null,
      };
    case "action_failed":
      return {
        ...EMPTY_VCS_ACTION_STATE,
        actionId: event.actionId,
        action: event.action,
        operation: "run_change_request",
        error: event.message,
      };
  }
}

export interface VcsActionManagerConfig {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly getClient: (environmentId: EnvironmentId) => VcsActionClient | null;
  readonly getActionId?: () => string;
  readonly onInvalidate?: (target: VcsActionTarget) => void | Promise<void>;
}

export function createVcsActionManager(config: VcsActionManagerConfig) {
  function setState(targetKey: string, nextState: VcsActionState): void {
    config.getRegistry().set(vcsActionStateAtom(targetKey), nextState);
  }

  function startOperation(
    targetKey: string,
    input: {
      readonly operation: VcsActionOperation;
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
      phaseStartedAtMs: nowMs(),
      hookStartedAtMs: null,
      error: null,
    });
  }

  function finishOperation(targetKey: string): void {
    setState(targetKey, EMPTY_VCS_ACTION_STATE);
  }

  function failOperation(
    targetKey: string,
    error: unknown,
    input: {
      readonly operation: VcsActionOperation;
      readonly actionId?: string;
      readonly action?: GitStackedAction;
    },
  ): void {
    setState(targetKey, {
      ...EMPTY_VCS_ACTION_STATE,
      operation: input.operation,
      actionId: input.actionId ?? null,
      action: input.action ?? null,
      error: error instanceof Error ? error.message : "Source control action failed.",
    });
  }

  async function runOperation<TResult>(
    target: VcsActionTarget,
    input: {
      readonly operation: VcsActionOperation;
      readonly label: string;
      readonly actionId?: string;
      readonly action?: GitStackedAction;
      readonly client?: VcsActionClient | undefined;
      readonly invalidateOnSuccess?: boolean;
      readonly execute: (client: VcsActionClient) => Promise<TResult>;
    },
  ): Promise<TResult | null> {
    const targetKey = getVcsActionTargetKey(target);
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
      if (input.invalidateOnSuccess ?? true) {
        await config.onInvalidate?.(target);
      }
      return result;
    } catch (error) {
      failOperation(targetKey, error, input);
      throw error;
    }
  }

  function getSnapshot(target: VcsActionTarget): VcsActionState {
    const targetKey = getVcsActionTargetKey(target);
    if (targetKey === null) {
      return EMPTY_VCS_ACTION_STATE;
    }

    return config.getRegistry().get(vcsActionStateAtom(targetKey));
  }

  async function refreshStatus(
    target: VcsActionTarget,
    client?: VcsActionClient,
    options?: { readonly quiet?: boolean },
  ): Promise<Awaited<ReturnType<VcsActionClient["refreshStatus"]>> | null> {
    if (options?.quiet) {
      if (target.environmentId === null || target.cwd === null) {
        return null;
      }
      const resolved = client ?? config.getClient(target.environmentId);
      return resolved ? resolved.refreshStatus({ cwd: target.cwd }) : null;
    }

    return runOperation(target, {
      operation: "refresh_status",
      label: "Refreshing source control status",
      client,
      invalidateOnSuccess: false,
      execute: (resolved) => resolved.refreshStatus({ cwd: target.cwd! }),
    });
  }

  async function pull(
    target: VcsActionTarget,
    client?: VcsActionClient,
    options?: { readonly label?: string },
  ): Promise<VcsPullResult | null> {
    return runOperation(target, {
      operation: "pull",
      label: options?.label ?? "Pulling latest changes",
      client,
      execute: (resolved) => resolved.pull({ cwd: target.cwd! } satisfies VcsPullInput),
    });
  }

  async function switchRef(
    target: VcsActionTarget,
    input: Omit<VcsSwitchRefInput, "cwd">,
    client?: VcsActionClient,
    options?: { readonly label?: string },
  ): Promise<VcsSwitchRefResult | null> {
    return runOperation(target, {
      operation: "switch_ref",
      label: options?.label ?? "Switching branch",
      client,
      execute: (resolved) =>
        resolved.switchRef({ cwd: target.cwd!, ...input } as VcsSwitchRefInput),
    });
  }

  async function createRef(
    target: VcsActionTarget,
    input: Omit<VcsCreateRefInput, "cwd">,
    client?: VcsActionClient,
    options?: { readonly label?: string },
  ): Promise<VcsCreateRefResult | null> {
    return runOperation(target, {
      operation: "create_ref",
      label: options?.label ?? "Creating branch",
      client,
      execute: (resolved) =>
        resolved.createRef({ cwd: target.cwd!, ...input } as VcsCreateRefInput),
    });
  }

  async function createWorktree(
    target: VcsActionTarget,
    input: Omit<VcsCreateWorktreeInput, "cwd">,
    client?: VcsActionClient,
    options?: { readonly label?: string },
  ): Promise<VcsCreateWorktreeResult | null> {
    return runOperation(target, {
      operation: "create_worktree",
      label: options?.label ?? "Creating worktree",
      client,
      execute: (resolved) =>
        resolved.createWorktree({ cwd: target.cwd!, ...input } as VcsCreateWorktreeInput),
    });
  }

  async function init(
    target: VcsActionTarget,
    client?: VcsActionClient,
    options?: { readonly label?: string },
  ): Promise<Awaited<ReturnType<VcsActionClient["init"]>> | null> {
    return runOperation(target, {
      operation: "init",
      label: options?.label ?? "Initializing repository",
      client,
      execute: (resolved) => resolved.init({ cwd: target.cwd! }),
    });
  }

  async function runChangeRequest(
    target: VcsActionTarget,
    input: Omit<GitRunStackedActionInput, "cwd" | "actionId"> & { readonly actionId?: string },
    options?: {
      readonly client?: VcsActionClient;
      readonly gitStatus?: VcsStatusResult | null;
      readonly onProgress?: (event: GitActionProgressEvent) => void;
    },
  ): Promise<GitRunStackedActionResult | null> {
    const actionId =
      input.actionId ??
      config.getActionId?.() ??
      `vcs-action-${nowMs()}-${++nextGeneratedActionId}`;
    const targetKey = getVcsActionTargetKey(target);

    return runOperation(target, {
      operation: "run_change_request",
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
        })[0] ?? "Running source control action",
      actionId,
      action: input.action,
      client: options?.client,
      execute: async (resolved) => {
        const result = await resolved.runChangeRequest(
          {
            cwd: target.cwd!,
            actionId,
            ...input,
          },
          {
            onProgress: (event) => {
              if (targetKey !== null) {
                const current = getSnapshot(target);
                setState(targetKey, applyVcsActionProgressEvent(current, event));
              }
              options?.onProgress?.(event);
            },
          },
        );
        return result;
      },
    });
  }

  function reset(target?: VcsActionTarget): void {
    if (target) {
      const targetKey = getVcsActionTargetKey(target);
      if (targetKey !== null) {
        setState(targetKey, EMPTY_VCS_ACTION_STATE);
      }
      return;
    }

    for (const key of knownVcsActionKeys) {
      setState(key, EMPTY_VCS_ACTION_STATE);
    }
  }

  return {
    getSnapshot,
    refreshStatus,
    pull,
    switchRef,
    createRef,
    createWorktree,
    init,
    runChangeRequest,
    reset,
  };
}
