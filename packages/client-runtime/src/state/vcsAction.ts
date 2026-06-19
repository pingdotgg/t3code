import {
  EnvironmentId,
  type EnvironmentId as EnvironmentIdType,
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type GitStackedAction,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { runStream } from "../rpc/client.ts";
import {
  createRuntimeCommand,
  runStreamInEnvironment,
  type AtomCommand,
  type AtomCommandResult,
} from "./runtime.ts";
import { vcsCommandScheduler } from "./vcsCommandScheduler.ts";

export type VcsActionOperation =
  | "refresh_status"
  | "run_change_request"
  | "pull"
  | "switch_ref"
  | "create_ref"
  | "create_worktree"
  | "init"
  | "publish_repository"
  | "prepare_pull_request_thread";

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
  readonly environmentId: EnvironmentIdType | null;
  readonly cwd: string | null;
}

export interface ResolvedVcsActionTarget {
  readonly environmentId: EnvironmentIdType;
  readonly cwd: string;
}

export interface BeginVcsActionInput {
  readonly operation: VcsActionOperation;
  readonly label: string;
  readonly actionId?: string;
}

export interface RunVcsStackedActionInput {
  readonly actionId: string;
  readonly action: GitStackedAction;
  readonly commitMessage?: string;
  readonly featureBranch?: boolean;
  readonly filePaths?: ReadonlyArray<string>;
  readonly onProgress?: (event: GitActionProgressEvent) => void;
}

export class VcsActionUnavailableError extends Schema.TaggedErrorClass<VcsActionUnavailableError>()(
  "VcsActionUnavailableError",
  {
    message: Schema.String,
  },
) {}

export class VcsActionExecutionError extends Schema.TaggedErrorClass<VcsActionExecutionError>()(
  "VcsActionExecutionError",
  {
    message: Schema.String,
  },
) {}

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

const nowMs = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe());
let nextLocalActionId = 0;

