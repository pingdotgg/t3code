import { GitStackStatusResult, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { vcsRefsCacheStateAtom } from "./vcsRefInvalidation.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";
import { persistQuery } from "./queryPersistence.ts";
import type { createVcsActionManager } from "./vcsAction.ts";

export function createGitEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
  trackAction: ReturnType<typeof createVcsActionManager>["track"],
) {
  const startCommitWorkflow = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:git:start-commit-workflow",
    tag: WS_METHODS.gitStartCommitWorkflow,
    onSettled: ({ environmentId, input }, registry) =>
      input.scope.type === "working_tree_new_branch"
        ? invalidateCachedVcsRefs(registry, { environmentId, cwd: input.cwd })
        : Effect.void,
  });
  const rewriteCommitMessages = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:git:rewrite-commit-messages",
    tag: WS_METHODS.gitRewriteCommitMessages,
    scheduler: vcsCommandScheduler,
    concurrency: vcsCommandConcurrency,
  });
  const regeneratePullRequestDescription = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:git:regenerate-pull-request-description",
    tag: WS_METHODS.gitRegeneratePullRequestDescription,
    scheduler: vcsCommandScheduler,
    concurrency: vcsCommandConcurrency,
  });
  const stackStatus = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:git:stack-status",
    tag: WS_METHODS.gitStackStatus,
    persistence: persistQuery(GitStackStatusResult),
    staleTimeMs: 30_000,
    idleTtlMs: 5 * 60_000,
    refreshTrigger: ({ environmentId }) => vcsRefsCacheStateAtom({ environmentId }),
  });
  const manageStack = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:git:manage-stack",
    tag: WS_METHODS.gitStackManage,
    scheduler: vcsCommandScheduler,
    concurrency: vcsCommandConcurrency,
    onSettled: ({ environmentId, input }, registry) =>
      invalidateCachedVcsRefs(registry, { environmentId, cwd: input.cwd }),
  });
  return {
    workflowProgress: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:git:workflow-progress",
      tag: WS_METHODS.gitSubscribeWorkflowProgress,
    }),
    stackStatus,
    manageStack: {
      ...manageStack,
      run: (
        registry: Parameters<typeof manageStack.run>[0],
        target: Parameters<typeof manageStack.run>[1],
      ) =>
        trackAction(
          registry,
          { environmentId: target.environmentId, cwd: target.input.cwd },
          {
            operation: "manage_stack",
            label:
              target.input.action === "adopt" || target.input.action === "edit"
                ? "Saving stack layers..."
                : target.input.action === "abort"
                  ? "Aborting stack update..."
                  : "Updating branch stack...",
          },
          () => manageStack.run(registry, target),
        ),
    },
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
    rewriteableCommits: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git:rewriteable-commits",
      tag: WS_METHODS.gitListRewriteableCommits,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    listRewriteableCommits: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:list-rewriteable-commits",
      tag: WS_METHODS.gitListRewriteableCommits,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    rewriteCommitMessages: {
      ...rewriteCommitMessages,
      run: (
        registry: Parameters<typeof rewriteCommitMessages.run>[0],
        target: Parameters<typeof rewriteCommitMessages.run>[1],
      ) =>
        trackAction(
          registry,
          { environmentId: target.environmentId, cwd: target.input.cwd },
          { operation: "rewrite_commit_messages", label: "Rewriting commit messages..." },
          () => rewriteCommitMessages.run(registry, target),
        ),
    },
    regeneratePullRequestDescription: {
      ...regeneratePullRequestDescription,
      run: (
        registry: Parameters<typeof regeneratePullRequestDescription.run>[0],
        target: Parameters<typeof regeneratePullRequestDescription.run>[1],
      ) =>
        trackAction(
          registry,
          { environmentId: target.environmentId, cwd: target.input.cwd },
          {
            operation: "regenerate_change_request",
            label: "Regenerating request title and description...",
          },
          () => regeneratePullRequestDescription.run(registry, target),
        ),
    },
  };
}
