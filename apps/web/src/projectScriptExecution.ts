import { canLaunchWorkbench } from "@t3tools/client-runtime/state/task-workbench";
import type { ProjectScript, ScopedProjectRef } from "@t3tools/contracts";
import type { WorkbenchResolution } from "@t3tools/client-runtime/state/task-workbench";
import { scopedProjectKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";

/** Selection, persistence and execution all use this scoped project's current scripts. */
export function resolveProjectScriptLaunch(input: {
  workbench: WorkbenchResolution;
  project: {
    environmentId: ScopedProjectRef["environmentId"];
    id: ScopedProjectRef["projectId"];
    workspaceRoot: string;
    scripts: readonly ProjectScript[];
  } | null;
  scriptId: string;
}) {
  const { workbench, project } = input;
  if (
    !canLaunchWorkbench(workbench) ||
    !project ||
    project.environmentId !== workbench.projectRef.environmentId ||
    project.id !== workbench.projectRef.projectId ||
    project.workspaceRoot !== workbench.workspaceRoot
  )
    return null;
  const script = project.scripts.find((script) => script.id === input.scriptId);
  if (!script) return null;
  return {
    ownerRef: workbench.ownerRef,
    projectRef: workbench.projectRef,
    projectKey: scopedProjectKey(workbench.projectRef),
    projectCwd: workbench.workspaceRoot,
    cwd: workbench.cwd,
    worktreePath: workbench.worktreePath,
    env: projectScriptRuntimeEnv({
      project: { cwd: workbench.workspaceRoot },
      worktreePath: workbench.worktreePath,
    }),
    script,
  };
}

export function workbenchLaunchKey(workbench: WorkbenchResolution) {
  return canLaunchWorkbench(workbench)
    ? JSON.stringify([
        scopedThreadKey(workbench.ownerRef),
        scopedProjectKey(workbench.projectRef),
        workbench.workspaceRoot,
        workbench.cwd,
        workbench.worktreePath,
      ])
    : null;
}

export function scriptNeedsNewTerminal(input: {
  busy: boolean;
  knownTerminal: boolean;
  existingCwd: string | null | undefined;
  cwd: string;
}) {
  return input.busy || (input.knownTerminal && input.existingCwd !== input.cwd);
}

/** Opening may await remote preparation; revalidate the captured target before sending a command. */
export async function executeProjectScript(input: {
  isCurrent: () => boolean;
  open: () => Promise<boolean>;
  write: () => Promise<void>;
}) {
  if (!input.isCurrent() || !(await input.open()) || !input.isCurrent()) return;
  await input.write();
}
