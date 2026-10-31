import type { ProjectId } from "@t3tools/contracts";

import GitActionsControl from "../GitActionsControl";
import { ProjectAutomationsHeaderControl } from "./ThreadAutomationsPanel";
import type { ThreadDetailsPanel } from "./ThreadDetailsPanel";

/**
 * The pane header's project cluster (pen mlsUZ): the project's automations.
 * Project actions and git live in thread details; the header keeps a
 * control-less git mount so the commit and push shortcut works while thread
 * details is closed.
 */
export function PaneHeaderActions(
  props: Pick<
    Parameters<typeof ThreadDetailsPanel>[0],
    "environmentId" | "threadId" | "draftId" | "activeProjectName" | "gitCwd" | "isGitRepo"
  > & { readonly projectId: ProjectId | null },
) {
  if (!props.activeProjectName) return null;

  return (
    <div className="hidden min-w-0 shrink-0 items-center gap-1.5 lg:flex">
      {props.gitCwd && props.isGitRepo ? (
        <GitActionsControl
          presentation="shortcut"
          listenForShortcuts={false}
          gitCwd={props.gitCwd}
          activeThreadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
          {...(props.draftId ? { draftId: props.draftId } : {})}
        />
      ) : null}
      {props.projectId ? (
        <ProjectAutomationsHeaderControl
          environmentId={props.environmentId}
          projectId={props.projectId}
          projectName={props.activeProjectName}
        />
      ) : null}
    </div>
  );
}
