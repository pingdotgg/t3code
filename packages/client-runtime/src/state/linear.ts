import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createLinearEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  return {
    authStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:auth-status",
      tag: WS_METHODS.linearAuthStatus,
    }),
    searchIssues: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:search-issues",
      tag: WS_METHODS.linearSearchIssues,
    }),
    listIssues: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:list-issues",
      tag: WS_METHODS.linearListIssues,
    }),
    teams: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:teams",
      tag: WS_METHODS.linearListTeams,
    }),
    workflowStates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:workflow-states",
      tag: WS_METHODS.linearListWorkflowStates,
    }),
    projects: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:projects",
      tag: WS_METHODS.linearListProjects,
    }),
    labels: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:labels",
      tag: WS_METHODS.linearListLabels,
    }),
    users: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:linear:users",
      tag: WS_METHODS.linearListUsers,
    }),
    fetchIssues: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:fetch-issues",
      tag: WS_METHODS.linearFetchIssues,
      scheduler: commandScheduler,
    }),
    updateIssueState: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:update-issue-state",
      tag: WS_METHODS.linearUpdateIssueState,
      scheduler: commandScheduler,
    }),
    createComment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:create-comment",
      tag: WS_METHODS.linearCreateComment,
      scheduler: commandScheduler,
    }),
    createAttachment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:create-attachment",
      tag: WS_METHODS.linearCreateAttachment,
      scheduler: commandScheduler,
    }),
    completeThreadIssue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:complete-thread-issue",
      tag: WS_METHODS.linearCompleteThreadIssue,
      scheduler: commandScheduler,
    }),
    setToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:set-token",
      tag: WS_METHODS.linearSetToken,
      scheduler: commandScheduler,
    }),
    clearToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:linear:clear-token",
      tag: WS_METHODS.linearClearToken,
      scheduler: commandScheduler,
    }),
  };
}
