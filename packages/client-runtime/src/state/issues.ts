import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Every read shells out to the host's CLI, so results are reused for a short while and
 * refreshed explicitly. Mutations run serially per environment: CLI actions on the same
 * issue are order-sensitive, and the detail view refetches after each one.
 */
export function createIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:list",
      tag: WS_METHODS.issuesList,
      staleTimeMs: 30_000,
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:detail",
      tag: WS_METHODS.issuesDetail,
      staleTimeMs: 15_000,
    }),
    activity: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:activity",
      tag: WS_METHODS.issuesActivity,
      staleTimeMs: 15_000,
    }),
    commentsPage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:comments-page",
      tag: WS_METHODS.issuesCommentsPage,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    /**
     * Its own query rather than part of the detail: the labels a repository has are only wanted
     * once somebody opens the label picker, so this atom is read then and not before. Kept fresh
     * for a minute, because what labels a repository has changes far more slowly than an issue.
     */
    labelCandidates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:label-candidates",
      tag: WS_METHODS.issuesLabelCandidates,
      staleTimeMs: 60_000,
    }),
    /**
     * Same reasoning as `labelCandidates`: who may be assigned is only wanted once somebody opens
     * the assignee menu, and who has access to a repository changes far more slowly too.
     */
    assigneeCandidates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:assignee-candidates",
      tag: WS_METHODS.issuesAssigneeCandidates,
      staleTimeMs: 60_000,
    }),
    /**
     * The same reasoning again, held longer still: what a repository offers a new issue is a file
     * in that repository, so it changes with a commit rather than with anything anyone does here.
     */
    templates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:templates",
      tag: WS_METHODS.issuesTemplates,
      staleTimeMs: 300_000,
    }),
    runAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:run-action",
      tag: WS_METHODS.issuesRunAction,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    comment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:comment",
      tag: WS_METHODS.issuesComment,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    updateComment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:update-comment",
      tag: WS_METHODS.issuesUpdateComment,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    setReaction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:set-reaction",
      tag: WS_METHODS.issuesSetReaction,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:create",
      tag: WS_METHODS.issuesCreate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:update",
      tag: WS_METHODS.issuesUpdate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    setLabels: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:set-labels",
      tag: WS_METHODS.issuesSetLabels,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    setAssignees: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:set-assignees",
      tag: WS_METHODS.issuesSetAssignees,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    /**
     * Explicit refresh: forget the server's cached answers, then re-run the reads. A separate
     * request rather than a flag on a read, so only a person's refresh spends host requests
     * while every silent re-read shares the cache.
     */
    invalidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:invalidate",
      tag: WS_METHODS.issuesInvalidate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
