import {
  EnvironmentId,
  type EnvironmentId as EnvironmentIdType,
  GitActionProgressPhase,
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  GitStackedAction,
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

export const VcsActionOperation = Schema.Literals([
  "refresh_status",
  "run_change_request",
  "pull",
  "switch_ref",
  "create_ref",
  "create_worktree",
  "init",
  "publish_repository",
  "prepare_pull_request_thread",
]);
export type VcsActionOperation = typeof VcsActionOperation.Type;

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
    operation: VcsActionOperation,
    environmentId: Schema.NullOr(EnvironmentId),
    cwd: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `Source control operation '${this.operation.replaceAll("_", " ")}' is unavailable.`;
  }
}

export class VcsActionRemoteFailureError extends Schema.TaggedErrorClass<VcsActionRemoteFailureError>()(
  "VcsActionRemoteFailureError",
  {
    actionId: Schema.String,
    transportActionId: Schema.String,
    action: GitStackedAction,
    environmentId: EnvironmentId,
    cwd: Schema.String,
    phase: Schema.NullOr(GitActionProgressPhase),
    remoteMessageLength: Schema.Number,
  },
) {
  override get message(): string {
    const phase = this.phase === null ? "execution" : this.phase;
    return `Source control action '${this.action}' failed during ${phase}.`;
  }
}

export class VcsActionMissingTerminalEventError extends Schema.TaggedErrorClass<VcsActionMissingTerminalEventError>()(
  "VcsActionMissingTerminalEventError",
  {
    actionId: Schema.String,
    transportActionId: Schema.String,
    action: GitStackedAction,
    environmentId: EnvironmentId,
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return `Source control action '${this.action}' ended without a terminal result.`;
  }
}

export class VcsActionTargetKeyParseError extends Schema.TaggedErrorClass<VcsActionTargetKeyParseError>()(
  "VcsActionTargetKeyParseError",
  {
    keyLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid source control action target key (${this.keyLength} characters).`;
  }
}

export const VcsActionExecutionError = Schema.Union([
  VcsActionRemoteFailureError,
  VcsActionMissingTerminalEventError,
]);
export type VcsActionExecutionError = typeof VcsActionExecutionError.Type;

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
const decodeVcsActionTargetKey = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, Schema.String]),
);

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

export function parseVcsActionTargetKey(key: string): ResolvedVcsActionTarget {
  try {
    const [environmentId, cwd] = decodeVcsActionTargetKey(JSON.parse(key));
    return { environmentId, cwd };
  } catch (cause) {
    throw new VcsActionTargetKeyParseError({ keyLength: key.length, cause });
  }
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
    readonly action: GitStackedAction;
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
          return Effect.fail<VcsActionExecutionError>(
            new VcsActionRemoteFailureError({
              actionId: input.actionId,
              transportActionId: input.transportActionId,
              action: terminalEvent.action,
              environmentId: input.target.environmentId,
              cwd: input.target.cwd,
              phase: terminalEvent.phase,
              remoteMessageLength: terminalEvent.message.length,
            }),
          );
        }
        return Effect.fail<VcsActionExecutionError>(
          new VcsActionMissingTerminalEventError({
            actionId: input.actionId,
            transportActionId: input.transportActionId,
            action: input.action,
            environmentId: input.target.environmentId,
            cwd: input.target.cwd,
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
        ...EMPTY_VCS_ACTION_STATE,
        actionId: event.actionId,
        action: event.action,
        operation: "run_change_request",
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
  const runStackedActionCommands = new Map<
    string,
    AtomCommand<RunVcsStackedActionInput, GitRunStackedActionResult, unknown>
  >();
  const getRunStackedActionCommand = (requestedTarget: VcsActionTarget) => {
    const targetKey = getVcsActionTargetKey(requestedTarget);
    const commandKey =
      targetKey ??
      JSON.stringify([
        "vcs-action-target:unavailable",
        requestedTarget.environmentId,
        requestedTarget.cwd,
      ]);
    const existing = runStackedActionCommands.get(commandKey);
    if (existing !== undefined) {
      return existing;
    }
    const target = targetKey === null ? null : parseVcsActionTargetKey(targetKey);
    const stateAtom = targetKey === null ? EMPTY_VCS_ACTION_ATOM : vcsActionStateAtom(targetKey);
    const command = createRuntimeCommand<
      EnvironmentRegistry | R,
      E,
      RunVcsStackedActionInput,
      GitRunStackedActionResult,
      unknown
    >(runtime, {
      label: `vcs-action:run-stacked:${commandKey}`,
      scheduler: vcsCommandScheduler,
      concurrency: { mode: "serial", key: () => commandKey },
      execute: (input: RunVcsStackedActionInput, registry) => {
        if (target === null) {
          return Effect.fail(
            new VcsActionUnavailableError({
              operation: "run_change_request",
              environmentId: requestedTarget.environmentId,
              cwd: requestedTarget.cwd,
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
            action: input.action,
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
    runStackedActionCommands.set(commandKey, command);
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
    runStackedAction: (target: VcsActionTarget) => getRunStackedActionCommand(target),
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
              operation: input.operation,
              environmentId: target.environmentId,
              cwd: target.cwd,
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
