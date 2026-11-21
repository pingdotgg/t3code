import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { MultiRepoProjectSetup } from "@t3tools/client-runtime/state/project-grouping";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";

import type { AddProjectTarget } from "./useAddProjectTargets";
import { listMultiRepoSetupTargets, MULTI_REPO_SETUP_SCOPES } from "../multiRepoSetupMenu";
import { useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../state/session";

export type MultiRepoSetupTarget = AddProjectTarget & { readonly setup: MultiRepoProjectSetup };

export function readCanSetUpMultiRepoProject(environmentId: EnvironmentId): boolean {
  return MULTI_REPO_SETUP_SCOPES.every((scope) => readEnvironmentScope(environmentId, scope));
}

/** Machines a multi-repo project can be set up on, for the Run on picker. */
export function useMultiRepoSetupTargets(
  project: EnvironmentProject | null,
): readonly MultiRepoSetupTarget[] {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const canInspect = useEnvironmentsWithScope(environments, MULTI_REPO_SETUP_SCOPES[0]);
  const canClone = useEnvironmentsWithScope(environments, MULTI_REPO_SETUP_SCOPES[1]);
  const canCreate = useEnvironmentsWithScope(environments, MULTI_REPO_SETUP_SCOPES[2]);
  if (!project?.multiRepo) return [];
  return listMultiRepoSetupTargets({
    projects,
    projectRefs: [scopeProjectRef(project.environmentId, project.id)],
    environments,
    canSetUp: (id) => canInspect.has(id) && canClone.has(id) && canCreate.has(id),
  })
    .map(({ environment, setup }) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      machine: resolveEnvironmentMachineKind(environment.serverConfig),
      setup,
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}