export const vcsActionStateAtom = Atom.family((key: string) => {
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
  return JSON.stringify([target.environmentId, target.cwd]);
}

function parseVcsActionTargetKey(key: string): ResolvedVcsActionTarget {
  const [environmentId, cwd] = JSON.parse(key) as [string, string];
  return {
    environmentId: EnvironmentId.make(environmentId),
    cwd,
  };
}

export function getVcsActionStateAtom(target: VcsActionTarget) {
  const key = getVcsActionTargetKey(target);
  return key === null ? EMPTY_VCS_ACTION_ATOM : vcsActionStateAtom(key);
}

function createLocalActionId(): string {
  nextLocalActionId += 1;
  return `local-vcs-action:${nextLocalActionId}`;
}

export function beginVcsActionState(
  input: BeginVcsActionInput,
): VcsActionState & { readonly actionId: string } {
  const actionId = input.actionId ?? createLocalActionId();
  const startedAt = nowMs();
  return {
    ...EMPTY_VCS_ACTION_STATE,
    isRunning: true,
    operation: input.operation,
    actionId,
    currentLabel: input.label,
    currentPhaseLabel: input.label,
    phaseStartedAtMs: startedAt,
  };
}

export function failVcsActionState(
  operation: VcsActionOperation,
  actionId: string,
  error: unknown,
): VcsActionState {
  return {
    ...EMPTY_VCS_ACTION_STATE,
    operation,
    actionId,
    error: error instanceof Error ? error.message : "Source control action failed.",
  };
}

export function createVcsActionTransportId(
  target: ResolvedVcsActionTarget,
  actionId: string,
): string {
  const targetKey = JSON.stringify([target.environmentId, target.cwd]);
  return `${targetKey.length}:${targetKey}${actionId}`;
}

export function normalizeVcsActionProgressEvent(
  target: ResolvedVcsActionTarget,
  transportActionId: string,
  actionId: string,
  event: GitActionProgressEvent,
): GitActionProgressEvent | null {
  if (event.actionId !== transportActionId || event.cwd !== target.cwd) {
    return null;
  }
  return {
    ...event,
    actionId,
  };
}

export function consumeVcsActionProgress<E, R>(
  stream: Stream.Stream<GitActionProgressEvent, E, R>,
  input: {
    readonly target: ResolvedVcsActionTarget;
    readonly transportActionId: string;
    readonly actionId: string;
    readonly onProgress: (event: GitActionProgressEvent) => Effect.Effect<void>;
  },
): Effect.Effect<GitRunStackedActionResult, E | VcsActionExecutionError, R> {
  return Effect.suspend(() => {
    let terminalEvent: GitActionProgressEvent | null = null;
    return stream.pipe(
      Stream.runForEach((event) => {
        const normalized = normalizeVcsActionProgressEvent(
          input.target,
          input.transportActionId,
          input.actionId,
          event,
        );
        if (normalized === null) {
          return Effect.void;
        }
        if (normalized.kind === "action_finished" || normalized.kind === "action_failed") {
          terminalEvent = normalized;
        }
        return input.onProgress(normalized);
      }),
      Effect.flatMap(() => {
        if (terminalEvent?.kind === "action_finished") {
          return Effect.succeed(terminalEvent.result);
        }
        if (terminalEvent?.kind === "action_failed") {
          return Effect.fail(
            new VcsActionExecutionError({
              message: terminalEvent.message,
            }),
          );
        }
        return Effect.fail(
          new VcsActionExecutionError({
            message: "Source control action ended without a result.",
          }),
        );
      }),
    );
  });
}

export function applyVcsActionProgressEvent(
  current: VcsActionState,
  event: GitActionProgressEvent,
): VcsActionState {
  if (current.actionId !== event.actionId) {
    return current;
  }
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

export function createVcsActionManager<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const unavailableTargetKey = "vcs-action-target:unavailable";
  const runStackedActionCommands = new Map<
    string,
    AtomCommand<RunVcsStackedActionInput, GitRunStackedActionResult, unknown>
  >();
  const getRunStackedActionCommand = (key: string) => {
    const existing = runStackedActionCommands.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const target = key === unavailableTargetKey ? null : parseVcsActionTargetKey(key);
    const stateAtom = target === null ? EMPTY_VCS_ACTION_ATOM : vcsActionStateAtom(key);
    const command = createRuntimeCommand<
      EnvironmentRegistry | R,
      E,
      RunVcsStackedActionInput,
      GitRunStackedActionResult,
      unknown
    >(runtime, {
      label: `vcs-action:run-stacked:${key}`,
      scheduler: vcsCommandScheduler,
      concurrency: { mode: "serial", key: () => key },
      execute: (input: RunVcsStackedActionInput, registry) => {
        if (target === null) {
          return Effect.fail(
            new VcsActionUnavailableError({
              message: "Source control action is unavailable.",
            }),
          );
        }
        const transportActionId = createVcsActionTransportId(target, input.actionId);
        registry.set(
          stateAtom,
          beginVcsActionState({
            operation: "run_change_request",
            label: "Running source control action",
            actionId: input.actionId,
          }),
        );

        const rpcInput: GitRunStackedActionInput = {
          actionId: transportActionId,
          cwd: target.cwd,
          action: input.action,
          ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
          ...(input.featureBranch ? { featureBranch: true } : {}),
          ...(input.filePaths?.length ? { filePaths: [...input.filePaths] } : {}),
        };
        return consumeVcsActionProgress(
          runStreamInEnvironment(
            target.environmentId,
            runStream(WS_METHODS.gitRunStackedAction, rpcInput),
          ),
          {
            target,
            transportActionId,
            actionId: input.actionId,
            onProgress: (event) =>
              Effect.sync(() => {
                const current = registry.get(stateAtom);
                if (current.actionId !== input.actionId) {
                  return;
                }
                registry.set(stateAtom, applyVcsActionProgressEvent(current, event));
                if (input.onProgress !== undefined) {
                  try {
                    input.onProgress(event);
                  } catch {
                    // Presentation callbacks must not fail the source-control operation.
                  }
                }
              }),
          },
        ).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              const current = registry.get(stateAtom);
              if (current.actionId === input.actionId && current.isRunning) {
                registry.set(
                  stateAtom,
                  failVcsActionState("run_change_request", input.actionId, error),
                );
              }
            }),
          ),
        );
      },
    });
    runStackedActionCommands.set(key, command);
    return command;
  };

  const setState = (
    registry: AtomRegistry.AtomRegistry,
    target: VcsActionTarget,
    update: (current: VcsActionState) => VcsActionState,
  ): void => {
    const key = getVcsActionTargetKey(target);
    if (key === null) {
      return;
    }
    const stateAtom = vcsActionStateAtom(key);
    registry.set(stateAtom, update(registry.get(stateAtom)));
  };

  return {
    stateAtom: getVcsActionStateAtom,
    runStackedAction: (target: VcsActionTarget) => {
      const key = getVcsActionTargetKey(target);
      return getRunStackedActionCommand(key ?? unavailableTargetKey);
    },
    track: async <A, E>(
      registry: AtomRegistry.AtomRegistry,
      target: VcsActionTarget,
      input: BeginVcsActionInput,
      action: () => Promise<AtomCommandResult<A, E>>,
    ): Promise<AtomCommandResult<A, E | VcsActionUnavailableError>> => {
      const key = getVcsActionTargetKey(target);
      if (key === null) {
        return AsyncResult.failure<never, VcsActionUnavailableError>(
          Cause.fail(
            new VcsActionUnavailableError({
              message: "Source control action is unavailable.",
            }),
          ),
        );
      }
      const stateAtom = vcsActionStateAtom(key);
      const next = beginVcsActionState(input);
      registry.set(stateAtom, next);
      const result = await action();
      const current = registry.get(stateAtom);
      if (current.actionId !== next.actionId) {
        return result;
      }
      if (AsyncResult.isSuccess(result) || Cause.hasInterruptsOnly(result.cause)) {
        registry.set(stateAtom, EMPTY_VCS_ACTION_STATE);
      } else {
        if (registry.get(stateAtom).actionId === next.actionId) {
          registry.set(
            stateAtom,
            failVcsActionState(input.operation, next.actionId, Cause.squash(result.cause)),
          );
        }
      }
      return result;
    },
    resetError: (
      registry: AtomRegistry.AtomRegistry,
      target: VcsActionTarget,
      operation: VcsActionOperation,
    ): void => {
      setState(registry, target, (current) =>
        !current.isRunning && current.operation === operation ? EMPTY_VCS_ACTION_STATE : current,
      );
    },
  };
}
