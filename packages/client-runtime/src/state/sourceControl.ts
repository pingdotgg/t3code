import {
  WS_METHODS,
  type EnvironmentId,
  type SourceControlDiscoveryResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import type {
  SourceControlAccount,
  SourceControlAccountsByEnvironment,
} from "./projectGrouping.ts";
import { reuseUnchanged } from "./serverConfigProjection.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";

/** Logins the server verified: its effective account and each host's active one. */
export function verifiedSourceControlAccounts(
  discovery: SourceControlDiscoveryResult,
): SourceControlAccount[] {
  return discovery.sourceControlProviders.flatMap(({ auth }) => [
    ...(auth.status === "authenticated" && Option.isSome(auth.host) && Option.isSome(auth.account)
      ? [{ host: auth.host.value, account: auth.account.value }]
      : []),
    ...(auth.accounts ?? [])
      .filter((entry) => entry.active && entry.authenticated)
      .map(({ host, account }) => ({ host, account })),
  ]);
}

export function createSourceControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const discovery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:server:source-control-discovery",
    tag: WS_METHODS.serverDiscoverSourceControl,
  });
  const accountsFamily = Atom.family((environmentIdsKey: string) =>
    Atom.make((get): SourceControlAccountsByEnvironment => {
      const accounts: Record<string, SourceControlAccount[]> = {};
      for (const environmentId of JSON.parse(environmentIdsKey) as EnvironmentId[]) {
        const result = AsyncResult.value(get(discovery({ environmentId, input: {} })));
        if (Option.isSome(result))
          accounts[environmentId] = verifiedSourceControlAccounts(result.value);
      }
      return reuseUnchanged(Option.getOrUndefined(get.self()), accounts);
    }).pipe(Atom.withLabel(`environment-data:source-control:accounts:${environmentIdsKey}`)),
  );
  return {
    discovery,
    /** Verified logins for each listed environment, for labelling repositories the user owns. */
    accounts: (environmentIds: Iterable<EnvironmentId>) =>
      accountsFamily(JSON.stringify([...new Set(environmentIds)].sort())),
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
    publishRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:publish-repository",
      tag: WS_METHODS.sourceControlPublishRepository,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: (target, registry) =>
        invalidateCachedVcsRefs(registry, {
          environmentId: target.environmentId,
          cwd: target.input.cwd,
        }),
    }),
  };
}
