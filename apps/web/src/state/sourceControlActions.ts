import { useAtomValue } from "@effect/atom-react";
import type {
  AtomCommandFailure,
  AtomCommandResult,
  AtomCommandSuccess,
} from "@t3tools/client-runtime/state/runtime";
import {
  VcsActionUnavailableError,
  type VcsActionOperation,
  type RunVcsStackedActionInput,
} from "@t3tools/client-runtime/state/vcs";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type GitResolvePullRequestResult,
  type SourceControlCloneProtocol,
  type SourceControlProviderKind,
  type SourceControlRepositoryVisibility,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { gitEnvironment } from "./git";
import { useEnvironmentQuery } from "./query";
import { readEnvironmentScope, useEnvironmentScope } from "./session";
import { sourceControlEnvironment } from "./sourceControl";
import { useAtomCommand } from "./use-atom-command";
import { vcsActionManager, vcsEnvironment } from "./vcs";
import { suggestAppAccessForRemote } from "../components/sourceControlAppAccessToast";

export type SourceControlActionKind =
  | "init"
  | "pull"
  | "publishRepository"
  | "runStackedAction"
  | "preparePullRequestThread";

export interface SourceControlActionScope {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

interface SourceControlActionState<
  TArgs extends ReadonlyArray<unknown>,
  R extends AtomCommandResult<unknown, unknown>,
> {
  readonly isPending: boolean;
  readonly isAllowed: boolean;
  readonly error: unknown;
  readonly run: (
    ...args: TArgs
  ) => Promise<
    AtomCommandResult<
      AtomCommandSuccess<R>,
      AtomCommandFailure<R> | VcsActionUnavailableError | EnvironmentAuthorizationError
    >
  >;
  readonly resetError: () => void;
}

const ACTION_OPERATION = {
  init: "init",
  pull: "pull",
  publishRepository: "publish_repository",
  runStackedAction: "run_change_request",
  preparePullRequestThread: "prepare_pull_request_thread",
} as const satisfies Record<SourceControlActionKind, VcsActionOperation>;

function useAction<
  TArgs extends ReadonlyArray<unknown>,
  R extends AtomCommandResult<unknown, unknown>,
>(input: {
  readonly kind: SourceControlActionKind;
  readonly label: string;
  readonly scope: SourceControlActionScope;
  readonly action: (...args: TArgs) => Promise<R>;
  readonly onSuccess?: () => void;
  readonly managedExternally?: boolean;
}): SourceControlActionState<TArgs, R> {
  const isAllowed = useEnvironmentScope(input.scope.environmentId, AuthSourceControlWriteScope);
  const operation = ACTION_OPERATION[input.kind];
  const state = useAtomValue(vcsActionManager.stateAtom(input.scope));
  const ownsState = state.operation === operation;

  const resetError = () => {
    vcsActionManager.resetError(appAtomRegistry, input.scope, operation);
  };

  const run = async (...args: TArgs) => {
    if (
      input.scope.environmentId === null ||
      !readEnvironmentScope(input.scope.environmentId, AuthSourceControlWriteScope)
    ) {
      return AsyncResult.failure<never, EnvironmentAuthorizationError>(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthSourceControlWriteScope,
            message: "This connection cannot change source control.",
          }),
        ),
      );
    }
    const execute = async (): Promise<
      AtomCommandResult<AtomCommandSuccess<R>, AtomCommandFailure<R>>
    > => {
      const result = await input.action(...args);
      if (AsyncResult.isSuccess(result)) {
        input.onSuccess?.();
      }
      return result as AtomCommandResult<AtomCommandSuccess<R>, AtomCommandFailure<R>>;
    };
    return input.managedExternally === true
      ? execute()
      : vcsActionManager.track(
          appAtomRegistry,
          input.scope,
          {
            operation,
            label: input.label,
          },
          execute,
        );
  };

  return {
    isAllowed,
    error: ownsState ? state.error : null,
    isPending: ownsState && state.isRunning,
    resetError,
    run,
  };
}

function resolveScope(scope: SourceControlActionScope) {
  if (scope.environmentId === null || scope.cwd === null) {
    return null;
  }
  return {
    environmentId: scope.environmentId,
    cwd: scope.cwd,
  };
}

export function useSourceControlActionRunning(
  scope: SourceControlActionScope,
  kinds: ReadonlyArray<SourceControlActionKind>,
): boolean {
  const state = useAtomValue(vcsActionManager.stateAtom(scope));
  return (
    state.isRunning &&
    state.operation !== null &&
    kinds.some((kind) => ACTION_OPERATION[kind] === state.operation)
  );
}

export function useVcsInitAction(scope: SourceControlActionScope) {
  const init = useAtomCommand(vcsEnvironment.init, { reportFailure: false });
  const action = async () => {
    const target = resolveScope(scope);
    if (target === null) {
      return AsyncResult.failure<never, VcsActionUnavailableError>(
        Cause.fail(
          new VcsActionUnavailableError({
            operation: "init",
            environmentId: scope.environmentId,
            cwd: scope.cwd,
          }),
        ),
      );
    }
    return init({
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    });
  };
  return useAction({ kind: "init", label: "Initializing repository", scope, action });
}

