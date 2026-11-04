import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";
import type { createVcsActionManager } from "./vcsAction.ts";

export function createGitEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
  trackAction: ReturnType<typeof createVcsActionManager>["track"],
) {
  const startCommitWorkflow = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:git:start-commit-workflow",
    tag: WS_METHODS.gitStartCommitWorkflow,
  });
  return {
    cancelCommitWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:cancel-commit-workflow",
      tag: WS_METHODS.gitCancelCommitWorkflow,
    }),
    startCommitWorkflow: {
      ...startCommitWorkflow,
      run: (
        registry: Parameters<typeof startCommitWorkflow.run>[0],
        target: Parameters<typeof startCommitWorkflow.run>[1],
      ) =>
        trackAction(
          registry,
          { environmentId: target.environmentId, cwd: target.input.cwd },
          {
            operation: "split_commits",
            label: "Splitting into logical commits...",
            actionId: target.input.commandId,
          },
          () => startCommitWorkflow.run(registry, target),
        ),
    },
    pullRequestResolution: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git:resolve-pull-request",
      tag: WS_METHODS.gitResolvePullRequest,
    }),
    preparePullRequestThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:prepare-pull-request-thread",
      tag: WS_METHODS.gitPreparePullRequestThread,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: ({ environmentId, input }, registry) =>
        invalidateCachedVcsRefs(registry, { environmentId, cwd: input.cwd }),
    }),
    listRewriteableCommits: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:list-rewriteable-commits",
      tag: WS_METHODS.gitListRewriteableCommits,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    rewriteCommitMessages: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:rewrite-commit-messages",
      tag: WS_METHODS.gitRewriteCommitMessages,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    regeneratePullRequestDescription: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:regenerate-pull-request-description",
      tag: WS_METHODS.gitRegeneratePullRequestDescription,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}
