import type { ProjectId } from "@t3tools/contracts";

import GitActionsControl from "../GitActionsControl";
import { ProjectAutomationsHeaderControl } from "./ThreadAutomationsPanel";
import type { ThreadDetailsPanel } from "./ThreadDetailsPanel";
import { ThreadLineageHeaderControl } from "./ThreadRelationshipsControl";

/**
 * Keep a control-less git mount so commit/push shortcuts work with thread details closed.
 * Narrow panes hide this cluster to reserve space for their tabs.
 */
export function PaneHeaderActions(
  props: Pick<
    Parameters<typeof ThreadDetailsPanel>[0],
    "environmentId" | "threadId" | "draftId" | "activeProjectName" | "gitCwd" | "isGitRepo"
  > & { readonly projectId: ProjectId | null },
) {
  if (!props.activeProjectName) return null;

  return (
    <div className="hidden min-w-0 shrink-0 items-center gap-1.5 md:empty:hidden lg:@2xl/header-actions:flex">
      {props.draftId ? null : (
        <ThreadLineageHeaderControl environmentId={props.environmentId} threadId={props.threadId} />
      )}
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
