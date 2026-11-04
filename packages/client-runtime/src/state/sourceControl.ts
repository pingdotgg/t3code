import {
  WS_METHODS,
  type EnvironmentId,
  type SourceControlCloneRepositoryInput,
  type SourceControlPublishRepositoryInput,
  type SourceControlSshPasswordPromptRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createRuntimeCommand,
  runInEnvironment,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  config as environmentConfig,
  requestGuarded,
  RpcPermissionGuard,
  runStream,
} from "../rpc/client.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";
import { consumeSshPromptedOperation } from "./sshPasswordPrompts.ts";

export function createSourceControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  return {
    discovery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:source-control-discovery",
      tag: WS_METHODS.serverDiscoverSourceControl,
    }),
    appAccess: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:app-access",
      tag: WS_METHODS.sourceControlAppAccess,
    }),
    // One check, as after cloning, where no view keeps the query mounted.
    checkAppAccess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:check-app-access",
      tag: WS_METHODS.sourceControlAppAccess,
    }),
    checkStarred: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:check-starred",
      tag: WS_METHODS.sourceControlStarred,
    }),
    star: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:star",
      tag: WS_METHODS.sourceControlStar,
    }),
    repository: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:repository",
      tag: WS_METHODS.sourceControlLookupRepository,
    }),
    cloneRepository: createRuntimeCommand(runtime, {
      label: "environment-data:source-control:clone-repository",
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
      execute: (
        target: {
          readonly environmentId: EnvironmentId;
          readonly input: SourceControlCloneRepositoryInput;
          readonly onSshPasswordPrompt?: (
            request: SourceControlSshPasswordPromptRequest,
          ) => Promise<string | null>;
        },
        registry: AtomRegistry.AtomRegistry,
      ) =>
        runInEnvironment(
          target.environmentId,
          Effect.gen(function* () {
            const onSshPasswordPrompt = target.onSshPasswordPrompt;
            if (onSshPasswordPrompt === undefined) {
              return yield* requestGuarded(WS_METHODS.sourceControlCloneRepository, target.input);
            }
            const serverConfig = yield* environmentConfig;
            if (serverConfig.environment.capabilities.sourceControlSshPasswordPrompts !== true) {
              return yield* requestGuarded(WS_METHODS.sourceControlCloneRepository, target.input);
            }
            return yield* consumeSshPromptedOperation(
              target.environmentId,
              "Repository cloning",
              runStream(WS_METHODS.sourceControlCloneRepositoryWithPrompts, target.input),
              onSshPasswordPrompt,
            );
          }).pipe(
            Effect.provideService(RpcPermissionGuard, {
              authorize: (id, method, payload) =>
                createCommandPermissions(runtime, method).authorize(registry, id, payload),
            }),
          ),
        ),
    }),
    // Clone-backed project creation. The RPC returns once the project exists
    // and the clone runs in the background; `projectClones` carries progress.
    startProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-start",
      tag: WS_METHODS.projectCloneStart,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    // Cancel and retry share the start queue so a double click cannot race
    // two actions against the same clone.
    cancelProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-cancel",
      tag: WS_METHODS.projectCloneCancel,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    retryProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-retry",
      tag: WS_METHODS.projectCloneRetry,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    // Unscheduled: a pending sign-in waits on the user for minutes and must not hold up clones.
    startSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:sign-in-start",
      tag: WS_METHODS.sourceControlSignInStart,
    }),
    waitForSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:sign-in-wait",
      tag: WS_METHODS.sourceControlSignInWait,
    }),
    cancelSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:sign-in-cancel",
      tag: WS_METHODS.sourceControlSignInCancel,
    }),
    projectClones: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:source-control:project-clones",
      tag: WS_METHODS.subscribeProjectClones,
    }),
    publishRepository: createRuntimeCommand(runtime, {
      label: "environment-data:source-control:publish-repository",
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      execute: (
        target: {
          readonly environmentId: EnvironmentId;
          readonly input: SourceControlPublishRepositoryInput;
          readonly onSshPasswordPrompt?: (
            request: SourceControlSshPasswordPromptRequest,
          ) => Promise<string | null>;
        },
        registry,
      ) =>
        runInEnvironment(
          target.environmentId,
          Effect.gen(function* () {
            const onSshPasswordPrompt = target.onSshPasswordPrompt;
            if (onSshPasswordPrompt === undefined) {
              return yield* requestGuarded(WS_METHODS.sourceControlPublishRepository, target.input);
            }

            const serverConfig = yield* environmentConfig;
            if (serverConfig.environment.capabilities.sourceControlSshPasswordPrompts !== true) {
              return yield* requestGuarded(WS_METHODS.sourceControlPublishRepository, target.input);
            }

            return yield* consumeSshPromptedOperation(
              target.environmentId,
              "Repository publishing",
              runStream(WS_METHODS.sourceControlPublishRepositoryWithPrompts, target.input),
              onSshPasswordPrompt,
            );
          }).pipe(
            Effect.provideService(RpcPermissionGuard, {
              authorize: (id, method, payload) =>
                createCommandPermissions(runtime, method).authorize(registry, id, payload),
            }),
          ),
        ).pipe(
          Effect.ensuring(
            invalidateCachedVcsRefs(registry, {
              environmentId: target.environmentId,
              cwd: target.input.cwd,
            }),
          ),
        ),
    }),
  };
}