export function useVcsPullAction(scope: SourceControlActionScope) {
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );
  const action = async () => {
    const target = resolveScope(scope);
    if (target === null) {
      return AsyncResult.failure<never, VcsActionUnavailableError>(
        Cause.fail(
          new VcsActionUnavailableError({
            operation: "pull",
            environmentId: scope.environmentId,
            cwd: scope.cwd,
          }),
        ),
      );
    }
    return pull({
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    });
  };
  return useAction({
    kind: "pull",
    label: "Pulling latest changes...",
    scope,
    action,
    onSuccess: status.refresh,
  });
}

export function useGitStackedAction(scope: SourceControlActionScope) {
  const runStackedAction = useAtomCommand(vcsActionManager.runStackedAction(scope), {
    reportFailure: false,
  });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );

  const action = async (input: RunVcsStackedActionInput) => {
    if (resolveScope(scope) === null) {
      return AsyncResult.failure<never, VcsActionUnavailableError>(
        Cause.fail(
          new VcsActionUnavailableError({
            operation: "run_change_request",
            environmentId: scope.environmentId,
            cwd: scope.cwd,
          }),
        ),
      );
    }
    return runStackedAction(input);
  };

  return useAction({
    kind: "runStackedAction",
    label: "Running source control action",
    scope,
    action,
    onSuccess: status.refresh,
    managedExternally: true,
  });
}

export function useSourceControlPublishRepositoryAction(scope: SourceControlActionScope) {
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );
  const action = async (input: {
    provider: SourceControlProviderKind;
    repository: string;
    visibility: SourceControlRepositoryVisibility;
    remoteName: string;
    protocol: SourceControlCloneProtocol;
  }) => {
    const target = resolveScope(scope);
    if (target === null) {
      return AsyncResult.failure<never, VcsActionUnavailableError>(
        Cause.fail(
          new VcsActionUnavailableError({
            operation: "publish_repository",
            environmentId: scope.environmentId,
            cwd: scope.cwd,
          }),
        ),
      );
    }
    const result = await publishRepository({
      environmentId: target.environmentId,
      input: {
        cwd: target.cwd,
        ...input,
      },
    });
    if (result._tag === "Success") {
      void suggestAppAccessForRemote(target.environmentId, result.value.remoteUrl);
    }
    return result;
  };
  return useAction({
    kind: "publishRepository",
    label: "Publishing repository",
    scope,
    action,
    onSuccess: status.refresh,
  });
}

export function usePreparePullRequestThreadAction(scope: SourceControlActionScope) {
  const preparePullRequestThread = useAtomCommand(gitEnvironment.preparePullRequestThread, {
    reportFailure: false,
  });
  const action = async (input: {
    reference: string;
    mode: "local" | "worktree";
    threadId?: ThreadId;
  }) => {
    const target = resolveScope(scope);
    if (target === null) {
      return AsyncResult.failure<never, VcsActionUnavailableError>(
        Cause.fail(
          new VcsActionUnavailableError({
            operation: "prepare_pull_request_thread",
            environmentId: scope.environmentId,
            cwd: scope.cwd,
          }),
        ),
      );
    }
    if (
      input.mode === "worktree" &&
      input.threadId !== undefined &&
      !readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)
    ) {
      return AsyncResult.failure<never, EnvironmentAuthorizationError>(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthOrchestrationOperateScope,
            message: "This connection cannot change threads.",
          }),
        ),
      );
    }
    return preparePullRequestThread({
      environmentId: target.environmentId,
      input: {
        cwd: target.cwd,
        reference: input.reference,
        mode: input.mode,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
    });
  };
  return useAction({
    kind: "preparePullRequestThread",
    label: "Preparing pull request thread",
    scope,
    action,
  });
}

export interface PullRequestResolutionTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string | null;
}

export function readCachedPullRequestResolution(
  target: PullRequestResolutionTarget,
): GitResolvePullRequestResult | null {
  if (target.environmentId === null || target.cwd === null || target.reference === null) {
    return null;
  }
  return AsyncResult.getOrElse(
    appAtomRegistry.get(
      gitEnvironment.pullRequestResolution({
        environmentId: target.environmentId,
        input: { cwd: target.cwd, reference: target.reference },
      }),
    ),
    () => null,
  );
}

export function usePullRequestResolutionState(target: PullRequestResolutionTarget) {
  const query = useEnvironmentQuery(
    target.environmentId !== null && target.cwd !== null && target.reference !== null
      ? gitEnvironment.pullRequestResolution({
          environmentId: target.environmentId,
          input: {
            cwd: target.cwd,
            reference: target.reference,
          },
        })
      : null,
  );
  const cached = readCachedPullRequestResolution(target);

  return {
    data: query.data ?? cached,
    error: query.error,
    isPending: query.isPending && cached === null,
    isFetching: query.isPending,
    refresh: query.refresh,
  };
}
